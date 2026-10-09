import PQueue from "p-queue";
import {
  createDiscoveryBudget,
  DiscoveryLimitError,
  discoverCollectionChildren,
  isCollectionLike,
} from "../../stores/iiif-remote-discovery.ts";
import type { IIIFRemoteStore } from "../../stores/iiif-remote.ts";
import type { BuildProgressCallbacks } from "../../util/build-progress.ts";
import { resolveNetworkConfig } from "../../util/network.ts";
import { createStoreRequestCache } from "../../util/store-request-cache.ts";
import type { BuildConfig } from "../build.ts";

interface WarmCacheState {
  storeRequestCaches: Record<string, ReturnType<typeof createStoreRequestCache>>;
}

interface WarmStats {
  stores: number;
  urls: number;
  failures: number;
}

function normalizeStoreUrls(storeConfig: IIIFRemoteStore) {
  if (storeConfig.urls) {
    return storeConfig.urls;
  }
  if (storeConfig.url) {
    return [storeConfig.url];
  }
  return [];
}

export async function warmRemoteStores(
  buildConfig: BuildConfig,
  state: WarmCacheState,
  progress?: BuildProgressCallbacks
): Promise<WarmStats> {
  const { stores, config, requestCacheDir, options } = buildConfig;
  const stats: WarmStats = {
    stores: 0,
    urls: 0,
    failures: 0,
  };

  for (const storeId of stores) {
    const storeConfig = config.stores[storeId];
    if (!storeConfig || storeConfig.type !== "iiif-remote") {
      continue;
    }

    stats.stores += 1;

    const network = resolveNetworkConfig(buildConfig.network, storeConfig.network);
    const useNetworkCache = options.networkCache ?? true;
    const requestCache =
      useNetworkCache && state.storeRequestCaches[storeId]
        ? state.storeRequestCaches[storeId]
        : createStoreRequestCache(
            storeId,
            requestCacheDir,
            !useNetworkCache,
            undefined,
            network,
            async (event) => {
              await progress?.onFetch?.({
                ...event,
                phase: "warm-remote",
              });
            },
            buildConfig.fetch
          );
    state.storeRequestCaches[storeId] = requestCache;

    const queue = new PQueue({ concurrency: network.concurrency });
    const budget = createDiscoveryBudget(storeConfig.discovery);
    const canonicalIds = new Set<string>();
    let failure: Error | undefined;

    const enqueue = (url: string) => {
      if (!url || failure) {
        return;
      }
      try {
        if (!budget.resource(url)) return;
      } catch (error) {
        failure = error instanceof Error ? error : new Error("IIIF warming failed", { cause: error });
        return;
      }
      stats.urls += 1;

      queue.add(async () => {
        if (failure) return;
        try {
          const resource = await requestCache.fetch(url);
          const id = resource?.["@id"] || resource?.id;
          if (
            storeConfig.validation?.strict &&
            (!id ||
              typeof id !== "string" ||
              !["Manifest", "Collection", "sc:Manifest", "sc:Collection"].includes(
                resource?.type || resource?.["@type"]
              ))
          ) {
            throw new Error(`Invalid IIIF Manifest or Collection at ${url}`);
          }
          if (!id || canonicalIds.has(id)) return;
          canonicalIds.add(id);
          if (!isCollectionLike(resource)) {
            return;
          }

          const children = await discoverCollectionChildren(
            url,
            resource,
            (childUrl) => requestCache.fetch(childUrl),
            (childUrl, error) => {
              if (storeConfig.validation?.strict) throw error;
              buildConfig.log(`Failed warming collection page ${childUrl}`, error);
            },
            { ...storeConfig.discovery, strict: storeConfig.validation?.strict, budget }
          );

          for (const child of children) {
            enqueue(child.id);
          }
        } catch (error) {
          if (storeConfig.validation?.strict || error instanceof DiscoveryLimitError) failure = error instanceof Error ? error : new Error("IIIF warming failed", { cause: error });
          stats.failures += 1;
          buildConfig.log(`Failed warming URL: ${url}`);
        }
      });
    };

    for (const rootUrl of normalizeStoreUrls(storeConfig)) {
      enqueue(rootUrl);
    }

    await queue.onIdle();
    if (failure) throw failure;
  }

  return stats;
}
