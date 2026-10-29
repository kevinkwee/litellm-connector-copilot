import { rmSync } from "node:fs";
import console from "node:console";
import process from "node:process";

// Removes each directory named on the command line. Missing paths are not an
// error: clean runs before every build and on a fresh checkout none exist.
const targets = process.argv.slice(2);
if (targets.length === 0) {
    console.error("Usage: node scripts/clean.mjs <dir> [dir...]");
    process.exit(1);
}

for (const target of targets) {
    rmSync(target, { recursive: true, force: true });
}
