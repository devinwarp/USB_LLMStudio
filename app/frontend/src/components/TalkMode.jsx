import React, { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Square } from "lucide-react";
import {
  deleteTtsOutput,
  getTtsStatus,
  listSpeechModels,
  listTtsModels,
  speakTts,
  transcribeSpeech,
} from "../services/api";
import { createMicRecorder } from "../utils/audio";
import {
  TALK_RECORDING_FILENAME,
  TALK_STATE,
  TALK_TRANSCRIBE_LANGUAGE,
  TALK_VOICE_STORAGE_KEY,
  createSpeechChunker,
  createSpeechPipeline,
} from "../utils/talk";
import "../styles/talk.css";

const STATUS_TEXT = {
  [TALK_STATE.IDLE]: "Hold the mic button and speak. Release to send.",
  [TALK_STATE.LISTENING]: "Listening… release to send",
  [TALK_STATE.TRANSCRIBING]: "Turning your speech into text…",
  [TALK_STATE.THINKING]: "Thinking…",
  [TALK_STATE.SPEAKING]: "Speaking… press to interrupt",
};

const readStoredVoice = () => {
  try { return localStorage.getItem(TALK_VOICE_STORAGE_KEY) || ""; } catch (_) { return ""; }
};

// Push-to-talk voice loop for TextChat. onSend(text, { onContent }) sends a chat turn
// through the normal chat flow and resolves to the final reply text.
export default function TalkMode({ disabled, onSend, onStopGeneration, showAlert }) {
  const [state, setState] = useState(TALK_STATE.IDLE);
  const [voices, setVoices] = useState([]);
  const [voice, setVoice] = useState(readStoredVoice);
  const [missing, setMissing] = useState([]);

  const recorderRef = useRef(null);
  const pipelineRef = useRef(null);
  const audioRef = useRef(null);
  const finishPlaybackRef = useRef(null);
  const turnRef = useRef(0);
  const holdingRef = useRef(false);
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  useEffect(() => {
    let alive = true;
    Promise.all([getTtsStatus(), listSpeechModels().catch(() => []), listTtsModels().catch(() => [])])
      .then(([ttsStatus, speechModels, ttsModels]) => {
        if (!alive) return;
        const nextVoices = ttsStatus?.voices || [];
        setVoices(nextVoices);
        setVoice((current) => current || ttsStatus?.settings?.voice || nextVoices[0]?.id || "");
        const needs = [];
        if (!speechModels.some((model) => model.installed)) needs.push("a Whisper speech model");
        if (!ttsModels.some((model) => model.installed)) needs.push("a Kokoro voice model");
        setMissing(needs);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    try { if (voice) localStorage.setItem(TALK_VOICE_STORAGE_KEY, voice); } catch (_) {}
  }, [voice]);

  const stopPlayback = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
    }
    finishPlaybackRef.current?.();
    finishPlaybackRef.current = null;
  };

  const playClip = (clip) => new Promise((resolve, reject) => {
    const audio = audioRef.current;
    if (!audio || !clip?.url) { resolve(); return; }
    const done = () => {
      audio.onended = null;
      audio.onerror = null;
      finishPlaybackRef.current = null;
      resolve();
    };
    finishPlaybackRef.current = done;
    audio.onended = done;
    audio.onerror = () => { done(); reject(new Error("The voice clip could not be played.")); };
    audio.src = clip.url;
    audio.play().catch((err) => { done(); if (err.name !== "AbortError") reject(err); });
  });

  // Barge-in: silence the current reply and stop generating it
  const interrupt = () => {
    turnRef.current += 1;
    pipelineRef.current?.cancel();
    pipelineRef.current = null;
    stopPlayback();
    onStopGeneration?.();
  };

  // Release the mic and the speaker if chat leaves talk mode mid-turn
  useEffect(() => () => {
    turnRef.current += 1;
    recorderRef.current?.cancel().catch(() => {});
    recorderRef.current = null;
    pipelineRef.current?.cancel();
    stopPlayback();
  }, []);

  const startListening = async () => {
    if (disabled || holdingRef.current) return;
    holdingRef.current = true;
    interrupt();
    try {
      const recorder = await createMicRecorder();
      if (!holdingRef.current) {
        await recorder.cancel();
        return;
      }
      recorderRef.current = recorder;
      setState(TALK_STATE.LISTENING);
    } catch (err) {
      holdingRef.current = false;
      setState(TALK_STATE.IDLE);
      showAlert?.({ title: "Microphone unavailable", message: err.message || String(err), danger: true });
    }
  };

  const finishListening = async () => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) return;
    const turn = turnRef.current;
    setState(TALK_STATE.TRANSCRIBING);
    try {
      const wav = await recorder.stop();
      const result = await transcribeSpeech(wav, {
        language: TALK_TRANSCRIBE_LANGUAGE,
        filename: TALK_RECORDING_FILENAME,
        save: false,
      });
      if (turn !== turnRef.current) return;
      const spoken = String(result?.text || "").replace(/\s+/g, " ").trim();
      if (!spoken) {
        setState(TALK_STATE.IDLE);
        showAlert?.({ title: "Didn't catch that", message: "No speech was heard. Try again a little closer to the mic." });
        return;
      }

      setState(TALK_STATE.THINKING);
      const chunker = createSpeechChunker();
      const pipeline = createSpeechPipeline({
        synthesize: (text) => speakTts(text, { voice: voiceRef.current || undefined }),
        play: (clip) => {
          if (turn === turnRef.current) setState(TALK_STATE.SPEAKING);
          return playClip(clip);
        },
        stop: stopPlayback,
        // Talk replies are throwaway audio; keep them out of the Voice screen's history
        discard: (clip) => { if (clip?.filename) deleteTtsOutput(clip.filename).catch(() => {}); },
        onError: (err) => showAlert?.({ title: "Couldn't speak the reply", message: err.message || String(err), danger: true }),
      });
      pipelineRef.current = pipeline;

      const reply = await onSendRef.current(spoken, {
        onContent: (content) => chunker.push(content).forEach((text) => pipeline.enqueue(text)),
      });
      chunker.flush(reply || "").forEach((text) => pipeline.enqueue(text));
      await pipeline.drained();
    } catch (err) {
      if (turn === turnRef.current) {
        showAlert?.({ title: "Talk mode stopped", message: err.message || String(err), danger: true });
      }
    } finally {
      if (turn === turnRef.current) {
        pipelineRef.current = null;
        setState(TALK_STATE.IDLE);
      }
    }
  };

  const busy = state === TALK_STATE.TRANSCRIBING || state === TALK_STATE.THINKING;
  const listening = state === TALK_STATE.LISTENING;

  return (
    <div className="talk-mode" aria-live="polite">
      <button
        type="button"
        className={`talk-mode-ptt ${listening ? "listening" : ""}`}
        disabled={disabled}
        aria-pressed={listening}
        aria-label={listening ? "Release to send" : "Hold to talk"}
        title="Hold to talk. Pressing again interrupts the reply."
        onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); startListening(); }}
        onPointerUp={finishListening}
        onPointerCancel={finishListening}
        onKeyDown={(event) => {
          if ((event.key === " " || event.key === "Enter") && !event.repeat) { event.preventDefault(); startListening(); }
        }}
        onKeyUp={(event) => {
          if (event.key === " " || event.key === "Enter") { event.preventDefault(); finishListening(); }
        }}
      >
        {busy ? <LoaderCircle size={22} className="talk-mode-spin" aria-hidden="true" /> : <Mic size={22} aria-hidden="true" />}
      </button>

      <div className="talk-mode-body">
        <span className="talk-mode-status">
          {missing.length > 0
            ? `Talk mode needs ${missing.join(" and ")}. Get them on the Models screen.`
            : STATUS_TEXT[state]}
        </span>
        {voices.length > 0 && (
          <label className="talk-mode-voice">
            <span>Voice</span>
            <select value={voice} onChange={(event) => setVoice(event.target.value)} disabled={listening}>
              {voices.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {state === TALK_STATE.SPEAKING && (
        <button type="button" className="chat-composer-stop-btn" onClick={() => { interrupt(); setState(TALK_STATE.IDLE); }} aria-label="Stop speaking" title="Stop speaking">
          <Square size={14} fill="currentColor" />
        </button>
      )}
      <audio ref={audioRef} hidden />
    </div>
  );
}
