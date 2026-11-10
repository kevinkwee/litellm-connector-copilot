import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import https from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const DTS_ENTRY = createRequire(import.meta.url).resolve("@vscode/dts/index.js");
const TYPES_DIR = "src";
const VSCODE_BRANCH = "main";
// `dts` leaves its sockets open after a failed download, so this bound turns a missing file
// into a message instead of a hang.
const DTS_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Proposals that only switch on a `package.json` capability. VS Code publishes no typings
 * for them, so the script skips them rather than asking for the 404 it expects.
 */
const CAPABILITY_ONLY_PROPOSALS = new Set(["agentsWindowActivation"]);

const buildProposalUrl = (name) =>
    `https://raw.githubusercontent.com/microsoft/vscode/${VSCODE_BRANCH}/src/vscode-dts/vscode.proposed.${name}.d.ts`;

/**
 * The proposal name without its `@version` suffix, which is how `dts` names the typings
 * file it writes.
 */
function proposalName(entry) {
    const versionSeparator = entry.lastIndexOf("@");
    return versionSeparator < 0 ? entry : entry.slice(0, versionSeparator);
}

/**
 * Runs one typings download and fails with a diagnostic when it cannot finish.
 *
 * `dts` reports a missing file as `Failed to get <url>` and then keeps the process alive,
 * so its output is inspected before the bound is reported as the cause.
 */
