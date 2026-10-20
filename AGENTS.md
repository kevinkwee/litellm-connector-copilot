# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository. It defines repo-wide, tool-agnostic expectations for agents contributing to `litellm-connector-copilot`.

> This is the single source of truth for agent behavior. Any tool-specific instruction files should **reference** this file and avoid duplicating it.

## Project Overview

`litellm-connector-copilot` is a VS Code extension that integrates a LiteLLM proxy into VS Code's Language Model APIs. It exposes the proxy's models as user-selectable chat models for GitHub Copilot Chat, streams chat responses and tool calls, reports per-model pricing and estimated request costs, and adds LiteLLM-backed git commit message generation. The codebase is TypeScript, bundled with esbuild, and targets the VS Code 1.125 Language Model API surface with per-group provider configuration.

## Prerequisites

- Node.js and npm. No Node version is pinned in the manifest.
- `npm install` also runs `npm run download-api`, which refreshes `src/vscode.d.ts` and the `src/vscode.proposed.*.d.ts` files from `@vscode/dts`.
- VS Code 1.125 or newer (`engines.vscode` is `^1.125.0`).
- A LiteLLM proxy (or compatible OpenAI-like gateway) exposing `/chat/completions`, `/completions`, or `/responses` endpoints, with a base URL and API key.
- GitHub Copilot Chat, which hosts the chat models this extension provides.

## Core Philosophy

### Trade-off Priority (when conflicts arise)

1. **Correctness**: code does what it should
2. **Simplicity and readability**: code is easy to understand
3. **Testability**: code is easy to test
4. **Performance**: code is fast enough
5. **Abstraction and reuse**: code is DRY

### Ground Rules

- Read and understand existing code before modifying it.
- Treat the project's existing patterns and code as a starting point, not as evidence of correctness. Legacy code can carry bad practices, over-complex code, and code smells. If something looks wrong, speak up and write new code the right way (correct, secure, performant, readable, maintainable) instead of propagating the problem, even if that means departing from existing code.
- Isolate new code from legacy where possible, and never copy legacy code into new code without reviewing its quality.
- If a requirement is ambiguous, ask before writing code.
- Prefer incremental delivery. Core logic first, then edge cases, then refinements.
- Do not overengineer. Build for today's requirements, not hypothetical future ones.
- Do not break foundation code. Changes to widely-depended-on modules ripple into every dependent, so verify dependents before changing a shared field, method, or contract.

## Design Principles

### SOLID

| Principle | Rule | Common Mistake |
|-----------|------|----------------|
| **SRP** (Single Responsibility) | Each class/function/file has ONE reason to change. If you need "and" or "or" to describe it, split it. | Interpreting SRP as "one function per class." SRP means one *axis of change*. |
| **OCP** (Open/Closed) | Add new behavior by writing new code, not modifying existing code. Use polymorphism or strategy patterns where change is expected. | Over-engineering with premature abstractions. Apply OCP where you have *evidence* of changing requirements. |
| **LSP** (Liskov Substitution) | Subclasses must honor the contract of their parent. Prefer composition over inheritance when "is-a" is not strict. | Overriding a method to throw or do nothing. |
| **ISP** (Interface Segregation) | Define small, role-specific interfaces. Clients depend only on methods they use. | Creating one "service" interface stuffed with methods for many unrelated roles. |
| **DIP** (Dependency Inversion) | Depend on abstractions at module boundaries, not concrete implementations. | Confusing DIP with "just use dependency injection." DIP is about inverting the *direction of source-code dependency*. |

### DRY (Don't Repeat Yourself)

- Extract duplicated logic when the copies are the same business rule and the duplication already costs more than a shared implementation would.
- Single source of truth for configuration, constants, and schema definitions.
- **Prefer duplication over wrong abstraction.** Two pieces of code that look similar but serve different business purposes are NOT duplication, because merging them creates accidental coupling.
- "Wrong abstraction" means premature generalization, unclear purpose, or coupling unrelated concerns.
- Reusable by default: extract pure helpers and shared utilities instead of copy/paste.
- Avoid duplicate branches of logic when a shared helper, adapter, or base-class method can express the behavior once.

### KISS (Keep It Simple)

- Choose the simplest implementation that satisfies current requirements.
- Prefer simple, explicit code over cleverness.
- Prefer standard library solutions over custom implementations.
- A plain function call beats metaprogramming. A plain object beats a class when all you need is data grouping.
- Do not add design patterns, abstractions, or frameworks "just in case."

### YAGNI (You Aren't Gonna Need It)

- Implement features only when there is a concrete, current requirement.
- Do not build generic or extensible frameworks before you have at least two concrete use cases.
- Delete speculative code and unused feature flags regularly.
- Three similar lines of code is better than a premature abstraction.

## Code Quality

### Linting and Formatting

- We use **ESLint** for linting and **Prettier** for formatting. Match the existing TypeScript patterns and the repo's ESLint and Prettier configuration.
- After making changes, run `npm run lint` to lint and `npm run format` to check formatting. Use `npm run lint:fix` and `npm run format:fix` to autofix.
- Ensure all rules defined in the linter config (`eslint.config.*`) and the Prettier config are followed (e.g. standard line length, quotes, no unused imports).

#### Handling Linter Violations (Decision Tree)

When the linter reports a violation, follow this decision tree **in order**. Use the **least invasive** option that keeps the codebase correct and the rule meaningful. Do not jump straight to suppressing a rule. Always evaluate fixing or configuring it first.

1. **Fix the code** (preferred, almost always the right choice)
   - Resolve the underlying issue so the rule passes naturally.
   - Example: remove an unused import, rename a shadowed variable, simplify a complex conditional, add a type annotation.
   - This is the only option that improves the codebase.

2. **Configure the rule** (when the rule is valid but its default settings or thresholds do not fit the project). Tuning keeps the rule active while fitting the project's conventions.
   - Example tuning knobs: line length, complexity thresholds, quote style.
   - Add an inline comment in the config when the reason is not obvious from the setting name.

3. **Per-line suppression** (when the violation is a genuine, localized exception and fixing it would make the code worse).
   - Use the **specific rule name(s)**, never a blanket suppression:

     ```typescript
     const proposed = vscode.lm as any; // eslint-disable-next-line @typescript-eslint/no-explicit-any -- proposed-API shape is untyped in the current @vscode/dts snapshot
     ```

   - Add a brief reason explaining *why* the suppression is necessary.
   - Suppress only the offending rule(s), not everything on that line.
   - Valid reasons: false positive, a necessary inline pattern, or a framework or proposed-API quirk.

4. **Block-scope suppression** (when a contiguous block of lines legitimately violates a rule and per-line suppression would be noisy).
   - Wrap the block between disable and enable markers:

     ```typescript
     /* eslint-disable @stylistic/max-len -- generated data table with intentionally wide lines */
     const PAYLOAD_TABLE = [
       // ...
     ];
     /* eslint-enable @stylistic/max-len */
     ```

   - Use the specific rule name(s), and always re-enable on the other side. Never leave a rule disabled for the rest of the file.
   - Prefer this over per-line when the block spans more than ~3 lines, or the rule would be violated on every line of the block.

