#!/usr/bin/env node
/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("fs");
const path = require("path");

// require() of ES modules needs Node >= 22.12.
const { bumpVersion } = require("./versionUtils.mjs");

const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const args = process.argv.slice(2);
const isDevRequested = args.includes("dev");
const bumpType = args.find((arg) => ["patch", "minor", "major"].includes(arg)) || (isDevRequested ? "none" : "patch");

const validBumpArgs = ["patch", "minor", "major", "dev"];
if (args.some((arg) => !validBumpArgs.includes(arg))) {
    console.error("Usage: npm run bump-version [patch|minor|major] [dev]");
    console.error("  patch: 0.1.0 -> 0.1.1");
    console.error("  minor: 0.1.0 -> 0.2.0");
    console.error("  major: 0.1.0 -> 1.0.0");
    console.error("  dev:   0.1.0 -> 0.1.0-dev.1 (or increments -dev.N if present)");
    console.error("  patch dev: 0.1.0 -> 0.1.1-dev.1");
    process.exit(1);
}

const oldVersion = packageJson.version;

let newVersion;
try {
    // Without a core bump, increment the dev counter in place; with one,
    // start a fresh dev.1 cycle on the bumped version.
    newVersion = isDevRequested
        ? bumpVersion(oldVersion, bumpType, "dev", bumpType === "none" ? "inc" : "bump")
        : bumpVersion(oldVersion, bumpType, null);
} catch {
    console.error(`Invalid version format in package.json: ${oldVersion}`);
    process.exit(1);
}

packageJson.version = newVersion;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, "\t") + "\n");
console.log(`Version bumped: ${oldVersion} -> ${newVersion}`);
process.stdout.write(`${oldVersion} -> ${newVersion}`);
