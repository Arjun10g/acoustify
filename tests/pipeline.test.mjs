// Tests for the publishing/deploy tooling: stamp-version, run-tests discovery
// and failure propagation, the static smoke test (on a synthetic shell, both
// passing and failing), and the Python tools' offline self-tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readVersion, stampSource, STAMPED_FILES } from "../tools/stamp-version.mjs";
import { discoverSteps } from "../tools/run-tests.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${String(error?.stack || error).split("\n").join("\n    ")}`);
  }
}

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `acoustify-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function write(root, file, content) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function runNode(script, args = [], cwd = ROOT) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

// ── stamp-version ────────────────────────────────────────────────────────────
console.log("stamp-version");

test("stampSource rewrites both assignment styles and keeps the quote style", () => {
  const config = `export const CONFIG = Object.freeze({\n  APP_VERSION: "dev",\n  HUB: "x"\n});\n`;
  const sw = `// APP_VERSION is stamped\nconst APP_VERSION = 'dev';\nconst SHELL = \`acoustify-shell-\${APP_VERSION}\`;\n`;
  const a = stampSource(config, "1a2b3c4");
  const b = stampSource(sw, "1a2b3c4");
  assert.equal(a.count, 1);
  assert.equal(b.count, 1);
  assert.match(a.text, /APP_VERSION: "1a2b3c4",/);
  assert.match(b.text, /const APP_VERSION = '1a2b3c4';/);
  assert.ok(b.text.includes("// APP_VERSION is stamped"), "comments untouched");
  assert.ok(b.text.includes("acoustify-shell-${APP_VERSION}"), "template usage untouched");
  assert.equal(readVersion(b.text), "1a2b3c4");
  assert.equal(stampSource("const x = 1;", "v").count, 0);
});

function stampFixture() {
  const dir = tempDir("stamp");
  for (const file of STAMPED_FILES) {
    const source = path.join(ROOT, file);
    const fallback = file.endsWith("sw.js")
      ? `const APP_VERSION = "dev";\nconst SHELL_CACHE = \`acoustify-shell-\${APP_VERSION}\`;\n`
      : `export const CONFIG = Object.freeze({ APP_VERSION: "dev" });\n`;
    write(dir, file, fs.existsSync(source) ? fs.readFileSync(source, "utf8") : fallback);
  }
  return dir;
}

