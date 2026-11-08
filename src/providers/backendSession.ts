import type { LiteLLMClient } from "../adapters/litellmClient";

/**
 * Represents a resolved per-group connection context.
 * Holds everything needed to make requests to one LiteLLM backend.
 * Populated from VS Code's per-group `options.configuration`.
 */
export interface BackendSession {
    /** Backend label shown in each model row's detail and tooltip, derived from the URL host. */
    readonly backendName: string;
    /** Base URL of the LiteLLM proxy */
    readonly baseUrl: string;
    /** API key for authentication (undefined if not required) */
    readonly apiKey: string | undefined;
    /** HTTP client for making requests */
    readonly client: LiteLLMClient;
}
