import * as assert from "assert";

import { chatTextFrame, SSE_DONE_FRAME, SteppedSseStream } from "./testStreamUtils";

suite("SteppedSseStream", () => {
    test("rejects a checkpoint past the last scripted frame", () => {
        assert.throws(() => new SteppedSseStream([chatTextFrame("hi"), SSE_DONE_FRAME], [2]), RangeError);
    });

    test("rejects a negative checkpoint", () => {
        assert.throws(() => new SteppedSseStream([chatTextFrame("hi"), SSE_DONE_FRAME], [-1]), RangeError);
    });

    test("rejects a fractional checkpoint", () => {
        assert.throws(() => new SteppedSseStream([chatTextFrame("hi"), SSE_DONE_FRAME], [0.5]), RangeError);
    });

    test("rejects releasing a frame that is not a checkpoint", () => {
        const stream = new SteppedSseStream([chatTextFrame("hi"), SSE_DONE_FRAME], [1]);

        assert.throws(() => stream.release(0), RangeError);
    });
});
