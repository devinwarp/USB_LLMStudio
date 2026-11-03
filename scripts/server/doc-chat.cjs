// Document chat (local RAG): a per-drive index of the user's documents and the
// /api/docs/* routes. Text is extracted in the browser (pdf.js) and sent here as pages.
//
// Retrieval is BM25 keyword search, which needs no model and works fully offline.
// The running llama.cpp chat server cannot also serve embeddings (llama-server only
// answers /v1/embeddings when started with --embeddings, which is meant for a dedicated
// embedding model). If USBLLM_EMBEDDINGS_URL points at such a local server, chunks are
// also embedded and results are ranked by keyword + vector similarity together.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DOC_CHAT = require("../../app/frontend/src/config/doc-chat.json");

const ROOT = path.join(__dirname, "..", "..");
const DEFAULT_DATA_DIR = path.join(ROOT, "app", "doc-index");
const INDEX_FILE = "index.json";
const INDEX_VERSION = 1;
const EMBEDDINGS_URL_ENV = "USBLLM_EMBEDDINGS_URL";
const EMBEDDINGS_PATH = "/v1/embeddings";
const EMBEDDING_BATCH_SIZE = 32;
const EMBEDDING_TIMEOUT_MS = 120000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_NAME_CHARS = 200;
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP_CHARS = 200;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const HYBRID_VECTOR_WEIGHT = 0.5;

const JSON_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

// Lowercased letter/number runs. Arabic diacritics and tatweel are dropped so
// vowelled and unvowelled spellings match.
function tokenize(text) {
  return (String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .match(/[\p{L}\p{N}]+/gu) || [])
    .filter((token) => token.length > 1 || /\p{N}/u.test(token));
}

// Splits one page into overlapping chunks, preferring paragraph, then sentence, then word breaks.
function chunkPage(text, { size = CHUNK_CHARS, overlap = CHUNK_OVERLAP_CHARS } = {}) {
  const clean = String(text || "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const minBreak = Math.floor(size / 2);
      const breaks = [window.lastIndexOf("\n\n"), window.search(/[.!?؟。][^.!?؟。]*$/), window.lastIndexOf(" ")];
      const best = breaks.find((index) => index >= minBreak);
      if (best !== undefined) end = start + best + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlap);
    // Start the overlap on a word boundary
    const space = clean.indexOf(" ", start);
    if (space !== -1 && space < end) start = space + 1;
  }
  return chunks;
}

function chunkDocument(pages, options) {
  const chunks = [];
  for (const { page, text } of pages) {
    for (const piece of chunkPage(text, options)) {
      chunks.push({ page: Number.isInteger(page) && page > 0 ? page : null, text: piece });
    }
  }
  return chunks;
}

// Builds BM25 statistics for a list of chunks ({ text }).
function buildBm25(chunks) {
  const docFreq = new Map();
  const termFreqs = chunks.map((chunk) => {
    const counts = new Map();
    for (const token of tokenize(chunk.text)) counts.set(token, (counts.get(token) || 0) + 1);
    for (const token of counts.keys()) docFreq.set(token, (docFreq.get(token) || 0) + 1);
    return counts;
  });
  const lengths = termFreqs.map((counts) => [...counts.values()].reduce((sum, count) => sum + count, 0));
  const avgLength = lengths.reduce((sum, length) => sum + length, 0) / (lengths.length || 1);
  return { docFreq, termFreqs, lengths, avgLength: avgLength || 1, total: chunks.length };
}

function bm25Scores(stats, query) {
  const terms = [...new Set(tokenize(query))];
  return stats.termFreqs.map((counts, index) => {
    let score = 0;
    for (const term of terms) {
      const tf = counts.get(term);
      if (!tf) continue;
      const df = stats.docFreq.get(term) || 0;
      const idf = Math.log(1 + (stats.total - df + 0.5) / (df + 0.5));
      score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * stats.lengths[index] / stats.avgLength));
    }
    return score;
  });
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

