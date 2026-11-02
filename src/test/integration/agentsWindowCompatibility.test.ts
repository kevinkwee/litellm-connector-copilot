import * as assert from "assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The Agents (sessions) window enables only extensions that carry no code
 * (`main`/`browser` absent) unless the manifest declares Agents window
 * support. This suite pins the manifest declarations that make the shipped,
 * code-carrying extension runnable there, so a cleanup cannot silently break
 * Agents window availability.
 */

/**
 * The subset of a JSON-schema property declaration these assertions inspect.
 */
interface ManifestProperty {
    type?: string;
    enum?: string[];
    items?: { type?: string; enum?: string[] };
}

/**
 * Walks up from this compiled module to the repository root and returns the
 * first ancestor holding the extension manifest. The depth is not stable
 * across build layouts (tsc emits under `out/src/...`), so the search keeps
 * the test correct regardless of the out directory nesting.
 */
function findExtensionManifestPath(): string {
    let dir = dirname(__dirname);
    for (let depth = 0; depth < 10; depth++) {
        const candidate = join(dir, "package.json");
        if (existsSync(candidate)) {
            const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string };
            if (parsed.name === "litellm-connector-copilot") {
                return candidate;
            }
        }
        const parent = dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    assert.fail("Extension manifest (package.json) not found above the test module");
}

suite("Agents Window Compatibility Manifest", () => {
    let manifest: Record<string, unknown>;

    setup(() => {
        manifest = JSON.parse(readFileSync(findExtensionManifestPath(), "utf8")) as Record<string, unknown>;
    });

    test("declares agentsWindowActivation API proposal", () => {
        const proposals = manifest.enabledApiProposals;
        assert.ok(Array.isArray(proposals), "enabledApiProposals must exist");
        assert.ok(
            proposals.includes("agentsWindowActivation"),
            `enabledApiProposals must include 'agentsWindowActivation'; got: ${JSON.stringify(proposals)}`
        );
    });

    test("declares Agents window support capability", () => {
        const capabilities = manifest.capabilities;
        assert.ok(typeof capabilities === "object" && capabilities !== null, "capabilities must exist");
        const agentsWindow = (capabilities as Record<string, unknown>).agentsWindow;
        assert.ok(typeof agentsWindow === "object" && agentsWindow !== null, "capabilities.agentsWindow must exist");
        assert.strictEqual(
            (agentsWindow as Record<string, unknown>).supported,
            true,
            "capabilities.agentsWindow.supported must be true so the code-carrying extension runs in the Agents window"
        );
    });

    test("activates on startup finished so the provider registers without an editor window", () => {
        const activationEvents = manifest.activationEvents;
        assert.ok(Array.isArray(activationEvents), "activationEvents must exist");
        assert.ok(
            activationEvents.includes("onStartupFinished"),
            "onStartupFinished activation must stay so the provider registers without an editor window"
        );
    });

    test("activates on language model provider configuration changes", () => {
        const activationEvents = manifest.activationEvents;
        assert.ok(Array.isArray(activationEvents), "activationEvents must exist");
        assert.ok(
            activationEvents.includes("onLanguageModelChatProvider:litellm-connector"),
            "onLanguageModelChatProvider:<vendor> activation must stay so configuration changes activate the provider"
        );
    });

    test("registers the Language Model provider contribution", () => {
        const contributes = manifest.contributes;
        assert.ok(typeof contributes === "object" && contributes !== null, "contributes must exist");
        const providers = (contributes as Record<string, unknown>).languageModelChatProviders;
        assert.ok(Array.isArray(providers) && providers.length > 0, "languageModelChatProviders must be declared");
        const provider = providers[0] as Record<string, unknown>;
        assert.strictEqual(provider.vendor, "litellm-connector", "provider vendor must be litellm-connector");
    });

    test("carries extension code, which is why the capability declaration is required", () => {
        assert.ok(
            typeof manifest.main === "string" && manifest.main.length > 0,
            "main field must exist. The Agents window disables code-carrying extensions unless capabilities declare support"
        );
    });

    test("offers max in both effort enums and declares forceMandatory", () => {
        const contributes = manifest.contributes as Record<string, unknown>;
        const properties = (contributes.configuration as Record<string, unknown>).properties as Record<
            string,
            { items?: { properties?: Record<string, ManifestProperty> } }
        >;
        const overrideProperties = properties["litellm-connector.modelOverrides"].items?.properties;
        assert.ok(overrideProperties, "modelOverrides item properties must exist");

        // `SupportedReasoningEffort` includes `max`, so the schema must offer it
        // or a valid override is flagged by the settings editor.
        const effortsEnum = overrideProperties.reasoningEfforts?.items?.enum;
        assert.ok(
            effortsEnum?.includes("max"),
            `reasoningEfforts must offer 'max'; got: ${JSON.stringify(effortsEnum)}`
        );
        const defaultEffortEnum = overrideProperties.defaultEffort?.enum;
        assert.ok(
            defaultEffortEnum?.includes("max"),
            `defaultEffort must offer 'max'; got: ${JSON.stringify(defaultEffortEnum)}`
        );
        assert.strictEqual(
            overrideProperties.forceMandatory?.type,
            "boolean",
            "forceMandatory must be declared as a boolean"
        );
    });

    test("declares no model discovery change-notification timing settings", () => {
        const contributes = manifest.contributes as Record<string, unknown>;
        const properties = (contributes.configuration as Record<string, unknown>).properties as Record<string, unknown>;
        assert.strictEqual("litellm-connector.discoveryFireDebounceMs" in properties, false);
        assert.strictEqual("litellm-connector.discoveryFireMinIntervalMs" in properties, false);
    });

    test("declares the two routing settings as opt-in booleans", () => {
        const contributes = manifest.contributes as Record<string, unknown>;
        const properties = (contributes.configuration as Record<string, unknown>).properties as Record<
            string,
            ManifestProperty & { default?: unknown }
        >;

        for (const key of ["forceResponsesEndpoint", "allowChatCompletionsFallback"]) {
            const declared = properties[`litellm-connector.${key}`];
            assert.ok(declared, `${key} must be declared`);
            assert.strictEqual(declared.type, "boolean", `${key} must be a boolean`);
            assert.strictEqual(declared.default, false, `${key} must default to false`);
        }
    });

    test("declares both request time bounds as top-level number settings", () => {
        const contributes = manifest.contributes as Record<string, unknown>;
        const properties = (contributes.configuration as Record<string, unknown>).properties as Record<
            string,
            ManifestProperty & { default?: unknown; minimum?: unknown; maximum?: unknown }
        >;

        // A settings entry nested inside another entry is valid JSON and is still
        // invisible to VS Code, so the shape is asserted, not just the key.
        const expected: Record<string, { default: number; minimum: number; maximum: number }> = {
            "litellm-connector.headersTimeout": { default: 120, minimum: 1, maximum: 300 },
            "litellm-connector.retryBudgetSeconds": { default: 300, minimum: 0, maximum: 3_600 },
        };
        for (const [key, bounds] of Object.entries(expected)) {
            const declared = properties[key];
            assert.ok(declared, `${key} must be declared as a top-level setting`);
            assert.strictEqual(declared.type, "number", `${key} must be a number`);
            assert.strictEqual(declared.default, bounds.default, `${key} default`);
            assert.strictEqual(declared.minimum, bounds.minimum, `${key} minimum`);
            assert.strictEqual(declared.maximum, bounds.maximum, `${key} maximum`);
        }
    });
});
