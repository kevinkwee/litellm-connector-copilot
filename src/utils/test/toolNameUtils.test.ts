import * as assert from "assert";
import { buildToolNameMapping, deriveWireToolNames, sanitizeToolName, TOOL_NAME_MAX_LENGTH } from "../toolNameUtils";

declare const suite: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;

suite("sanitizeToolName", () => {
    test("truncates names longer than 64 characters to exactly 64 characters", () => {
        const longName = "a".repeat(100);

        assert.strictEqual(sanitizeToolName(longName), "a".repeat(TOOL_NAME_MAX_LENGTH));
    });

    test("does not truncate names of exactly 64 characters", () => {
        const exactly64 = "a".repeat(TOOL_NAME_MAX_LENGTH);

        assert.strictEqual(sanitizeToolName(exactly64), exactly64);
    });

    test("leaves a valid short name unchanged", () => {
        assert.strictEqual(sanitizeToolName("my_tool"), "my_tool");
    });

    test("normalizes non-string inputs and the empty string to 'tool'", () => {
        for (const input of [null, undefined, 123, { name: "tool" }, ""]) {
            assert.strictEqual(sanitizeToolName(input), "tool", String(input));
        }
    });

    test("prefixes a name that does not start with a letter", () => {
        assert.strictEqual(sanitizeToolName("123toolstart"), "tool_123toolstart");
    });

    test("leaves letters, digits, dashes and underscores unchanged", () => {
        const name = "tool-with-dashes-and_underscores";

        assert.strictEqual(sanitizeToolName(name), name);
    });

    test("preserves consecutive dashes and underscores", () => {
        const name = "tool_---__tool";

        assert.strictEqual(sanitizeToolName(name), name);
    });

    test("keeps two names that differ only in repeated underscores distinct", () => {
        assert.strictEqual(sanitizeToolName("a__b"), "a__b");
        assert.strictEqual(sanitizeToolName("a_b"), "a_b");
    });

    test("truncates after replacing invalid characters", () => {
        const result = sanitizeToolName(`${"a".repeat(60)} ${"b".repeat(10)}`);

        assert.strictEqual(result.length, TOOL_NAME_MAX_LENGTH);
        assert.ok(result.startsWith("a".repeat(60)));
    });
});

suite("deriveWireToolNames", () => {
    test("leaves unique names untouched", () => {
        assert.deepStrictEqual(deriveWireToolNames([{ name: "read" }, { name: "write" }]), ["read", "write"]);
    });

    test("suffixes the later of two colliding names", () => {
        assert.deepStrictEqual(
            deriveWireToolNames([{ name: "github.create_issue" }, { name: "github_create_issue" }]),
            ["github_create_issue", "github_create_issue_2"]
        );
    });

    test("keeps suffixing when the suffixed name is taken as well", () => {
        assert.deepStrictEqual(deriveWireToolNames([{ name: "a.b" }, { name: "a_b" }, { name: "a_b_2" }]), [
            "a_b",
            "a_b_2",
            "a_b_2_2",
        ]);
    });

    test("keeps every wire name within the 64-character limit", () => {
        const longest = "a".repeat(TOOL_NAME_MAX_LENGTH);
        const wireNames = deriveWireToolNames([{ name: longest }, { name: longest }]);

        assert.strictEqual(wireNames[1].length, TOOL_NAME_MAX_LENGTH);
        assert.ok(wireNames[1].endsWith("_2"));
    });
});

suite("buildToolNameMapping", () => {
    test("records only the names the sanitizer changed", () => {
        const mapping = buildToolNameMapping([{ name: "read_file" }, { name: "search files" }]);

        assert.deepStrictEqual([...mapping.wireToDeclared], [["search_files", "search files"]]);
        assert.deepStrictEqual([...mapping.declaredToWire], [["search files", "search_files"]]);
    });

    test("maps a deduplicated wire name back to the tool it was declared for", () => {
        const mapping = buildToolNameMapping([{ name: "github.create_issue" }, { name: "github_create_issue" }]);

        assert.strictEqual(mapping.wireToDeclared.get("github_create_issue"), "github.create_issue");
        assert.strictEqual(mapping.wireToDeclared.get("github_create_issue_2"), "github_create_issue");
        assert.strictEqual(mapping.declaredToWire.get("github_create_issue"), "github_create_issue_2");
    });

    test("returns empty maps for no tools", () => {
        const mapping = buildToolNameMapping([]);

        assert.strictEqual(mapping.wireToDeclared.size, 0);
        assert.strictEqual(mapping.declaredToWire.size, 0);
    });
});
