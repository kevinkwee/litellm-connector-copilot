# LiteLLM Connector for Copilot (personal fork)

This repository is my personal fork of [gethnet/litellm-connector-copilot](https://github.com/gethnet/litellm-connector-copilot), customized for my own use. It is **not** published to the VS Code Marketplace or Open VSX, and it does not accept issues or pull requests. For the original project, documentation, and support, see the upstream repository.

All credit for the original extension belongs to the upstream authors. Licensed under Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).

## Custom changes added in this fork

Forked from upstream `v2.1.9`. Everything below is on top of that baseline.

### Reasoning control
- Expanded reasoning effort levels with corrected fallback behavior.
- `reasoning_effort: "none"` is now sent explicitly instead of the parameter being silently dropped.

### Claude reasoning continuity across tool calls
- Claude's encrypted thinking is preserved across tool call rounds: signed thinking blocks are sealed into VS Code replayable thinking parts (signature plus the exact block text in part metadata, matching the keys the built-in Copilot providers persist), and redacted thinking blocks carry the redacted data. On later rounds the connector rebuilds Anthropic `thinking_blocks` from those parts, so the model keeps its reasoning context instead of re-deriving it.
- Unsigned or malformed signed blocks are ignored rather than reconstructed; user and system messages never receive signatures.
- Claude stream usage reports Anthropic prompt-cache counters separately: cache-write tokens are billed at the cache-write price and cache-read tokens at the cache-read price in the estimated request costs.

### Anthropic prompt caching
- New setting `litellm-connector.anthropicPromptCaching` (`off` | `5m` | `1h`, default `5m`) marks Claude requests with a top-level `cache_control` ephemeral CachePoint that LiteLLM forwards to the Claude API, so repeated prefixes (system prompt, tools, conversation history) are served from Anthropic's prompt cache. Unrelated to `litellm-connector.disableCaching`, which bypasses the LiteLLM proxy response cache.
- `1h` cache writes cost 2x input tokens versus 1.25x for `5m`; cache reads cost 0.1x for both tiers. Applies only to Anthropic Claude models; commit message generation never marks its one-shot prompts.
- If a model rejects the marker, the connector strips it, retries the request, and remembers the rejection for the rest of the session (no repeat failure cost).

### Multimodal tool results
- An image returned by a tool now reaches the model instead of being silently dropped.
- The wire shape follows the provider family. Anthropic, Gemini/Vertex and Bedrock models receive `image_url` parts inside the `role: "tool"` message. OpenAI-compatible models (OpenAI, OpenRouter, DeepSeek, Moonshot, Mistral, SambaNova and anything unknown) receive placeholder text in the tool message plus one following user message with the images, because LiteLLM's transforms for those providers keep only the text of a content list and would drop the image.
- Images from parallel tool calls are grouped into one user message after the last tool message of the run, so tool-call adjacency is preserved, and each image group is attributed to the tool that produced it.
- Parts tagged with a `LanguageModelPartAudience` that excludes the model are not uploaded.
- Images returned by tools count toward the token budget, and `.copilotmd` transcripts render them as a size placeholder instead of raw bytes.

