// Generated outputs and TTS audio files API routes.
// Moved verbatim from the request handler in serve.cjs. Mutable server state
// (ports, process handles, settings, progress) is read and written via ctx.state.
const fs = require("fs");
const path = require("path");
const { MIME, pathInside, readJsonBody, json } = require("../http-helpers.cjs");
const { createRouteTable } = require("../route-table.cjs");

module.exports = function createOutputsRoutes(ctx) {
  const { OUTPUTS, TTS_OUTPUTS, deleteGeneratedOutputs, ensureBrowserCompatibleTtsWav,
    listGeneratedOutputs, saveGeneratedOutput } = ctx;
  const { routes, exact, prefix } = createRouteTable();

  // GET /api/outputs
  exact("GET", "/api/outputs", async (req, res) => {
    return json(res, 200, { outputs: listGeneratedOutputs() });
  });

  // GET /api/output-file?filename=...
  prefix("GET", "/api/output-file", async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const filename = path.basename(parsed.searchParams.get("filename") || "");
    const filePath = path.join(OUTPUTS, filename);
    if (!filename || !fs.existsSync(filePath)) {
      return json(res, 404, { error: "Output file not found" });
    }
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (err, data) => {
      if (err) return json(res, 500, { error: err.message });
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Access-Control-Allow-Origin": "*" });
      res.end(data);
    });
    return;
  });

  prefix("GET", "/tts-outputs/", async (req, res) => {
    const filename = path.basename(decodeURIComponent(req.url.replace(/^\/tts-outputs\//, "").split("?")[0] || ""));
    const filePath = path.join(TTS_OUTPUTS, filename);
    if (!filename || !pathInside(filePath, TTS_OUTPUTS) || !fs.existsSync(filePath)) {
      return json(res, 404, { ok: false, error: "TTS output not found" });
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".wav") ensureBrowserCompatibleTtsWav(filePath);
    const stat = fs.statSync(filePath);
    const contentType = MIME[ext] || "application/octet-stream";
    const range = req.headers.range;

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        res.writeHead(416, {
          "Content-Range": `bytes */${stat.size}`,
          "Accept-Ranges": "bytes",
          "Access-Control-Allow-Origin": "*",
        });
        res.end();
        return;
      }

      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : stat.size - 1;
      if (!match[1] && match[2]) {
        const suffixLength = Math.min(Number(match[2]) || 0, stat.size);
        start = stat.size - suffixLength;
        end = stat.size - 1;
      }

      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= stat.size || start > end) {
        res.writeHead(416, {
          "Content-Range": `bytes */${stat.size}`,
          "Accept-Ranges": "bytes",
          "Access-Control-Allow-Origin": "*",
        });
        res.end();
        return;
      }

      res.writeHead(206, {
        "Content-Type": contentType,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  });

  // POST /api/save-output
  exact("POST", "/api/save-output", async (req, res) => {
    try {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const saved = saveGeneratedOutput(body.image, body.metadata || {});
      return json(res, 200, { ok: true, output: { ...saved, url: `/api/output-file?filename=${encodeURIComponent(saved.image)}` } });
    } catch (err) {
      console.error("  [api] Failed to save output:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  // POST /api/delete-outputs
  exact("POST", "/api/delete-outputs", async (req, res) => {
    try {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const deleted = deleteGeneratedOutputs(body.outputs || []);
      return json(res, 200, { ok: true, deleted });
    } catch (err) {
      console.error("  [api] Failed to delete outputs:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  return routes;
};