// Ranks chunks for a query. Keyword scores are scaled to 0..1 so they can be blended
// with cosine similarity when chunk and query vectors are available.
function rankChunks(chunks, query, { topK = DOC_CHAT.limits.defaultTopK, queryVector = null } = {}) {
  if (!chunks.length) return [];
  const keyword = bm25Scores(buildBm25(chunks), query);
  const maxKeyword = Math.max(...keyword);
  const useVectors = Array.isArray(queryVector) && chunks.some((chunk) => Array.isArray(chunk.vector));
  return chunks
    .map((chunk, index) => {
      const keywordScore = maxKeyword > 0 ? keyword[index] / maxKeyword : 0;
      const score = useVectors
        ? (1 - HYBRID_VECTOR_WEIGHT) * keywordScore + HYBRID_VECTOR_WEIGHT * Math.max(0, cosine(chunk.vector, queryVector))
        : keywordScore;
      return { chunk, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function embeddingsBaseUrl(env = process.env) {
  const raw = String(env[EMBEDDINGS_URL_ENV] || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    // Stay offline: only a server on this machine may see document text
    if (!["http:", "https:"].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) return "";
    return url.origin + url.pathname.replace(/\/+$/, "").replace(/\/v1(\/embeddings)?$/, "");
  } catch (_) {
    return "";
  }
}

function createEmbedder(baseUrl, fetchImpl = globalThis.fetch) {
  if (!baseUrl || typeof fetchImpl !== "function") return null;
  return async (texts) => {
    const vectors = [];
    for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
      const res = await fetchImpl(baseUrl + EMBEDDINGS_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: batch }),
        signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Embedding server returned HTTP ${res.status}`);
      const data = await res.json();
      const rows = [...(data.data || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (rows.length !== batch.length) throw new Error("Embedding server returned the wrong number of vectors");
      vectors.push(...rows.map((row) => row.embedding));
    }
    return vectors;
  };
}

function emptyIndex() {
  return { version: INDEX_VERSION, docs: [], chunks: [] };
}

function createDocStore(dataDir = DEFAULT_DATA_DIR) {
  const indexPath = path.join(dataDir, INDEX_FILE);
  let cache = null;

  const load = () => {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      cache = parsed?.version === INDEX_VERSION ? parsed : emptyIndex();
    } catch (_) {
      cache = emptyIndex();
    }
    return cache;
  };

  const save = (index) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = `${indexPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(index));
    fs.renameSync(temp, indexPath);
    cache = index;
  };

  return {
    list() {
      return load().docs;
    },
    add(doc, chunks) {
      const index = load();
      save({ ...index, docs: [...index.docs, doc], chunks: [...index.chunks, ...chunks] });
    },
    remove(id) {
      const index = load();
      if (!index.docs.some((doc) => doc.id === id)) return false;
      save({
        ...index,
        docs: index.docs.filter((doc) => doc.id !== id),
        chunks: index.chunks.filter((chunk) => chunk.docId !== id),
      });
      return true;
    },
    chunks(docIds = null) {
      const wanted = Array.isArray(docIds) && docIds.length ? new Set(docIds) : null;
      return load().chunks.filter((chunk) => !wanted || wanted.has(chunk.docId));
    },
  };
}

function sendJson(res, code, body) {
  res.writeHead(code, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readJson(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        const err = new Error(`Request body is too large. Limit is ${Math.round(limit / (1024 * 1024))} MB.`);
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"));
      } catch (_) {
        const err = new Error("Invalid JSON request body");
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function normalizePages(pages) {
  if (!Array.isArray(pages)) throw badRequest("pages must be a list of { page, text }.");
  const normalized = pages
    .map((item) => ({ page: Number(item?.page) || null, text: String(item?.text || "") }))
    .filter((item) => item.text.trim());
  const chars = normalized.reduce((sum, item) => sum + item.text.length, 0);
  if (!chars) throw badRequest("No readable text was found in this document.");
  if (chars > DOC_CHAT.limits.maxDocumentChars) {
    throw badRequest(`Document is too long. Limit is ${DOC_CHAT.limits.maxDocumentChars.toLocaleString("en-US")} characters.`);
  }
  return { pages: normalized, chars };
}

function createDocChat({ dataDir = DEFAULT_DATA_DIR, embed = createEmbedder(embeddingsBaseUrl()), now = () => new Date() } = {}) {
  const store = createDocStore(dataDir);
  const { routes, limits } = DOC_CHAT;

  async function addDocument(body) {
    const name = path.basename(String(body.name || "").trim()).slice(0, MAX_NAME_CHARS);
    if (!name) throw badRequest("Document name is required.");
    const { pages, chars } = normalizePages(body.pages);
    const id = crypto.randomUUID();
    const pieces = chunkDocument(pages);
    let vectors = null;
    if (embed) {
      try {
        vectors = await embed(pieces.map((piece) => piece.text));
      } catch (err) {
        console.warn(`  [docs] Embeddings unavailable, using keyword search only: ${err.message}`);
      }
    }
    const chunks = pieces.map((piece, index) => ({
      id: `${id}:${index}`,
      docId: id,
      page: piece.page,
      text: piece.text,
      ...(vectors ? { vector: vectors[index] } : {}),
    }));
    const doc = {
      id,
      name,
      chars,
      pages: pages.length,
      chunks: chunks.length,
      embedded: Boolean(vectors),
      addedAt: now().toISOString(),
    };
    store.add(doc, chunks);
    return doc;
  }

  async function search(body) {
    const query = String(body.query || "").trim().slice(0, limits.maxQueryChars);
    if (!query) throw badRequest("Search query is required.");
    const topK = Math.max(1, Math.min(limits.maxTopK, Number(body.topK) || limits.defaultTopK));
    const chunks = store.chunks(body.docIds);
    let queryVector = null;
    if (embed && chunks.some((chunk) => Array.isArray(chunk.vector))) {
      try {
        [queryVector] = await embed([query]);
      } catch (_) {}
    }
    const names = new Map(store.list().map((doc) => [doc.id, doc.name]));
    return rankChunks(chunks, query, { topK, queryVector }).map(({ chunk, score }, index) => ({
      index: index + 1,
      docId: chunk.docId,
      name: names.get(chunk.docId) || "",
      page: chunk.page,
      text: chunk.text,
      score: Number(score.toFixed(4)),
    }));
  }

  // Returns true when the request was one of ours (and has been answered).
  async function handle(req, res) {
    const pathname = String(req.url || "").split("?")[0];
    const route = (target, method) => pathname === target && req.method === method;
    try {
      if (route(routes.list, "GET")) {
        sendJson(res, 200, { ok: true, documents: store.list(), embeddings: Boolean(embed) });
        return true;
      }
      if (route(routes.add, "POST")) {
        sendJson(res, 200, { ok: true, document: await addDocument(await readJson(req)) });
        return true;
      }
      if (route(routes.delete, "POST")) {
        const body = await readJson(req);
        if (!store.remove(String(body.id || ""))) {
          sendJson(res, 404, { ok: false, error: "Document not found" });
        } else {
          sendJson(res, 200, { ok: true });
        }
        return true;
      }
      if (route(routes.search, "POST")) {
        sendJson(res, 200, { ok: true, results: await search(await readJson(req)) });
        return true;
      }
    } catch (err) {
      sendJson(res, err.statusCode || 500, { ok: false, error: err.message || String(err) });
      return true;
    }
    return false;
  }

  return { handle, store, addDocument, search };
}

module.exports = {
  DEFAULT_DATA_DIR,
  EMBEDDINGS_URL_ENV,
  chunkDocument,
  chunkPage,
  createDocChat,
  createEmbedder,
  embeddingsBaseUrl,
  rankChunks,
  tokenize,
};
