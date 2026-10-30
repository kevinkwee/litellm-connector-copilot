import { StructuredLogger } from "../../observability/structuredLogger";
import type { LiteLLMModelInfoResponse } from "../../types";

/**
 * A single deployment row from a `/model/info` response. The same public
 * `model_name` can be served by multiple deployments with different
 * credentials or providers.
 */
export type LiteLLMModelInfoEntry = LiteLLMModelInfoResponse["data"][number];

/**
 * Applies LiteLLM's paused-model listing rule to a `/model/info` payload,
 * matching `Router.get_fully_blocked_model_names` on the proxy: a
 * deployment whose `model_info.blocked` is `true` is admin-paused and is
 * dropped. A public name is hidden only when every deployment carrying it
 * is paused; with at least one non-paused deployment the name stays
 * listable and is represented by its first non-paused deployment, so
 * multi-deployment names appear once. Entries without a `model_name` are
 * passed through unless paused, so the unknown-name skip in the registry's
 * `toVSCodeInfo` keeps reporting them. Strict `=== true` leaves older
 * proxies that do not send the flag untouched.
 */
export function toListableDeployments(data: readonly LiteLLMModelInfoEntry[]): LiteLLMModelInfoEntry[] {
    const namesWithPausedDeployment = new Set<string>();
    const namesWithLiveDeployment = new Set<string>();
    for (const entry of data) {
        if (!entry.model_name) {
            continue;
        }
        if (entry.model_info?.blocked === true) {
            namesWithPausedDeployment.add(entry.model_name);
        } else {
            namesWithLiveDeployment.add(entry.model_name);
        }
    }
    const hiddenNames = [...namesWithPausedDeployment].filter((name) => !namesWithLiveDeployment.has(name));
    if (hiddenNames.length > 0) {
        StructuredLogger.debug("discovery.paused_deployments_filtered", {
            hiddenModelNames: hiddenNames.sort(),
            hiddenCount: hiddenNames.length,
        });
    }

    const listedNames = new Set<string>();
    const listable: LiteLLMModelInfoEntry[] = [];
    for (const entry of data) {
        if (entry.model_info?.blocked === true) {
            continue;
        }
        if (entry.model_name && listedNames.has(entry.model_name)) {
            continue;
        }
        if (entry.model_name) {
            listedNames.add(entry.model_name);
        }
        listable.push(entry);
    }
    return listable;
}