test("CLI stamps temp copies of config.js and sw.js and nothing else changes", () => {
  const dir = stampFixture();
  const before = Object.fromEntries(STAMPED_FILES.map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
  const { status, output } = runNode(path.join(ROOT, "tools/stamp-version.mjs"), ["abc1234", "--root", dir]);
  assert.equal(status, 0, output);
  for (const file of STAMPED_FILES) {
    const after = fs.readFileSync(path.join(dir, file), "utf8");
    assert.equal(readVersion(after), "abc1234", `${file} stamped`);
    const { text } = stampSource(before[file], "abc1234");
    assert.equal(after, text, `${file}: only APP_VERSION changed`);
  }
});

test("CLI fails loudly, and writes nothing, when a file has no APP_VERSION", () => {
  const dir = stampFixture();
  write(dir, "sw.js", "self.addEventListener('install', () => {});\n");
  const config = fs.readFileSync(path.join(dir, "assets/js/config.js"), "utf8");
  const { status, output } = runNode(path.join(ROOT, "tools/stamp-version.mjs"), ["abc1234", "--root", dir]);
  assert.notEqual(status, 0);
  assert.match(output, /sw\.js: no APP_VERSION assignment found/);
  assert.equal(fs.readFileSync(path.join(dir, "assets/js/config.js"), "utf8"), config, "config.js untouched");
});

test("CLI rejects a missing or unsafe version", () => {
  const dir = stampFixture();
  assert.notEqual(runNode(path.join(ROOT, "tools/stamp-version.mjs"), ["--root", dir]).status, 0);
  assert.notEqual(runNode(path.join(ROOT, "tools/stamp-version.mjs"), ['1"; alert(1)', "--root", dir]).status, 0);
});

// ── run-tests ────────────────────────────────────────────────────────────────
console.log("run-tests");

test("discovers validate → tests/*.test.mjs (sorted) → smoke", () => {
  const steps = discoverSteps();
  assert.equal(steps[0].file, "tools/validate-catalog.mjs");
  assert.equal(steps.at(-1).file, "tools/smoke-test.mjs");
  const tests = steps.slice(1, -1).map((s) => s.file);
  assert.ok(tests.includes("tests/pipeline.test.mjs"));
  assert.deepEqual(tests, [...tests].sort());
  assert.ok(tests.every((f) => /^tests\/[^/]+\.test\.mjs$/.test(f)));
});

test("ignores helpers that are not *.test.mjs and tolerates a missing tests/ folder", () => {
  const dir = tempDir("discover");
  write(dir, "tests/b.test.mjs", "");
  write(dir, "tests/a.test.mjs", "");
  write(dir, "tests/fixtures.mjs", "");
  write(dir, "tests/notes.test.js", "");
  assert.deepEqual(discoverSteps(dir).map((s) => s.name), ["validate catalog", "a", "b", "smoke test"]);
  assert.deepEqual(discoverSteps(tempDir("empty")).map((s) => s.name), ["validate catalog", "smoke test"]);
});

test("--list prints the steps without running them", () => {
  const { status, output } = runNode(path.join(ROOT, "tools/run-tests.mjs"), ["--list"]);
  assert.equal(status, 0, output);
  assert.match(output, /validate catalog\ttools\/validate-catalog\.mjs/);
  assert.match(output, /pipeline\ttests\/pipeline\.test\.mjs/);
});

test("runs every step even after a failure, and exits non-zero", () => {
  const dir = tempDir("runner");
  fs.mkdirSync(path.join(dir, "tools"));
  fs.copyFileSync(path.join(ROOT, "tools/run-tests.mjs"), path.join(dir, "tools/run-tests.mjs"));
  write(dir, "tools/validate-catalog.mjs", 'console.log("validate ran");\n');
  write(dir, "tests/a.test.mjs", 'console.log("a ran"); process.exit(3);\n');
  write(dir, "tests/b.test.mjs", 'console.log("b ran");\n');
  write(dir, "tools/smoke-test.mjs", 'console.log("smoke ran");\n');
  const bad = runNode(path.join(dir, "tools/run-tests.mjs"), [], dir);
  assert.equal(bad.status, 1, bad.output);
  for (const line of ["validate ran", "a ran", "b ran", "smoke ran", "exit code 3", "1 of 4 step(s) failed"]) {
    assert.ok(bad.output.includes(line), `output mentions "${line}"\n${bad.output}`);
  }
  write(dir, "tests/a.test.mjs", 'console.log("a ran");\n');
  const good = runNode(path.join(dir, "tools/run-tests.mjs"), [], dir);
  assert.equal(good.status, 0, good.output);
  assert.match(good.output, /All 4 step\(s\) passed/);
  const filtered = runNode(path.join(dir, "tools/run-tests.mjs"), ["b"], dir);
  assert.equal(filtered.status, 0);
  assert.ok(filtered.output.includes("b ran") && !filtered.output.includes("a ran"), filtered.output);
});

// ── smoke-test ───────────────────────────────────────────────────────────────
console.log("smoke-test");

const STYLESHEETS = ["app", "nowplaying"].map((n) => `assets/css/${n}.css`)
  .concat(["home", "search", "artists", "library", "album", "settings"].map((n) => `assets/css/views/${n}.css`));
const MODULES = ["config", "cloud", "catalog", "db", "player", "utils", "icons", "ui", "nowplaying", "app"].map((n) => `assets/js/${n}.js`);
const VIEWS = ["home", "search", "songs", "artists", "series", "library", "album", "playlist", "settings", "edit"].map((n) => `assets/js/views/${n}.js`);
const ICON_FILES = ["icon-192.png", "icon-512.png", "maskable-512.png", "apple-touch-icon.png"].map((n) => `assets/icons/${n}`);
const ICON_NAMES = ["home", "search", "library", "artists", "songs", "series", "settings", "play", "pause", "prev", "next",
  "shuffle", "repeat", "repeat-one", "heart", "heart-fill", "more", "plus", "check", "close", "chevron-down",
  "chevron-left", "chevron-right", "download", "downloaded", "queue", "volume", "volume-mute", "edit", "external",
  "refresh", "cloud", "cloud-off", "trash", "clock", "disc", "sort", "info", "alert", "key", "mic", "sparkle",
  "arrow-up", "arrow-down", "list", "grid", "play-fill", "pause-fill"];
const SIDEBAR = ["home", "search", "artists", "songs", "library", "liked", "history", "downloads", "settings"];
const CSP = "default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data: blob: https://huggingface.co https://*.hf.co https://i.ytimg.com; "
  + "media-src 'self' blob: https://huggingface.co https://*.hf.co; connect-src 'self' https://huggingface.co https://*.hf.co https://i.ytimg.com; "
  + "frame-src https://www.youtube.com https://www.youtube-nocookie.com; worker-src 'self'; manifest-src 'self'; "
  + "object-src 'none'; base-uri 'none'; form-action 'none'";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TABS = ["home", "search", "artists", "library"];

function shellFiles() {
  const files = {
    "index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${CSP}">
  <meta name="theme-color" content="#0a0a0b">
  <link rel="manifest" href="./manifest.webmanifest">
${STYLESHEETS.map((css) => `  <link rel="stylesheet" href="./${css}">`).join("\n")}
</head>
<body>
  <div id="app">
    <nav id="sidebar">${SIDEBAR.map((n) => `<a href="#/${n}" data-nav="${n}">${n}</a>`).join("")}<div id="playlist-nav"></div></nav>
    <main id="main"><div id="view"></div></main>
    <div id="player-bar"></div>
    <section id="now-playing"></section>
    <nav id="tabbar">${TABS.map((n) => `<a href="#/${n}" data-nav="${n}">${n}</a>`).join("")}</nav>
  </div>
  <audio id="local-audio" preload="auto"></audio>
  <div id="sheet-root"></div>
  <div id="toast-region" aria-live="polite"></div>
  <dialog id="dialog-playlist"><form id="playlist-form" method="dialog"></form></dialog>
  <dialog id="dialog-confirm"></dialog>
  <dialog id="dialog-prompt"></dialog>
  <input type="file" id="backup-import" accept="application/json" hidden>
  <svg id="icon-sprite" style="display:none" xmlns="http://www.w3.org/2000/svg">
${ICON_NAMES.map((n) => `    <symbol id="i-${n}" viewBox="0 0 24 24"><path d="M4 4h16"/></symbol>`).join("\n")}
  </svg>
  <script type="module" src="./assets/js/app.js"></script>
</body>
</html>
`,
    "404.html": "<!doctype html><meta http-equiv=\"refresh\" content=\"0; url=./\">\n",
    "manifest.webmanifest": JSON.stringify({
      name: "Acoustify", start_url: "./", scope: "./", display: "standalone",
      icons: [{ src: "./assets/icons/icon-192.png", sizes: "192x192" }, { src: "./assets/icons/icon-512.png", sizes: "512x512" }]
    }),
    "sw.js": `const APP_VERSION = "dev";
const HUB = "https://huggingface.co";
const REPO = "arjun10g/acoustify-library";
const SHELL_CACHE = \`acoustify-shell-\${APP_VERSION}\`;
const CACHES = ["acoustify-audio-v1", "acoustify-art-v1", "acoustify-auth"];
const TOKEN_KEY = "./__hf_token__";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./data/library.json",
${[...STYLESHEETS, ...MODULES, ...VIEWS, ...ICON_FILES].map((f) => `  "./${f}"`).join(",\n")}
];
self.addEventListener("message", (event) => { if (event.data?.type === "SKIP_WAITING") self.skipWaiting(); });
`,
    "data/library.json": JSON.stringify({
      schema: 2, repo: "arjun10g/acoustify-library", revision: COMMIT,
      sources: [{ id: "s", audio: { path: "media/AAAAAAAAAAA.m4a", rev: COMMIT }, art: { path: "artwork/AAAAAAAAAAA.jpg", rev: COMMIT }, tracks: [{ id: "t" }] }]
    }),
    "assets/js/config.js": 'export const CONFIG = Object.freeze({\n  APP_VERSION: "dev",\n  HUB: "https://huggingface.co",\n  REPO: "arjun10g/acoustify-library"\n});\n',
    "assets/js/icons.js": "export function icon(name) { return name; }\n",
    "assets/js/ui.js": 'import { icon } from "./icons.js";\n/* accepts "audio/*" files */\nexport const html = (s) => s;\nexport function toast() { return icon("x"); }\n',
    "assets/js/app.js": 'import { CONFIG } from "./config.js";\nimport { html, toast as showToast } from "./ui.js";\nimport { renderHome } from "./views/home.js";\n// import { gone } from "./missing.js";\nexport default { CONFIG, html, showToast, renderHome };\n'
  };
  for (const file of [...MODULES, ...VIEWS]) {
    if (!(file in files)) files[file] = `export function ${path.basename(file, ".js").replace(/\W/g, "")}Stub() {}\n`;
  }
  files["assets/js/views/home.js"] = 'import { html } from "../ui.js";\nexport function renderHome() { return html``; }\n';
  for (const css of STYLESHEETS) files[css] = css.includes("/views/") ? "" : ":root { color-scheme: dark; }\n";
  for (const png of ICON_FILES) files[png] = "\x89PNG fixture";
  return files;
}

function runSmoke(mutate = () => {}) {
  const dir = tempDir("smoke");
  const files = shellFiles();
  mutate(files);
  for (const [file, content] of Object.entries(files)) if (content !== null) write(dir, file, content);
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "tools/smoke-test.mjs"), path.join(dir, "tools/smoke-test.mjs"));
  return runNode(path.join(dir, "tools/smoke-test.mjs"), [], dir);
}

