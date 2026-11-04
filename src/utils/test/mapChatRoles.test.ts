import * as assert from "assert";
import { LanguageModelChatMessageRole } from "vscode";
import { lmcr_toString } from "../mapChatRoles";

suite("mapChatRoles", () => {
    suite("lmcr_toString", () => {
        test("converts User role to 'user'", () => {
            assert.strictEqual(lmcr_toString(LanguageModelChatMessageRole.User), "user");
        });

        test("converts Assistant role to 'assistant'", () => {
            assert.strictEqual(lmcr_toString(LanguageModelChatMessageRole.Assistant), "assistant");
        });

        test("converts numeric system role (3) to 'system'", () => {
            // Using cast since it might be proposed or not in the stable API yet
            assert.strictEqual(lmcr_toString(3 as LanguageModelChatMessageRole), "system");
        });

        test("defaults unknown roles to 'system'", () => {
            assert.strictEqual(lmcr_toString(99 as unknown as LanguageModelChatMessageRole), "system");
        });
    });
});
