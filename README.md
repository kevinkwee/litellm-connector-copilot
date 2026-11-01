# LiteLLM Connector for Copilot (personal fork)

This repository is my personal fork of [gethnet/litellm-connector-copilot](https://github.com/gethnet/litellm-connector-copilot), customized for my own use. It is **not** published to the VS Code Marketplace or Open VSX, and it does not accept issues or pull requests. For the original project, documentation, and support, see the upstream repository.

All credit for the original extension belongs to the upstream authors. Licensed under Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).

## Custom changes added in this fork

Forked from upstream `v2.1.9`. Everything below is on top of that baseline.

### Reasoning control
- Expanded reasoning effort levels with corrected fallback behavior.
- `reasoning_effort: "none"` is always sent explicitly instead of the parameter being silently dropped.
- The effort used when the user has not picked one is the highest level the model lists, so a model that never offers `medium` is not sent a level it rejects. A `modelOverrides` `defaultEffort` wins when the model's list contains it.
- The output-token reservation is capped at half the context window, so a model whose declared output limit covers its whole window still leaves a usable input limit.

### Claude reasoning continuity across tool calls
- Claude's encrypted thinking is preserved across tool call rounds: signed thinking blocks are sealed into VS Code replayable thinking parts (signature plus the exact block text in part metadata, matching the keys the built-in Copilot providers persist), and redacted thinking blocks carry the redacted data. On later rounds the connector rebuilds Anthropic `thinking_blocks` from those parts, so the model keeps its reasoning context instead of re-deriving it.
- Unsigned or malformed signed blocks are ignored rather than reconstructed; user and system messages never receive signatures.
- Claude stream usage reports Anthropic prompt-cache counters separately: cache-write tokens are billed at the cache-write price and cache-read tokens at the cache-read price in the estimated request costs.

### DeepSeek reasoning continuity across tool calls
- DeepSeek thinking mode requires `reasoning_content` on every assistant turn in the active tool loop whenever the request carries tools, including turns where the model produced no reasoning. Omitting the field makes the upstream return `400 ... The reasoning_content in the thinking mode must be passed back to the API.`
- For DeepSeek models, the connector fills `reasoning_content: ""` on active-turn assistant messages that have no reasoning part. Real reasoning replayed by VS Code is preserved.
- The fill is DeepSeek-only and scoped to the active turn (assistant messages after the latest real user message). Completed turns and every non-DeepSeek model keep their existing payload unchanged.

### Anthropic prompt caching
- New setting `litellm-connector.anthropicPromptCaching` (`off` | `5m` | `1h`, default `5m`) marks Claude requests with a top-level `cache_control` ephemeral CachePoint that LiteLLM forwards to the Claude API, so repeated prefixes (system prompt, tools, conversation history) are served from Anthropic's prompt cache. Unrelated to `litellm-connector.disableCaching`, which bypasses the LiteLLM proxy response cache.
- `1h` cache writes cost 2x input tokens versus 1.25x for `5m`; cache reads cost 0.1x for both tiers. Applies only to Anthropic Claude models.
- If a model rejects the marker, the connector strips it, retries the request, and remembers the rejection for the rest of the session (no repeat failure cost).

### Multimodal tool results
- An image returned by a tool now reaches the model instead of being silently dropped.
- The wire shape follows the provider family. Anthropic, Gemini/Vertex and Bedrock models receive `image_url` parts inside the `role: "tool"` message. OpenAI-compatible models (OpenAI, OpenRouter, DeepSeek, Moonshot, Mistral, SambaNova and anything unknown) receive placeholder text in the tool message plus one following user message with the images, because LiteLLM's transforms for those providers keep only the text of a content list and would drop the image.
- Images from parallel tool calls are grouped into one user message after the last tool message of the run, so tool-call adjacency is preserved, and each image group is attributed to the tool that produced it.
- Tool result parts are not filtered by `LanguageModelPartAudience`. Each part is converted according to its own content.
- Images returned by tools count toward the token budget, and `.copilotmd` transcripts render them as a size placeholder instead of raw bytes.

