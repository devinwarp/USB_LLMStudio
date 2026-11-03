// Text-to-speech (Kokoro) API routes.
// Moved verbatim from the request handler in serve.cjs. Mutable server state
// (ports, process handles, settings, progress) is read and written via ctx.state.
const fs = require("fs");
const path = require("path");
const { pathInside, readJsonBody, json } = require("../http-helpers.cjs");
const { createRouteTable } = require("../route-table.cjs");

module.exports = function createTtsRoutes(ctx) {
  const { state, PREFERRED_TTS_PORT, TTS_MODELS, TTS_OUTPUTS, TTS_VOICES, getTtsModels,
    getTtsRuntimeStatus, installTtsCatalogModel, jsonErrorStatus, listTtsOutputs,
    runExclusiveTtsOperation, startTts, stopTts, streamModelUpload, synthesizeTts } = ctx;
  const { routes, exact, prefix } = createRouteTable();

  exact("GET", "/api/tts/status", async (req, res) => {
    const runtime = getTtsRuntimeStatus();
    return json(res, 200, {
      ok: true,
      ready: state.ttsReady,
      running: state.ttsReady,
      port: state.PORT_TTS,
      preferredPort: PREFERRED_TTS_PORT,
      runtimeInstalled: runtime.installed,
      runtimePath: runtime.runtime,
      workerPath: runtime.worker,
      cachePath: runtime.cache,
      backendMode: runtime.backendMode,
      error: state.ttsError,
      settings: state.ttsSettings,
      generation: state.ttsGenerationState,
      voices: TTS_VOICES,
    });
  });

  exact("GET", "/api/tts/models", async (req, res) => {
    return json(res, 200, { ok: true, models: getTtsModels(), voices: TTS_VOICES });
  });

  exact("POST", "/api/tts/start", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      await runExclusiveTtsOperation(() => startTts(body));
      return json(res, 200, { ok: true, ready: state.ttsReady, settings: state.ttsSettings, port: state.PORT_TTS });
    } catch (err) {
      state.ttsError = err.message || String(err);
      return json(res, jsonErrorStatus(err), { ok: false, error: state.ttsError, code: err.code || "", activeRuntime: err.activeRuntime || null });
    }
  });

  exact("POST", "/api/tts/stop", async (req, res) => {
    await stopTts();
    return json(res, 200, { ok: true });
  });

  exact("POST", "/api/tts/speak", async (req, res) => {
    const body = await readJsonBody(req, res, 512 * 1024);
    if (!body) return;
    try {
      if (!state.ttsReady || (body.model && state.ttsSettings.model !== body.model)) {
        await runExclusiveTtsOperation(() => startTts(body));
      }
      const output = await runExclusiveTtsOperation(() => synthesizeTts(body.text, body));
      return json(res, 200, { ok: true, output });
    } catch (err) {
      state.ttsError = err.message || String(err);
      return json(res, jsonErrorStatus(err), { ok: false, error: state.ttsError, code: err.code || "", activeRuntime: err.activeRuntime || null });
    }
  });

  exact("POST", "/api/tts/download-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const model = installTtsCatalogModel(body.modelId || body.model_id || body.model || body.filename);
      return json(res, 200, { ok: true, message: "TTS model manifest installed", filename: model.filename, model });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  });

  prefix("POST", "/api/tts/import-model", async (req, res) => {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await streamModelUpload(req, parsed.searchParams.get("filename"), TTS_MODELS, "tts");
      return json(res, 200, { ok: true, message: `Imported ${result.filename}`, model: result });
    } catch (err) {
      console.error("  [api] Failed to import TTS model:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  exact("POST", "/api/tts/delete-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    const modelPath = path.join(TTS_MODELS, filename);
    if (!filename || !filename.endsWith(".json") || !pathInside(modelPath, TTS_MODELS)) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    if (state.ttsSettings.model === filename) await stopTts();
    try {
      fs.unlinkSync(modelPath);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, err.code === "ENOENT" ? 404 : 500, { ok: false, error: err.code === "ENOENT" ? "TTS model not found" : err.message });
    }
  });

  exact("GET", "/api/tts/outputs", async (req, res) => {
    return json(res, 200, { ok: true, outputs: listTtsOutputs() });
  });

  exact("POST", "/api/tts/delete-output", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    if (!filename || !filename.endsWith(".json")) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    const jsonPath = path.join(TTS_OUTPUTS, filename);
    if (!pathInside(jsonPath, TTS_OUTPUTS)) {
      return json(res, 400, { ok: false, error: "Invalid path" });
    }
    try {
      if (!fs.existsSync(jsonPath)) {
        return json(res, 404, { ok: false, error: "TTS output metadata not found" });
      }
      const metadata = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const audioFile = metadata.audioFile ? path.basename(String(metadata.audioFile)) : "";
      fs.unlinkSync(jsonPath);
      if (audioFile) {
        const audioPath = path.join(TTS_OUTPUTS, audioFile);
        if (pathInside(audioPath, TTS_OUTPUTS) && fs.existsSync(audioPath)) {
          fs.unlinkSync(audioPath);
        }
      }
      return json(res, 200, { ok: true });
    } catch (err) {
      console.error("  [api] Failed to delete TTS output:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  return routes;
};
