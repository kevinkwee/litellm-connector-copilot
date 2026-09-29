/**
 * No-op sink for the web (browser) extension target. The bundled web build
 * cannot use Node's synchronous filesystem API, and there is no persistent
 * local file location there, so log mirroring is node-target only. Channel
 * logging is unaffected.
 */
import type { StructuredLogFileSinkOptions } from "./structuredLogFileSink";

export type { StructuredLogFileSinkOptions } from "./structuredLogFileSink";

export class StructuredLogFileSink {
    public readonly isEnabled = false;
    public readonly currentFilePath: string | undefined = undefined;

    public constructor(_options?: StructuredLogFileSinkOptions) {
        // Intentionally inert: see the module docstring.
    }

    public initialize(_storagePath: string | undefined): void {
        // Intentionally inert: see the module docstring.
    }

    public append(_line: string): void {
        // Intentionally inert: see the module docstring.
    }
}
