import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  "index.html",
  "404.html",
  "manifest.webmanifest",
  "sw.js",
  "assets/css/app.css",
  "assets/js/app.js",
  "assets/js/catalog.js",
  "assets/js/db.js",
  "assets/js/player.js",
  "assets/js/utils.js",
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png",
  "assets/icons/maskable-512.png",
  "assets/icons/apple-touch-icon.png",
  "downloads/youtube_podcast_audio_extractor.zip",
  "data/catalog.json"
];
const errors = [];
for (const file of requiredFiles) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) errors.push(`Missing ${file}`);
  else if (fs.statSync(full).size === 0) errors.push(`Empty ${file}`);
}

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
for (const id of ["view", "youtube-player", "local-audio", "player-bar", "progress-control", "volume-control", "extracted-audio-import"]) {
  if (!html.includes(`id="${id}"`)) errors.push(`index.html is missing #${id}`);
}
for (const src of ["./assets/css/app.css", "./assets/js/app.js", "./manifest.webmanifest"]) {
  if (!html.includes(src)) errors.push(`index.html does not reference ${src}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
if (!String(manifest.start_url || "").startsWith("./")) errors.push("Manifest start_url must remain relative for project Pages sites.");
if (manifest.scope !== "./") errors.push("Manifest scope must be ./ for repository subpaths.");
if (manifest.display !== "standalone") errors.push("Manifest display must support an installed mobile app.");
if (!manifest.icons?.some((icon) => icon.sizes === "192x192") || !manifest.icons?.some((icon) => icon.sizes === "512x512")) errors.push("Manifest needs 192px and 512px install icons.");

for (const file of ["app.js", "catalog.js", "db.js", "player.js", "utils.js"]) {
  const source = fs.readFileSync(path.join(root, "assets", "js", file), "utf8");
  if (/\b(eval|new Function)\s*\(/.test(source)) errors.push(`${file} uses dynamic code evaluation.`);
}

if (errors.length) {
  console.error(`Static smoke test failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}
console.log(`Static smoke test passed: ${requiredFiles.length} required files present.`);
