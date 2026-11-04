import * as assert from "assert";
import * as vscode from "vscode";

import { convertTools } from "../../utils";

suite("convertTools", () => {
    test("convertTools asks for any tool when ToolMode.Required covers several tools", () => {
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "t1", description: "", inputSchema: {} },
            { name: "t2", description: "", inputSchema: {} },
            { name: "t3", description: "", inputSchema: {} },
        ];

        const result = convertTools({
            tools,
            toolMode: vscode.LanguageModelChatToolMode.Required,
            requestInitiator: "test",
        });

        assert.strictEqual(result.tool_choice, "required");
        assert.strictEqual(result.tools?.length, 3);
    });

    test("convertTools names the only tool when ToolMode.Required covers one", () => {
        const tools: vscode.LanguageModelChatTool[] = [{ name: "only", description: "", inputSchema: {} }];

        const result = convertTools({
            tools,
            toolMode: vscode.LanguageModelChatToolMode.Required,
            requestInitiator: "test",
        });

        assert.deepStrictEqual(result.tool_choice, { type: "function", function: { name: "only" } });
    });

    test("convertTools sends the declared schema unchanged and enforces Required mode", () => {
        const inputSchema = {
            type: "object",
            properties: {
                mode: { anyOf: [{ type: "null" }, { type: "integer" }] },
                ref: { $ref: "#/$defs/Thing" },
                name: { type: "string", const: "fixed", title: "Name" },
                tags: { type: "array", items: [{ type: "string" }, { type: "number" }], minItems: 1 },
                nested: { type: ["object", "null"], additionalProperties: { type: "string" } },
            },
            $defs: { Thing: { type: "object", properties: { id: { type: "string" } } } },
            required: ["name"],
            additionalProperties: false,
        };
        const tools: vscode.LanguageModelChatTool[] = [{ name: "-bad name", description: "", inputSchema }];

        const res = convertTools({
            tools,
            toolMode: vscode.LanguageModelChatToolMode.Required,
            requestInitiator: "test",
        });

        assert.ok(res.tools);
        assert.strictEqual(res.tools?.length, 1);
        assert.strictEqual(res.tools?.[0].function.name, "tool_-bad_name");
        assert.strictEqual(res.tools?.[0].function.parameters, inputSchema);
        assert.ok(res.tool_choice && typeof res.tool_choice !== "string");
        assert.strictEqual(res.tool_choice?.function.name, "tool_-bad_name");
    });

    test("convertTools leaves the chat-completions function free of strict", () => {
        // The Responses adapter sets `strict` explicitly. A chat completions tool
        // leaves the field to the endpoint, whose default is false.
        const res = convertTools({
            tools: [{ name: "search", description: "", inputSchema: { type: "object", properties: {} } }],
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            requestInitiator: "test",
        });

        const sentTool = res.tools?.[0];
        assert.ok(sentTool, "the declared tool must survive conversion");
        assert.strictEqual(Object.hasOwn(sentTool.function, "strict"), false);
    });

    test("convertTools passes a deep-frozen declared schema through untouched", () => {
        const inputSchema = Object.freeze({
            type: "object",
            properties: Object.freeze({ q: Object.freeze({ type: "string" }) }),
        });

        const res = convertTools({
            tools: [{ name: "search", description: "", inputSchema }],
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            requestInitiator: "test",
        });

        assert.strictEqual(res.tools?.[0].function.parameters, inputSchema);
    });

    test("convertTools substitutes an empty object schema when the tool declares none", () => {
        const res = convertTools({
            tools: [
                { name: "first", description: "" },
                { name: "second", description: "", inputSchema: null as unknown as object },
                { name: "third", description: "", inputSchema: [] as unknown as object },
                { name: "fourth", description: "", inputSchema: "nope" as unknown as object },
            ],
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            requestInitiator: "test",
        });

        const schemas = (res.tools ?? []).map((tool) => tool.function.parameters);
        assert.deepStrictEqual(schemas[0], { type: "object", properties: {} });
        assert.deepStrictEqual(schemas[1], { type: "object", properties: {} });
        assert.deepStrictEqual(schemas[2], { type: "object", properties: {} });
        assert.deepStrictEqual(schemas[3], { type: "object", properties: {} });
        // Each schema-less tool must receive its own object, not a shared one.
        assert.notStrictEqual(schemas[0], schemas[1]);
    });

    test("convertTools suffixes a tool name that collides with an earlier one", () => {
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "github.create_issue", description: "", inputSchema: {} },
            { name: "github_create_issue", description: "", inputSchema: {} },
        ];

        const names = convertTools({
            tools,
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            requestInitiator: "test",
        }).tools?.map((tool) => tool.function.name);

        assert.deepStrictEqual(names, ["github_create_issue", "github_create_issue_2"]);
    });

    test("convertTools keeps a repeated-underscore name and leaves ordinary names alone", () => {
        const tools: vscode.LanguageModelChatTool[] = [
            { name: "github__create_issue", description: "", inputSchema: {} },
            { name: "github_create_issue", description: "", inputSchema: {} },
        ];

        const names = convertTools({
            tools,
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            requestInitiator: "test",
        }).tools?.map((tool) => tool.function.name);

        assert.deepStrictEqual(names, ["github__create_issue", "github_create_issue"]);
    });

    test("convertTools sanitizes a name with invalid characters for the wire", () => {
        const tools: vscode.LanguageModelChatTool[] = [{ name: "search files", description: "", inputSchema: {} }];

        const names = convertTools({
            tools,
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            requestInitiator: "test",
        }).tools?.map((tool) => tool.function.name);

        assert.deepStrictEqual(names, ["search_files"]);
    });

    test("convertTools returns the mapping the request advertised", () => {
        const result = convertTools({
            tools: [
                { name: "github.create_issue", description: "", inputSchema: {} },
                { name: "github_create_issue", description: "", inputSchema: {} },
            ],
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            requestInitiator: "test",
        });

        assert.deepStrictEqual(
            result.tools?.map((tool) => tool.function.name),
            ["github_create_issue", "github_create_issue_2"]
        );
        assert.strictEqual(result.toolNames?.wireToDeclared.get("github_create_issue_2"), "github_create_issue");
        assert.strictEqual(result.toolNames?.declaredToWire.get("github_create_issue"), "github_create_issue_2");
    });

    test("convertTools returns no tools and no tool_choice for a null entry in Required mode", () => {
        const result = convertTools({
            tools: [null] as unknown as vscode.LanguageModelChatTool[],
            toolMode: vscode.LanguageModelChatToolMode.Required,
            requestInitiator: "test",
        });

        assert.strictEqual(result.tools, undefined);
        assert.strictEqual(result.tool_choice, undefined);
        assert.strictEqual(result.toolNames.wireNames.length, 0);
    });

    test("convertTools should NOT return tool_choice when toolMode is Auto/undefined", () => {
        const tools: vscode.LanguageModelChatTool[] = [{ name: "tool1", description: "test", inputSchema: {} }];

        const res = convertTools({
            tools,
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            requestInitiator: "test",
        });

        assert.strictEqual(res.tool_choice, undefined, "tool_choice should be undefined when toolMode is Auto");
    });

    test("convertTools returns no tools when none are declared", () => {
        const res = convertTools({
            tools: [],
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            requestInitiator: "test",
        });

        assert.strictEqual(res.tools, undefined);
        assert.strictEqual(res.tool_choice, undefined);
        assert.strictEqual(res.toolNames.wireNames.length, 0);
    });
});
