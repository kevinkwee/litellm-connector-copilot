export function createMockSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of chunks) {
                const data = {
                    choices: [
                        {
                            delta: { content: chunk },
                            finish_reason: null,
                        },
                    ],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });
}

export const SSE_DONE_FRAME = "[DONE]";

export function chatTextFrame(text: string): string {
    return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

export function chatReasoningFrame(reasoning: string): string {
    return JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] });
}

export function chatToolCallHeaderFrame(id: string, name: string): string {
    return JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }],
    });
}

export function chatToolCallArgumentsFrame(argumentsJson: string): string {
    return JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argumentsJson } }] } }],
    });
}

export function chatFinishFrame(reason: string): string {
    return JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] });
}

interface StreamCheckpoint {
    readonly reached: PromiseWithResolvers<void>;
    readonly released: PromiseWithResolvers<void>;
}

function createStreamCheckpoint(): StreamCheckpoint {
    return { reached: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() };
}

/**
 * SSE body that hands one frame per consumer read and pauses before each
 * checkpoint frame until the test releases it, so tests can interleave
 * concurrent streams deterministically. Reaching a checkpoint proves every
 * earlier frame was processed, because no frame is pulled before the consumer
 * asks for the next one. Frames are SSE `data:` payloads, a JSON chunk or
 * `[DONE]`.
 */
export class SteppedSseStream {
    readonly body: ReadableStream<Uint8Array>;
    private readonly checkpoints: ReadonlyMap<number, StreamCheckpoint>;

    constructor(frames: readonly string[], checkpointFrameIndices: readonly number[]) {
        const unreachableIndex = checkpointFrameIndices.find(
            (index) => !Number.isInteger(index) || index < 0 || index >= frames.length
        );
        if (unreachableIndex !== undefined) {
            throw new RangeError(`Checkpoint ${unreachableIndex} is outside the ${frames.length} scripted frames`);
        }
        this.checkpoints = new Map(checkpointFrameIndices.map((index) => [index, createStreamCheckpoint()]));
        const encoder = new TextEncoder();
        let nextFrameIndex = 0;
        this.body = new ReadableStream<Uint8Array>(
            {
                pull: async (controller) => {
                    if (nextFrameIndex >= frames.length) {
                        controller.close();
                        return;
                    }
                    const checkpoint = this.checkpoints.get(nextFrameIndex);
                    if (checkpoint) {
                        checkpoint.reached.resolve();
                        await checkpoint.released.promise;
                    }
                    controller.enqueue(encoder.encode(`data: ${frames[nextFrameIndex]}\n\n`));
                    nextFrameIndex += 1;
                },
            },
            { highWaterMark: 0 }
        );
    }

    /** Resolves once every frame before `frameIndex` has been consumed. */
    reached(frameIndex: number): Promise<void> {
        return this.requireCheckpoint(frameIndex).reached.promise;
    }

    /** Lets the consumer receive the held-back frame at `frameIndex`. */
    release(frameIndex: number): void {
        this.requireCheckpoint(frameIndex).released.resolve();
    }

    private requireCheckpoint(frameIndex: number): StreamCheckpoint {
        const checkpoint = this.checkpoints.get(frameIndex);
        if (!checkpoint) {
            throw new RangeError(`Frame ${frameIndex} is not a checkpoint of this stream`);
        }
        return checkpoint;
    }
}

export function createMockToolCallStream(toolName: string, args: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            const data = {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call_123",
                                    type: "function",
                                    function: { name: toolName, arguments: args },
                                },
                            ],
                        },
                    },
                ],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });
}
