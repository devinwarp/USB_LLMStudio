// Text model (LLM) runtime and chat API routes.
// Moved verbatim from the request handler in serve.cjs. Mutable server state
// (ports, process handles, settings, progress) is read and written via ctx.state.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { comprehensiveWebSearch } = require("../../search/core");
const { pathInside, readJsonBody, json } = require("../http-helpers.cjs");
const { createRouteTable } = require("../route-table.cjs");

module.exports = function createLlmRoutes(ctx) {
  const { state, LLM_MODELS, PREFERRED_LLM_PORT, ROOT, WEB_SEARCH_CACHE, deleteChatConversation,
    getGpuInfo, getLlmBackend, getLlmBackendCandidates, getLlmBackendProbe,
    getPersistedLlmBenchmarks, getPersistedLlmModelSettings, jsonErrorStatus, killLlm,
    listChatConversations, llmHttpAgent, osPlatform, recordLlmBenchmark, requestJson,
    runExclusiveLlmOperation, saveChatConversation, startLlm, startLlmWithBackend,
    updateLlmModelSettings } = ctx;
  const { routes, exact, prefix } = createRouteTable();

  function isOomError(msg) {
    if (!msg) return false;
    const lower = String(msg).toLowerCase();
    return lower.includes("out of memory") ||
           lower.includes("failed to allocate") ||
           lower.includes("failed to initialize the context") ||
           lower.includes("oom") ||
           lower.includes("not enough memory") ||
           lower.includes("allocation failed") ||
           lower.includes("failed to create context");
  }

  async function retryLowerContext() {
    const currentCtx = state.llmSettings.contextSize || 4096;
    const contextLadder = [32768, 24576, 16384, 12288, 8192, 4096, 2048, 1024, 512];
    const nextLimit = contextLadder.find(limit => limit < currentCtx);
    if (!nextLimit) {
      throw new Error("Cannot lower context size any further.");
    }
    console.log(`  [llm] Retrying with lower context limit: ${nextLimit} (was ${currentCtx})`);
    
    const originalModel = state.llmSettings.model;
    const newSettings = {
      model: originalModel,
      threads: state.llmSettings.threads,
      contextSize: nextLimit,
      gpuLayers: state.llmSettings.gpuLayers,
      enableThinking: state.llmSettings.enableThinking,
    };
    
    await runExclusiveLlmOperation(() => startLlm(newSettings));
  }

  function getMessageText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      }).join("\n");
    }
    if (content && typeof content === "object") {
      if (typeof content.text === "string") return content.text;
      if (typeof content.content === "string") return content.content;
    }
    return "";
  }

  function getLastUserQuery(messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === "user") {
        return getMessageText(messages[i].content).trim();
      }
    }
    return "";
  }

  // Asks the loaded model whether the latest message needs a web search and, if so, for a
  // standalone query that resolves references to earlier turns ("what about its price?").
  // Returns "" when the model decides no search is needed, or null if planning failed.
  async function planWebSearchQuery(messages) {
    const recent = messages
      .filter((message) => message?.role === "user" || message?.role === "assistant")
      .slice(-6)
      .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${getMessageText(message.content).replace(/<think>[\s\S]*?<\/think>/g, "").trim().slice(0, 600)}`)
      .join("\n");
    if (!recent) return null;
    try {
      const result = await requestJson(`http://127.0.0.1:${state.PORT_LLM}/v1/chat/completions`, {
        model: state.llmSettings.model || "local-model",
        messages: [
          {
            role: "system",
            content: "You decide whether answering the user's latest message needs a web search. " +
              "If it does, reply with ONLY a short standalone search query (max 12 words) that includes any names or topics the message refers to from earlier in the conversation. " +
              "If it does not (greetings, chit-chat, rewriting or explaining text already in the chat, math, coding with no recent facts), reply with ONLY the word NONE.",
          },
          { role: "user", content: `Conversation:\n${recent}\n\nSearch query for the latest user message (or NONE):` },
        ],
        temperature: 0,
        max_tokens: 48,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }, 30000);
      const raw = String(result?.choices?.[0]?.message?.content || "")
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .split("\n").map((line) => line.trim()).find(Boolean) || "";
      const query = raw.replace(/^(search query|query)\s*:\s*/i, "").replace(/^["'`]+|["'`]+$/g, "").trim();
      if (!query) return null;
      if (/^none\.?$/i.test(query)) return "";
      return query.slice(0, 200);
    } catch (err) {
      console.warn("  [web-search] Query planning failed, using the last message:", err.message || err);
      return null;
    }
  }

  async function augmentMessagesWithWebSearch(messages, body) {
    if (body.useWeb !== true && body.use_web !== true) {
      return { messages, webSources: [], webContext: "" };
    }
    let query = String(body.webQuery || body.query || "").trim();
    if (!query) {
      const planned = state.llmReady ? await planWebSearchQuery(messages) : null;
      if (planned === "") return { messages, webSources: [], webContext: "", webSkipped: true };
      query = String(planned || getLastUserQuery(messages) || "").trim();
    }
    if (!query) return { messages, webSources: [], webContext: "" };
    console.log(`  [web-search] Query: ${query}`);

    const result = await comprehensiveWebSearch(query, {
      timeFilter: body.timeFilter || body.time_filter || "any",
      resultLimit: body.webResultLimit || 5,
      fetchLimit: body.webFetchLimit || 3,
      cacheDir: WEB_SEARCH_CACHE,
    });
    if (!result.context || !result.sources.length) {
      return { messages, webSources: [], webContext: "" };
    }
    let insertAt = 0;
    while (insertAt < messages.length && messages[insertAt]?.role === "system") {
      insertAt += 1;
    }
    const augmentedMessages = [
      ...messages.slice(0, insertAt),
      { role: "user", content: result.context },
      ...messages.slice(insertAt),
    ];
    return {
      messages: augmentedMessages,
      webSources: result.sources,
      webContext: result.context,
    };
  }

  async function doLlmChat(req, res, body, retryCount = 0) {
    try {
      const isStream = body.stream === true;
      const rawMessages = Array.isArray(body.messages) ? body.messages : [];
      const webAugmentation = await augmentMessagesWithWebSearch(rawMessages, body);
      const requestData = JSON.stringify({
        model: state.llmSettings.model || "local-model",
        messages: webAugmentation.messages,
        temperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.7,
        max_tokens: Math.max(1, Math.min(4096, Number(body.max_tokens) || Number(body.maxTokens) || 1024)),
        stream: isStream,
        // New sampling parameters
        top_p: Number.isFinite(Number(body.top_p)) ? Number(body.top_p) : 0.95,
        top_k: Number.isFinite(Number(body.top_k)) ? Number(body.top_k) : 40,
        min_p: Number.isFinite(Number(body.min_p)) ? Number(body.min_p) : 0.05,
        repeat_penalty: Number.isFinite(Number(body.repeat_penalty)) ? Number(body.repeat_penalty) : 1.1,
        frequency_penalty: Number.isFinite(Number(body.frequency_penalty)) ? Number(body.frequency_penalty) : 0.0,
        presence_penalty: Number.isFinite(Number(body.presence_penalty)) ? Number(body.presence_penalty) : 0.0,
        seed: Number.isInteger(Number(body.seed)) ? Number(body.seed) : undefined,
        stop: Array.isArray(body.stop) ? body.stop : (body.stop ? [body.stop] : undefined),
      });

      if (isStream) {
        const clientReq = http.request({
          hostname: "127.0.0.1",
          port: state.PORT_LLM,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(requestData),
          },
          agent: llmHttpAgent,  // ✅ HTTP keep-alive: eliminates TCP handshake per turn
        }, (clientRes) => {
          if (clientRes.statusCode < 200 || clientRes.statusCode >= 300) {
            let errorBody = "";
            clientRes.setEncoding("utf8");
            clientRes.on("data", (chunk) => { errorBody += chunk; });
            clientRes.on("end", async () => {
              let message = `Text backend returned HTTP ${clientRes.statusCode}`;
              try {
                message = JSON.parse(errorBody || "{}").error?.message || message;
              } catch (_) {}
              
              if (isOomError(message) && retryCount === 0) {
                try {
                  await retryLowerContext();
                  return doLlmChat(req, res, body, retryCount + 1);
                } catch (retryErr) {
                  console.error("Failed OOM recovery retry:", retryErr);
                }
              }
              json(res, clientRes.statusCode || 500, { ok: false, error: message });
            });
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
          });
          const socket = res.socket || res.connection;
          socket?.setNoDelay?.(true);
          res.flushHeaders?.();
          if (webAugmentation.webSources.length) {
            res.write(`event: web_sources\ndata: ${JSON.stringify({ sources: webAugmentation.webSources })}\n\n`);
          }
          clientRes.on("data", (chunk) => res.write(chunk));
          clientRes.on("end", () => res.end());
          clientRes.on("error", (err) => res.destroy(err));
        });

        clientReq.on("error", async (err) => {
          console.error("LLM stream request error:", err);
          if (isOomError(err.message) && retryCount === 0) {
            try {
              await retryLowerContext();
              return doLlmChat(req, res, body, retryCount + 1);
            } catch (retryErr) {
              console.error("Failed OOM recovery retry:", retryErr);
            }
          }
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          } else {
            res.end();
          }
        });

        clientReq.write(requestData);
        clientReq.end();
        res.on("close", () => {
          if (!res.writableEnded && !clientReq.destroyed) clientReq.destroy();
        });
        return;
      } else {
        try {
          const result = await requestJson(`http://127.0.0.1:${state.PORT_LLM}/v1/chat/completions`, JSON.parse(requestData), 300000);
          if (webAugmentation.webSources.length) {
            result.web_sources = webAugmentation.webSources;
          }
          return json(res, 200, result);
        } catch (err) {
          if (isOomError(err.message) && retryCount === 0) {
            try {
              await retryLowerContext();
              return doLlmChat(req, res, body, retryCount + 1);
            } catch (retryErr) {
              console.error("Failed OOM recovery retry:", retryErr);
            }
          }
          throw err;
        }
      }
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  }

  function getLlmRuntimeStats() {
    const benchmarks = getPersistedLlmBenchmarks();
    return {
      ok: true,
      ready: state.llmReady,
      running: state.llmProc !== null,
      selectedBackend: getLlmBackendProbe().selected,
      settings: state.llmSettings,
      modelSettings: getPersistedLlmModelSettings(),
      benchmarks: (benchmarks.results || []).slice(0, 20),
    };
  }

  async function benchmarkLlmBackend(model, backend, baseSettings = {}) {
    const prompt = String(baseSettings.prompt || "Reply with one short sentence about local AI performance.");
    const startedAt = Date.now();
    await startLlmWithBackend({
      ...baseSettings,
      model,
      contextSize: Math.min(2048, Number(baseSettings.contextSize) || 2048),
      gpuLayers: Number.isFinite(Number(baseSettings.gpuLayers)) ? Number(baseSettings.gpuLayers) : -1,
      enableThinking: false,
    }, backend);

    const result = await requestJson(`http://127.0.0.1:${state.PORT_LLM}/v1/chat/completions`, {
      model: state.llmSettings.model || "local-model",
      messages: [
        { role: "system", content: "You are a concise local benchmark assistant." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 64,
      stream: false,
    }, 180000);
    const finishedAt = Date.now();
    const timings = result.timings || {};
    return {
      backendKey: backend.key,
      backendMode: state.llmSettings.backendMode || backend.mode,
      backendBinary: state.llmSettings.backendBinary || path.basename(backend.path),
      model,
      ok: true,
      total_ms: finishedAt - startedAt,
      prompt_ms: Number(timings.prompt_ms) || null,
      predicted_ms: Number(timings.predicted_ms) || null,
      predicted_n: Number(timings.predicted_n) || null,
      predicted_per_second: Number(timings.predicted_per_second) || null,
      prompt_per_second: Number(timings.prompt_per_second) || null,
    };
  }

  async function benchmarkLlmModel(settings = {}) {
    const filename = path.basename(String(settings.model || state.llmSettings.model || ""));
    const modelPath = path.join(LLM_MODELS, filename);
    if (!filename || !pathInside(modelPath, LLM_MODELS) || !fs.existsSync(modelPath)) {
      throw new Error("Select a downloaded GGUF text model before benchmarking.");
    }

    const previous = {
      ready: state.llmReady,
      model: state.llmSettings.model,
      settings: { ...state.llmSettings },
    };
    const requestedBackends = Array.isArray(settings.backends)
      ? settings.backends.map((item) => String(item).toLowerCase())
      : [];
    const candidates = getLlmBackendCandidates()
      .filter((backend) => backend.key !== "cpu" || settings.includeCpu !== false)
      .filter((backend) => requestedBackends.length === 0 || requestedBackends.includes(backend.key));

    if (candidates.length === 0) {
      throw new Error("No available text backends were detected for benchmarking.");
    }

    const results = [];
    for (const backend of candidates) {
      try {
        const result = await benchmarkLlmBackend(filename, backend, settings);
        results.push(recordLlmBenchmark(result));
      } catch (err) {
        results.push(recordLlmBenchmark({
          backendKey: backend.key,
          backendMode: backend.mode,
          backendBinary: path.basename(backend.path),
          model: filename,
          ok: false,
          error: (err.message || String(err)).slice(-800),
        }));
        await killLlm();
      }
    }

    const successful = results
      .filter((item) => item.ok && Number(item.predicted_per_second) > 0)
      .sort((a, b) => Number(b.predicted_per_second) - Number(a.predicted_per_second));
    const winner = successful[0] || null;
    if (winner) {
      updateLlmModelSettings(filename, {
        preferredBackend: winner.backendKey,
        benchmarkWinner: {
          backendMode: winner.backendMode,
          predicted_per_second: winner.predicted_per_second,
          createdAt: winner.createdAt,
        },
      });
    }

    if (previous.ready && previous.model && previous.model === filename && winner) {
      try {
        await startLlm({ ...previous.settings, model: filename, preferredBackend: winner.backendKey });
      } catch (err) {
        console.warn("  [llm] Failed to restore text model after benchmark:", err.message || err);
      }
    }

    return { ok: true, model: filename, winner, results };
  }

  // ── llmfit Integration ──────────────────────────────────────────────────────────
  let cachedLlmfitResults = new Map();

  function getHardwareHash() {
    const cpus = os.cpus();
    const gpu = getGpuInfo();
    const ram = os.totalmem();
    return `${cpus.length}-${cpus[0]?.model || 'unknown'}-${gpu.name}-${ram}`;
  }

  async function getLlmfitRecommendations(useCase = "chat", limit = 10) {
    const hardwareHash = getHardwareHash();
    const cacheKey = `${hardwareHash}:${useCase}:${limit}`;
    
    const cached = cachedLlmfitResults.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < 3600000) { // 1 hour cache
      return cached.data;
    }
    
    // Try to find llmfit binary
    const llmfitPaths = [
      path.join(ROOT, "app", "tools", "llmfit", osPlatform === "win32" ? "llmfit.exe" : "llmfit"),
      "llmfit", // PATH
    ];
    
    let llmfitPath = null;
    for (const p of llmfitPaths) {
      try {
        if (fs.existsSync(p)) {
          llmfitPath = p;
          break;
        }
        if (osPlatform !== "win32") {
          const whichResult = spawnSync("which", [p], { stdio: "ignore" });
          if (whichResult.status === 0) {
            llmfitPath = p;
            break;
          }
        }
      } catch (_) {}
    }
    
    if (!llmfitPath) return null; // Fallback to tier table
    
    try {
      const result = spawnSync(llmfitPath, [
        "recommend", "--json", "--limit", String(limit),
        "--use-case", useCase, "--force-runtime", "llamacpp"
      ], {
        encoding: "utf8",
        timeout: 8000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      
      if (result.status !== 0) return null;
      
      const data = JSON.parse(result.stdout);
      cachedLlmfitResults.set(cacheKey, { timestamp: Date.now(), data });
      return data;
    } catch (_) {
      return null;
    }
  }

  exact("GET", "/api/llm/status", async (req, res) => {
    const backend = getLlmBackend();
    const probe = getLlmBackendProbe();
    return json(res, 200, {
      ready: state.llmReady,
      running: state.llmProc !== null,
      port: state.PORT_LLM,
      preferredPort: PREFERRED_LLM_PORT,
      error: state.llmError,
      settings: state.llmSettings,
      backendInstalled: Boolean(backend),
      backendMode: backend?.mode || "",
      backendPath: backend?.path || "",
      selectedBackend: probe.selected,
      availableBackends: probe.available,
    });
  });

  prefix("GET", "/api/llm/backends", async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    return json(res, 200, { ok: true, ...getLlmBackendProbe(parsed.searchParams.get("refresh") === "1") });
  });

  exact("GET", "/api/llm/stats", async (req, res) => {
    return json(res, 200, getLlmRuntimeStats());
  });

  exact("GET", "/api/llm/model-settings", async (req, res) => {
    return json(res, 200, { ok: true, ...getPersistedLlmModelSettings() });
  });

  exact("POST", "/api/llm/model-settings", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const filename = path.basename(String(body.model || ""));
    if (!filename) return json(res, 400, { ok: false, error: "model is required" });
    const updated = updateLlmModelSettings(filename, {
      preferredBackend: body.preferredBackend ? String(body.preferredBackend).toLowerCase() : undefined,
    });
    return json(res, 200, { ok: true, model: filename, settings: updated });
  });

  exact("GET", "/api/llm/conversations", async (req, res) => {
    return json(res, 200, { ok: true, conversations: listChatConversations() });
  });

  exact("POST", "/api/llm/save-conversation", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const conversation = saveChatConversation(body.conversation || body);
      return json(res, 200, { ok: true, conversation });
    } catch (err) {
      console.error("  [api] Failed to save chat conversation:", err);
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  });

  exact("POST", "/api/llm/delete-conversation", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const deleted = deleteChatConversation(body.id);
      return json(res, 200, { ok: true, deleted });
    } catch (err) {
      console.error("  [api] Failed to delete chat conversation:", err);
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  });

  exact("POST", "/api/llm/start", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      await runExclusiveLlmOperation(() => startLlm(body));
      return json(res, 200, { ok: true, ready: state.llmReady, port: state.PORT_LLM, settings: state.llmSettings });
    } catch (err) {
      state.llmError = err.message || String(err);
      if (err.code !== "MODEL_ALREADY_ACTIVE") {
        await runExclusiveLlmOperation(() => killLlm());
      }
      return json(res, jsonErrorStatus(err), { ok: false, error: state.llmError, code: err.code || "", activeRuntime: err.activeRuntime || null });
    }
  });

  exact("POST", "/api/llm/stop", async (req, res) => {
    await runExclusiveLlmOperation(() => killLlm());
    return json(res, 200, { ok: true });
  });

  exact("POST", "/api/llm/benchmark", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    try {
      const result = await runExclusiveLlmOperation(() => benchmarkLlmModel(body));
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || String(err) });
    }
  });

  exact("POST", "/api/llm/chat", async (req, res) => {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (!state.llmReady) return json(res, 409, { ok: false, error: "Load a text model before sending a message." });
    await doLlmChat(req, res, body);
    return;
  });

  // GET /api/llm/recommend: llmfit recommendations
  prefix("GET", "/api/llm/recommend", async (req, res) => {
    // Fresh cache per request, exactly as when this Map was declared inside the request handler.
    cachedLlmfitResults = new Map();
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const useCase = url.searchParams.get("useCase") || "chat";
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 10));
    const recommendations = await getLlmfitRecommendations(useCase, limit);
    return json(res, 200, { ok: true, recommendations, source: recommendations ? "llmfit" : "fallback" });
  });

  return routes;
};
