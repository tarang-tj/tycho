// Cheap lint fallback: no bundler, no eslint dependency to install. Runs
// `node --check` (parse-only, no execution) over every web/*.js and
// scripts/*.mjs file so a syntax error fails the gate before it reaches the
// browser or a test run.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function jsFilesIn(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".js") || f.endsWith(".mjs")).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

const targets = [
  ...jsFilesIn(join(root, "web")),
  ...jsFilesIn(join(root, "scripts")),
  ...jsFilesIn(join(root, "tests")),
];

if (targets.length === 0) {
  console.error("check_syntax: no .js/.mjs files found to check");
  process.exit(1);
}

let failed = false;
for (const file of targets) {
  try {
    // --check parses without executing (no module-load side effects, no
    // network calls for the `three` import in web/scene.js).
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    failed = true;
    console.error(`SYNTAX ERROR: ${file}`);
    console.error(error.stderr?.toString() || error.message);
  }
}

if (failed) {
  process.exit(1);
}
console.log(`check_syntax: ${targets.length} files OK`);
