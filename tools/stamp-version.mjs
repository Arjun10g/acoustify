// Stamp the deployed app with a version (CI passes the short commit SHA):
//
//   node tools/stamp-version.mjs 1a2b3c4
//   node tools/stamp-version.mjs 1a2b3c4 --root path/to/copy   (tests)
//
// Rewrites APP_VERSION in assets/js/config.js and sw.js. The service worker's
// shell cache name derives from it, so every deploy installs a fresh shell and
// the installed PWA picks up the new code.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const STAMPED_FILES = ["assets/js/config.js", "sw.js"];
const PATTERN = /(\bAPP_VERSION\s*[:=]\s*)(["'])[^"'\n]*\2/g;

export function stampSource(text, version) {
  let count = 0;
  const next = text.replace(PATTERN, (_, lead, quote) => {
    count += 1;
    return `${lead}${quote}${version}${quote}`;
  });
  return { text: next, count };
}

export function readVersion(text) {
  const match = /\bAPP_VERSION\s*[:=]\s*(["'])([^"'\n]*)\1/.exec(text);
  return match ? match[2] : null;
}

function parseArgs(argv) {
  const args = { version: "", root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") args.root = path.resolve(argv[++i] || "");
    else if (!args.version) args.version = argv[i].trim();
    else throw new Error(`Unexpected argument: ${argv[i]}`);
  }
  return args;
}

function main() {
  const { version, root } = parseArgs(process.argv.slice(2));
  if (!/^[\w.-]{1,64}$/.test(version)) {
    throw new Error(`Usage: node tools/stamp-version.mjs <version>  (letters, digits, "." "_" "-"; got "${version}")`);
  }
  // Check every file before writing any, so a failure never leaves a half-stamped app.
  const updates = STAMPED_FILES.map((file) => {
    const full = path.join(root, file);
    if (!fs.existsSync(full)) throw new Error(`${file} not found`);
    const { text, count } = stampSource(fs.readFileSync(full, "utf8"), version);
    if (count === 0) throw new Error(`${file}: no APP_VERSION assignment found`);
    return { file, full, text };
  });
  for (const { file, full, text } of updates) {
    fs.writeFileSync(full, text);
    console.log(`${file}: APP_VERSION = "${version}"`);
  }
}

// realpath: os.tmpdir() and friends are symlinks on macOS, import.meta.url is not.
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(`stamp-version failed: ${error.message}`);
    process.exit(1);
  }
}
