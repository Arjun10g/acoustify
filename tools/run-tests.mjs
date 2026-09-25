// Run every check the repo has, in order, and fail if any fails:
//
//   node tools/run-tests.mjs            validate catalog → tests/*.test.mjs → static smoke test
//   node tools/run-tests.mjs runtime    only steps whose name contains "runtime"
//   node tools/run-tests.mjs --list     print the steps without running them
//
// Each step runs in its own Node process so one file's globals or stubs never
// leak into the next.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function discoverSteps(root = ROOT) {
  const testsDir = path.join(root, "tests");
  const testFiles = fs.existsSync(testsDir)
    ? fs.readdirSync(testsDir).filter((name) => name.endsWith(".test.mjs")).sort()
    : [];
  return [
    { name: "validate catalog", file: "tools/validate-catalog.mjs" },
    ...testFiles.map((name) => ({ name: name.replace(/\.test\.mjs$/, ""), file: `tests/${name}` })),
    { name: "smoke test", file: "tools/smoke-test.mjs" }
  ];
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = paint("32");
const red = paint("31");
const dim = paint("2");
const bold = paint("1");

function runStep(step, root) {
  const full = path.join(root, step.file);
  if (!fs.existsSync(full)) return { ok: false, ms: 0, reason: `${step.file} is missing` };
  const started = performance.now();
  const result = spawnSync(process.execPath, [full], { cwd: root, stdio: "inherit", env: process.env });
  const ms = Math.round(performance.now() - started);
  if (result.error) return { ok: false, ms, reason: result.error.message };
  if (result.signal) return { ok: false, ms, reason: `killed by ${result.signal}` };
  return { ok: result.status === 0, ms, reason: result.status === 0 ? "" : `exit code ${result.status}` };
}

function main(argv) {
  const list = argv.includes("--list");
  const filters = argv.filter((arg) => !arg.startsWith("--")).map((arg) => arg.toLowerCase());
  const steps = discoverSteps().filter((step) =>
    !filters.length || filters.some((f) => step.name.toLowerCase().includes(f) || step.file.toLowerCase().includes(f)));

  if (list) {
    for (const step of steps) console.log(`${step.name}\t${step.file}`);
    return 0;
  }
  if (!steps.length) {
    console.error(`No test step matches: ${filters.join(", ")}`);
    return 1;
  }

  const results = [];
  for (const [index, step] of steps.entries()) {
    console.log(`\n${bold(`▶ [${index + 1}/${steps.length}] ${step.name}`)} ${dim(step.file)}`);
    const outcome = runStep(step, ROOT);
    results.push({ step, ...outcome });
    console.log(outcome.ok ? green(`✓ ${step.name} ${dim(`(${outcome.ms} ms)`)}`) : red(`✗ ${step.name} — ${outcome.reason}`));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${bold("Summary")}`);
  for (const r of results) console.log(`  ${r.ok ? green("✓") : red("✗")} ${r.step.name}${r.ok ? "" : red(`  (${r.reason})`)}`);
  console.log(failed.length
    ? red(`\n${failed.length} of ${results.length} step(s) failed.`)
    : green(`\nAll ${results.length} step(s) passed.`));
  return failed.length ? 1 : 0;
}

// realpath: os.tmpdir() and friends are symlinks on macOS, import.meta.url is not.
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
