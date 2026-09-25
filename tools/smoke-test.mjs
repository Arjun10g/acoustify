// Static checks of the deployable app shell — no browser, no network:
// required files, index.html contracts (container ids, nav, icon sprite, CSS
// order, module entry, Content-Security-Policy), service-worker/config version
// agreement and precache coverage, module import/export wiring, the bundled
// library (every file pinned to a real commit), and a scan for leaked Hugging
// Face tokens.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const fail = (message) => errors.push(message);
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (file) => fs.existsSync(path.join(root, file));
const versionOf = (text) => (/\bAPP_VERSION\s*[:=]\s*(["'])([^"'\n]*)\1/.exec(text) || [])[2];
const constOf = (text, name) => (new RegExp(`\\b${name}\\s*[:=]\\s*"([^"]*)"`).exec(text) || [])[1];

const JS_MODULES = ["config", "cloud", "catalog", "db", "player", "utils", "icons", "ui", "nowplaying", "app"]
  .map((name) => `assets/js/${name}.js`);
const VIEW_MODULES = ["home", "search", "songs", "artists", "series", "library", "album", "playlist", "settings", "edit"]
  .map((name) => `assets/js/views/${name}.js`);
const STYLESHEETS = [
  "assets/css/app.css",
  "assets/css/nowplaying.css",
  ...["home", "search", "artists", "library", "album", "settings"].map((name) => `assets/css/views/${name}.css`)
];
const ICONS = ["icon-192.png", "icon-512.png", "maskable-512.png", "apple-touch-icon.png"].map((name) => `assets/icons/${name}`);
const REQUIRED = ["index.html", "404.html", "manifest.webmanifest", "sw.js", "data/library.json",
  ...STYLESHEETS, ...JS_MODULES, ...VIEW_MODULES, ...ICONS];
// View stylesheets "may be tiny" — they only have to exist.
const MAY_BE_EMPTY = new Set(STYLESHEETS.filter((file) => file.includes("/views/")));

const CONTAINER_IDS = ["app", "sidebar", "playlist-nav", "main", "view", "player-bar", "now-playing", "tabbar",
  "local-audio", "sheet-root", "toast-region", "dialog-playlist", "playlist-form", "dialog-confirm", "dialog-prompt",
  "backup-import", "icon-sprite"];
const SIDEBAR_NAV = ["home", "search", "artists", "songs", "library", "liked", "history", "downloads", "settings"];
const TABBAR_NAV = ["home", "search", "artists", "library"];
const ICON_NAMES = ["home", "search", "library", "artists", "songs", "series", "settings", "play", "pause", "prev", "next",
  "shuffle", "repeat", "repeat-one", "heart", "heart-fill", "more", "plus", "check", "close", "chevron-down",
  "chevron-left", "chevron-right", "download", "downloaded", "queue", "volume", "volume-mute", "edit", "external",
  "refresh", "cloud", "cloud-off", "trash", "clock", "disc", "sort", "info", "alert", "key", "mic", "sparkle",
  "arrow-up", "arrow-down", "list", "grid", "play-fill", "pause-fill"];
const TOKEN_PATTERN = /hf_[A-Za-z0-9]{30,}/;

// ── Required files ───────────────────────────────────────────────────────────
for (const file of REQUIRED) {
  if (!exists(file)) fail(`Missing ${file}`);
  else if (!MAY_BE_EMPTY.has(file) && fs.statSync(path.join(root, file)).size === 0) fail(`Empty ${file}`);
}

// ── index.html contracts ─────────────────────────────────────────────────────
function elementById(html, id) {
  const match = new RegExp(`<([a-z][\\w-]*)\\b[^>]*\\sid="${id}"[^>]*>`, "i").exec(html);
  return match ? { tag: match[1].toLowerCase(), index: match.index } : null;
}

function sectionOf(html, id) {
  // Text from the element's opening tag to its matching close (good enough for nav containers).
  const found = elementById(html, id);
  if (!found) return "";
  const open = new RegExp(`<${found.tag}\\b`, "gi");
  const close = new RegExp(`</${found.tag}>`, "gi");
  let depth = 0;
  let cursor = found.index;
  for (;;) {
    open.lastIndex = cursor + 1;
    close.lastIndex = cursor + 1;
    const nextOpen = open.exec(html);
    const nextClose = close.exec(html);
    if (!nextClose) return html.slice(found.index);
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index;
    } else if (depth > 0) {
      depth -= 1;
      cursor = nextClose.index;
    } else {
      return html.slice(found.index, nextClose.index);
    }
  }
}

if (exists("index.html")) {
  const html = read("index.html");
  for (const id of CONTAINER_IDS) if (!elementById(html, id)) fail(`index.html is missing #${id}`);
  const audio = elementById(html, "local-audio");
  if (audio && audio.tag !== "audio") fail("#local-audio must be an <audio> element");
  if (elementById(html, "icon-sprite")?.tag !== "svg") fail("#icon-sprite must be an inline <svg>");
  for (const id of ["dialog-playlist", "dialog-confirm", "dialog-prompt"]) {
    const el = elementById(html, id);
    if (el && el.tag !== "dialog") fail(`#${id} must be a <dialog>`);
  }

  const sidebar = sectionOf(html, "sidebar");
  for (const nav of SIDEBAR_NAV) if (!sidebar.includes(`data-nav="${nav}"`)) fail(`#sidebar has no data-nav="${nav}" link`);
  const tabbar = sectionOf(html, "tabbar");
  for (const nav of TABBAR_NAV) if (!tabbar.includes(`data-nav="${nav}"`)) fail(`#tabbar has no data-nav="${nav}" link`);

  const sprite = sectionOf(html, "icon-sprite");
  const missingIcons = ICON_NAMES.filter((name) => !new RegExp(`<symbol\\b[^>]*\\sid="i-${name}"`).test(sprite));
  if (missingIcons.length) fail(`Icon sprite is missing: ${missingIcons.map((n) => `i-${n}`).join(", ")}`);

  if (!/<script\b(?=[^>]*\btype="module")(?=[^>]*\bsrc="\.\/assets\/js\/app\.js")[^>]*>\s*<\/script>/.test(html)) {
    fail('index.html must load <script type="module" src="./assets/js/app.js">');
  }
  if (!/<link\b[^>]*\brel="manifest"[^>]*\bhref="\.\/manifest\.webmanifest"|<link\b[^>]*\bhref="\.\/manifest\.webmanifest"[^>]*\brel="manifest"/.test(html)) {
    fail("index.html must link ./manifest.webmanifest");
  }
  const stylesheetHrefs = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => /\brel="stylesheet"/.test(tag))
    .map((tag) => (/\bhref="([^"]+)"/.exec(tag) || [])[1]);
  const expectedCss = STYLESHEETS.map((file) => `./${file}`);
  const actualCss = stylesheetHrefs.filter((href) => expectedCss.includes(href));
  if (JSON.stringify(actualCss) !== JSON.stringify(expectedCss)) {
    fail(`index.html stylesheets must be, in order: ${expectedCss.join(", ")} (found ${stylesheetHrefs.join(", ") || "none"})`);
  }
  const external = [...html.matchAll(/<(script|link)\b[^>]*\b(?:src|href)="(https?:)?\/\/[^"]+"[^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => /^<script/i.test(tag) || /\brel="(stylesheet|preload|modulepreload|icon)"/.test(tag));
  if (external.length) fail(`index.html loads external resources (no CDNs allowed): ${external.join(" ")}`);
  if (!/<meta\b[^>]*name="theme-color"/.test(html)) fail("index.html is missing <meta name=\"theme-color\">");
  checkContentSecurityPolicy(html);
}

// ── Content-Security-Policy (index.html <meta>) ──────────────────────────────
// GitHub Pages can't send headers, so the policy is a <meta> tag. It only covers
// what comes after it, and it has to keep allowing what the app really loads:
// the dataset (HUB) and the CDN it redirects to, YouTube stills and the iframe API.
function checkContentSecurityPolicy(html) {
  const tag = /<meta\b[^>]*\bhttp-equiv="Content-Security-Policy"[^>]*>/i.exec(html);
  if (!tag) {
    fail('index.html has no <meta http-equiv="Content-Security-Policy">.');
    return;
  }
  const firstResource = html.search(/<(link|script|style)\b/i);
  if (firstResource !== -1 && firstResource < tag.index) {
    fail("index.html: the Content-Security-Policy <meta> must come before every <link>, <script> and <style>.");
  }
  const content = (/\bcontent="([^"]*)"/i.exec(tag[0]) || [])[1] || "";
  const directives = new Map(content.split(";").map((part) => part.trim().split(/\s+/)).filter((words) => words[0])
    .map(([name, ...sources]) => [name.toLowerCase(), sources]));
  const sourcesFor = (name) => directives.get(name) || directives.get("default-src") || null;
  const allows = (name, source) => (sourcesFor(name) || []).includes(source);
  const requireExactly = (name, allowed) => {
    const sources = directives.get(name);
    if (!sources || sources.length !== 1 || !allowed.includes(sources[0])) {
      fail(`Content-Security-Policy must set ${name} ${allowed.join(" or ")} (found ${sources ? sources.join(" ") || "nothing" : "no directive"}).`);
    }
  };

  const scripts = sourcesFor("script-src");
  if (!scripts) fail("Content-Security-Policy needs script-src (or default-src).");
  else {
    const loose = scripts.filter((s) => /^'unsafe-|^\*$|^(https?|data|blob):$/i.test(s));
    if (loose.length) fail(`Content-Security-Policy script-src must not allow ${loose.join(" ")}.`);
  }
  requireExactly("object-src", ["'none'"]);
  requireExactly("base-uri", ["'none'", "'self'"]);
  requireExactly("form-action", ["'none'"]); // the token form must never be submitted as a URL

  const hub = exists("assets/js/config.js") ? constOf(read("assets/js/config.js"), "HUB") : null;
  for (const name of ["connect-src", "img-src", "media-src"]) {
    for (const source of [hub, "https://*.hf.co"].filter(Boolean)) {
      if (!allows(name, source)) fail(`Content-Security-Policy ${name} must allow ${source} (the dataset and the CDN it redirects to).`);
    }
  }
  const appCode = walk(path.join(root, "assets", "js"), (name) => name.endsWith(".js"))
    .map((file) => fs.readFileSync(file, "utf8")).join("\n");
  if (appCode.includes("https://i.ytimg.com/") && !allows("img-src", "https://i.ytimg.com")) {
    fail("Content-Security-Policy img-src must allow https://i.ytimg.com (fallback artwork).");
  }
  if (appCode.includes("https://www.youtube.com/iframe_api") && !allows("script-src", "https://www.youtube.com")) {
    fail("Content-Security-Policy script-src must allow https://www.youtube.com (the YouTube player API).");
  }
}

// ── Manifest ─────────────────────────────────────────────────────────────────
if (exists("manifest.webmanifest")) {
  try {
    const manifest = JSON.parse(read("manifest.webmanifest"));
    if (!String(manifest.start_url || "").startsWith("./")) fail("Manifest start_url must stay relative for a project Pages site.");
    if (manifest.scope !== "./") fail("Manifest scope must be ./ for the repository subpath.");
    if (manifest.display !== "standalone") fail("Manifest display must be standalone (installable app).");
    const sizes = new Set((manifest.icons || []).map((icon) => icon.sizes));
    if (!sizes.has("192x192") || !sizes.has("512x512")) fail("Manifest needs 192px and 512px icons.");
    for (const icon of manifest.icons || []) {
      const file = String(icon.src || "").replace(/^\.\//, "");
      if (file && !/^https?:/.test(file) && !exists(file)) fail(`Manifest icon ${icon.src} does not exist.`);
    }
  } catch (error) {
    fail(`manifest.webmanifest is not valid JSON: ${error.message}`);
  }
}

// ── Service worker ⇄ config ──────────────────────────────────────────────────
if (exists("sw.js") && exists("assets/js/config.js")) {
  const sw = read("sw.js");
  const config = read("assets/js/config.js");
  const swVersion = versionOf(sw);
  const configVersion = versionOf(config);
  if (!swVersion) fail("sw.js has no APP_VERSION assignment (tools/stamp-version.mjs needs it).");
  if (!configVersion) fail("assets/js/config.js has no APP_VERSION (tools/stamp-version.mjs needs it).");
  if (swVersion && configVersion && swVersion !== configVersion) {
    fail(`APP_VERSION differs: config.js "${configVersion}" vs sw.js "${swVersion}".`);
  }
  if (!sw.includes("acoustify-shell-")) fail('sw.js must name its shell cache with the "acoustify-shell-" prefix.');
  for (const name of ["acoustify-audio-v1", "acoustify-art-v1", "acoustify-auth", "SKIP_WAITING"]) {
    if (!sw.includes(name)) fail(`sw.js does not mention ${name}.`);
  }
  for (const name of ["HUB", "REPO"]) {
    const a = constOf(sw, name);
    const b = constOf(config, name);
    if (a && b && a !== b) fail(`${name} differs between sw.js ("${a}") and config.js ("${b}").`);
  }

  // Every shell file must be precached, and every precached path must exist.
  const literals = new Set([...sw.matchAll(/["'`](\.\/[^"'`$\s]*)["'`]/g)].map((m) => m[1]));
  for (const file of ["index.html", "manifest.webmanifest", "data/library.json", ...STYLESHEETS, ...JS_MODULES, ...VIEW_MODULES, ...ICONS]) {
    if (!literals.has(`./${file}`)) fail(`sw.js does not precache ./${file}`);
  }
  for (const literal of literals) {
    const file = literal.slice(2);
    if (/\.[a-z0-9]+$/i.test(file) && !file.startsWith("__") && !exists(file) && !REQUIRED.includes(file)) {
      fail(`sw.js references ./${file}, which does not exist.`);
    }
  }
}

// ── Module wiring: every relative import resolves and every named import is exported ──
function walk(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, out);
    else if (predicate(entry.name)) out.push(full);
  }
  return out;
}

// Only comments that start a line: stripping "/*" inside strings like "audio/*" would eat real code.
const stripComments = (source) => source
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

function exportsOf(source) {
  const code = source; // a commented-out export counting as real is harmless; missing a real one is not
  if (/\bexport\s*\*\s*from\b/.test(code) || /\bexport\s+(const|let|var)\s*[{[]/.test(code)) return null; // too dynamic to check
  const names = new Set();
  for (const m of code.matchAll(/\bexport\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bexport\s+default\b/g)) names.add("default");
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const spec = part.trim();
      if (!spec) continue;
      const alias = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(spec);
      names.add(alias ? alias[1] : spec.split(/\s+/)[0]);
    }
  }
  // const a = 1, b = 2 after `export const` — pick up the trailing declarators.
  for (const m of code.matchAll(/\bexport\s+(?:const|let|var)\s+[^;]*?,\s*([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  return names;
}

const jsFiles = walk(path.join(root, "assets", "js"), (name) => name.endsWith(".js"));
const exportCache = new Map();
for (const file of jsFiles) {
  const rel = path.relative(root, file);
  const source = fs.readFileSync(file, "utf8");
  const code = stripComments(source);
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(code)) fail(`${rel} uses dynamic code evaluation.`);

  const imports = [
    ...[...code.matchAll(/^[ \t]*import\s+([\w$*{}\s,]+?)\s+from\s+["']([^"']+)["']/gm)].map((m) => ({ clause: m[1], spec: m[2] })),
    ...[...code.matchAll(/^[ \t]*export\s*\{([^}]*)\}\s*from\s+["']([^"']+)["']/gm)].map((m) => ({ clause: `{${m[1]}}`, spec: m[2] })),
    ...[...code.matchAll(/^[ \t]*import\s*["']([^"']+)["']/gm)].map((m) => ({ clause: "", spec: m[1] })),
    ...[...code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => ({ clause: "", spec: m[1] }))
  ];
  for (const { clause, spec } of imports) {
    if (!spec.startsWith(".")) {
      fail(`${rel} imports "${spec}" — the app must only import its own relative modules.`);
      continue;
    }
    const target = path.resolve(path.dirname(file), spec);
    const targetRel = path.relative(root, target);
    if (!fs.existsSync(target)) {
      fail(`${rel} imports ${spec}, which does not exist (${targetRel}).`);
      continue;
    }
    const named = /\{([^}]*)\}/.exec(clause);
    if (!named) continue;
    if (!exportCache.has(target)) exportCache.set(target, exportsOf(fs.readFileSync(target, "utf8")));
    const available = exportCache.get(target);
    if (!available) continue;
    for (const part of named[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && !available.has(name)) fail(`${rel} imports { ${name} } from ${spec}, but ${targetRel} does not export it.`);
    }
  }
}

// ── Bundled library (data/library.json, written by tools/publish.py) ─────────
if (exists("data/library.json")) {
  try {
    const library = JSON.parse(read("data/library.json"));
    if (library.schema !== 2) fail(`data/library.json must be schema 2 (found ${library.schema}).`);
    if (!Array.isArray(library.sources)) fail("data/library.json has no sources array.");
    if (library.repo && exists("assets/js/config.js")) {
      const repo = constOf(read("assets/js/config.js"), "REPO");
      if (repo && library.repo !== repo) fail(`data/library.json repo "${library.repo}" differs from config.js REPO "${repo}".`);
    }
    // Only a real publish writes this file, and it pins every file to the commit
    // that holds it. Anything else ("main", a dry run's pending upload) would ship
    // phones songs whose files may not exist on the dataset.
    const COMMIT = /^[0-9a-f]{40}$/;
    const unpinned = [];
    if (library.revision !== undefined && !COMMIT.test(String(library.revision))) unpinned.push(`revision "${library.revision}"`);
    for (const source of library.sources || []) {
      if (!source?.id) fail("data/library.json has a source without an id.");
      else if (!source.audio?.path || !source.audio?.rev) fail(`data/library.json ${source.id}: audio needs path and rev.`);
      else if (!Array.isArray(source.tracks) || !source.tracks.length) fail(`data/library.json ${source.id}: no tracks.`);
      for (const key of ["audio", "art"]) {
        const rev = source?.[key]?.rev;
        if (rev !== undefined && !COMMIT.test(String(rev))) unpinned.push(`${source.id} ${key} "${rev}"`);
      }
    }
    if (unpinned.length) {
      fail(`data/library.json pins ${unpinned.slice(0, 3).join(", ")}${unpinned.length > 3 ? ` and ${unpinned.length - 3} more` : ""} `
        + "to something other than a commit. Only a real publish (npm run publish) may write this file.");
    }
  } catch (error) {
    fail(`data/library.json is not valid JSON: ${error.message}`);
  }
}

// ── Leaked Hugging Face tokens (never print the match itself) ─────────────────
const SKIP_DIRS = new Set([".git", ".venv", "node_modules", "library", "media", "local-audio", "test-results", "_site",
  "__pycache__", ".github-cache"]);
const TEXT_EXT = /\.(m?js|cjs|json|webmanifest|html|css|md|txt|py|sh|ya?ml|toml|cfg|ini|svg|example)$/i;
function scanForTokens(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".env")) continue; // the one place the token is allowed (gitignored, never deployed)
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !full.includes(`${path.sep}.venv`)) scanForTokens(full);
      continue;
    }
    if (!TEXT_EXT.test(entry.name) && entry.name !== ".gitignore") continue;
    if (fs.statSync(full).size > 5_000_000) continue;
    const lines = fs.readFileSync(full, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (TOKEN_PATTERN.test(line)) fail(`Possible Hugging Face token in ${path.relative(root, full)}:${index + 1} — remove it and revoke the token.`);
    });
  }
}
scanForTokens(root);

// ── Report ───────────────────────────────────────────────────────────────────
if (errors.length) {
  console.error(`Static smoke test failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}
console.log(`Static smoke test passed: ${REQUIRED.length} required files, ${jsFiles.length} modules wired, shell contracts intact.`);
