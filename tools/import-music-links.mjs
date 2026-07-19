import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applyMusicLinksToCatalog, getMusicLinkEntries } from "./music-link-ingest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    file: "music-links.json",
    check: false,
    replace: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--replace") options.replace = true;
    else if (arg === "--file") options.file = argv[++index];
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

try {
  const options = parseArgs(process.argv.slice(2));
  const inboxPath = path.resolve(root, options.file);
  const catalogPath = path.join(root, "data", "catalog.json");

  if (!fs.existsSync(inboxPath)) {
    console.log(`No ${path.relative(root, inboxPath)} found. Copy music-links.example.json to music-links.json when you have links to import.`);
    process.exit(0);
  }

  const entries = getMusicLinkEntries(readJson(inboxPath));
  if (entries.length === 0) {
    console.log(`No active links found in ${path.relative(root, inboxPath)}.`);
    process.exit(0);
  }

  const currentCatalog = readJson(catalogPath);
  const result = applyMusicLinksToCatalog(currentCatalog, entries, { replace: options.replace });

  if (options.check) {
    console.log(`Music link check passed: ${entries.length} link(s) ready.`);
  } else {
    fs.writeFileSync(catalogPath, `${JSON.stringify(result.catalog, null, 2)}\n`);
    const added = result.summary.added.length;
    const updated = result.summary.updated.length;
    console.log(`Imported ${entries.length} link(s): ${added} added, ${updated} updated.`);
  }
} catch (error) {
  console.error(`Music link import failed: ${error.message}`);
  process.exit(1);
}