### `.copilotmd` session transcripts
- Chat requests are exported as `.copilotmd` markdown files (byte-compatible with Copilot Chat's debug view, except binary parts, which render as size placeholders instead of raw bytes) into `copilot-debug/<session id>/` under VS Code's hidden per-workspace extension storage (default) or global storage, configured via `litellm-connector.debug.copilotMdExport.*`. The export is off by default.
- Per-session retention caps keep the export folder bounded.
- New command: **LiteLLM: Open .copilotmd Export Folder**.
- Reasoning/thinking parts and tool messages are rendered in transcripts; thinking parts are concatenated into continuous reasoning lines with visible separation between reasoning and text.
- The session id attached to request metadata (`metadata.session_id`, which LiteLLM promotes to `litellm_session_id`) is the same id used for the export folder, so transcripts group with LiteLLM spend logs. It is derived from the host's conversation id when VS Code provides one (Copilot Chat in editor windows, and the Agents window from VS Code 1.143 on): passed through verbatim when that id is already a UUID, hashed to a UUID v5 otherwise. Requests with no host conversation behind them (title generation, commit-message generation, other extensions, Agents window sessions on older builds) fall back to a fingerprint of the conversation's opening context: every message before the first assistant reply, system prompt included. The fingerprint separates sessions running under different agents or modes, and still collides when two conversations share both the system prompt and the opening request. Because the system prompt is part of the fingerprint, a mid-conversation system-prompt rebuild, such as a mode change, starts a new id for the turns that follow.

### Structured log persistence
- The "LiteLLM Structured" output channel is mirrored to daily JSONL files in extension global storage with 14-day retention (toggle via `litellm-connector.debug.structuredLogFile.enabled`), so diagnostics survive VS Code's output-channel rotation.
- Corrupt tool-call arguments now emit error-level structured events at every detection point (finish gate, recovery flush, emission fallback) with argument length and a preview, instead of leaving no durable evidence.
- Log-level pre-filtering guards on hot paths avoid message-formatting costs during long streaming responses.

### Streaming resilience
- Transport-level retry with mid-stream resume: when a stream dies mid-response, the connector rebuilds the request and resumes from the last assistant turn, appending a "Continue" nudge.
- Reasoning-only streaming responses are retried instead of surfacing as empty replies.
- Cancellation and watchdog aborts are surfaced correctly on clean stream completion instead of being masked by retry exhaustion.
- Complete tool calls still buffered when a stream ends without a finish frame are delivered instead of discarded, and each concurrent session keeps its own stream state, so one session's tool calls never reach another.
- Configurable 429 retry budget via `litellm-connector.rateLimitMaxDelaySeconds` (honors `Retry-After`); the `networkRetries` cap was removed.

### Request handling fixes
- Reasoning-only assistant messages are supported (empty-string content) instead of being rejected.
- `normalizeToolCallId` only treats a leading `fc_` as a provider prefix and varies the padding filler, preventing dropped or duplicated tool call ids on repeated runs.
- Request errors are surfaced as response text instead of thrown exceptions, and the streaming cancellation listener is disposed when the stream ends.
- `discoveryTimeoutMs` is passed through to per-session clients.
- Model discovery applies LiteLLM's paused-model rule: deployments a proxy admin paused (`model_info.blocked`) are dropped during `/model/info` discovery, a public model name stays listed while at least one of its deployments is live, and each name is listed once.

### New settings
- `litellm-connector.anthropicPromptCaching` (Anthropic prompt caching, default `5m`): see the dedicated section above.
- `litellm-connector.autoTrimMessages` (opt-in, off by default): trims older messages to fit the model input token budget, covering both the proactive per-request trim and the recovery retry after a context-overflow rejection.
- Per-model temperature: a `temperature` configuration property is exposed per model in VS Code's model settings (only for models that support the parameter) and sent with every request.

### Internal cleanup
- Removed legacy and deprecated code paths, the unused v2 message pipeline, the legacy config migration, and the old Set Log Level command; inlined language model provider registration.
- Removed upstream's PostHog telemetry pipeline, marketplace packaging, CI/CD, and community scaffolding. Local metric logging and structured logging remain.
- `npm run bump-version dev` now emits semver-correct dotted prerelease tags (e.g. `2.1.10-dev.11`).

### Agents window (Copilot SDK harness) compatibility
- The manifest declares `capabilities.agentsWindow.supported: true` plus the `agentsWindowActivation` API proposal, so the extension runs in the Agents window even when no editor window is open there.
- Requires `chat.agentHost.byokModels.enabled` to be on (default). If it is off, re-enable it, because the Agents window loads BYOK models only through that bridge. Separately, models surface only when `extensions.experimental.enableAgentsWindowCapability` is on (default). If that setting is off, or your VS Code build predates it, add the explicit override: `"extensions.supportAgentsWindow": { "GethNet.litellm-connector-copilot": true }`.
- Session grouping uses the Copilot SDK session id that VS Code 1.143+ forwards to BYOK providers. Older builds fall back to the message fingerprint described above.
- Streaming limitation: in Agents window (Agent Host) sessions, responses arrive as one block after generation instead of incrementally. This is a VS Code buffering limitation, not a connector bug. The connector streams normally in editor-window chat. Tracked upstream in microsoft/vscode#339493. Related caveats: BYOK models may be rejected for subagents (microsoft/vscode#333802) and BYOK over SSH hosts is unsupported (microsoft/vscode#325738).

## Building locally

On Windows, run npm scripts from Git Bash because the `clean` scripts use Unix `find`.

```bash
npm install
npm run vscode:pack:dev   # produces litellm-connector-copilot-<version>.vsix
```