### `.copilotmd` session transcripts
- Chat requests are exported as `.copilotmd` markdown files (byte-compatible with Copilot Chat's debug view, except binary parts, which render as size placeholders instead of raw bytes) into `copilot-debug/<session id>/` under VS Code's hidden per-workspace extension storage (default) or global storage, configured via `litellm-connector.debug.copilotMdExport.*`. The export is off by default.
- Retention caps keep the export folder bounded: `maxFilesPerSession` trims the oldest files within each session, `maxSessions` deletes whole sessions beyond the count, and `maxTotalBytes` deletes whole sessions, oldest first, until the total is at or under 80% of the cap or only the session being written is left. The byte cap evicts every other session before the one being written; if that session alone still exceeds `maxTotalBytes`, its oldest files go until the total fits, including the file just written when that file alone exceeds the cap. Deleting a file updates its folder's modified time, so a folder can show a recent date without a new transcript.
- New command: **LiteLLM: Open .copilotmd Export Folder**.
- Reasoning/thinking parts and tool messages are rendered in transcripts; thinking parts are concatenated into continuous reasoning lines with visible separation between reasoning and text.
- The Metadata block escapes the free-text values it interpolates, so a tool description containing `<select>`, `<script>`, or `<!--` renders as text instead of hiding the rest of the preview. Headings collapse to one escaped line, a fenced block widens its fence past the longest run of `~` in its content, and a failed request renders the partial response it streamed before the failure heading.
- The session id attached to request metadata (`metadata.session_id`, which LiteLLM promotes to `litellm_session_id`) is the same id used for the export folder, so transcripts group with LiteLLM spend logs. It is derived from the host's conversation id when VS Code provides one (Copilot Chat in editor windows, and the Agents window from VS Code 1.143 on): passed through verbatim when that id is already a UUID, hashed to a UUID v5 otherwise. Requests with no host conversation behind them (title generation, other extensions, Agents window sessions on older builds) fall back to a fingerprint of the conversation's opening context: every message before the first assistant reply, system prompt included. The fingerprint separates sessions running under different agents or modes, and still collides when two conversations share both the system prompt and the opening request. Because the system prompt is part of the fingerprint, a mid-conversation system-prompt rebuild, such as a mode change, starts a new id for the turns that follow.
- Each transcript's Metadata block shows `sessionId` and `sessionIdSource` (`conversation` for a host UUID, `conversation-hashed` for a hashed host id, `fingerprint` for the fallback), and the `copilotmd.exported` structured log event carries the same source. `sessionIdSource` is the authoritative answer. As a quick hint from the folder name alone: fingerprints and hashed host ids are UUID v5 (`5` as the first character of the third group), while the host conversation ids seen so far have been UUID v4.

### Structured log persistence
- The "LiteLLM Structured" output channel is mirrored to daily JSONL files in extension global storage with 14-day retention (toggle via `litellm-connector.debug.structuredLogFile.enabled`), so diagnostics survive VS Code's output-channel rotation.
- The file mirror stays bounded: lines are counted in bytes, expired files are pruned at startup and at every rollover, and the whole folder is capped at 256 MB, deleting the oldest files first and never the file being written.
- Corrupt tool-call arguments now emit error-level structured events at every detection point (finish gate, recovery flush, emission fallback) with argument length and a preview, instead of leaving no durable evidence.
- Log-level pre-filtering guards on hot paths avoid message-formatting costs during long streaming responses.

### Model reload
- **LiteLLM: Reload Models** forgets the limits a live rejection taught the session, clears the discovery response cache and every backend's backoff history, then asks VS Code to re-query every provider group. Routing survives the reload, so a request from a running session keeps resolving its model while the picker refills.
- Changing a setting that shapes the model list (`modelOverrides`, `enableModelOverrides`, `modelCapabilitiesOverrides`, `displayPricingInPicker`, `forceResponsesEndpoint`) refreshes the model list automatically, without forgetting learned limits, because the limits describe the proxy rather than the settings. Other settings do not trigger a refresh, because they do not change what discovery returns.
- **LiteLLM: Show Available Models** lists the models each group currently delivers, shows the routable id as the row description, and copies that id when you pick a row. A group whose URL or API key changed stops contributing its previous backend's models to the list, unless another group still uses that backend.

### Streaming resilience
- Transport-level retry with mid-stream resume: when a stream dies mid-response, the connector rebuilds the request and resumes from the last assistant turn, appending a "Continue" nudge.
- Upstream failures reported *inside* the stream (LiteLLM's mid-stream `{"error": ...}` frame, and the Responses API `error` and `response.failed` events) are no longer ignored: transient ones (408, 409, 425, 429, 5xx including Anthropic's 529, overloaded, rate-limit, timeout) resume the request, and everything else surfaces the upstream message instead of ending the turn silently or being misread as an empty response.
- A response that stops at the output-token limit (`length`) or behind a content filter (`content_filter`) ends with a visible note explaining why it is incomplete. On the `/responses` endpoint the same note appears when the turn ends with `response.incomplete`: `max_output_tokens` maps to `length`, and `content_filter` stays `content_filter`.
- Reasoning-only streaming responses are retried instead of surfacing as empty replies.
- Cancellation and watchdog aborts are surfaced correctly on clean stream completion instead of being masked by retry exhaustion.
- Complete tool calls still buffered when a stream ends without a finish frame are delivered instead of discarded, and each concurrent session keeps its own stream state, so one session's tool calls never reach another.
- An abandoned upstream response body is cancelled, so a retried or failed request stops generating and billing.
- Configurable 429 retry budget via `litellm-connector.rateLimitMaxDelaySeconds`, the most time one call to the proxy spends waiting between rate-limit retries (default 120s). Without `Retry-After`, waits start at 0.5s and double, each at most 60s. A `Retry-After` that fits in the time left is honored exactly, and a longer one fails that call at once with a chat notice naming the setting instead of waiting for a retry that would be refused. Each wait is logged as `[rateLimitRetry]` in the output channel and as `request.rate_limit_retry` in the structured log.
- `networkRetries` and `networkRetryDelayMs` bound the resume attempts for dropped connections and transient upstream errors.

### Request handling fixes
- Reasoning-only assistant messages are supported (empty-string content) instead of being rejected.
- `normalizeToolCallId` only treats a leading `fc_` as a provider prefix and varies the padding filler, preventing dropped or duplicated tool call ids on repeated runs.
- Request errors are surfaced as response text instead of thrown exceptions, so the failed turn keeps the partial answer it already streamed: a thrown error makes the Agents window answer the turn with a 502 and drop that output. Each occurrence writes a `request.error_surfaced_as_text` entry with the request id, model, caller, error name and status, so a failure from a background caller (for example a summarization request) still leaves a trace. The caller is VS Code's `requestInitiator` (`core` from the Agents window harness), or `unknown` when the host sends none. Upstream error text is never logged.
- A stream cancelled after its last event is reported as cancelled, not as a success, and its transcript is marked `canceled`.
- The streaming cancellation listener is disposed when the stream ends, and a cancelled request is reported as `cancelled` rather than as a failure.
- `litellm-connector.inactivityTimeout` is clamped to 1 to 3600 seconds. A value of 0 or less would otherwise abort every response as soon as it starts.
- `discoveryTimeoutMs` is passed through to per-session clients and applies to reading the model-list body as well as the response headers.
- A caller that forces a tool call (`LanguageModelChatToolMode.Required`) sends `tool_choice: "required"` when it offers several tools, and names the single tool when it offers one, which `/responses` carries as a top-level `{ type: "function", name }` choice.
- `/responses` requests send their output-token cap as `max_output_tokens`, and usage detail objects are read under both LiteLLM's plural `input_tokens_details` / `output_tokens_details` names and the singular `input_token_details` / `output_token_details`.
- A tool-only reply counts its tool-call tokens as output, and the transcript usage line and the estimated cost include them.
- Model discovery applies LiteLLM's paused-model rule: deployments a proxy admin paused (`model_info.blocked`) are dropped during `/model/info` discovery, a public model name stays listed while at least one of its deployments is live, and each name is listed once.
- A model-list refresh that fails for a transient reason (network, timeout, 408/409/425/429, 5xx) keeps the group's last known models, marked with a warning icon and hover text, instead of emptying the picker (and the model choice of a running session). A misconfigured group (a 400, 401, 403, or 404, or one that never discovered) still shows an empty list so the real error stays visible.
- Requests route by the model object VS Code returns for the group, so two provider groups on the same LiteLLM host keep their own URL and API key.
- A rejected model parameter is reported once with the proxy-side fix (`additional_drop_params` / `drop_params`) instead of being stripped and resent. Only parameters the connector adds itself (the `cache_control` prompt-caching marker and the cache-bypass flag) are removed and retried.
- A model that rejects `stream_options.include_usage` is remembered under its namespaced model id, so later requests omit the flag without paying another failed round trip. Reload Models forgets it.
- `litellm-connector.disableCaching` sends `cache: { "no-cache": true }` at the top level of every chat and `/responses` body, which is where the proxy reads the directive and which it never forwards to a provider. A key that is not allowed to set it answers 403, so the connector strips it, retries once, and omits it for that model afterwards.
- `litellm-connector.forceResponsesEndpoint` sends chat-mode models to `/responses`, and `litellm-connector.allowChatCompletionsFallback` retries a `/responses` 5xx once on `/chat/completions`. Both default to false.
- A pasted Base URL is normalized: a trailing slash and one terminal `/chat/completions`, `/completions`, `/responses`, or `/model/info` are stripped, and a `/v1` prefix is kept.
- Tool-call-shaped text in a model's answer is delivered as text; only structured tool-call fields can trigger a tool.
- A tool keeps the name the caller declared. A name the wire already accepts is sent unchanged, so `github__create_issue` no longer collapses into `github_create_issue`. A name that had to change for the wire is translated back to the declared spelling before VS Code sees the call, and two names that would still collide are given distinct wire names.
- Tool schemas are sent as the caller declared them, with no rewriting, no dropped keywords, and no composite flattening. LiteLLM's transforms convert a schema where a provider needs a different shape (Gemini, Anthropic, Bedrock, vLLM, watsonx). A tool that declares no schema, or one that is not a JSON object, receives an empty object schema, which every endpoint accepts.
- The separate text parts of one tool result stay distinguishable: Claude and Bedrock receive one text item per part, and every other provider receives the parts joined with a blank line instead of running together.
- No chat history is dropped to fit a token budget: a context-overflow rejection from the proxy reaches the turn as an error with the proxy's message.

### New settings
- `litellm-connector.anthropicPromptCaching` (Anthropic prompt caching, default `5m`): see the dedicated section above.
- Per-model temperature: a `temperature` configuration property is exposed per model in VS Code's model settings (only for models that support the parameter) and sent with every request.

### Internal cleanup
- Removed the git commit-message feature (its command, SCM title button, `litellm-connector.commitModelIdOverride` setting, and provider), the unused `AuditTrail`, the "LiteLLM: Reset All Configuration" command, and the server-side token-counter request. Token counts now come from the local estimator only.
- Removed legacy and deprecated code paths, the unused v2 message pipeline, the legacy config migration, and the old Set Log Level command; inlined language model provider registration.
- Removed upstream's PostHog telemetry pipeline, marketplace packaging, CI/CD, and community scaffolding. Local metric logging and structured logging remain.
- `npm run bump-version dev` now emits semver-correct dotted prerelease tags (e.g. `2.1.10-dev.11`).

### Agents window (Copilot SDK harness) compatibility
- The manifest declares `capabilities.agentsWindow.supported: true` plus the `agentsWindowActivation` API proposal, so the extension runs in the Agents window even when no editor window is open there.
- Requires `chat.agentHost.byokModels.enabled` to be on (default). If it is off, re-enable it, because the Agents window loads BYOK models only through that bridge. Separately, models surface only when `extensions.experimental.enableAgentsWindowCapability` is on (default). If that setting is off, or your VS Code build predates it, add the explicit override: `"extensions.supportAgentsWindow": { "GethNet.litellm-connector-copilot": true }`.
- Session grouping uses the Copilot SDK session id that VS Code 1.143+ forwards to BYOK providers. Older builds fall back to the message fingerprint described above.
- Streaming limitation: in Agents window (Agent Host) sessions, responses arrive as one block after generation instead of incrementally. This is a VS Code buffering limitation, not a connector bug. The connector streams normally in editor-window chat. Tracked upstream in microsoft/vscode#339493. Related caveats: BYOK models may be rejected for subagents (microsoft/vscode#333802) and BYOK over SSH hosts is unsupported (microsoft/vscode#325738).

## Building locally

Run npm scripts from any shell: the `clean` scripts are cross-platform Node scripts.

```bash
npm install
npm run vscode:pack:dev   # produces litellm-connector-copilot-<version>.vsix
```
