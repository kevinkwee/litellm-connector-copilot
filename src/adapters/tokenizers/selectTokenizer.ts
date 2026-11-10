import type { LiteLLMModelInfo } from "../../types";
import { HeuristicTokenizer } from "./heuristicTokenizer";
import type { Tokenizer } from "./types";

/**
 * Returns the tokenizer that estimates token counts for a model.
 *
 * The heuristic estimator serves every model. It deliberately overestimates, so an
 * unfamiliar provider vocabulary cannot undercount the prompt. Every call site
 * already passes the model id and info, so a per-family tokenizer can be selected
 * here without a signature change.
 */
export function selectTokenizer(_modelId: string, _modelInfo?: LiteLLMModelInfo): Tokenizer {
    return new HeuristicTokenizer();
}
