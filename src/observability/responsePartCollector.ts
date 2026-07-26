import type * as vscode from "vscode";

/**
 * Wraps a `Progress<LanguageModelResponsePart>` and records every part that
 * flows through, so the `.copilotmd` exporter can render the `## Response`
 * section after the stream completes.
 *
 * Why a separate collector instead of adding collection to
 * `StreamTokenCapture`? `StreamTokenCapture` already wraps the inner
 * progress for token-counting reasons, and its `progress` getter is what
 * the chat provider passes to `processStreamingResponse`/`emitPartsToVSCode`.
 * Wrapping that *again* here keeps the collector's concerns (response
 * rendering) separate from the token capturer's concerns (usage tracking),
 * and avoids a cross-cutting change to `StreamTokenCapture`'s shape.
 *
 * The parts array is exposed read-only via {@link parts} after the request
 * completes. The collector never mutates the parts themselves — it only
 * pushes references — so the same part instances VS Code received are the
 * ones the exporter renders.
 */
export class ResponsePartCollector {
    private readonly _inner: vscode.Progress<vscode.LanguageModelResponsePart>;
    private readonly _collected: vscode.LanguageModelResponsePart[] = [];

    constructor(inner: vscode.Progress<vscode.LanguageModelResponsePart>) {
        this._inner = inner;
    }

    /**
     * The wrapped progress. Pass this to the streaming pipeline instead of
     * the original progress; every `report()` is forwarded to the inner
     * progress AND recorded.
     */
    get progress(): vscode.Progress<vscode.LanguageModelResponsePart> {
        return {
            report: (part: vscode.LanguageModelResponsePart): void => {
                this._collected.push(part);
                this._inner.report(part);
            },
        };
    }

    /**
     * The collected response parts, in emission order. Returns a defensive
     * copy so callers can't mutate the live array after the stream ends.
     */
    get parts(): readonly vscode.LanguageModelResponsePart[] {
        return [...this._collected];
    }
}
