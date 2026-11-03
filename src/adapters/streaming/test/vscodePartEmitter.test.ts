import * as vscode from "vscode";
import * as sinon from "sinon";
import * as assert from "assert";
import { emitPartsToVSCode } from "../vscodePartEmitter";
import { Logger } from "../../../utils/logger";
import { StructuredLogger } from "../../../observability/structuredLogger";

suite("vscodePartEmitter", () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test("logs the dropped call", () => {
        const warnStub = sandbox.stub(Logger, "warn");
        const progress = { report: () => undefined } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitPartsToVSCode([{ type: "tool_call", index: 0, id: "call_1", name: "t1", args: "{invalid json" }], progress);

        sinon.assert.calledOnce(warnStub);
        const callArgs = warnStub.firstCall.args;
        assert.ok((callArgs[0] as string).includes("Failed to parse tool call arguments"));
        const fields = callArgs[1] as Record<string, unknown>;
        assert.strictEqual(fields.toolName, "t1");
        assert.strictEqual(fields.id, "call_1");
    });

    test("returns the dropped calls so the caller can explain the loss", () => {
        const progress = { report: () => undefined } as vscode.Progress<vscode.LanguageModelResponsePart>;

        const dropped = emitPartsToVSCode(
            [{ type: "tool_call", index: 0, id: "call_1", name: "t1", args: "{invalid json" }],
            progress
        );

        assert.deepStrictEqual(dropped, [{ id: "call_1", name: "t1" }]);
    });

    test("delivers the readable parts before and after a dropped call", () => {
        const reported: unknown[] = [];
        const progress = {
            report: (p: unknown) => reported.push(p),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitPartsToVSCode(
            [
                { type: "text", value: "before" },
                { type: "tool_call", index: 0, id: "call_1", name: "t1", args: "{invalid json" },
                { type: "text", value: "after" },
            ],
            progress
        );

        assert.deepStrictEqual(
            reported.map((part) => (part as { value?: string }).value),
            ["before", "after"],
            "a dropped call must not cost the text beside it"
        );
    });

    test("logs an error-level structured event on tool-call argument parse failure", () => {
        const errorStub = sandbox.stub(StructuredLogger, "error");
        const progress = { report: () => undefined } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitPartsToVSCode([{ type: "tool_call", index: 0, id: "call_1", name: "t1", args: "{invalid json" }], progress);

        const failureCalls = errorStub.getCalls().filter((call) => call.args[0] === "vscode.tool_call_parse_failed");
        assert.strictEqual(failureCalls.length, 1);
        const fields = failureCalls[0].args[1] as Record<string, unknown>;
        assert.strictEqual(fields.toolName, "t1");
        assert.strictEqual(fields.argsLength, "{invalid json".length);
        assert.strictEqual(fields.argsPreview, "{invalid json");
    });

    test("reports every data part without dropping any", () => {
        const reported: unknown[] = [];
        const progress = {
            report: (p: unknown) => reported.push(p),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitPartsToVSCode(
            [
                {
                    type: "data",
                    mimeType: "application/vnd.cache-control+json",
                    value: { $mid: 24, mimeType: "cache_control", data: "ZXBoZW1lcmFs" },
                },
                { type: "text", value: "cache_control is legitimate text here" },
            ],
            progress
        );

        assert.strictEqual(reported.length, 2);
        assert.ok(reported[0] instanceof vscode.LanguageModelDataPart);
        assert.deepStrictEqual(
            (reported[0] as vscode.LanguageModelDataPart).mimeType,
            "application/vnd.cache-control+json"
        );
        assert.ok(reported[1] instanceof vscode.LanguageModelTextPart);
        assert.strictEqual(
            (reported[1] as vscode.LanguageModelTextPart).value,
            "cache_control is legitimate text here"
        );
    });

    test("emits usage data parts with the raw usage mimetype", () => {
        const reported: unknown[] = [];
        const progress = {
            report: (p: unknown) => reported.push(p),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitPartsToVSCode(
            [
                {
                    type: "data",
                    mimeType: "usage",
                    value: {
                        prompt_tokens: 11,
                        completion_tokens: 7,
                        total_tokens: 18,
                        prompt_tokens_details: {
                            cached_tokens: 3,
                        },
                        completion_tokens_details: {
                            reasoning_tokens: 4,
                        },
                    },
                },
            ],
            progress
        );

        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] instanceof vscode.LanguageModelDataPart);
        const part = reported[0] as vscode.LanguageModelDataPart;
        assert.strictEqual(part.mimeType, "usage");
        assert.deepStrictEqual(JSON.parse(Buffer.from(part.data).toString("utf-8")), {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18,
            prompt_tokens_details: {
                cached_tokens: 3,
            },
            completion_tokens_details: {
                reasoning_tokens: 4,
            },
        });
    });

    test("handles text part with non-string value", () => {
        const reported: unknown[] = [];
        const progress = {
            report: (p: unknown) => reported.push(p),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitPartsToVSCode([{ type: "text", value: 12345 } as unknown as { type: "text"; value: string }], progress);

        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] instanceof vscode.LanguageModelTextPart);
        assert.strictEqual((reported[0] as vscode.LanguageModelTextPart).value, "12345");
    });

    test("emits data parts with non-text mimeType as opaque binary", () => {
        const reported: unknown[] = [];
        const progress = {
            report: (p: unknown) => reported.push(p),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitPartsToVSCode([{ type: "data", mimeType: "application/octet-stream", value: { raw: "data" } }], progress);

        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] instanceof vscode.LanguageModelDataPart);
    });

    test("ignores response and finish parts", () => {
        const reported: unknown[] = [];
        const progress = {
            report: (p: unknown) => reported.push(p),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitPartsToVSCode(
            [
                { type: "response" } as unknown as { type: "text"; value: string },
                { type: "finish" } as unknown as { type: "text"; value: string },
                { type: "text", value: "after" },
            ],
            progress
        );

        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] instanceof vscode.LanguageModelTextPart);
        assert.strictEqual((reported[0] as vscode.LanguageModelTextPart).value, "after");
    });

    test("emits usage data parts with string value", () => {
        const reported: unknown[] = [];
        const progress = {
            report: (p: unknown) => reported.push(p),
        } as vscode.Progress<vscode.LanguageModelResponsePart>;

        emitPartsToVSCode([{ type: "data", mimeType: "usage", value: '{"tokens": 10}' }], progress);

        assert.strictEqual(reported.length, 1);
        assert.ok(reported[0] instanceof vscode.LanguageModelDataPart);
        assert.strictEqual((reported[0] as vscode.LanguageModelDataPart).mimeType, "usage");
    });
});
