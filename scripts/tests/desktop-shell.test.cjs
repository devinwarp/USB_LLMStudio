const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..");
const tauriDir = path.join(root, "app/frontend/src-tauri");

test("desktop shell uses the HTTP API when the UI is served by the local server", async () => {
  const originalWindow = global.window;
  try {
    const { isTauri } = await import(`${pathToFileURL(path.join(root, "app/frontend/src/services/api.js")).href}?desktop-shell`);
    global.window = { __TAURI_INTERNALS__: {}, location: { protocol: "http:" } };
    assert.equal(isTauri(), false);
    global.window = { __TAURI_INTERNALS__: {}, location: { protocol: "tauri:" } };
    assert.equal(isTauri(), true);
    global.window = { location: { protocol: "http:" } };
    assert.equal(isTauri(), false);
  } finally {
    global.window = originalWindow;
  }
});

test("desktop shell config points at files that exist", () => {
  const config = JSON.parse(fs.readFileSync(path.join(tauriDir, "tauri.conf.json"), "utf8"));
  assert.ok(fs.existsSync(path.join(tauriDir, config.build.frontendDist, "index.html")));
  for (const icon of config.bundle.icon) {
    assert.ok(fs.existsSync(path.join(tauriDir, icon)), `missing icon ${icon}`);
  }
  const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(config.version, rootPackage.version);
});

test("desktop shell starts the same server script and port variable the launchers use", () => {
  const shell = fs.readFileSync(path.join(tauriDir, "src/main.rs"), "utf8");
  // Read every server module so the check survives serve.cjs being split into route files
  const serverDir = path.join(root, "scripts/server");
  const server = fs.readdirSync(serverDir)
    .filter((name) => name.endsWith(".cjs"))
    .map((name) => fs.readFileSync(path.join(serverDir, name), "utf8"))
    .join("\n");
  const script = shell.match(/const SERVER_SCRIPT: &\[&str\] = &\[([^\]]+)\]/)[1]
    .split(",").map((part) => part.trim().replace(/"/g, "")).join("/");
  assert.ok(fs.existsSync(path.join(root, script)));
  const portVariable = shell.match(/const PORT_ENV: &str = "([^"]+)"/)[1];
  assert.ok(server.includes(`process.env.${portVariable}`));
  const errorFn = shell.match(/const SHELL_ERROR_FN: &str = "([^"]+)"/)[1];
  assert.ok(fs.readFileSync(path.join(tauriDir, "shell/index.html"), "utf8").includes(`${errorFn} = function`));
});