5. **Per-file ignore in the linter config** (when a whole file or directory legitimately violates the rule).
   - Scope the glob pattern as narrowly as possible (e.g. `src/test/**`, not `**/*.ts`).
   - Document *why* each rule is ignored for that path with an inline config comment.

6. **Global ignore of the rule** (last resort, only when the rule is incompatible with the project's conventions or produces widespread false positives).
   - Before adding it, confirm the rule is not catching real bugs across the codebase, and check that it is not already ignored.
   - Always add an inline comment explaining *why* it is disabled.

### Naming

- Use clear, meaningful, intention-revealing names. The name should answer *why* it exists and *what* it does.
- Functions start with a verb that names the action they perform.
- When a framework or convention dictates the name (interface implementations, overrides, event handlers, generated hooks), follow it.
- Classes are nouns: the type is a thing, and its functions are its behavior.
- Booleans read as a yes/no question to the reader. A prefix (`is`, `has`, `can`, `should`) works, and so does a plain adjective or past participle (`enabled`, `deprecated`) when the declaration or context makes the type clear. Prefer whichever form the surrounding code already uses, so related names stay consistent.
- No abbreviations unless universally understood (`id`, `url`, `api`).
- No generic names: `data`, `result`, `obj`, `thing`, `temp`, `misc`, `utils`.
- The joiners "and" or "or" in a unit's name signal that the unit may hold two responsibilities. Treat them as a reason to re-examine the unit, and usually to split it, not as words that must never appear. When the joined form is genuinely one domain concept, the name is fine.

### Strong Typing

- Use strong typing everywhere. Avoid `any`, `object`, or untyped escape hatches.
- Use typed parameters and return types for all public functions.
- Never cast to `any` just to make something compile.
- Tests must not use or target `any` as an item or constraint either. `any` leads to confusion and black-box type code. Use `unknown` plus narrowing, or a typed test seam, instead.

### Immutability

- Default to immutable. Use `const`, `readonly`, `ReadonlyArray`, and `ReadonlyMap`.
- Return new objects from transformation functions instead of mutating inputs.
- Never expose mutable internal collections. Return copies or read-only views.
- Mutable local variables inside a function are fine. The danger is mutable *shared state*.

### Early Returns and Guard Clauses

- Validate preconditions at the top of functions and return or throw early.
- Reduce nesting by inverting conditions and returning early.
- Keep the happy path at the lowest indentation level.

### No Magic Values

- Extract repeated numbers and strings to named constants.
- Use descriptive variable names instead of inline literals.

### Comments and Docstrings

- Do not comment obvious code. Prefer self-explanatory code through good naming. A comment that exists only to compensate for a poor name is a failure to express yourself in code.
- Comments explain **WHY**, never **WHAT**. Before writing a comment, ask whether removing it leaves the code harder to understand. If not, delete it.
- Document non-obvious code blocks, especially around request shaping, streaming, retries, trimming, and error handling. State the assumptions, invariants, and failure modes the next reader cannot infer from the code.
- **No black boxes**: if something just works, document *why* (assumptions, invariants, and failure modes).
- No section separator comments (`// ====== banners` between functions), since file structure already separates the sections.
- No commented-out code. Use version control.
- No TODO comments without ticket references (the referenced ticket must be findable by a cold reader).
- **Cold-reader oriented.** Every comment must make sense to a reader with no prior context. Do not reference internal plans, phases, iterations, decision tables, meetings, or documents the reader cannot find. If a design decision needs context, state the constraint itself.
- **No change narration.** Comments describe the current code, not how it got there. No "previously", "no longer", "was removed", "was refactored", "moved to", "used to". If a negative statement is genuinely needed for correctness (e.g. a guard that explicitly rejects an input), state the positive contract (what *is* required).
- **Describe the unit, not its sibling.** Do not write that code "mirrors", "reflects", or "matches" another module as a substitute for describing it. State each fact directly where it lives.
- **No unverified performance claims.** Do not write estimated timings in comments unless they were actually measured and the measurement is load-bearing for the design.

### Functions

- Keep functions short with a single level of abstraction.
- One function does one thing. If it does two things, split it.
- Do not use boolean parameters that switch behavior. Split them into two named functions.
- Eliminate dead code and unused imports on every change.

### Performance

- Avoid N+1 patterns. Batch work instead of issuing per-item calls in loops, including HTTP requests, discovery fetches, and telemetry events.
- Reach for raw escape hatches only for what the framework cannot express, and never at the cost of type safety.

## Architecture

```
src/
├── extension.ts         # activation, provider registration, command wiring
├── types.ts             # shared extension types
├── providers/           # Language Model provider implementations
│   └── base/            # shared base-orchestrator support modules
├── adapters/            # HTTP client, payload shaping, SSE and stream parsing, tokenizers
├── config/              # configuration and secrets
├── commands/            # command registrations and UI entry points
├── observability/       # structured logging, audit trail, debug export
├── utils/               # shared utilities (logging, model helpers, pricing)
└── test/                # integration tests and shared test utilities
```

This structure can be updated as the project evolves. If you add new files or modules, update this diagram and the corresponding sections to reflect the changes.

### Separation of Concerns

- Prefer small, hierarchical modules with one clear responsibility each.
- Keep orchestration thin. Push protocol and payload shaping and parsing into adapters, and shared transformations into pure utilities.
- Pure transformations (input to output) stay separated from side effects (I/O, VS Code APIs, HTTP, telemetry).
- Centralize cross-cutting concerns: logging, telemetry, model capability logic, and token budgeting and trimming.

### Layer Rules

| Layer | CAN | CANNOT |
|-------|-----|--------|
| **Provider** (`src/providers/`) | Orchestrate the request lifecycle, emit VS Code protocol parts | Shape HTTP payloads, parse SSE streams, own transport policy |
| **Adapter** (`src/adapters/`) | Translate payloads, parse streams, route endpoints | Make product decisions, own telemetry policy |
| **Client** (`litellmClient.ts`) | Execute HTTP, retries, endpoint routing | Contain chat-protocol logic |
| **Config** (`src/config/`) | Read and convert configuration and secrets | Contain request logic |
| **Utils** (`src/utils/`) | Pure helpers, validation, formatting | Have side effects, do I/O, maintain state |

### Dependency Injection

- Inject dependencies through constructors or method parameters. Make all dependencies explicit.
- Inject I/O boundaries (HTTP clients, VS Code API surfaces, clock, logger) so they are swappable in tests.
- Keep the composition root at the extension entry point (`src/extension.ts`), separate from business logic.
- Only inject things that have *side effects* or *vary between environments*. Do not inject pure utility functions.

### Dependency Direction

- Base and shared modules are depended upon by feature modules, never the reverse. Foundation code must not import feature code.
- Derived providers extend `LiteLLMProviderBase` and add VS Code protocol handling only. Shared cross-provider behavior belongs in the base class or adapters.
- Do not modify vendored or generated code (`src/vscode.d.ts`, `src/vscode.proposed.*.d.ts`), because those are upstream snapshots refreshed by `npm run download-api`. The only exception is a minimal, clearly-marked patch for a confirmed upstream bug.

## File Structure

### Avoid Over-Engineering

- Split when you have clear, reusable responsibilities. Keep together when separation adds complexity without benefit.
- Prefer extending an existing module before creating a parallel one with overlapping behavior.
- Keep files focused and avoid monolithic logic. Limit any TypeScript file to **1000 lines of code**. Break larger files into smaller modular files or submodules before they exceed this threshold.

### File Naming

- **NEVER** use generic names: `utils`, `helpers`, `misc`, `common`, `shared` as standalone files.
- Name files after what they do, not after a contract nickname or an internal artifact.
- Prefer names that convey intent (`*Client`, `*Adapter`, `*Utils`, `*Provider`).
- Keep new file names consistent with the project's existing naming scheme.
- Place new code in the most specific folder that owns the responsibility.
- When introducing a new folder or module, make the ownership boundary obvious from the name.

Folder ownership (unit tests are co-located with the module under test in `src/**/test/`):

- `src/providers/`: Language Model provider implementations (`liteLLMProviderBase.ts`, `liteLLMChatProvider.ts`, `liteLLMCommitProvider.ts`, `index.ts`)
- `src/adapters/`: HTTP clients, payload shaping, endpoint-specific parsing, SSE and streaming (`sse/`, `streaming/`), tokenizers
- `src/utils/`: shared utilities (logging, local request metrics, model helpers, pricing, `thinkingBlocks`, `promptCaching`, `connectorNotice`, `transportRetry`)
- `src/config/`: configuration and secrets
- `src/commands/`: command registrations and UI entry points
- `src/observability/`: structured logging, audit trail, debug export
- `src/test/`: integration tests (`integration/`) and shared test utilities (`utils/`)

## Error Handling

- Handle expected errors explicitly. No silent failures.
- Use domain-relevant error types where they exist instead of generic throws.
- Do not swallow errors silently. If an upstream or external call fails, log the failure (with approved identifiers, not payloads or secrets) and surface a meaningful error to the caller.
- Return or throw errors with meaningful context: what failed, what input caused it, and how to fix it.
- Errors are part of the API contract.
- Validate inputs at system boundaries (request ingress, configuration conversion). Fail fast on invalid data.
- Distinguish between recoverable errors (retryable transport failures, rate limits, reasoning-only responses) and fatal exceptions. The retry budgets in the client layer exist for the recoverable class.
- Never silently coerce or fix invalid input. Reject it with a clear message.

```typescript
// BAD
try {
  const result = doSomething();
} catch {
  // ignored
}

// GOOD
try {
  const result = doSomething();
} catch (err) {
  throw new Error("Do something failed", { cause: err });
}
```

### Error Chaining

When wrapping a caught error in a new one, pass the original through `cause` so diagnostics survive the layer boundary.

- Use `{ cause: err }` when the original error adds diagnostic value across a layer boundary.
- Omit `cause` only when the original would leak internals into a user-facing message. In that case fold the useful facts into the new message instead.
- Do not both embed the cause's text in the new message and attach `cause`. Pick one, so the error is not reported twice.

## Security

- Sanitize and validate all user and external input at the boundary. Model lists, configuration values, and streamed SSE payloads are external input. Never trust data from outside the system boundary.
- Use allowlists, not denylists. Reject by default, accept only known-good patterns.
- Store API keys only via `ConfigManager` / `SecretStorage`. Provider secrets are declared with `"secret": true` in the `languageModelChatProviders` contribution in `package.json` and encrypted by VS Code. **Never** store secrets in `globalState`.
- No hardcoded API keys, tokens, or passwords.
- Do not expose internal details in error messages to end users.
- Use fake or anonymized data in tests, never real user data. Tests use mocked fetch and must never hit a real LiteLLM proxy.

## Observability

### Logging

- Use the structured log channel ("LiteLLM Structured") with consistent key-value fields, not interpolated strings.
- Log at key decision points and boundaries (discovery, request routing, retries, quota errors), not inside tight loops or per-chunk stream handling.
- Include the operation name, the model id, the endpoint, the outcome (success or failure), and the duration where relevant.
- Use consistent field names across the entire codebase.
- Add logging at major function entry and exit and at critical decisions where applicable.

### Log an Error at Exactly One Layer

A given error should be logged by exactly **one** handler: the layer that **terminates** its lifecycle (it swallows the error, converts it into a user-facing message, or surfaces it to VS Code). Every other layer that touches it must either re-throw silently or transform it without logging.

- You **swallow** the error (catch and continue, return a fallback): **log it**. No caller will see it, so this is your last chance.
- You **re-throw**: **do not log**. Let the next handler own the log.
- You are at the **top boundary** (stream failure surfaced to VS Code, activation failure): **log it**.
- You are an **intermediate layer** translating infra errors: **do not log**. Attach `cause` and let the boundary log.

### Log Levels

| Level | When to Use |
|-------|-------------|
| **Error** | Something is broken and needs human attention |
| **Warn** | Degraded but self-recoverable (retrying, falling back) |
| **Info** | Significant events (backend registered, models discovered) |
| **Debug/Trace** | Diagnostic detail (payload summaries, stream state) |

### PII and Secrets in Logs (Zero Tolerance)

- **NEVER** log API keys, Authorization headers, raw prompt content, user message text, or tool call payloads.
- Approved log content: model identifiers, endpoint paths, HTTP status codes, durations, token counts, and error codes.
- One exception: when tool call arguments fail to parse, `stream.tool_call_args_invalid_json`, `vscode.tool_call_parse_failed`, and the `[vscodePartEmitter] Part #<n>: Failed to parse tool call arguments` warning keep an `argsPreview` of at most 160 characters. Merged or truncated arguments can only be diagnosed from their content, for example two calls whose fragments share one buffer.
- Even at trace level, log the **length** of a payload, delta, or reasoning chunk instead of a slice of it, apart from the tool-argument preview above. The structured channel is mirrored to a file, so a `preview` field is a persisted copy of model output or tool arguments.
- Quota errors detected in chat history trigger tool redaction before anything is logged or retried (see `disableQuotaToolRedaction`).
- No `console.log()` with user data, since these lines go to production logs.

## Testing

> **Test code is production code.** It receives the same care, review, and quality standards.

### Core Principles

- Write unit tests for all core logic. Unit tests are co-located with the module under test in `src/**/test/` as `*.test.ts` files. Integration tests live in `src/test/`.
- Write integration tests for external integrations (the LiteLLM HTTP surface, VS Code protocol wiring).
- Distribute tests as a pyramid: many fast unit tests at the base, focused integration tests at the boundaries, and only a few end-to-end tests for critical user journeys.
- Follow Arrange-Act-Assert (AAA) structure. ONE act per test, ONE logical assertion per test.
- Tests MUST be independent, deterministic, and not depend on execution order.
- Mock or fake all external dependencies (HTTP, VS Code APIs, filesystem, time, randomness). Never hit real external services in tests.
- Test behavior through public APIs rather than calling private or internal methods directly. Preserve meaningful branch coverage while minimizing coupling to implementation details.
- When a mock must throw, have it throw a concrete type (the error the real code would raise), not a bare or generic `Error`.
- Use the test commands documented in this file for the touched modules. Do not invent new test commands.
- Tests must be explanatory: intent is obvious from the name and structure.
- Tests must be clean and well documented. Prefer clarity in setup, act, and assert.
- Prefer small, focused unit tests with deterministic inputs.

### How to Run Tests

```bash
npm run test:coverage
```

This is the only test command agents should use. It compiles first, runs the VS Code-hosted Mocha suite with coverage enabled, and prints a text summary. HTML and lcov reports land in `coverage/`.

### Test Naming

- Test files are named after the unit under test, optionally with an aspect suffix (`mapChatRoles.test.ts`, `liteLLMProviderBase.transport.test.ts`), and live in the `test/` folder of the module they cover.
- Suites (`suite(...)`) name the unit under test and may nest per function (e.g. `suite("lmcr_toString")` inside `suite("mapChatRoles")`).
- Test cases (`test(...)`) name the behavior they protect: subject plus scenario or outcome (e.g. `test("converts User role to 'user'")`, `test("defaults unknown roles to 'system'")`).
- Keep names concise and readable. Prefer "not found" over "doesn't exist". Do not pad names with should or when ceremony.
- Do not encode the assertion type or the fixture names in the test name.

### Tests Must Also Challenge the Code, Not Only Confirm It

**Happy path tests are the foundation**, because they validate the code works under normal conditions. Always start with these.

**But happy path tests ALONE are not enough.** You MUST also write adversarial tests that actively try to break the code and find defects:

- Unexpected input types: `null`, `""`, `[]`, `{}`, `0`, `-1`
- Boundary values: max token budget, exactly at the limit, one past the limit
- Malformed data: missing fields, extra fields, wrong types, invalid formats (malformed SSE frames, truncated JSON)
- Error states: what happens when dependencies fail?
- What should NOT happen: verify that forbidden states are correctly rejected
- Error messages and types: not just that it fails, but *how* it fails

**Write tests based on REQUIREMENTS/SPEC, not on what the source code currently does.** This is how you catch bugs where the code diverges from expected behavior.

**When a test fails:** first ask if the CODE is wrong, not the test. Do NOT silently change a failing assertion to match the current code without understanding WHY.

When fixing bugs, add a regression test that captures the bug so it cannot silently return.

### Test File Rules

- Split test files by logical separation, not by an arbitrary line count. One file per unit, module, or service is fine even at 800+ lines, and unrelated behaviors belong in separate files.
- Keep the Arrange part of each test small. When one test's setup grows past ~20 lines, extract it into helpers or factories. Shared helpers live in `src/test/utils/`.

### Coverage

- **Minimum acceptable: 85% lines.** Below it, the task is not complete.
- **No category (statements, branches, functions, lines) may regress by more than 1%** relative to the previous coverage state.
- Strive for 90%+ on statements, branches, and functions.
- Focus on **branch coverage** (both sides of `if/else`, all `catch` blocks), not just line coverage.
- High coverage with no assertions is worthless. Every test MUST have at least one meaningful assertion.
- Coverage must be **run and shown** at the end for ALL created tests.

### All Created Tests MUST Pass

- Every test you create or modify MUST pass. Zero failures, zero skips.
- Never disable, skip, or delete a test to hide a failure.
- Never leave a test "to fix later". Fix it now.
- If coverage is below the agreed minimum: write more tests, re-run, repeat until the minimum is met.

### What NOT to Test

- Simple getters, setters, and trivial mappers are not worth testing.
- Implementation details such as method call order or internal state. Test behavior instead.
- Do not inflate coverage with meaningless assertions.

### Anti-Patterns (Forbidden)

| Pattern | Problem |
|---------|---------|
| **The Liar** | Test passes but doesn't verify the behavior it claims to test |
| **The Mirror** | Test reads the source code and asserts exactly what the code does, so it finds zero bugs |
| **The Giant** | 50+ lines of setup, multiple acts, and dozens of assertions. Should be 5+ separate tests |
| **The Mockery** | So many mocks that the test only tests the mock setup |
| **The Inspector** | Coupled to implementation details, breaks on any refactor |
| **The Chain Gang** | Tests depend on execution order or share mutable state |
| **The Flaky** | Sometimes passes, sometimes fails with no code changes |

## Change Workflow (Agent and CI)

### Commands (permitted only)

- `npm run clean`: clean build artifacts
- `npm run compile`: TypeScript typecheck and build validation
- `npm run lint`: ESLint checks
- `npm run lint:fix`: ESLint checks with autofix
- `npm run format`: Prettier formatting check
- `npm run format:fix`: Prettier formatting with fix
- `npm run test:coverage`: unit tests with coverage report (use this for testing)
- `npm run bump-version patch|minor|dev`: version bumps

> ⚠️ **Do not use any other npm scripts.** They may cause issues. Only run the commands listed above.

### When to Run What

- Cover non-trivial logic changes with tests, added or updated alongside the change.
- Before and after non-trivial edits: run `npm run compile` and `npm run test:coverage`.
- Before finishing the task: verify the changed files contain the intended code, or that new files exist with the expected contents.
- Before finishing the task: run `npm run lint`, then `npm run format`, then `npm run test:coverage` independently, and verify each succeeds.
- Before opening or updating a PR: run `npm run lint`, then `npm run format`, then `npm run test:coverage` independently, and verify each succeeds.

### Validation Requirements

- Do not assume an edit succeeded. Confirm the change by inspecting the file contents or verifying the new file exists on disk with the expected content.
- Validate both behavior and implementation presence: passing tests alone are not enough if the requested file edits did not land.
- When reporting completion, ensure the repository state reflects the requested changes and the final file contents match the intended outcome.

## Code Review

### Priority (blockers first)

1. **Security and PII**: no PII in logs, no hardcoded secrets, secrets only via `ConfigManager` / `SecretStorage`
2. **DRY**: no duplicate types, classes, functions, or logic
3. **File Structure**: single responsibility per file, naming respected
4. **Architecture**: layer separation, base and derived provider split respected
5. **Code Quality**: SOLID, strong typing, error handling
6. **Testing**: both happy path and adversarial tests, coverage minimums met
7. **Observability**: structured logging, no PII

### Review Questions for Tests

1. "Are there BOTH happy path AND adversarial tests?"
2. "Would these tests catch a regression if someone broke the logic?"
3. "Are there edge cases or failure modes that aren't being tested?"
4. "If I remove a line of business logic, will at least one test fail?"

### Legacy Code

- Do NOT prolong bad patterns. Even if the surrounding code is bad, write good code.
- Do NOT copy-paste from legacy code without reviewing quality.
- Isolate new code from legacy where possible.

## Documentation

- Update `README.md` when you add new features, endpoints, or significant changes.
- Update this file (`AGENTS.md`) when you add new modules, classes, or change architecture. Both `README.md` and `AGENTS.md` must be kept in sync with the codebase.
- If a file is renamed or responsibility moves, update the architecture notes in this file in the same change.
- Prefer pointing at the exact module that owns the behavior (single source of truth).

## Communication Artifacts (commit messages, PRs, issues, changelogs)

- **Be clear and concise**: state *what* changed and *why* in as few words as possible.
- **Use emojis for visual scanning**: include 1 to 2 relevant emojis at the start of titles (commit, PR, issue) to improve readability.
  - Examples: `🛠️ Fix tool-call id normalization`, `🧼 Sanitize provider error logs`, `🚀 Release v1.3.x`.
- **Prefer outcome-focused wording**: describe user impact (e.g. "prevents hard failure", "reduces false redactions").
- **Avoid noise**: no walls of text. Prefer short summaries and bullet points for PR descriptions and changelog entries.

## Updating Existing Code

Any code you edit must be brought up to these standards:

- simplify and clarify while touching it
- keep the design KISS and remove duplication while preserving readability
- improve module placement if the touched code is in the wrong logical home and the move is justified
- add comments that explain expectations or invariants where the logic is not obvious
- add or adjust tests to cover new and existing behavior
- ensure coverage does not regress beyond the allowed threshold

## Definition of Done (Agent Checklist)

- [ ] Relevant tests were written or updated for behavior changes.
- [ ] Code is readable at a glance; no unnecessary complexity.
- [ ] Code follows KISS and DRY; duplication has been removed or consciously justified.
- [ ] New logic is modular and reused where appropriate.
- [ ] Files and folders reflect clear ownership and logical placement.
- [ ] Logging added at major function entry/exit and critical decisions (where applicable).
- [ ] Telemetry updated for request outcomes and performance (where applicable).
- [ ] Comments/documentation explain non-obvious expectations, assumptions, and failure modes.
- [ ] Tests added/updated; intent is clear from test names.
- [ ] Coverage meets minimums and does not regress more than 1% in any category.
- [ ] Changed files were re-read or otherwise verified to confirm the requested code exists in the repository state.
- [ ] No secrets stored outside `ConfigManager` / `SecretStorage`.

### Provider-Specific Requirements (if working on `src/providers/`)

- [ ] Base class changes benefit all derived providers automatically (shared orchestration)
- [ ] Protocol-specific code stays in derived classes only (chat protocol, commit protocol, etc.)
- [ ] Shared request pipeline (message normalization, parameter filtering, token trimming) unchanged unless fixing a bug that affects all providers
- [ ] Both the chat and commit providers are tested for any base class changes
- [ ] New provider types extend base and reuse the pipeline (no duplication of request processing or endpoint-specific logic)
- [ ] Configuration handling respects the VS Code per-group provider config system
  - Provider secrets handled via `languageModelChatProviders.configuration` in `package.json`
  - Per-group `options.configuration` is read on every discovery call (no global config caching)
  - Response-time routing resolves the group by the model object VS Code passes back
  - Workspace settings retrieved via `vscode.workspace.getConfiguration()`
  - Use `ConfigManager.convertProviderConfiguration()` to unify config sources
- [ ] All `LanguageModelChatInformation` entries returned from `provideLanguageModelChatInformation` set `isUserSelectable: true` so they appear in the VS Code model picker
- [ ] Telemetry includes `caller` context to distinguish invocation source ("inline-completions", "terminal-chat", etc.)
- [ ] Model discovery tested for correctness and performance via the BackendRegistry (shared across all providers)

## Key Concepts

> This section is a reference for AI agents to understand the domain and architecture of the project. Update it whenever key concepts, modules, or architecture change. It must be kept in sync with the codebase.

### VS Code Extension Rules

This repository is a **VS Code extension**. Agents must follow these rules when changing extension code.

- **VS Code API**: Always target the `vscode` namespace.
- **Proposed APIs**: Use `@vscode/dts` and keep `src/vscode.d.ts` and the `src/vscode.proposed.*.d.ts` files current when relying on proposed types.
- **Engine target**: `package.json` `engines.vscode` is `^1.125.0`. All provider code must assume the VS Code 1.125 Language Model API surface.
- **Configuration and secrets (per-group configuration)**:
  - Language model provider configuration (base URL, API key, and any per-backend settings) is declared via the `languageModelChatProviders` contribution point in `package.json`.
  - VS Code supports **per-group configuration**: each configured provider group passes its own `options.configuration` into `provideLanguageModelChatInformation`. The provider must read configuration from `options.configuration` for every discovery call rather than caching globally.
  - At **response time**, `options.configuration` is the per-model picker configuration (`reasoningEffort`, `temperature`), not the group's credentials. Resolve credentials by the model object VS Code passes back (`registry.lookupInfo(model)`), falling back to the id only when the object was not produced by this registry.
  - Configuration properties marked with `"secret": true` are encrypted by VS Code.
  - Use `ConfigManager.convertProviderConfiguration()` to convert VS Code's per-group config object into the internal `LiteLLMConfig` format.
  - For non-provider secrets: use `vscode.SecretStorage` via `ConfigManager`. **Never** use `globalState`.
- **Model picker visibility**: every `LanguageModelChatInformation` returned from `provideLanguageModelChatInformation` must set `isUserSelectable: true` so the model appears in VS Code's model picker dropdown. Models that omit this flag (or set it to `false`) are hidden from the picker even when discovery succeeds.
- **Backend grouping**: each `LanguageModelChatInformation` must set `category: { label, order }`. `label` is the user-visible group heading in the picker (typically the backend or group name), and `order` is the deterministic display order. Without this, models from multiple backends collapse into a single ungrouped list.
- **Reasoning effort picker (`group: "navigation"`)**: when a model supports reasoning, its `configurationSchema.properties.reasoningEffort` must include `group: "navigation"`. Only navigation-grouped properties are surfaced as inline picker actions. Without it the effort selector is hidden behind the secondary settings UI and users cannot change effort from the chat picker.

### Architecture and Data Flow

This extension integrates LiteLLM proxies into VS Code's Language Model APIs (chat and commit generation). It uses a **shared orchestration plus specialized protocol handlers** pattern, with exactly **one** chat provider and one commit provider, and no version-suffixed variants.

- **Base Orchestrator**: `src/providers/liteLLMProviderBase.ts`
  - Owns the shared request lifecycle used by provider implementations.
  - Wires the BackendRegistry's `onDidChange` event to VS Code's `onDidChangeLanguageModelChatInformation` so the picker refreshes when a backend's model set actually changes.
  - Runs the common ingress pipeline (normalization, validation, parameter filtering, trimming, error detection).
  - Delegates transport concerns to adapter and client layers.
  - Centralizes telemetry, logging, and shared error handling.

- **Chat Provider** (single, unified): `src/providers/liteLLMChatProvider.ts`
  - There is **one** chat provider class named `LiteLLMChatProvider`. Do **not** introduce or reintroduce version-suffixed siblings (`LiteLLMChatProviderV2`, `LiteLLMChatProviderV3`, etc.). The previous V1/V2/V3 split has been collapsed into this single implementation.
  - Implements `vscode.LanguageModelChatProvider` against the current stable API surface.
  - Extends `LiteLLMProviderBase` and adds chat-protocol behavior only.
  - Handles chat-specific streaming, tool call buffering, response part emission (text, thinking, data, tool calls), and message parsing.
  - One instance serves every concurrent request (chat sessions, subagents, and background requests such as title generation), so request state never lives in instance fields. Shared instance state would let one session's tool calls, text, or usage reach another session's response.
    - The stream interpreter state is created per upstream attempt in `processStreamingResponse`, because a resumed retry is a new upstream response.
    - `StreamTokenCapture` and the retry accumulators are locals of `provideLanguageModelChatResponse`, because they span every attempt of one request.
  - Reads the per-group credentials from the model object VS Code passes back (see [Configuration Flow](#configuration-flow-per-group)); the per-model picker configuration still arrives on `options.configuration`.
  - Returns `LanguageModelChatInformation` entries with `isUserSelectable: true` so models appear in the picker.
  - Reuses the base request pipeline for normalization, filtering, trimming, and routing.

- **Commit provider**: `src/providers/liteLLMCommitProvider.ts`
  - Implements commit-message generation only (not a `LanguageModelTextCompletionProvider`).
  - Reuses the shared base lifecycle for LiteLLM-backed request orchestration.
  - Avoids re-implementing shared request preparation, endpoint selection, or quota/error logic.

- **Entry Point**: `src/extension.ts`
  - Activates the extension and instantiates exactly one `LiteLLMChatProvider` and one `LiteLLMCommitMessageProvider`.
  - Registers `LiteLLMChatProvider` with `vscode.lm.registerLanguageModelChatProvider("litellm-connector", provider)`.
  - The extension does NOT register a `LanguageModelTextCompletionProvider`. Completions are handled by VS Code's native tag-routing (the `inline-completions` tag on chat models) routed through the chat provider.
  - Both providers share the same `context.secrets` for `SecretStorage` (if needed for non-provider secrets).
  - Both receive per-group configuration from VS Code via `options.configuration` in `provideLanguageModelChatInformation`; response-time routing follows the model object VS Code passes back.
  - The configuration schema is defined in the `package.json` `languageModelChatProviders` contribution point (VS Code per-group format).

- **Adapters**:
  - `src/adapters/litellmClient.ts`: HTTP client and endpoint routing integration.
  - `src/adapters/responsesAdapter.ts`: LiteLLM `/responses` endpoint payload translation.
  - `/responses` stream event handling (`output_item.delta`, `output_item.done`, anonymous tool buffering) lives in `src/adapters/streaming/liteLLMStreamInterpreter.ts`.
  - `src/adapters/streaming/usagePayload.ts`: normalizes LiteLLM's usage variants into the internal shape and resolves the Anthropic cache-write and cache-read counters from `prompt_tokens_details`, `input_token_details`, or the top-level mirrors (in that precedence).
  - `src/adapters/tokenUtils.ts`: token budgeting, trimming, and related helpers.

- **Config**: `src/config/configManager.ts`
  - Handles per-group provider configuration from `options.configuration` (Base URL, API key, and any group-scoped settings supplied by VS Code).
  - Also manages workspace settings via `vscode.workspace.getConfiguration()` (model overrides, caching, etc.).
  - `convertProviderConfiguration()` converts the per-group VS Code provider config into the internal `LiteLLMConfig` format.

**Key design principle**: There is exactly one chat provider and one commit provider. Both reuse the same message ingress pipeline in the base orchestrator. This eliminates code duplication, ensures consistent behavior, and avoids version-suffixed provider sprawl. Adding new provider types requires minimal code (a protocol wrapper only).

**Structural rule of thumb**: shared cross-provider behavior belongs in the base class or adapters. VS Code protocol specifics belong in the single derived provider that owns that protocol. Do not fork chat-protocol logic into version-suffixed siblings.

When architecture changes, update this section in the same change so the document remains a reliable map of the codebase.

### Shared Message Ingress Pipeline (Base Orchestrator)

All incoming requests (chat or commit generation) flow through this pipeline:

1. **Normalize**: Convert to `OpenAIChatCompletionRequest` format. Chat: messages already in correct format. Commit generation and completion-style prompts: wrap the prompt string as a user message.
2. **Validate**: Get model info, check if model exists and is configured.
3. **Filter parameters**: Strip unsupported params via `KNOWN_PARAMETER_LIMITATIONS`.
4. **Trim**: Ensure messages fit within `model.maxInputTokens` budget.
5. **Detect errors**: Check for quota failures, apply tool redaction if needed.
6. **Route**: Send to appropriate endpoint via `LiteLLMClient.getEndpoint()`.
7. **Process response**: Extract completion text or stream response parts.

Keep this pipeline shared unless the change is intentionally protocol-specific and cannot be expressed in the common path.

### Chat-Specific Logic (Chat Provider)

- **Request part conversion**: handle `LanguageModelTextPart` and `LanguageModelBinaryPart` (vision). Images must be encoded for OpenAI-compatible payloads. Tool result images follow the provider-specific shapes described in [Multimodal Tool Results](#multimodal-tool-results).
- **Streaming state management**: buffer partial tool calls when SSE frames arrive fragmented. When a stream ends without a finish frame, either closing cleanly or closing before `[DONE]` with an unterminated frame, its buffered chat-completions tool calls are settled by the rules of a non-`tool_calls` finish frame: complete calls reach VS Code, incomplete or invalid ones are dropped with a `stream.tool_call_buffer_dropped` warning tagged with the request id, and ids already emitted are skipped. If an unterminated-frame ending recovers no call, the retry loop resumes the request. A transport read error such as `terminated` and an inactivity abort resume the request without recovery, and a cancelled stream discards its buffers.
- **Upstream failures inside the stream**: the interpreter throws `UpstreamStreamError` for a chat-completions `{"error": ...}` frame (the proxy's mid-stream failure shape) and for the Responses API `error` and `response.failed` events. The retry loop treats a transient one (408, 409, 425, 429, 5xx including Anthropic's 529, or an overloaded / rate-limit / timeout / unavailable code) exactly like a dropped socket: it resumes, except when a tool call was already delivered. A rejected request surfaces the upstream message instead. Never let one of these frames fall through to the reasoning-only detector, which would retry a hard failure.
- **Visible stop reasons**: a `length` or `content_filter` finish reason reports a `stream.stopped_early` warning and appends a connector notice text part to the response, because an incomplete answer is otherwise indistinguishable from a finished one.
- **A response only ever ends when its body is closed**: `processStreamingResponse` cancels the upstream body in `finally`; every exit path (error frame, retry, recovered tool calls) must stop the provider from generating and billing.
- **Response emission**: emit `LanguageModelResponsePart`, `LanguageModelToolCallPart`, `LanguageModelToolResultPart` to the progress callback.
- **Tool call parsing**: extract and validate tool calls from the structured streaming fields only. Text that looks like a tool call (`<tool_call>`, `<|tool_call_begin|>`) is model output and is emitted verbatim: turning it into a `LanguageModelToolCallPart` would let a model's explanation of a tool-call format execute a real tool.
- **Connector notices**: text the connector writes itself (failure explanations, stop notices) is `formatConnectorNotice(...)` from `src/utils/connectorNotice.ts`. A notice starts the response or a new block, so a notice appended to streamed text carries `\n\n` before the prefix; `splitConnectorNotice` only recognises the prefix at the start or after a blank line. Consumers such as commit-message generation rely on that shape and must not mistake a notice for model output.
- **Cost tracking**: pricing from LiteLLM `/model/info` is extracted and propagated through `StreamTokenCapture`. Request-level estimated costs are attached to usage payloads and telemetry metrics.

### Anthropic Thinking Preservation (Claude)

Claude reasoning arrives as thinking deltas plus signature and redacted-thinking frames in the LiteLLM stream. Because the connector wraps Claude without a protocol layer of its own, tool call rounds replay history through VS Code, so signed reasoning must survive as VS Code-replayable parts or the model re-derives (and re-bills) its reasoning and can drift mid-task. The stream interpreter seals each signed block into an empty-value thinking part whose `metadata` carries `signature` plus `_completeThinking` (the exact block text), or `redactedData` for redacted blocks. The metadata keys match what the built-in Copilot providers already persist, so VS Code stores and replays these parts in later tool call rounds (its one-sealed-thinking-part-per-round rule makes the last sealed block of a round the one replayed).

- **Emission**: `src/adapters/streaming/liteLLMStreamInterpreter.ts`; part ids are `litellm-thinking-N`. Unsigned or malformed signed blocks are ignored rather than reconstructed.
- **Replay**: `convertMessages` (`src/utils.ts`, via `src/utils/thinkingBlocks.ts`) rebuilds `thinking_blocks` from sealed parts and omits `reasoning_content` when blocks exist. Unsigned reasoning parts keep `reasoning_content`, so the transport-retry resume path is unchanged.
- **Role safety**: blocks and signatures are only attached to assistant messages; user and system roles never carry them.

### Multimodal Tool Results

Images returned by a tool (a screenshot tool, a chart renderer, an MCP server) travel to the model instead of being dropped. `convertMessages` collects them into `image_url` items, but the wire shape depends on the provider family because LiteLLM's transforms disagree about tool message content.

- **Native shape**: Anthropic, Gemini/Vertex and Bedrock transforms parse `image_url` parts inside a `role: "tool"` message, so the images stay in the tool message.
- **Hoisted shape**: OpenAI-compatible providers run tool messages through `convert_content_list_to_str`, which keeps only text, so the tool message carries a placeholder and one user message after the run carries the images. Grouping after the last tool message preserves the tool-call adjacency that strict providers require, and each image group is attributed to its tool so parallel calls stay distinguishable.
- **Mode selection**: `resolveToolResultImageMode` in `src/utils/modelUtils.ts` picks the shape from `modelInfo.litellm_provider`, and `src/providers/base/requestBuilder.ts` passes it to `convertMessages`. Unknown providers and `/responses` requests hoist, because hoisting keeps the images reachable while native content risks silent loss.
- **Audience filtering**: a tool result part whose `audience` list excludes `Assistant` is not uploaded. Parts without the flag stay unconditional.
- **Responses API**: `src/adapters/responsesAdapter.ts` carries message images as `input_image` items, the only shape LiteLLM's Responses-to-chat transform reads.

### Anthropic Prompt Caching

- `litellm-connector.anthropicPromptCaching` (`off` | `5m` | `1h`, default `5m`) adds a top-level `cache_control: {type: "ephemeral"}` directive (plus `ttl: "1h"` on the higher tier) to chat requests; LiteLLM forwards it to the Claude API as the automatic prompt-caching marker. Unrelated to `disableCaching`, which bypasses the proxy response cache.
- **Gating**: `src/utils/promptCaching.ts` allows the marker only for Anthropic-family requests where `modelInfo.litellm_provider` is authoritative, `supports_prompt_caching` is not explicitly false, and `options.modelOptions.promptCaching` is not false. Commit generation opts out: its prompts are one-shot messages with no reusable prefix, so the cache-write premium never pays off.
- **Live learning**: when a 400 names `cache_control`, `litellmClient.chat` strips it and retries once, then notifies the transport, which records it through the registry (`recordUnsupportedParameter`). The request builder consults `getUnsupportedParameters`, so later requests omit the marker without paying a failed round trip. The learned key is the raw model name (the request body's `model` value).

### Commit-Specific Logic (Commit Provider)

- **Prompt wrapping**: convert a simple `string` prompt to `LanguageModelChatRequestMessage` for the base pipeline.
- **Stream text extraction**: parse SSE chunks and accumulate completion text.
- **Model selection**: resolve the model using the `commitModelIdOverride` setting. Commit generation routes through `vscode.lm.selectChatModels()`.
- **Cost tracking**: commit generation reuses the same pricing and token snapshot pipeline so estimated request costs are reported consistently with chat.

### Configuration Flow (per-group)

Configuration from user settings reaches providers via VS Code's language model API on a per-group basis:

1. User configures Base URL, API Key, and any other declared properties for a provider group in the language model provider settings UI.
2. VS Code encrypts secrets (fields marked `"secret": true` in `package.json`).
3. VS Code passes the per-group configuration to the provider via `options.configuration` on `provideLanguageModelChatInformation`.
4. `ConfigManager.convertProviderConfiguration()` converts the per-group object to internal `LiteLLMConfig` format.
5. Discovery uses that config for model discovery and records each returned model object in the registry (see [BackendRegistry Contract](#backendregistry-contract)).
6. Response-time resolution differs by shape, and both paths must work:
   - `options.configuration` at response time is the **per-model picker configuration** (`reasoningEffort`, `temperature`), not the group's credentials. Treat it as group credentials only when it carries both a usable `baseUrl` and `apiKey`.
   - Otherwise resolve by the model object VS Code passed back (`lookupInfo(model)`), falling back to the id (`lookup(model.id)`). The object is the exact one this group's discovery returned, which is what distinguishes two groups on the same host.
7. Workspace-level settings (model overrides, caching preferences) are retrieved via `vscode.workspace.getConfiguration()`.

Provider code must not assume a single global configuration. Multiple groups may be active simultaneously and each call must use its own `options.configuration` at discovery time and its own model object at response time.

### Endpoint Agnosticism

The ingress pipeline is agnostic to endpoint choice:

- `LiteLLMClient.getEndpoint()` decides routing based on model info and endpoint availability.
- Request building happens once in base, regardless of endpoint choice.
- Responses are parsed uniformly (SSE format compatible across endpoint types).
- Both chat and commit generation use the same routing logic transparently.
- **Benefit**: `/responses` endpoint support benefits both chat and commit generation automatically.

### Cost Tracking Pipeline

- **Pricing extraction**: `src/utils/pricingCalculator.ts` provides pure helpers to extract pricing from `LiteLLMModelInfo` (including nested `pricing` fallback), format display strings, derive price categories, and calculate request costs from token snapshots.
- **Model picker pricing surfaces**: `src/providers/litellmProviderRegistry.ts` maps per-token LiteLLM pricing to VS Code per-1M fields (`inputCost`, `outputCost`, `cacheCost`, `cacheWriteCost`, `priceCategory`) and sets `pricing` for compact labels.
- **Fallback picker detail/tooltip**: when enabled by `displayPricingInPicker`, `toVSCodeInfo()` appends compact pricing to `detail` and appends a pricing breakdown to `tooltip` for environments where hover pricing tables are unavailable.
- **Price category strategy**: `derivePriceCategory()` categorizes by `maxCost` (highest per-1M input/output cost) using thresholds `<=10` low, `<20` medium, `<=100` high, otherwise very_high.
- **Token snapshot cost fields**: `src/adapters/streaming/streamTokenCapture.ts` stores flat estimated fields (`estimatedInputCost`, `estimatedOutputCost`, `estimatedTotalCost`) on `TokenSnapshot`.
- **Cache usage parsing**: `src/adapters/streaming/usagePayload.ts` resolves `cache_creation_input_tokens` (cache write) and `cache_read_input_tokens` (cache read) from `prompt_tokens_details`, `input_token_details`, or the top-level mirrors (in that precedence). `StreamTokenCapture` bills cache-write tokens at the cache-write price and cache-read tokens at the cache-read price, and Snapshots carry the separate write/read tallies.
- **Usage payload enrichment**: usage DataParts include `estimated_input_cost`, `estimated_output_cost`, and `estimated_total_cost` in `OpenAIUsagePayload` for downstream consumers, while remaining compatible with VS Code's required usage fields.
- **Metrics logging**: `src/utils/telemetry.ts` carries flat estimated cost fields in `IMetrics` and logs each completed request's token and cost totals to the output channel via `LiteLLMTelemetry.reportMetric()`.
- **Numeric handling**: scientific-notation pricing values are supported as native `number`. `calculateRequestCost()` normalizes floating artifacts with fixed precision while display formatting handles human-readable rounding.

### BackendRegistry Contract

The `BackendRegistry` (class `LiteLLMProviderRegistry` in `src/providers/litellmProviderRegistry.ts`) is the **single source of truth for backends and their associated models**. It owns the discovery HTTP fetch, the per-group namespacing, the change detection, and the per-model capability caches.

The contract is **public read, internal write**:

- **Public surface (read + ingress)**:
  - `discoverModels(options, token)`: the only way for VS Code (or any consumer) to fetch a model list and populate the registry. The registry owns the HTTP fetch, the namespacing (`<routing>/<rawModel>` ids), and the change detection. Consumers see a single ingress that returns the model list, updates the registry, and fires the change event as a unit. Discovery applies LiteLLM's paused-model listing rule (see `toListableDeployments`): deployments with `model_info.blocked === true` are dropped, each public `model_name` is listed once from its first live deployment, and a name whose every deployment is paused is hidden.
  - `lookup(id)`: resolve a namespaced id to its routing entry (`{baseUrl, apiKey, rawModelName, routingIdentity}`). This is the fallback for a model object the registry did not produce.
  - `lookupInfo(info)`: resolve the exact model object VS Code passes back at request time. This is the primary response-time path, because two groups on the same host produce the same namespaced ids but different credentials. The registry records each object in a `WeakMap` as it returns it from discovery.
  - `extractRawName(id)`: strip the routing prefix from a namespaced id.
  - `getModelInfo(id)` / `getDerivedCapabilities(id)`: read the per-model capability caches populated during discovery. These are NOT a model-list cache. They cache the capability info for known models and feed the request hot path. Ids are per host, so two groups on one host share these entries.
  - `size()`, `clear()`, `clearCaches()`: registration-state reads and reset. `clear()` wipes the routing table (user-initiated reload). `clearCaches()` wipes the capability caches and the backoff controller.
  - `recordUnsupportedParameter(modelId, param)` / `getUnsupportedParameters(modelId)`: the in-session store of parameters a live 400 taught the client to strip. Keyed by the raw model name (the request body's `model` value). The transport wires the client's strip-and-retry callback into `recordUnsupportedParameter`; the request builder reads `getUnsupportedParameters` to skip re-sending what a model already rejected. Only connector-added parameters (the `cache_control` marker) are recorded: a model parameter the proxy's `/model/info` claimed to support is surfaced to the user instead of being stripped.
  - `onDidChange`: fires when a backend's model set has actually changed. The base provider subscribes once and forwards to VS Code's `onDidChangeLanguageModelChatInformation`.

- **Internal surface (write, NOT part of the public contract)**:
  - `setModelsForBackend(backendKey, baseUrl, apiKey, routingIdentity, models)`, `getModelsForBackend(backendKey)`, `getModelIdsForBackend(backendKey)`: internal write/read, used only by `discoverModels` itself for change detection and stale fallback. They are TypeScript `private` and MUST NOT be called from outside the class. Tests that need to seed a known (id to backend) mapping cast via `unknown` to a typed test seam. `backendKey` is the backend identity: the server URL plus an API-key hash suffix, so two groups on one host keep separate change-detection state.

**Why merge discovery into the registry?** The previous design kept `ModelDiscovery` as a separate class and the registry as a pure data structure. The base provider had to call `modelDiscovery.discover(...)`, then `registry.setModelsForBackend`, then check `registry.getModelIdsForBackend` for change detection, a three-step orchestration that was easy to get wrong (write-before-compare silently broke change detection). With the merge, `discoverModels` is the only call site that needs to know the write protocol exists, and consumers see a single ingress.

**Short-lived discovery cache**: the registry keeps a TTL-bound response cache keyed by backend identity (the server URL with trailing slashes trimmed, plus a hash suffix of the API key) rather than by host alone. Cache entries are invalidated by `clear()`, `clearCaches()`, and manual reloads. Set `discoveryCacheTtlMs=0` to disable caching entirely.

**Stale-while-error**: a refresh that fails for a transient reason (network, timeout, 5xx, anything except a 400/401/403/404 response) returns the models this backend delivered last time, copied with a warning `statusIcon` and `warningText` so the failure stays visible in the picker. A misconfigured group (400/401/403/404) returns an empty list so the real error is not hidden, and so does a group with no prior successful discovery. Emptying a working group would otherwise drop the model choice of a running chat session.

**Change notifications are immediate**: `discoverModels` fires `onDidChange` as soon as a backend's model id set differs from its prior delivery. The registry has a `DebouncedEmitter` for this purpose, but the discovery path calls `_onDidChangeEmitter` directly, so `discoveryFireDebounceMs` and `discoveryFireMinIntervalMs` are not applied on this path.

### External Dependencies

- **LiteLLM**: expects a compatible OpenAI-like proxy with `/chat/completions`, `/completions`, and/or `/responses` endpoints.
- **GitHub Copilot Chat**: this extension is a *provider* for the official Copilot Chat extension (chat provider).
- **VS Code 1.125+** (declared in `package.json` `engines.vscode` as `^1.125.0`): required for the `languageModelChatProviders` contribution point with per-group configuration schema, the stable `LanguageModelChatProvider` API used by the unified `LiteLLMChatProvider`, the `isUserSelectable` flag on `LanguageModelChatInformation` for model picker visibility, and proper secrets encryption for provider configuration.

## Rule of Thumb

**When in doubt, choose simplicity. When trade-offs arise, follow the priority order in [Core Philosophy](#core-philosophy).**
**Build for correctness first. Optimize later. Test always.**