// System, health, diagnostics and hardware API routes.
// Moved verbatim from the request handler in serve.cjs. Mutable server state
// (ports, process handles, settings, progress) is read and written via ctx.state.
const { readJsonBody, json } = require("../http-helpers.cjs");
const { createRouteTable } = require("../route-table.cjs");

module.exports = function createSystemRoutes(ctx) {
  const { state, cleanupSelected, getBackendOptions, getCleanupCandidates, getHardwareSpecs,
    getHealth, getSpeechBackend, getTelemetry } = ctx;
  const { routes, exact } = createRouteTable();

  // ── Management API ────────────────────────────────────────────────────────
  // GET /api/health
  exact("GET", "/api/health", async (req, res) => {
    return json(res, 200, await getHealth());
  });

  // GET /api/diagnostics
  exact("GET", "/api/diagnostics", async (req, res) => {
    return json(res, 200, {
      generatedAt: new Date().toISOString(),
      health: await getHealth(),
      cleanupCandidates: getCleanupCandidates(),
      download: state.downloadState,
      generation: state.generationState,
      llm: {
        ready: state.llmReady,
        running: state.llmProc !== null,
        error: state.llmError,
        settings: state.llmSettings,
        port: state.PORT_LLM,
      },
      speech: {
        ready: state.speechReady,
        error: state.speechError,
        settings: state.speechSettings,
        backend: getSpeechBackend(),
        transcription: state.speechTranscriptionState,
      },
      hardware: getHardwareSpecs(),
      telemetry: getTelemetry(),
    });
  });

  // GET /api/cleanup-candidates
  exact("GET", "/api/cleanup-candidates", async (req, res) => {
    return json(res, 200, { candidates: getCleanupCandidates() });
  });

  // POST /api/cleanup
  exact("POST", "/api/cleanup", async (req, res) => {
    try {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const deleted = cleanupSelected(Array.isArray(body.ids) ? body.ids : []);
      return json(res, 200, { ok: true, deleted });
    } catch (err) {
      console.error("  [api] Cleanup failed:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  // GET /api/hardware-specs
  exact("GET", "/api/hardware-specs", async (req, res) => {
    return json(res, 200, getHardwareSpecs());
  });

  // GET /api/backend-options
  exact("GET", "/api/backend-options", async (req, res) => {
    return json(res, 200, getBackendOptions());
  });

  // GET /api/telemetry
  exact("GET", "/api/telemetry", async (req, res) => {
    return json(res, 200, getTelemetry());
  });

  return routes;
};
