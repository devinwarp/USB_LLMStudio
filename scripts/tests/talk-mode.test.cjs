const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const loadTalk = () => import(pathToFileURL(path.join(root, "app/frontend/src/utils/talk.js")).href);

test("talk mode TTS chunk limit matches the server's synthesizeTts limit", async () => {
  const { TTS_MAX_TEXT_CHARS, TALK_CHUNK_MAX_CHARS } = await loadTalk();
  // Read every server module so the check survives serve.cjs being split into route files
  const serverDir = path.join(root, "scripts/server");
  const server = fs.readdirSync(serverDir)
    .filter((name) => name.endsWith(".cjs"))
    .map((name) => fs.readFileSync(path.join(serverDir, name), "utf8"))
    .join("\n");
  const limit = Number(server.match(/cleanedText\.length > (\d+)/)?.[1]);
  assert.equal(TTS_MAX_TEXT_CHARS, limit);
  assert.ok(TALK_CHUNK_MAX_CHARS <= TTS_MAX_TEXT_CHARS);
});

test("stripForSpeech drops markdown, code and links but keeps the words", async () => {
  const { stripForSpeech } = await loadTalk();
  const spoken = stripForSpeech([
    "## Steps",
    "1. Open **Settings** and pick [the model](https://example.com/x).",
    "- Run `npm test`",
    "```js",
    "console.log('hi');",
    "```",
    "Done at https://example.com now.",
  ].join("\n"));
  assert.equal(spoken, "Steps Open Settings and pick the model. Run npm test Done at now.");
});

test("speech chunker speaks the first sentence early, then groups the rest", async () => {
  const { createSpeechChunker } = await loadTalk();
  const chunker = createSpeechChunker({ firstMinChars: 10, minChars: 40, maxChars: 200 });
  const reply = "Sure, here it is. The second sentence is here. A third one follows. And a fourth one to finish.";

  // Streaming token by token never emits half a sentence
  const streamed = [];
  for (let i = 1; i <= reply.length; i += 1) streamed.push(...chunker.push(reply.slice(0, i)));
  assert.deepEqual(streamed, [
    "Sure, here it is.",
    "The second sentence is here. A third one follows.",
  ]);
  assert.deepEqual(chunker.flush(reply), ["And a fourth one to finish."]);
  assert.deepEqual(chunker.flush(reply), []);
});

test("speech chunker never cuts inside an open code block and splits overlong text", async () => {
  const { createSpeechChunker } = await loadTalk();
  const chunker = createSpeechChunker({ firstMinChars: 5, minChars: 5, maxChars: 40 });
  assert.deepEqual(chunker.push("Look. ```\nfoo. bar. baz."), ["Look."]);
  assert.deepEqual(chunker.push("Look. ```\nfoo. bar. baz.\n``` After the code. Next."), ["After the code."]);

  const long = createSpeechChunker({ firstMinChars: 5, minChars: 5, maxChars: 20 });
  const parts = long.flush("word ".repeat(12));
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 20));
  assert.equal(parts.join(" ").split(" ").length, 12);
});

test("speech chunker recognises Arabic question marks", async () => {
  const { createSpeechChunker } = await loadTalk();
  const chunker = createSpeechChunker({ firstMinChars: 3, minChars: 3, maxChars: 100 });
  assert.deepEqual(chunker.push("كيف حالك؟ أنا"), ["كيف حالك؟"]);
});

test("speech pipeline plays clips in order while the next one synthesizes", async () => {
  const { createSpeechPipeline } = await loadTalk();
  const log = [];
  const pipeline = createSpeechPipeline({
    synthesize: async (text) => { log.push(`synth:${text}`); return { text }; },
    play: async (clip) => { log.push(`play:${clip.text}`); },
    discard: (clip) => log.push(`discard:${clip.text}`),
  });
  pipeline.enqueue("a");
  pipeline.enqueue("b");
  await pipeline.drained();
  assert.deepEqual(log.filter((entry) => entry.startsWith("play")), ["play:a", "play:b"]);
  assert.ok(log.indexOf("synth:b") < log.indexOf("play:b"));
  assert.deepEqual(log.filter((entry) => entry.startsWith("discard")), ["discard:a", "discard:b"]);
});

test("speech pipeline barge-in stops playback, drops queued text and discards late clips", async () => {
  const { createSpeechPipeline } = await loadTalk();
  const played = [];
  const synthesized = [];
  const discarded = [];
  let stopped = 0;
  let finishPlayback;
  let releaseSecondClip;
  const pipeline = createSpeechPipeline({
    synthesize: (text) => {
      synthesized.push(text);
      if (text === "second") return new Promise((resolve) => { releaseSecondClip = () => resolve({ text }); });
      return Promise.resolve({ text });
    },
    play: (clip) => new Promise((resolve) => { played.push(clip.text); finishPlayback = resolve; }),
    stop: () => { stopped += 1; finishPlayback?.(); },
    discard: (clip) => discarded.push(clip.text),
  });
  pipeline.enqueue("first");
  pipeline.enqueue("second");
  pipeline.enqueue("third");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(played, ["first"]);

  pipeline.cancel();
  pipeline.cancel();
  releaseSecondClip();
  await pipeline.drained();

  assert.equal(stopped, 1);
  assert.deepEqual(played, ["first"]);
  assert.deepEqual(synthesized, ["first", "second"]);
  assert.deepEqual(discarded, ["first", "second"]);
  pipeline.enqueue("ignored");
  await pipeline.drained();
  assert.deepEqual(synthesized, ["first", "second"]);
});
