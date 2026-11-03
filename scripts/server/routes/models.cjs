// Model library: list, download, import, move, link and delete API routes.
// Moved verbatim from the request handler in serve.cjs. Mutable server state
// (ports, process handles, settings, progress) is read and written via ctx.state.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { detectModelKindCached } = require("../model-kind.cjs");
const { pathInside, readJsonBody, json } = require("../http-helpers.cjs");
const { createRouteTable } = require("../route-table.cjs");

module.exports = function createModelsRoutes(ctx) {
  const { state, IMAGE_BACKEND_DOWNLOADS, LLM_MODELS, MODELS, OPENVINO_MODELS, SPEECH_MODELS,
    addHuggingFaceFileSize, cancelModelDownload, describeLinkedModel, findOpenVinoModel,
    getLlmModels, getModelDownloadUrlIssue, getModelInfo, getOpenVinoModelInfo, getOpenVinoNpuInfo,
    isModelFile, killLlm, modelFolderFor, readdirVisible, resolveHuggingFaceProjector,
    searchHuggingFaceModels, startModelDownload, startOpenVinoModelDownload, streamModelUpload } = ctx;
  const { routes, exact, prefix } = createRouteTable();

  exact("GET", "/api/llm/models", async (req, res) => {
    return json(res, 200, { models: getLlmModels() });
  });

  prefix("GET", "/api/huggingface/models", async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const query = String(parsed.searchParams.get("query") || "").slice(0, 120);
    const filters = String(parsed.searchParams.get("filters") || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => ["vision", "uncensored"].includes(value));
    const page = Math.max(1, Math.min(20, Number(parsed.searchParams.get("page")) || 1));
    const pageSize = 9;
    try {
      const rankedModels = await searchHuggingFaceModels(query, [...new Set(filters)]);
      const start = (page - 1) * pageSize;
      const pageModels = rankedModels.slice(start, start + pageSize);
      const models = await Promise.all(pageModels.map(addHuggingFaceFileSize));
      return json(res, 200, {
        ok: true,
        source: "huggingface",
        models,
        page,
        hasMore: start + models.length < rankedModels.length,
      });
    } catch (err) {
      return json(res, 502, { ok: false, error: err.message || "Hugging Face search failed." });
    }
  });

  // GET /api/models: list available model files
  exact("GET", "/api/models", async (req, res) => {
    try {
      let files = readdirVisible(MODELS).filter(isModelFile).map(getModelInfo);
      if (state.downloadState.active && state.downloadState.filename) {
        files = files.filter(model => model.filename !== state.downloadState.filename);
      }
      return json(res, 200, { models: files });
    } catch (_) { return json(res, 200, { models: [] }); }
  });

  exact("GET", "/api/openvino-models", async (req, res) => {
    const npuInfo = getOpenVinoNpuInfo();
    return json(res, 200, {
      supported: npuInfo.supported,
      reason: npuInfo.reason || "",
      npu: npuInfo.npu || null,
      python: npuInfo.python || "",
      models: npuInfo.supported ? getOpenVinoModelInfo() : [],
    });
  });

  // POST /api/download-model
  exact("POST", "/api/download-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { url } = body;
    if (!url) return json(res, 400, { error: "URL is required" });
    // Catalog entries pass a filename for URLs that don't end in one (e.g. Civitai API links).
    const overrideFilename = body.filename ? path.basename(String(body.filename)) : null;
    if (overrideFilename && !/\.(safetensors|gguf|ckpt)$/i.test(overrideFilename)) {
      return json(res, 400, { ok: false, error: "Image model filename must end in .safetensors, .gguf or .ckpt." });
    }
    const urlIssue = overrideFilename
      ? (/^https?:\/\//i.test(String(url)) ? "" : "Only http(s) download URLs are supported.")
      : getModelDownloadUrlIssue(url);
    if (urlIssue) return json(res, 400, { ok: false, error: urlIssue });
    // startModelDownload only guards against concurrent downloads when no filename is passed.
    if (overrideFilename && state.downloadState.active) return json(res, 409, { ok: false, error: "Another model download is already active." });

    startModelDownload(url, overrideFilename);
    return json(res, 200, { ok: true, message: "Download started" });
  });

  exact("POST", "/api/llm/download-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const url = String(body.url || "");
    if (!url) return json(res, 400, { ok: false, error: "URL is required" });
    if (state.downloadState.active) return json(res, 409, { ok: false, error: "Another model download is already active." });
    try {
      const directUrl = url.includes("huggingface.co") ? url.replace("/blob/", "/resolve/") : url;
      const overrideFilename = body.filename ? path.basename(String(body.filename)) : null;
      const filename = overrideFilename || path.basename(new URL(directUrl).pathname);
      if (!filename.toLowerCase().endsWith(".gguf")) {
        return json(res, 400, { ok: false, error: "Text model URL must point to a .gguf file." });
      }
      const projector = body.projectorUrl && body.projectorFilename
        ? { url: String(body.projectorUrl), filename: path.basename(String(body.projectorFilename)) }
        : await resolveHuggingFaceProjector(directUrl, filename);
      startModelDownload(directUrl, filename, LLM_MODELS, "text");
      return json(res, 200, {
        ok: true,
        message: "Text model download started",
        filename,
        projectorUrl: projector?.url || "",
        projectorFilename: projector?.filename || "",
      });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message || String(err) });
    }
  });

  exact("POST", "/api/download-openvino-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const modelId = String(body.model_id || body.modelId || "");
    if (!modelId) return json(res, 400, { ok: false, error: "model_id is required" });
    try {
      startOpenVinoModelDownload(modelId);
      return json(res, 200, { ok: true, message: "OpenVINO model download started" });
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  });

  // GET /api/download-progress
  exact("GET", "/api/download-progress", async (req, res) => {
    if (!state.downloadState.active && state.downloadState.kind === "backend" && state.downloadState.backendId) {
      const backend = IMAGE_BACKEND_DOWNLOADS[state.downloadState.backendId];
      const installed = backend &&
        fs.existsSync(path.join(backend.destDir, backend.exeName)) &&
        fs.existsSync(path.join(backend.destDir, backend.requiredDll));
      if (installed && !state.downloadState.error) {
        state.cachedBackendOptions = null;
        state.downloadState = {
          active: false,
          filename: "",
          progress: 0,
          speed: "0 MB/s",
          eta: 0,
          totalBytes: 0,
          downloadedBytes: 0,
          error: null,
        };
      }
    }
    return json(res, 200, state.downloadState);
  });

  // POST /api/cancel-download
  exact("POST", "/api/cancel-download", async (req, res) => {
    const cancelled = cancelModelDownload();
    return json(res, 200, { ok: true, cancelled });
  });

  // POST /api/import-model?filename=...
  prefix("POST", "/api/import-model", async (req, res) => {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await streamModelUpload(req, parsed.searchParams.get("filename"));
      return json(res, 200, { ok: true, message: `Imported ${result.filename}`, model: result, filename: result.filename });
    } catch (err) {
      console.error("  [api] Failed to import model:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  prefix("POST", "/api/llm/import-model", async (req, res) => {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const result = await streamModelUpload(req, parsed.searchParams.get("filename"), LLM_MODELS, "text");
      return json(res, 200, { ok: true, message: `Imported ${result.filename}`, model: result });
    } catch (err) {
      console.error("  [api] Failed to import text model:", err);
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  exact("POST", "/api/llm/delete-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    const modelPath = path.join(LLM_MODELS, filename);
    if (!filename || !pathInside(modelPath, LLM_MODELS)) {
      return json(res, 400, { ok: false, error: "Invalid filename" });
    }
    if (state.llmSettings.model === filename && state.llmProc) await killLlm();
    try {
      fs.unlinkSync(modelPath);
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, err.code === "ENOENT" ? 404 : 500, {
        ok: false,
        error: err.code === "ENOENT" ? "Text model not found" : err.message,
      });
    }
  });

  // POST /api/move-model { filename, from, to }: refile a model under the right type (a text GGUF
  // sitting with the image models). Moving a linked model moves only the link.
  exact("POST", "/api/move-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.filename || ""));
    const fromDir = modelFolderFor(String(body.from || ""));
    const toDir = modelFolderFor(String(body.to || ""));
    if (!filename || !fromDir || !toDir || fromDir === toDir) {
      return json(res, 400, { ok: false, error: "Choose a model and where to move it." });
    }
    const loaded = (body.from === "image" && state.currentSettings.model === filename && state.backendProc)
      || (body.from === "text" && state.llmSettings.model === filename && state.llmProc)
      || (body.from === "speech" && state.speechSettings.model === filename && state.speechReady);
    if (loaded) return json(res, 409, { ok: false, error: "Unload the model before moving it." });
    const fromPath = path.join(fromDir, filename);
    const toPath = path.join(toDir, filename);
    if (!fs.existsSync(fromPath) && !describeLinkedModel(fromPath).linkedFrom) {
      return json(res, 404, { ok: false, error: "Model not found." });
    }
    if (fs.existsSync(toPath) || describeLinkedModel(toPath).linkedFrom) {
      return json(res, 409, { ok: false, error: `${filename} is already there.` });
    }
    try {
      fs.mkdirSync(toDir, { recursive: true });
      fs.renameSync(fromPath, toPath);
      state.cachedBackendOptions = null;
      console.log(`  [api] Moved model ${filename} from ${body.from} to ${body.to}`);
      return json(res, 200, { ok: true, filename });
    } catch (err) {
      return json(res, 500, { ok: false, error: `Couldn't move the model: ${err.message}` });
    }
  });

  // POST /api/pick-model-file { type }: open the system's own file dialog and return the chosen path.
  // The page can't learn a file's real location from a browser picker, but this server runs on the same machine.
  exact("POST", "/api/pick-model-file", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const extensions = { image: ["safetensors", "ckpt", "gguf"], text: ["gguf"], speech: ["bin"] }[String(body.type || "image")];
    if (!extensions) return json(res, 400, { ok: false, error: "Browsing is available for image, text and speech models." });
    const prompt = "Choose a model file to use from where it is";
    let command;
    let args;
    if (process.platform === "darwin") {
      // "activate" brings the dialog in front of the browser
      command = "osascript";
      args = ["-e", "activate", "-e", `POSIX path of (choose file with prompt ${JSON.stringify(prompt)})`];
    } else if (process.platform === "win32") {
      const filter = `Model files (${extensions.map((ext) => `*.${ext}`).join(", ")})|${extensions.map((ext) => `*.${ext}`).join(";")}`;
      command = "powershell";
      args = ["-NoProfile", "-STA", "-Command", [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$d = New-Object System.Windows.Forms.OpenFileDialog",
        `$d.Title = '${prompt}'`,
        `$d.Filter = '${filter}'`,
        "$f = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}",
        "if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.FileName) }",
      ].join("; ")];
    } else {
      command = "zenity";
      args = ["--file-selection", `--title=${prompt}`, `--file-filter=Model files | ${extensions.map((ext) => `*.${ext}`).join(" ")}`];
    }
    execFile(command, args, { timeout: 10 * 60 * 1000, windowsHide: false }, (err, stdout) => {
      const picked = String(stdout || "").trim();
      if (picked) return json(res, 200, { ok: true, path: picked });
      // Closing the dialog is not an error; a missing helper (no zenity on Linux) is
      if (err && err.code === "ENOENT") {
        return json(res, 501, { ok: false, error: "This system has no file dialog helper. Paste the path instead." });
      }
      return json(res, 200, { ok: true, path: "", cancelled: true });
    });
    return;
  });

  // POST /api/link-model { path, type }: use a model file where it already is, without copying it
  exact("POST", "/api/link-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const type = String(body.type || "image");
    const targets = {
      image: { dir: MODELS, valid: (name) => /\.(safetensors|ckpt|gguf)$/i.test(name), hint: ".safetensors, .ckpt or .gguf" },
      text: { dir: LLM_MODELS, valid: (name) => /\.gguf$/i.test(name), hint: ".gguf" },
      speech: { dir: SPEECH_MODELS, valid: (name) => /\.bin$/i.test(name), hint: ".bin" },
    };
    const target = targets[type];
    if (!target) return json(res, 400, { ok: false, error: "Linking is available for image, text and speech models." });

    // Accept what Finder (Option-Command-C) or Explorer ("Copy as path") puts on the clipboard
    let source = String(body.path || "").trim().replace(/^["']|["']$/g, "");
    if (source.startsWith("file://")) source = decodeURIComponent(new URL(source).pathname);
    if (source.startsWith("~")) source = path.join(os.homedir(), source.slice(1));
    if (!source || !path.isAbsolute(source)) {
      return json(res, 400, { ok: false, error: "Paste the full path to the file, starting from the drive or your home folder." });
    }
    let stats;
    try {
      stats = fs.statSync(source);
    } catch (_) {
      return json(res, 404, { ok: false, error: `Nothing was found at ${source}.` });
    }
    const filename = path.basename(source);
    // File it by what it actually is, not by the tab it was added from
    const detected = stats.isFile() ? detectModelKindCached(source) : { kind: "unknown" };
    const kind = targets[detected.kind] && targets[detected.kind].valid(filename) ? detected.kind : type;
    const chosen = targets[kind];
    if (!stats.isFile() || !chosen.valid(filename)) {
      return json(res, 400, { ok: false, error: `That isn't a ${type} model file. Choose a ${target.hint} file.` });
    }
    if (pathInside(source, chosen.dir)) {
      return json(res, 400, { ok: false, error: "That file is already in the app's models folder." });
    }
    const dest = path.join(chosen.dir, filename);
    if (fs.existsSync(dest) || describeLinkedModel(dest).linkedFrom) {
      return json(res, 409, { ok: false, error: `A model named ${filename} is already in the app.` });
    }
    try {
      fs.mkdirSync(chosen.dir, { recursive: true });
      try {
        fs.symlinkSync(source, dest, "file");
      } catch (err) {
        // Windows only allows symlinks in Developer Mode; a hard link also uses no extra space on the same drive
        if (err.code !== "EPERM" && err.code !== "EACCES") throw err;
        fs.linkSync(source, dest);
      }
      state.cachedBackendOptions = null;
      console.log(`  [api] Linked ${kind} model in place: ${source}`);
      return json(res, 200, { ok: true, filename, linkedFrom: source, kind, detail: detected.detail || "" });
    } catch (err) {
      const crossDrive = err.code === "EXDEV";
      return json(res, 500, {
        ok: false,
        error: crossDrive
          ? "This system can't link to a file on another drive. Use Import a copy instead."
          : `Couldn't link the file: ${err.message}`,
      });
    }
  });

  // POST /api/delete-model
  exact("POST", "/api/delete-model", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { filename } = body;
    if (!filename) return json(res, 400, { error: "Filename is required" });
    
    const openvinoModel = findOpenVinoModel(filename);
    const safeFilename = path.basename(filename);
    const modelPath = path.join(MODELS, safeFilename);
    
    try {
      if (openvinoModel?.installed && openvinoModel.path && pathInside(openvinoModel.path, OPENVINO_MODELS)) {
        fs.rmSync(openvinoModel.path, { recursive: true, force: true });
        state.cachedBackendOptions = null;
        console.log(`  [api] Deleted OpenVINO model: ${openvinoModel.id}`);
        return json(res, 200, { ok: true, message: `Deleted ${openvinoModel.name}` });
      } else if (fs.existsSync(modelPath) || describeLinkedModel(modelPath).linkedFrom) {
        // For a linked model this removes only the link; the original file stays where it is
        fs.unlinkSync(modelPath);
        console.log(`  [api] Deleted model file: ${safeFilename}`);
        return json(res, 200, { ok: true, message: `Deleted ${safeFilename}` });
      } else {
        return json(res, 404, { error: "Model file not found" });
      }
    } catch (err) {
      console.error(`  [api] Failed to delete model ${safeFilename}:`, err);
      return json(res, 500, { error: err.message });
    }
  });

  return routes;
};
