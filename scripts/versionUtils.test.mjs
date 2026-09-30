import test from 'node:test';
import assert from 'node:assert/strict';

import { parseVersion, formatVersion, bumpVersion, autoBump } from './versionUtils.mjs';

test('parseVersion reads a stable version', () => {
    assert.deepEqual(parseVersion('2.1.10'), { major: 2, minor: 1, patch: 10, suffix: null, suffixNum: null });
});

test('parseVersion reads the dotted dev prerelease tag', () => {
    assert.deepEqual(parseVersion('2.1.10-dev.10'), {
        major: 2,
        minor: 1,
        patch: 10,
        suffix: 'dev',
        suffixNum: 10,
    });
});

test('parseVersion reads legacy no-dot prerelease tags', () => {
    assert.deepEqual(parseVersion('2.1.10-dev10'), {
        major: 2,
        minor: 1,
        patch: 10,
        suffix: 'dev',
        suffixNum: 10,
    });
    assert.deepEqual(parseVersion('2.1.10-beta5'), { major: 2, minor: 1, patch: 10, suffix: 'beta', suffixNum: 5 });
});

test('parseVersion reads a bare suffix without a number', () => {
    assert.deepEqual(parseVersion('2.1.10-dev'), { major: 2, minor: 1, patch: 10, suffix: 'dev', suffixNum: null });
});

test('parseVersion rejects malformed prerelease tags', () => {
    assert.throws(() => parseVersion('2.1.10-dev.beta'));
    assert.throws(() => parseVersion('2.1.10-dev.'));
    assert.throws(() => parseVersion('2.1.10-dev.10.5'));
});

test('formatVersion emits the semver dotted prerelease tag', () => {
    assert.equal(formatVersion({ major: 2, minor: 1, patch: 10, suffix: 'dev', suffixNum: 11 }), '2.1.10-dev.11');
    assert.equal(formatVersion({ major: 2, minor: 1, patch: 10, suffix: 'beta', suffixNum: 3 }), '2.1.10-beta.3');
});

test('formatVersion keeps a bare suffix without a number', () => {
    assert.equal(formatVersion({ major: 2, minor: 1, patch: 10, suffix: 'dev', suffixNum: null }), '2.1.10-dev');
});

test('formatted dev versions satisfy the semver prerelease grammar', () => {
    const semverPrerelease = /^(\d+)\.(\d+)\.(\d+)(-dev\.(0|[1-9]\d+))?$/;
    assert.match(formatVersion({ major: 2, minor: 1, patch: 10, suffix: 'dev', suffixNum: 11 }), semverPrerelease);
});

test('bumpVersion increments the dev number without touching the core version', () => {
    assert.equal(bumpVersion('2.1.10-dev.10', 'none', 'dev', 'inc'), '2.1.10-dev.11');
    assert.equal(bumpVersion('2.1.10-dev', 'none', 'dev', 'inc'), '2.1.10-dev.1');
});

test('bumpVersion migrates a legacy no-dot tag to the dotted form', () => {
    assert.equal(bumpVersion('2.1.10-dev10', 'none', 'dev', 'inc'), '2.1.10-dev.11');
    assert.equal(bumpVersion('2.1.10-dev9', 'none', 'dev', 'inc'), '2.1.10-dev.10');
});

test('bumpVersion starts a dev cycle on a stable version without a core bump', () => {
    assert.equal(bumpVersion('2.1.10', 'none', 'dev', 'inc'), '2.1.10-dev.1');
});

test('bumpVersion pairs a core bump with a fresh dev cycle', () => {
    assert.equal(bumpVersion('2.1.10-dev.10', 'patch', 'dev'), '2.1.11-dev.1');
    assert.equal(bumpVersion('2.1.10', 'minor', 'dev'), '2.2.0-dev.1');
    assert.equal(bumpVersion('2.1.10', 'major', 'dev'), '3.0.0-dev.1');
});

test('bumpVersion without a prerelease clears the dev tag on a core bump', () => {
    assert.equal(bumpVersion('2.1.10-dev.10', 'patch', null), '2.1.11');
    assert.equal(bumpVersion('2.1.10', 'patch', null), '2.1.11');
});

test('autoBump increments the dev number on prerelease versions', () => {
    assert.equal(autoBump('2.1.10-dev.10'), '2.1.10-dev.11');
});

test('autoBump bumps the patch on stable versions', () => {
    assert.equal(autoBump('2.1.10'), '2.1.11');
});