test("passes on a shell that meets every contract", () => {
  const { status, output } = runSmoke();
  assert.equal(status, 0, output);
  assert.match(output, /Static smoke test passed/);
});

const failures = [
  ["a missing view module", (f) => { f["assets/js/views/edit.js"] = null; }, /Missing assets\/js\/views\/edit\.js/],
  ["a missing container id", (f) => { f["index.html"] = f["index.html"].replace(' id="toast-region"', ""); }, /missing #toast-region/],
  ["a missing icon symbol", (f) => { f["index.html"] = f["index.html"].replace('id="i-heart-fill"', 'id="i-hearts"'); }, /i-heart-fill/],
  ["stylesheets out of order", (f) => {
    f["index.html"] = f["index.html"].replace('href="./assets/css/views/home.css"', 'href="./tmp.css"')
      .replace('href="./assets/css/views/search.css"', 'href="./assets/css/views/home.css"').replace('href="./tmp.css"', 'href="./assets/css/views/search.css"');
  }, /stylesheets must be, in order/],
  ["APP_VERSION drift between config.js and sw.js", (f) => {
    f["assets/js/config.js"] = f["assets/js/config.js"].replace('"dev"', '"abc1234"');
  }, /APP_VERSION differs/],
  ["a shell file the service worker does not precache", (f) => {
    f["sw.js"] = f["sw.js"].replace('  "./assets/js/views/edit.js",\n', "");
  }, /does not precache \.\/assets\/js\/views\/edit\.js/],
  ["a named import the module does not export", (f) => {
    f["assets/js/app.js"] = `import { nope } from "./config.js";\n${f["assets/js/app.js"]}`;
  }, /imports \{ nope \} from \.\/config\.js/],
  ["an import of a module that does not exist", (f) => {
    f["assets/js/app.js"] = `import "./views/missing.js";\n${f["assets/js/app.js"]}`;
  }, /imports \.\/views\/missing\.js, which does not exist/],
  ["an external CDN script", (f) => {
    f["index.html"] = f["index.html"].replace("</head>", '<script src="https://cdn.example.com/x.js"></script></head>');
  }, /external resources/],
  ["a bundled library that is not schema 2", (f) => { f["data/library.json"] = JSON.stringify({ schema: 1, sources: [] }); }, /schema 2/],
  ["a bundled library pinned to \"main\" (a dry run's pending upload)", (f) => {
    f["data/library.json"] = f["data/library.json"].replace(`"art":{"path":"artwork/AAAAAAAAAAA.jpg","rev":"${COMMIT}"}`, '"art":{"path":"artwork/AAAAAAAAAAA.jpg","rev":"main"}');
  }, /pins s art "main" to something other than a commit/],
  ["no Content-Security-Policy", (f) => {
    f["index.html"] = f["index.html"].replace(/ *<meta http-equiv="Content-Security-Policy"[^>]*>\n/, "");
  }, /no <meta http-equiv="Content-Security-Policy">/],
  ["a Content-Security-Policy after the stylesheets", (f) => {
    const tag = /<meta http-equiv="Content-Security-Policy"[^>]*>\n/.exec(f["index.html"])[0];
    f["index.html"] = f["index.html"].replace(tag, "").replace("</head>", `${tag}</head>`);
  }, /must come before every <link>/],
  ["a Content-Security-Policy that allows inline scripts", (f) => {
    f["index.html"] = f["index.html"].replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
  }, /script-src must not allow 'unsafe-inline'/],
  ["a Content-Security-Policy that lets forms submit", (f) => {
    f["index.html"] = f["index.html"].replace("; form-action 'none'", "");
  }, /must set form-action 'none'/],
  ["a Content-Security-Policy that blocks the dataset", (f) => {
    f["index.html"] = f["index.html"].replace("connect-src 'self' https://huggingface.co", "connect-src 'self'");
  }, /connect-src must allow https:\/\/huggingface\.co/]
];
for (const [name, mutate, pattern] of failures) {
  test(`fails on ${name}`, () => {
    const { status, output } = runSmoke(mutate);
    assert.equal(status, 1, output);
    assert.match(output, pattern);
  });
}

test("flags a leaked Hugging Face token without printing it", () => {
  const fakeToken = `hf${"_"}${"Q".repeat(20)}${"7".repeat(14)}`;
  const { status, output } = runSmoke((f) => { f["data/notes.md"] = `oops\ntoken: ${fakeToken}\n`; });
  assert.equal(status, 1, output);
  assert.match(output, /Possible Hugging Face token in data\/notes\.md:2/);
  assert.ok(!output.includes(fakeToken), "the token itself must never be printed");
});

// ── Python tools (offline self-tests) ────────────────────────────────────────
console.log("python tools");

function findPython() {
  const venv = path.join(ROOT, ".venv", "bin", "python");
  if (fs.existsSync(venv)) return venv;
  const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? "python3" : null;
}

const python = findPython();
for (const tool of ["tools/publish.py", "tools/add_music.py"]) {
  if (!python) {
    console.log(`  - ${tool} --self-test skipped (no .venv or python3)`);
    continue;
  }
  test(`${tool} --self-test`, () => {
    const result = spawnSync(python, [path.join(ROOT, tool), "--self-test"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /self-test: \d+ checks passed/);
  });
}

for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\npipeline: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
