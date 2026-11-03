// Speech-to-text (Whisper) API routes.
// Moved verbatim from the request handler in serve.cjs. Mutable server state
// (ports, process handles, settings, progress) is read and written via ctx.state.
const fs = require("fs");
const path = require("path");
const { pathInside, readBinaryBody, readJsonBody, json } = require("../http-helpers.cjs");
const { createRouteTable } = require("../route-table.cjs");

module.exports = function createSpeechRoutes(ctx) {
  const { state, PREFERRED_SPEECH_PORT, SPEECH_MODELS, SPEECH_MODEL_CATALOG, TRANSCRIPTIONS,
    getSpeechBackend, getSpeechModels, jsonErrorStatus, listTranscriptions,
    runExclusiveSpeechOperation, startModelDownload, startSpeech, stopSpeech, streamModelUpload,
    transcribeWavBuffer } = ctx;
  const { routes, exact, prefix } = createRouteTable();

  exact("GET", "/api/speech/status", async (req, res) => {
    const backend = getSpeechBackend();
    return json(res, 200, {
      ok: true,
      ready: state.speechReady,
      running: state.speechReady,
      port: state.PORT_SPEECH,
      preferredPort: PREFERRED_SPEECH_PORT,
      backendInstalled: Boolean(backend.cli),
      backendPath: backend.cli || "",
      serverPath: backend.server || "",
      backendMode: backend.mode,
      backendPreference: backend.preference,
      backends: backend.candidates,
      error: state.speechError,
      settings: state.speechSettings,
      transcription: state.speechTranscriptionState,
    });
  });

  exact("GET", "/api/speech/models", async (req, res) => {
    return json(res, 200, { ok: true, models: getSpeechModels() });
  });

  exact("POST", "/api/speech/start", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      await runExclusiveSpeechOperation(() => startSpeech(body));
      return json(res, 200, { ok: true, ready: state.speechReady, settings: state.speechSettings, port: state.PORT_SPEECH });
    } catch (err) {
      state.speechError = err.message || String(err);
      return json(res, jsonErrorStatus(err), { ok: false, error: state.speechError, code: err.code || "", activeRuntime: err.activeRuntime || null });
    }
  });

  exact("POST", "/api/speech/stop", async (req, res) => {
    await stopSpeech();
    return json(res, 200, { ok: true });
  });

  prefix("POST", "/api/speech/transcribe", async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    try {
      const audio = await readBinaryBody(req);
      const result = await runExclusiveSpeechOperation(() => transcribeWavBuffer(audio, {
        model: parsed.searchParams.get("model") || state.speechSettings.model,
        language: parsed.searchParams.get("language") || "auto",
        filename: parsed.searchParams.get("filename") || req.headers["x-filename"] || "recording.wav",
        threads: parsed.searchParams.get("threads") || state.speechSettings.threads,
        backendPreference: parsed.searchParams.get("backendPreference") || state.speechSettings.backendPreference,
        translate: parsed.searchParams.get("translate") === "true",
        save: parsed.searchParams.get("save") !== "false",
      }));
      return json(res, 200, { ok: true, transcription: result });
    } catch (err) {
      state.speechError = err.message || String(err);
      return json(res, err.message?.includes("too large") ? 413 : 500, { ok: false, error: state.speechError });
    }
  });

  exact("POST", "/api/speech/download-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (state.downloadState.active) return json(res, 409, { ok: false, error: "Another model download is already active." });
    const modelId = String(body.modelId || body.model_id || body.model || "");
    const catalogModel = SPEECH_MODEL_CATALOG.find((model) => model.id === modelId || model.filename === modelId);
    const url = body.url ? String(body.url) : (catalogModel ? `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${catalogModel.filename}` : "");
    const filename = path.basename(String(body.filename || catalogModel?.filename || ""));
    if (!url || !filename || !filename.toLowerCase().endsWith(".bin")) {
      return json(res, 400, { ok: false, error: "A speech model .bin URL or catalog model id is required." });
    }
    startModelDownload(url, filename, SPEECH_MODELS, "speech");
    return json(res, 200, { ok: true, message: "Speech model download started", filename });
  });

  prefix("POST", "/api/speech/import-model", async (req, res) => {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await streamModelUpload(req, parsed.searchParams.get("filename"), SPEECH_MODELS, "speech");
      return json(res, 200, { ok: true, message: `Imported ${result.filename}`, model: result });
    } catch (err) {
      console.error("  [api] Failed to import speech model:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  exact("POST", "/api/speech/delete-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    const modelPath = path.join(SPEECH_MODELS, filename);
    if (!filename || !pathInside(modelPath, SPEECH_MODELS)) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    if (state.speechSettings.model === filename) await stopSpeech();
    try {
      fs.unlinkSync(modelPath);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, err.code === "ENOENT" ? 404 : 500, { ok: false, error: err.code === "ENOENT" ? "Speech model not found" : err.message });
    }
  });

  exact("GET", "/api/speech/transcriptions", async (req, res) => {
    return json(res, 200, { ok: true, transcriptions: listTranscriptions() });
  });

  exact("POST", "/api/speech/delete-transcription", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    if (!filename || !filename.endsWith(".json")) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    const jsonPath = path.join(TRANSCRIPTIONS, filename);
    if (!pathInside(jsonPath, TRANSCRIPTIONS)) {
      return json(res, 400, { ok: false, error: "Invalid path" });
    }
    try {
      if (!fs.existsSync(jsonPath)) {
        return json(res, 404, { ok: false, error: "Transcription metadata not found" });
      }
      
      const metadata = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const textFile = metadata.textFile ? path.basename(String(metadata.textFile)) : "";
      
      fs.unlinkSync(jsonPath);
      
      if (textFile) {
        const textPath = path.join(TRANSCRIPTIONS, textFile);
        if (pathInside(textPath, TRANSCRIPTIONS) && fs.existsSync(textPath)) {
          fs.unlinkSync(textPath);
        }
      }
      
      return json(res, 200, { ok: true });
    } catch (err) {
      console.error("  [api] Failed to delete transcription:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  return routes;
};