function runDts(args, workingDirectory) {
    const result = spawnSync(process.execPath, [DTS_ENTRY, ...args], {
        cwd: workingDirectory,
        encoding: "utf8",
        timeout: DTS_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    process.stdout.write(output);

    const failedDownload = /^Failed to get (\S+)$/m.exec(output);
    if (failedDownload) {
        throw new Error(
            `dts could not download ${failedDownload[1]}. The file is missing from VS Code ${VSCODE_BRANCH}, or that branch cannot be reached.`
        );
    }
    if (result.error?.code === "ETIMEDOUT") {
        throw new Error(`dts ${args.join(" ")} did not finish within ${DTS_TIMEOUT_MS / 1000} seconds.`);
    }
    if (result.error) {
        throw new Error(`dts ${args.join(" ")} could not run: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`dts ${args.join(" ")} failed with exit code ${result.status}`);
    }
}

/**
 * Copies a downloaded typings file into `src/`.
 *
 * A rename cannot cross volumes and the download lives on the system temp volume, so the
 * copy goes into a sibling first and is then renamed over the target. A write that fails
 * partway therefore leaves the existing file in place.
 */
function copyIntoPlace(source, fileName) {
    const target = join(TYPES_DIR, fileName);
    const partial = `${target}.${process.pid}.tmp`;
    try {
        copyFileSync(source, partial);
        renameSync(partial, target);
    } finally {
        rmSync(partial, { force: true });
    }
    process.stdout.write(`Copied ${fileName} into ${TYPES_DIR}/\n`);
}

/**
 * True when VS Code publishes typings for this proposal on the branch.
 *
 * An inconclusive probe (no direct network, a proxy the probe cannot use) counts as
 * present, so `dts`, which honours `HTTPS_PROXY`, makes the decision and reports its own
 * failure.
 */
function hasProposalTypings(name) {
    const url = buildProposalUrl(name);
    return new Promise((resolve) => {
        const request = https.request(url, { method: "HEAD", timeout: PROBE_TIMEOUT_MS }, (response) => {
            response.resume();
            resolve((response.statusCode ?? 0) !== 404);
        });
        request.on("timeout", () => request.destroy());
        request.on("error", () => resolve(true));
        request.end();
    });
}

function readEnabledProposals() {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const proposals = manifest.enabledApiProposals;
    return Array.isArray(proposals) ? proposals.filter((entry) => typeof entry === "string") : [];
}

/**
 * The proposals to download, after refusing a manifest that names one VS Code does not
 * publish.
 *
 * The capability-only proposals are answered without a probe, because they are the only
 * ones where a missing typings file is expected rather than a manifest mistake. Both forms
 * of each name are returned: the entries go into the downloader's manifest, so it can still
 * report a version mismatch, and the names identify the files it writes.
 */
async function selectProposals() {
    const all = readEnabledProposals();
    const names = all.map(proposalName);
    const verdicts = await Promise.all(
        names.map(async (name) => {
            if (CAPABILITY_ONLY_PROPOSALS.has(name)) {
                return "capability";
            }
            return (await hasProposalTypings(name)) ? "typings" : "missing";
        })
    );

    const entries = [];
    const downloadable = [];
    const unexpected = [];
    all.forEach((entry, index) => {
        const verdict = verdicts[index];
        if (verdict === "capability") {
            process.stdout.write(`${entry} carries a capability only, so it has no typings to download.\n`);
        } else if (verdict === "typings") {
            entries.push(entry);
            downloadable.push(names[index]);
        } else {
            unexpected.push(entry);
        }
    });
    if (unexpected.length > 0) {
        throw new Error(
            `No typings for ${unexpected.join(", ")} on VS Code ${VSCODE_BRANCH}. Remove the proposal from enabledApiProposals or fix its spelling.`
        );
    }
    return { entries, downloadable };
}

/** Deletes typings for a proposal this run did not download. */
function removeNotDownloadedProposalTypings(downloaded) {
    const produced = new Set(downloaded);
    for (const entry of readdirSync(TYPES_DIR)) {
        const proposal = /^vscode\.proposed\.(.*)\.d\.ts$/.exec(entry);
        if (proposal && !produced.has(proposal[1])) {
            rmSync(join(TYPES_DIR, entry), { force: true });
            process.stdout.write(`Removed stale ${entry}\n`);
        }
    }
}

/** Downloads `vscode.d.ts` into the scratch folder and returns its path. */
function downloadVscodeTypes(scratch) {
    runDts(["main"], scratch);
    const types = join(scratch, "vscode.d.ts");
    if (!existsSync(types)) {
        throw new Error("dts main did not produce vscode.d.ts");
    }
    return types;
}

/**
 * Downloads the proposals into the scratch folder and returns that folder and the names it
 * produced.
 *
 * `dts dev` fails on a proposal that publishes nothing, so it runs in a folder whose
 * manifest lists only the downloadable ones. Every proposal in that list has to arrive,
 * because `main` copies only what arrived and then deletes the `src/` typings of every other
 * proposal, which would drop one the manifest still declares.
 */
function downloadProposals(scratch, entries, downloadable) {
    const folder = join(scratch, "proposals");
    mkdirSync(folder);
    writeFileSync(join(folder, "package.json"), JSON.stringify({ enabledApiProposals: entries }));
    runDts(["dev"], folder);

    const downloaded = readdirSync(folder)
        .map((entry) => /^vscode\.proposed\.(.*)\.d\.ts$/.exec(entry))
        .filter((match) => match !== null)
        .map((match) => match[1]);
    const missing = downloadable.filter((name) => !downloaded.includes(name));
    if (missing.length > 0) {
        throw new Error(`dts dev did not download ${missing.join(", ")}.`);
    }
    return { folder, downloaded };
}

/**
 * Deletes the `@types/vscode` copy that conflicts with the downloaded typings.
 *
 * `src/vscode.d.ts` and `@types/vscode` both declare the `vscode` module, so the compiler
 * would read two copies. `dts` looks for that copy only under its own working directory,
 * which is the scratch folder, so the script removes it here instead. It runs only after the
 * copies, so a failed run leaves the tree unchanged.
 */
function removeConflictingVscodeTypes() {
    const conflict = join("node_modules", "@types", "vscode");
    if (!existsSync(conflict)) {
        return;
    }
    rmSync(conflict, { recursive: true, force: true });
    process.stdout.write("Removed the conflicting node_modules/@types/vscode\n");
}

/**
 * Downloads the VS Code typings this extension compiles against into `src/`, where the
 * compiler reads them instead of `@types/vscode`.
 *
 * Every download finishes before anything in `src/` is replaced, so a failed download
 * leaves the previous typings in place.
 */
async function main() {
    const { entries, downloadable } = await selectProposals();

    const scratch = mkdtempSync(join(tmpdir(), "lmcr-typings-"));
    try {
        const types = downloadVscodeTypes(scratch);
        const proposals =
            downloadable.length === 0 ? undefined : downloadProposals(scratch, entries, downloadable);

        copyIntoPlace(types, "vscode.d.ts");
        for (const name of proposals?.downloaded ?? []) {
            copyIntoPlace(join(proposals.folder, `vscode.proposed.${name}.d.ts`), `vscode.proposed.${name}.d.ts`);
        }
        removeNotDownloadedProposalTypings(proposals?.downloaded ?? []);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }

    removeConflictingVscodeTypes();
}

try {
    await main();
} catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
}
