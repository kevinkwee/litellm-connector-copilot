import * as assert from "assert";

import { LiteLLMApiError } from "../../../adapters/litellmClient";
import { rejectsUsageOptOut } from "../usageOptOutRejection";

/** Builds the error the client raises for a rejected request. */
function rejected(bodyText: string): LiteLLMApiError {
    return new LiteLLMApiError(400, bodyText, `LiteLLM API error: 400 Bad Request\n${bodyText}`);
}

suite("rejectsUsageOptOut", () => {
    suite("wordings that refuse the flag", () => {
        test("names stream_options as the unrecognized argument", () => {
            assert.strictEqual(
                rejectsUsageOptOut(rejected("Unrecognized request argument supplied: stream_options")),
                true
            );
        });

        test("names include_usage as an unsupported parameter", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected("Unsupported parameter: include_usage")), true);
        });

        test("names the dotted path as an unknown parameter", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected("Unknown parameter: stream_options.include_usage")), true);
        });

        test("names the flag without quotes", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected("Unsupported parameter: stream_options")), true);
        });

        test("names the flag in a body the fork relayed with its model-group suffix", () => {
            // The proxy appends this suffix to a relayed provider error by default.
            const body = "Unrecognized request argument supplied: stream_options. Received Model Group=azure/gpt-5.4";

            assert.strictEqual(rejectsUsageOptOut(rejected(body)), true);
        });

        test("names a dotted flag path before the relayed suffix", () => {
            const body = "Unsupported parameter: stream_options.include_usage. Received Model Group=azure/gpt-5.4";

            assert.strictEqual(rejectsUsageOptOut(rejected(body)), true);
        });

        test("puts the flag in the same sentence as the refusal", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected("This model does not support stream_options for it")), true);
        });

        test("reads the proxy's list-of-parameters refusal", () => {
            assert.strictEqual(
                rejectsUsageOptOut(rejected("This model does not support parameters: ['stream_options']")),
                true
            );
        });

        test("reads the flag as unsupported for the model", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected("stream_options is unsupported for this model")), true);
        });

        test("reads the flag as not permitted", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected("stream_options is not permitted for this model")), true);
        });

        test("reads a pydantic refusal that puts the field first", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected("stream_options: Extra inputs are not permitted")), true);
        });

        test("reads a fork-relayed pydantic refusal", () => {
            const body =
                "litellm.BadRequestError: AnthropicException - stream_options: Extra inputs are not permitted. " +
                "Received Model Group=claude-sonnet";

            assert.strictEqual(rejectsUsageOptOut(rejected(body)), true);
        });

        test("reads Google's field refusal", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected('Unknown name "stream_options"')), true);
        });

        test("reads Jackson's field refusal", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected('Unrecognized field "stream_options"')), true);
        });

        test("reads serde's field refusal", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected("unknown field `stream_options`")), true);
        });

        test("reads a refusal beside an earlier mention of the flag", () => {
            // The refusal sits beside the first mention and a later mention follows it,
            // so a scan that started at the last mention would miss this.
            const body = 'stream_options is not supported. Request: {"stream_options":{"include_usage":true}}';

            assert.strictEqual(rejectsUsageOptOut(rejected(body)), true);
        });

        test("reads a body that names only include_usage", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected("include_usage is not supported")), true);
        });

        test("reads a refusal beside a later mention of the flag", () => {
            // The first mention sits too far from the refusal, so finding the flag has to
            // keep looking past it.
            const body = `stream_options was accepted earlier${" ".repeat(80)} but stream_options is not supported`;

            assert.strictEqual(rejectsUsageOptOut(rejected(body)), true);
        });

        test("reads a refusal 43 characters after the flag", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected(`stream_options${" ".repeat(43)} is not supported`)), true);
        });

        test("reads a refusal 44 characters before the flag", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected(`does not support${" ".repeat(44)}stream_options`)), true);
        });

        test("reads the message when the error carries no body", () => {
            assert.strictEqual(rejectsUsageOptOut(new Error("Unsupported parameter: include_usage")), true);
        });
    });

    suite("bodies that must not opt the model out", () => {
        test("a refusal 44 characters after the flag is an echo", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected(`stream_options${" ".repeat(44)} is not supported`)), false);
        });

        test("a refusal 45 characters before the flag is an echo", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected(`does not support${" ".repeat(45)}stream_options`)), false);
        });

        test("echoes the prompt with both words far apart", () => {
            const body = `Invalid request: ${"x".repeat(400)} stream_options ${"y".repeat(400)} is not supported`;

            assert.strictEqual(rejectsUsageOptOut(rejected(body)), false);
        });

        test("refuses another parameter whose echoed request contains the flag", () => {
            const body = 'Unsupported parameter: temperature {"stream_options":{"include_usage":true}}';

            assert.strictEqual(rejectsUsageOptOut(rejected(body)), false);
        });

        test("straddles a sentence end between the flag and a refusal", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected("stream_options. Also, audio is not supported.")), false);
        });

        test("straddles a newline between the refusal and the flag", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected("audio is not supported\nstream_options")), false);
        });

        test("straddles a newline between the flag and the refusal", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected("stream_options\naudio is not supported")), false);
        });

        test("straddles an escaped newline in a JSON body", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected("stream_options\\naudio is not supported")), false);
        });

        test("a bare unknown far from the flag is not evidence", () => {
            // An echoed request can carry an unrelated "unknown" value.
            const body = `stream_options {"user":"unknown"} ${"x".repeat(80)} rejected`;

            assert.strictEqual(rejectsUsageOptOut(rejected(body)), false);
        });

        test("an empty body is not a rejection", () => {
            assert.strictEqual(rejectsUsageOptOut(rejected("")), false);
        });

        test("a non-Error value is not a rejection", () => {
            assert.strictEqual(rejectsUsageOptOut(undefined), false);
        });
    });
});
