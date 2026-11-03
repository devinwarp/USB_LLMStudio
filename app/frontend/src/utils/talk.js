// Talk mode: push-to-talk voice loop (mic -> Whisper -> LLM -> Kokoro).
// Pure helpers only (no React, no fetch) so scripts/tests can import them directly.

export const TALK_STATE = Object.freeze({
  IDLE: "idle",
  LISTENING: "listening",
  TRANSCRIBING: "transcribing",
  THINKING: "thinking",
  SPEAKING: "speaking",
});

// Must match the text limit enforced by synthesizeTts in scripts/server/serve.cjs.
export const TTS_MAX_TEXT_CHARS = 5000;

// Every /api/tts/speak call starts a fresh Kokoro worker that loads the voice model,
// so the reply is spoken in a few sentence groups instead of one call per sentence.
// The first group is short so the first audio arrives quickly.
export const TALK_FIRST_CHUNK_MIN_CHARS = 40;
export const TALK_CHUNK_MIN_CHARS = 220;
export const TALK_CHUNK_MAX_CHARS = Math.min(900, TTS_MAX_TEXT_CHARS);

// Whisper picks the language itself; the Voice screen's dictation does the same.
export const TALK_TRANSCRIBE_LANGUAGE = "auto";
export const TALK_RECORDING_FILENAME = "talk.wav";
export const TALK_VOICE_STORAGE_KEY = "talkModeVoice";

const CODE_FENCE = "```";
// Sentence ends (Latin, CJK and Arabic punctuation) followed by whitespace, or a blank line.
const SENTENCE_BOUNDARY = /[.!?。！？؟]+["')\]]*(?=\s)|\n\s*\n/g;

const countFences = (text) => text.split(CODE_FENCE).length - 1;

// Turns markdown-ish model output into text worth reading aloud.
export function stripForSpeech(text) {
  return String(text || "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Feeds the growing assistant reply in and hands back speakable groups of sentences.
// push(fullText) takes the whole reply so far; flush(fullText) returns what is left.
export function createSpeechChunker({
  firstMinChars = TALK_FIRST_CHUNK_MIN_CHARS,
  minChars = TALK_CHUNK_MIN_CHARS,
  maxChars = TALK_CHUNK_MAX_CHARS,
} = {}) {
  let consumed = 0;
  let emitted = 0;

  const emit = (raw, out) => {
    const spoken = stripForSpeech(raw);
    if (spoken) {
      out.push(spoken.slice(0, TTS_MAX_TEXT_CHARS));
      emitted += 1;
    }
  };

  const nextCut = (pending) => {
    const min = emitted === 0 ? firstMinChars : minChars;
    SENTENCE_BOUNDARY.lastIndex = 0;
    let match;
    while ((match = SENTENCE_BOUNDARY.exec(pending))) {
      const end = match.index + match[0].length;
      if (end > maxChars) break;
      // Never cut inside an open code block
      if (end >= min && countFences(pending.slice(0, end)) % 2 === 0) return end;
    }
    if (pending.length > maxChars && countFences(pending.slice(0, maxChars)) % 2 === 0) {
      const space = pending.lastIndexOf(" ", maxChars);
      return space > min ? space : maxChars;
    }
    return -1;
  };

  return {
    push(fullText) {
      const out = [];
      const text = String(fullText || "");
      for (;;) {
        const pending = text.slice(consumed);
        const cut = nextCut(pending);
        if (cut <= 0) break;
        emit(pending.slice(0, cut), out);
        consumed += cut;
      }
      return out;
    },
    flush(fullText) {
      const out = this.push(fullText);
      const rest = String(fullText || "").slice(consumed);
      consumed += rest.length;
      for (let start = 0; start < rest.length; start += TTS_MAX_TEXT_CHARS) {
        emit(rest.slice(start, start + TTS_MAX_TEXT_CHARS), out);
      }
      return out;
    },
  };
}

// Synthesizes queued text in order and plays each clip as soon as the one before it ends,
// so clip N+1 is generated while clip N plays. cancel() is barge-in: queued text is dropped,
// playback stops, and a clip still being generated is discarded when it arrives
// (the server cannot stop a Kokoro worker mid-run).
export function createSpeechPipeline({ synthesize, play, stop = () => {}, discard = () => {}, onError = () => {} }) {
  let cancelled = false;
  let synthChain = Promise.resolve();
  let playChain = Promise.resolve();

  return {
    enqueue(text) {
      if (cancelled || !text) return;
      const clip = synthChain.then(() => (cancelled ? null : synthesize(text)));
      synthChain = clip.catch(() => {});
      playChain = playChain.then(async () => {
        let ready;
        try {
          ready = await clip;
        } catch (err) {
          if (!cancelled) onError(err);
          return;
        }
        if (!ready) return;
        try {
          if (!cancelled) await play(ready);
        } catch (err) {
          if (!cancelled) onError(err);
        } finally {
          discard(ready);
        }
      });
    },
    // Resolves once everything queued so far has been played (or dropped).
    drained() {
      return playChain;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      stop();
    },
    get cancelled() {
      return cancelled;
    },
  };
}
