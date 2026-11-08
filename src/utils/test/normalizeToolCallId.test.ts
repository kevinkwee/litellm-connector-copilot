import * as assert from "assert";

import { normalizeToolCallId } from "../../utils/messageConversion";

suite("normalizeToolCallId", () => {
    test("normalizeToolCallId handles edge cases", () => {
        assert.ok(normalizeToolCallId("").startsWith("fc_"));
        assert.ok(normalizeToolCallId("").length >= 42);

        // ID starting with fc_ but too short (must be padded to 42 chars minimum)
        console.log("Testing 'fc_abc' with length:", "fc_abc".length);
        const shortFc = normalizeToolCallId("fc_abc");
        console.log("Result:", shortFc, "length:", shortFc.length);
        assert.ok(shortFc.startsWith("fc_"));
        assert.ok(shortFc.length >= 42);
        assert.ok(shortFc.length <= 63);
        // Verify padding is deterministic due to stableHash
        assert.strictEqual(shortFc, normalizeToolCallId("fc_abc"));

        // Longest fc_ payload in the pass-through range is kept unchanged
        const longFc = "fc_" + "a".repeat(56);
        const normFc = normalizeToolCallId(longFc);
        assert.strictEqual(normFc, longFc);
        assert.ok(normFc.length >= 42);
        assert.ok(normFc.length <= 63);
        assert.ok(normFc.startsWith("fc_"));

        // Over-long fc_ payload is rebuilt within bounds
        const overLongFc = normalizeToolCallId("fc_" + "a".repeat(60));
        assert.ok(overLongFc.length >= 42);
        assert.ok(overLongFc.length <= 63);
        assert.ok(overLongFc.startsWith("fc_"));

        // ID with prefix call_ or tc_ (converted to fc_ format)
        assert.ok(normalizeToolCallId("call_abc").startsWith("fc_abc_"));
        assert.ok(normalizeToolCallId("tc_abc").startsWith("fc_abc_"));
        assert.ok(normalizeToolCallId("call_abc").length >= 42);
        assert.ok(normalizeToolCallId("call_abc").length <= 63);

        // ID with special characters (will be sanitized and padded)
        const sanitized = normalizeToolCallId("some!@#id");
        assert.ok(sanitized.startsWith("fc_"));
        assert.ok(sanitized.length >= 42);
        assert.ok(sanitized.length <= 56);

        // Surrounding whitespace is trimmed before normalization
        assert.ok(normalizeToolCallId(" tc_abc ").startsWith("fc_"));
    });

    test("normalizeToolCallId pads short fc_ IDs without crashing", () => {
        // Boundary payloads around the padding math, from empty up to just
        // under the 39-char payload minimum; all must normalize within bounds.
        for (const payload of ["", "a", "ab", "abc", "x".repeat(37), "x".repeat(38)]) {
            const raw = `fc_${payload}`;
            const normalized = normalizeToolCallId(raw);
            assert.ok(normalized.startsWith("fc_"), `must keep fc_ prefix for: ${raw}`);
            assert.ok(normalized.length >= 42, `must meet 42-char minimum for: ${raw}`);
            assert.ok(normalized.length <= 63, `must respect 63-char cap for: ${raw}`);
            assert.strictEqual(normalizeToolCallId(raw), normalized, `must be deterministic for: ${raw}`);
        }

        // Padding targets the 42-char minimum exactly.
        assert.strictEqual(normalizeToolCallId("fc_ab").length, 42);
    });

    test("normalizeToolCallId filler is varied, not a repeated pattern", () => {
        // Models echo tool call IDs back when emitting text-format tool calls,
        // and they tend to drop repetitions when copying long repeated runs.
        // A mistyped ID fails to pair with its tool result, so filler must be
        // varied per position while staying deterministic for a given raw ID.
        const twoCharRun = /(.{2})\1{3,}/; // same 2-char unit repeated 4+ times
        for (const raw of ["call_abc", "tc_abc", "some!@#id", "fc_ab", "fc_a", ""]) {
            const normalized = normalizeToolCallId(raw);
            assert.ok(!twoCharRun.test(normalized), `repeated 2-char run in: ${normalized}`);
        }

        assert.strictEqual(normalizeToolCallId("call_abc").length, 42);

        // Long fillers must not tile one hash block either.
        const fcAb = normalizeToolCallId("fc_ab");
        assert.notStrictEqual(fcAb.slice(5, 21), fcAb.slice(21, 37), "filler blocks must differ");
        const empty = normalizeToolCallId("");
        assert.notStrictEqual(empty.slice(3, 19), empty.slice(19, 35), "filler blocks must differ");
    });

    test("normalizeToolCallId treats only a leading fc_ as the provider prefix", () => {
        // An fc_ embedded mid-ID must not make the raw ID pass through as
        // "already prefixed": that would return an ID violating the fc_ rule.
        const midString = `call_fc_${"x".repeat(40)}`;
        const normalizedMid = normalizeToolCallId(midString);
        assert.ok(normalizedMid.startsWith("fc_"), "mid-string fc_ must be rebuilt with a real prefix");
        assert.ok(normalizedMid.length >= 42 && normalizedMid.length <= 63);
        assert.strictEqual(normalizeToolCallId(midString), normalizedMid);

        // With a leading fc_, any later fc_ is ordinary payload and survives.
        const repeated = `fc_${"y".repeat(2)}fc_${"z".repeat(2)}`;
        const normalizedRepeated = normalizeToolCallId(repeated);
        assert.ok(normalizedRepeated.startsWith("fc_yyfc_zz"));
        assert.strictEqual(normalizeToolCallId(repeated), normalizedRepeated);

        // Already-valid fc_ IDs pass through unchanged.
        const valid = `fc_${"a".repeat(39)}`;
        assert.strictEqual(normalizeToolCallId(valid), valid);

        // Normalized outputs are stable under re-normalization.
        for (const raw of ["call_abc", "tc_abc", "some!@#id", "fc_ab"]) {
            const once = normalizeToolCallId(raw);
            assert.strictEqual(normalizeToolCallId(once), once, `must be idempotent for: ${raw}`);
        }
    });
});
