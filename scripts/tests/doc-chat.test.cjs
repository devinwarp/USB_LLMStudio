const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const docChat = require("../server/doc-chat.cjs");
const DOC_CHAT = require("../../app/frontend/src/config/doc-chat.json");

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "usbllm-docs-"));

function fakeRequest(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.destroy = () => {};
  process.nextTick(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function fakeResponse() {
  return {
    status: 0,
    body: null,
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
}

async function call(chat, method, url, body) {
  const res = fakeResponse();
  const handled = await chat.handle(fakeRequest(method, url, body), res);
  return { handled, ...res };
}

test("tokenize lowercases, splits on punctuation and folds Arabic diacritics", () => {
  assert.deepEqual(docChat.tokenize("Hello, World! 42 a"), ["hello", "world", "42"]);
  // "kataba" with and without harakat, plus tatweel
  assert.deepEqual(docChat.tokenize("كَتَبَ كتـب"), ["كتب", "كتب"]);
});

test("chunkPage keeps chunks within size, overlaps them and loses no words", () => {
  const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about topic ${i}.`);
  const chunks = docChat.chunkPage(sentences.join(" "), { size: 200, overlap: 40 });
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every((chunk) => chunk.length <= 200));
  for (const sentence of sentences) {
    assert.ok(chunks.some((chunk) => chunk.includes(sentence)), `lost: ${sentence}`);
  }
  assert.deepEqual(docChat.chunkPage("   "), []);
});

test("chunkDocument keeps the page number on every chunk", () => {
  const chunks = docChat.chunkDocument([{ page: 3, text: "Alpha." }, { page: null, text: "Beta." }]);
  assert.deepEqual(chunks, [{ page: 3, text: "Alpha." }, { page: null, text: "Beta." }]);
});

test("rankChunks puts the passage that matches rare query terms first", () => {
  const chunks = [
    { text: "The cat sat on the mat." },
    { text: "Quarterly revenue grew because of the new warranty policy." },
    { text: "The dog chased the cat around the garden." },
  ];
  const hits = docChat.rankChunks(chunks, "What is the warranty policy?", { topK: 2 });
  assert.equal(hits[0].chunk, chunks[1]);
  assert.ok(hits.every((hit) => hit.score > 0));
  assert.deepEqual(docChat.rankChunks(chunks, "zebra"), []);
});

test("rankChunks blends in vector similarity when vectors are present", () => {
  const chunks = [
    { text: "apples and pears", vector: [1, 0] },
    { text: "fruit basket apples", vector: [0, 1] },
  ];
  const keywordOnly = docChat.rankChunks(chunks, "apples basket");
  assert.equal(keywordOnly[0].chunk, chunks[1]);
  const hybrid = docChat.rankChunks(chunks, "apples", { queryVector: [1, 0] });
  assert.equal(hybrid[0].chunk, chunks[0]);
});

test("embeddings URL must point at this machine", () => {
  const env = (value) => ({ [docChat.EMBEDDINGS_URL_ENV]: value });
  assert.equal(docChat.embeddingsBaseUrl(env("http://127.0.0.1:10090/v1")), "http://127.0.0.1:10090");
  assert.equal(docChat.embeddingsBaseUrl(env("http://localhost:10090/v1/embeddings")), "http://localhost:10090");
  assert.equal(docChat.embeddingsBaseUrl(env("https://api.example.com/v1")), "");
  assert.equal(docChat.embeddingsBaseUrl(env("not a url")), "");
  assert.equal(docChat.embeddingsBaseUrl({}), "");
});

test("embedder batches requests and keeps vectors in input order", async () => {
  const calls = [];
  const embed = docChat.createEmbedder("http://127.0.0.1:1", async (url, options) => {
    const { input } = JSON.parse(options.body);
    calls.push({ url, size: input.length });
    return {
      ok: true,
      json: async () => ({ data: input.map((text, index) => ({ index, embedding: [text.length] })).reverse() }),
    };
  });
  const vectors = await embed(Array.from({ length: 40 }, (_, i) => "x".repeat(i + 1)));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:1/v1/embeddings");
  assert.deepEqual(vectors.slice(0, 3), [[1], [2], [3]]);
  assert.equal(vectors.length, 40);
  assert.equal(docChat.createEmbedder(""), null);
});

test("doc chat routes add, list, search with citations and delete, persisted on disk", async () => {
  const dataDir = tempDir();
  try {
    const chat = docChat.createDocChat({ dataDir, embed: null });
    const { routes } = DOC_CHAT;

    const added = await call(chat, "POST", routes.add, {
      name: "../handbook.pdf",
      pages: [
        { page: 1, text: "Welcome to the company handbook." },
        { page: 2, text: "Employees get 25 days of paid leave every year." },
      ],
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.document.name, "handbook.pdf");
    assert.equal(added.body.document.pages, 2);

    // A fresh instance reads the same index back from the drive
    const reopened = docChat.createDocChat({ dataDir, embed: null });
    const listed = await call(reopened, "GET", routes.list);
    assert.deepEqual(listed.body.documents.map((doc) => doc.name), ["handbook.pdf"]);

    const found = await call(reopened, "POST", routes.search, { query: "How many days of paid leave?" });
    assert.equal(found.status, 200);
    assert.deepEqual(
      { index: found.body.results[0].index, name: found.body.results[0].name, page: found.body.results[0].page },
      { index: 1, name: "handbook.pdf", page: 2 },
    );

    const removed = await call(reopened, "POST", routes.delete, { id: added.body.document.id });
    assert.equal(removed.status, 200);
    assert.deepEqual((await call(reopened, "GET", routes.list)).body.documents, []);
    assert.equal((await call(reopened, "POST", routes.delete, { id: "missing" })).status, 404);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("doc chat rejects bad input and ignores routes it does not own", async () => {
  const dataDir = tempDir();
  try {
    const chat = docChat.createDocChat({ dataDir, embed: null });
    const { routes, limits } = DOC_CHAT;
    assert.equal((await call(chat, "POST", routes.add, { name: "empty.txt", pages: [{ text: "   " }] })).status, 400);
    assert.equal((await call(chat, "POST", routes.add, { name: "", pages: [{ text: "x" }] })).status, 400);
    const huge = await call(chat, "POST", routes.add, { name: "big.txt", pages: [{ text: "a".repeat(limits.maxDocumentChars + 1) }] });
    assert.equal(huge.status, 400);
    assert.equal((await call(chat, "POST", routes.search, { query: " " })).status, 400);
    assert.equal((await call(chat, "GET", "/api/llm/status")).handled, false);
    assert.equal((await call(chat, "GET", routes.search)).handled, false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("doc chat stores vectors when an embedder is configured and falls back without one", async () => {
  const dataDir = tempDir();
  try {
    const embed = async (texts) => texts.map((text) => [text.includes("leave") ? 1 : 0, 1]);
    const chat = docChat.createDocChat({ dataDir, embed });
    const doc = await chat.addDocument({ name: "a.txt", pages: [{ text: "Paid leave rules." }] });
    assert.equal(doc.embedded, true);
    assert.ok(Array.isArray(chat.store.chunks()[0].vector));

    const failing = docChat.createDocChat({ dataDir: path.join(dataDir, "fallback"), embed: async () => { throw new Error("offline"); } });
    const original = console.warn;
    console.warn = () => {};
    try {
      const fallback = await failing.addDocument({ name: "b.txt", pages: [{ text: "Paid leave rules." }] });
      assert.equal(fallback.embedded, false);
      assert.equal((await failing.search({ query: "leave" }))[0].name, "b.txt");
    } finally {
      console.warn = original;
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the server mounts the doc chat routes before the unknown-API fallback", () => {
  // Look in every server module so the check survives serve.cjs being split into route files
  const serverDir = path.join(root, "scripts/server");
  const host = fs.readdirSync(serverDir)
    .filter((name) => name.endsWith(".cjs") && name !== "doc-chat.cjs")
    .map((name) => fs.readFileSync(path.join(serverDir, name), "utf8"))
    .find((source) => source.includes("docChat.handle(req, res)"));
  assert.ok(host, "no server module mounts docChat.handle");
  assert.match(host, /require\("\.\/doc-chat\.cjs"\)\.createDocChat\(\)/);
  assert.match(host, /if \(await docChat\.handle\(req, res\)\) return;/);
  const fallback = host.indexOf('"Unknown API endpoint"');
  assert.ok(fallback === -1 || host.indexOf("docChat.handle(req, res)") < fallback);
});

test("client builds a cited prompt from search results using the shared routes", async () => {
  const { DOC_CHAT: clientConfig, buildDocumentContext, formatDocumentCitation, searchDocuments } = await import(
    pathToFileURL(path.join(root, "app/frontend/src/services/docs.js")).href
  );
  assert.deepEqual(clientConfig, DOC_CHAT);
  assert.equal(buildDocumentContext([]), "");
  const context = buildDocumentContext([
    { index: 1, name: "handbook.pdf", page: 2, text: "25 days of paid leave." },
    { index: 2, name: "notes.txt", page: null, text: "Ask HR first." },
  ]);
  assert.match(context, /\[1\] handbook\.pdf, page 2\n25 days of paid leave\./);
  assert.match(context, /\[2\] notes\.txt\nAsk HR first\./);
  assert.equal(formatDocumentCitation({ name: "x.pdf", page: 4 }), "x.pdf, page 4");

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, results: [{ index: 1 }] }) };
  };
  try {
    assert.deepEqual(await searchDocuments("leave"), [{ index: 1 }]);
    assert.equal(calls[0].url, DOC_CHAT.routes.search);
    assert.equal(calls[0].body.topK, DOC_CHAT.limits.defaultTopK);
  } finally {
    global.fetch = originalFetch;
  }
});
