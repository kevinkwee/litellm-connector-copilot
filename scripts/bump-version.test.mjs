import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

// The script resolves package.json relative to its own location, so each case
// runs against a throwaway copy instead of the real manifest.
let sandbox;

test.before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'bump-version-cli-'));
    mkdirSync(join(sandbox, 'scripts'), { recursive: true });
    cpSync(join(scriptsDir, 'bump-version.js'), join(sandbox, 'scripts', 'bump-version.js'));
    cpSync(join(scriptsDir, 'versionUtils.mjs'), join(sandbox, 'scripts', 'versionUtils.mjs'));
});

test.after(() => {
    rmSync(sandbox, { recursive: true, force: true });
});

function runBump(startVersion, bumpArgs) {
    const packageJsonPath = join(sandbox, 'package.json');
    writeFileSync(packageJsonPath, JSON.stringify({ version: startVersion }, null, '\t'));
    const result = spawnSync(process.execPath, [join(sandbox, 'scripts', 'bump-version.js'), ...bumpArgs], {
        encoding: 'utf8',
    });
    return { result, version: JSON.parse(readFileSync(packageJsonPath, 'utf8')).version };
}

test('CLI increments a dotted dev tag in place', () => {
    const { result, version } = runBump('2.1.10-dev.10', ['dev']);
    assert.equal(result.status, 0);
    assert.equal(version, '2.1.10-dev.11');
});

test('CLI migrates a legacy no-dot dev tag to the dotted form', () => {
    const { result, version } = runBump('2.1.10-dev9', ['dev']);
    assert.equal(result.status, 0);
    assert.equal(version, '2.1.10-dev.10');
});

test('CLI starts a fresh dev cycle on a patch bump', () => {
    const { result, version } = runBump('2.1.10-dev.10', ['patch', 'dev']);
    assert.equal(result.status, 0);
    assert.equal(version, '2.1.11-dev.1');
});

test('CLI drops the dev tag on a plain patch bump', () => {
    const { result, version } = runBump('2.1.10-dev.10', ['patch']);
    assert.equal(result.status, 0);
    assert.equal(version, '2.1.11');
});

test('CLI rejects unknown bump arguments with usage', () => {
    const { result, version } = runBump('2.1.10', ['banana']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: npm run bump-version/);
    assert.equal(version, '2.1.10');
});

test('CLI rejects malformed prerelease tags without touching package.json', () => {
    const { result, version } = runBump('2.1.10-dev.beta', ['dev']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid version format in package.json/);
    assert.equal(version, '2.1.10-dev.beta');
});
