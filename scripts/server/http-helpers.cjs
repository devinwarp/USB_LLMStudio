// Shared HTTP helpers for serve.cjs and the route modules in ./routes.
// Moved verbatim from serve.cjs; they depend only on Node built-ins.
const path = require("path");

const MAX_JSON_BODY_BYTES = 64 * 1024 * 1024;

function pathInside(childPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

// Uploads arrive as 16 kHz mono WAV (the browser converts other formats), about 115 MB
// per hour, so 1 GB allows roughly 9 hours of audio.
function readBinaryBody(req, limitBytes = 1024 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limitBytes) {
        reject(new Error(`Audio file is too large. Limit is ${Math.round(limitBytes / (1024 * 1024))} MB.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript",
  ".css":  "text/css",  ".png": "image/png",
  ".jpg":  "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico":  "image/x-icon", ".json": "application/json", ".wav": "audio/wav", ".txt": "text/plain",
  ".woff2":"font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    req.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_JSON_BODY_BYTES) {
        reject(new Error(`Request body is too large. Limit is ${Math.round(MAX_JSON_BODY_BYTES / (1024 * 1024))} MB.`));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end",  () => { try { resolve(JSON.parse(data || "{}")); } catch(e) { reject(new Error("Invalid JSON request body")); } });
    req.on("error", reject);
  });
}

async function readJsonBody(req, res) {
  try {
    return await readBody(req);
  } catch (err) {
    json(res, err.message.includes("too large") ? 413 : 400, { ok: false, error: err.message });
    return null;
  }
}

function safeOutputName(value) {
  return String(value || "")
    .replace(/[^a-z0-9._-]/gi, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

// Pages on other websites must not drive this API: it has no login, so only
// loopback origins (or non-browser clients that send no Origin header) are allowed.
function requestOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol === "tauri:" || hostname === "tauri.localhost") return true;
    if (protocol !== "http:" && protocol !== "https:") return false;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch (_) {
    return false;
  }
}

module.exports = {
  MAX_JSON_BODY_BYTES,
  MIME,
  pathInside,
  readBinaryBody,
  readBody,
  readJsonBody,
  safeOutputName,
  json,
  requestOriginAllowed,
};
