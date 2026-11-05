/**
 * Prints a start and a finish marker around each build, listing the errors
 * esbuild reported and each error's source location when it has one. A build
 * with no errors or warnings prints nothing at this log level, so the markers
 * are the completion signal a `--watch` session otherwise lacks.
 *
 * @type {import('esbuild').Plugin}
 */
const buildLogPlugin = {
    name: "build-log",
    setup(build) {
        build.onStart(() => {
            console.log("build started");
        });
        build.onEnd((result) => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ ${text}`);
                if (!location) return;
                console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            console.log("build finished");
        });
    },
};

const esbuild = require("esbuild");

const production = (process.argv.includes("--production") || process.env.NODE_ENV === "production") ? true : false;
const watch = process.argv.includes("--watch");
const generateSourceMaps = !production;

/** @type {esbuild.BuildOptions} */
const bundleOptions = {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    minify: production,
    sourcemap: generateSourceMaps ? "external" : false,
    sourcesContent: true,
    logLevel: "warning",
    treeShaking: true,
    define: {
        "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
    },
    external: ["vscode"],
    metafile: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: "dist/extension.js",
    plugins: [buildLogPlugin],
};

async function main() {
    const context = await esbuild.context(bundleOptions);
    if (watch) {
        console.log("Watching for changes...");
        await context.watch();
        return;
    }
    console.log("Building the extension bundle...");
    await context.rebuild();
    await context.dispose();
    console.log("Done.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
