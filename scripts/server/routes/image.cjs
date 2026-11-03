// Image backend (stable-diffusion.cpp / OpenVINO) lifecycle and generation API routes.
// Moved verbatim from the request handler in serve.cjs. Mutable server state
// (ports, process handles, settings, progress) is read and written via ctx.state.
const path = require("path");
const { readJsonBody, json } = require("../http-helpers.cjs");
const { createRouteTable } = require("../route-table.cjs");

module.exports = function createImageRoutes(ctx) {
  const { state, MODELS, PREFERRED_BACKEND_PORT, SERVER_BUILD, appleNpuRuntimeMatches,
    assertNoOtherActiveRuntime, backendSettingsMatch, findAvailableBackendPort,
    generateWithOpenVino, getCoreMLPythonPath, getDefaultModel, jsonErrorStatus, killBackend,
    killOpenVinoWorker, startBackend, startImageBackendDownload } = ctx;
  const { routes, exact } = createRouteTable();

  // GET /api/backend-status
  exact("GET", "/api/backend-status", async (req, res) => {
    return json(res, 200, {
      ready: state.backendReady || state.openvinoReady,
      running: state.backendProc !== null || state.openvinoProc !== null,
      port: state.PORT_BACKEND,
      preferredPort: PREFERRED_BACKEND_PORT,
      error: state.backendError,
      loading: state.backendLoadState,
      unloading: state.backendUnloadState,
      settings: state.currentSettings,
      build: SERVER_BUILD,
    });
  });

  // POST /api/restart-backend: restart with new settings
  exact("POST", "/api/restart-backend", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    console.log("  [api] Restart backend request:", body);
    const newSettings = {};
    if (body.model)    newSettings.model    = body.backend_type === "openvino-npu" ? String(body.model) : path.join(MODELS, body.model);
    if (body.steps)    newSettings.steps    = parseInt(body.steps);
    if (body.cfgScale) newSettings.cfgScale = parseFloat(body.cfgScale);
    if (body.sampler)  newSettings.sampler  = body.sampler;
    if (body.threads)  newSettings.threads  = parseInt(body.threads);
    if (body.width)    newSettings.width    = parseInt(body.width);
    if (body.height)   newSettings.height   = parseInt(body.height);
    if (typeof body.use_gpu === "boolean") newSettings.useGpu = body.use_gpu;
    if (body.backend_type) {
      newSettings.backendType = String(body.backend_type);
      newSettings.useGpu = body.backend_type !== "cpu";
    }
    if (typeof body.vae_tiling === "boolean") newSettings.vaeTiling = body.vae_tiling;
    if (typeof body.vae_on_cpu === "boolean") newSettings.vaeOnCpu = body.vae_on_cpu;
    if (typeof body.flash_attn === "boolean") newSettings.flashAttn = body.flash_attn;
    try {
      const targetModel = newSettings.model || state.currentSettings.model || getDefaultModel();
      assertNoOtherActiveRuntime("image", targetModel);
      const requestedSettings = { ...state.currentSettings, ...newSettings, model: targetModel };
      const imageBackendReady = (state.backendReady && state.backendProc) || (state.openvinoReady && state.openvinoProc);
      if (imageBackendReady && backendSettingsMatch(state.currentSettings, requestedSettings)) {
        return json(res, 200, { ok: true, message: "Backend already running with requested settings.", settings: state.currentSettings, port: state.PORT_BACKEND });
      }
      if (state.generationState.active) {
        return json(res, 409, {
          ok: false,
          error: "Image generation is in progress. Wait for it to finish or cancel it before changing backend settings.",
        });
      }
      if (state.backendReady && state.backendProc && appleNpuRuntimeMatches(state.currentSettings, requestedSettings)) {
        state.currentSettings = requestedSettings;
        return json(res, 200, { ok: true, message: "Apple NPU backend already running; updated generation defaults.", settings: state.currentSettings, port: state.PORT_BACKEND });
      }
      await killBackend();
      await new Promise(r => setTimeout(r, 500));
      if (newSettings.backendType === "openvino-npu") {
        startBackend(newSettings).catch((err) => {
          state.backendError = err.message || String(err);
          state.backendLoadState = {
            ...state.backendLoadState,
            active: false,
            phase: "OpenVINO NPU model load failed",
          };
          console.error("  [openvino-npu] Startup failed:", state.backendError);
        });
        return json(res, 200, { ok: true, message: "OpenVINO NPU backend starting...", settings: state.currentSettings, port: state.PORT_BACKEND });
      }
      if (newSettings.backendType === "apple-npu") {
        const backendPort = await findAvailableBackendPort();
        state.PORT_BACKEND = backendPort;
        newSettings.backendPort = backendPort;
        state.currentSettings = { ...state.currentSettings, ...newSettings };
        state.backendLoadState = {
          active: true,
          phase: "Starting Apple NPU backend...",
          progress: 1,
          current: 0,
          total: 0,
          speed: "",
          model: path.basename(newSettings.model || targetModel),
          backendMode: "Apple NPU",
          backendBinary: path.basename(getCoreMLPythonPath()),
          device: "",
        };
        startBackend(newSettings).catch((err) => {
          state.backendError = err.message || String(err);
          state.backendLoadState = {
            ...state.backendLoadState,
            active: false,
            phase: "Apple NPU model load failed",
          };
          console.error("  [coreml-npu] Startup failed:", state.backendError);
        });
        return json(res, 200, { ok: true, message: "Apple NPU backend starting...", settings: { ...state.currentSettings, ...newSettings }, port: backendPort });
      }
      await startBackend(newSettings);
      return json(res, 200, { ok: true, message: "Backend restarting...", settings: state.currentSettings, port: state.PORT_BACKEND });
    } catch (err) {
      state.backendError = err.message || String(err);
      return json(res, jsonErrorStatus(err), { ok: false, error: state.backendError, code: err.code || "", activeRuntime: err.activeRuntime || null, port: state.PORT_BACKEND });
    }
  });

  // POST /api/stop-backend
  exact("POST", "/api/stop-backend", async (req, res) => {
    await killBackend();
    await killOpenVinoWorker();
    return json(res, 200, { ok: true });
  });

  // POST /api/download-backend
  exact("POST", "/api/download-backend", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (state.downloadState.active) return json(res, 409, { ok: false, error: "Another download is already active." });
    try {
      const backendId = String(body.backend_id || body.backendId || body.id || "");
      await startImageBackendDownload(backendId);
      return json(res, 200, { ok: true, message: "Backend download started", backendId });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message || String(err) });
    }
  });

  // GET /api/generation-progress
  exact("GET", "/api/generation-progress", async (req, res) => {
    return json(res, 200, {
      ...state.generationState,
      backendMode: state.generationState.backendMode || state.currentSettings.backendMode || "",
      backendDevice: state.generationState.backendDevice || state.currentSettings.backendDevice || "",
    });
  });

  exact("POST", "/api/openvino-generate", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      return json(res, 200, await generateWithOpenVino(body));
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  });

  return routes;
};
