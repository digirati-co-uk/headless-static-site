import PQueue from "p-queue";
import { EXTRACTION_CACHE, EXTRACTION_CACHE_COMMIT, validExtractionCache } from "../../util/extraction-cache.ts";
import nfs from "node:fs";
import { join } from "node:path";
import type { IFS } from "unionfs";
import type { BuildProgressCallbacks } from "../../util/build-progress.ts";
import { makeProgressBar } from "../../util/make-progress-bar.ts";
import { resolveNetworkConfig } from "../../util/network.ts";
import { createStoreRequestCache } from "../../util/store-request-cache.ts";
import type { ActiveResourceJson, ParsedResource, Store } from "../../util/store.ts";
import type { BuildConfig } from "../build.ts";

export async function loadStores(
  {
    storeResources,
    storeIds,
    storeConfigs,
  }: {
    storeResources: Record<string, ParsedResource[]>;
    storeIds?: string[];
    storeConfigs?: Record<string, any>;
  },
  buildConfig: BuildConfig,
  customFs?: IFS,
  progressEvents?: BuildProgressCallbacks
) {
  const fss = customFs || nfs;
  const fs = fss.promises;
  const {
    options,
    config,
    stores: configuredStores,
    cacheDir,
    storeTypes,
    requestCacheDir,
    log,
    canvasExtractions,
    canvasEnrichment,
    files,
  } = buildConfig;

  let cacheGeneration: string | undefined;
  try {
    if (buildConfig.extractionCacheGeneration)
      cacheGeneration = await fs.readFile(files.resolve(join(cacheDir, EXTRACTION_CACHE_COMMIT)), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const allResources: Array<ActiveResourceJson> = [];
  const allPaths: Record<string, string> = {};
  const overrides: Record<string, string> = {};
  const rewrites: Record<string, string> = {};
  const editable: Record<string, string> = {};
  const idsToSlugs: Record<string, { slug: string; type: string }> = {};
  const uniqueSlugs = new Set<string>();

  let validCount = 0;
  let invalidCount = 0;

  const stores = storeIds || configuredStores;

  for (const store of stores) {
    const storeConfig = (storeConfigs && storeConfigs[store]) || config.stores[store];
    if (!storeConfig) {
      throw new Error(`Missing store config for "${store}"`);
    }
    const network = resolveNetworkConfig(buildConfig.network, storeConfig.network);
    const useNetworkCache = options.networkCache ?? true;
    const requestCache = createStoreRequestCache(
      store,
      requestCacheDir,
      !useNetworkCache,
      undefined,
      network,
      async (event) => {
        await progressEvents?.onFetch?.({
          ...event,
          phase: "load-stores",
        });
      },
      buildConfig.fetch
    );
    const resources = storeResources[store] || [];

    const progress = makeProgressBar("Loading store", resources.length, options.ui);

    const queue = new PQueue({ concurrency: buildConfig.concurrency?.load ?? 4 });
    const loaded = await Promise.allSettled(
      resources.map((resource) =>
        queue.add(async () => {
          let active: ActiveResourceJson;
          if (options.exact && resource.slug !== options.exact && resource.path !== options.exact) {
            progress.increment();
            return;
          }

          // Unique slug check. (NEEDS TO HAPPEN AFTER REWRITE)
          if (uniqueSlugs.has(resource.slug)) {
            log(`WARNING: Duplicate slug found: ${resource.slug} in resource: ${resource.path}`);
            return;
          }
          uniqueSlugs.add(resource.slug);

          // Here we need to actually load the existing folder from the cache if possible.
          const resourceDir = join(cacheDir, resource.slug);
          const cachesFile = join(resourceDir, "caches.json");
          const caches = await files.loadJson(cachesFile);
          const storeType: Store<any> = (storeTypes as any)[storeConfig.type];
          const selectedExtractions = [
            ...((resource.type === "Manifest" ? buildConfig.manifestExtractions : buildConfig.collectionExtractions) ||
              []),
            ...(storeConfig.run || []).map((id: string) => buildConfig.allExtractions?.find((step) => step.id === id)),
          ];
          const missingExtractionCache = selectedExtractions.some(
            (step) =>
              step?.cache &&
              step.types.includes(resource.type) &&
              !(storeConfig.skip || []).includes(step.id) &&
              !caches[EXTRACTION_CACHE]?.[step.id]
          );
          const corruptExtractionCache =
            EXTRACTION_CACHE in caches && !validExtractionCache(caches[EXTRACTION_CACHE], cacheGeneration);
          const shouldRebuild =
            !options.cache ||
            corruptExtractionCache ||
            missingExtractionCache ||
            (await storeType.invalidate(storeConfig as any, resource, caches));

          if (shouldRebuild) {
            log(`Building ${resource.path}`);
            invalidCount++;
            await files.mkdir(resourceDir);
            const data = await storeType.load(storeConfig as any, resource, resourceDir, {
              requestCache,
              storeId: resource.storeId,
              build: buildConfig,
              files,
            });
            if (!data) {
              // Then there was a problem loading this store item.
              progress.increment();
              return;
            }

            active = data["resource.json"];

            await Promise.all([
              files.saveJson(join(resourceDir, "resource.json"), data["resource.json"]),
              files.saveJson(join(resourceDir, "vault.json"), data["vault.json"]),
              files.saveJson(join(resourceDir, "meta.json"), data["meta.json"]),
              files.saveJson(join(resourceDir, "caches.json"), data["caches.json"]),
              files.saveJson(join(resourceDir, "indices.json"), data["indices.json"]),
            ]);
          } else {
            validCount++;
            const data = await files.loadJson(join(resourceDir, "resource.json"));
            data.inputKey = resource.inputKey;
            data.saveToDisk = resource.saveToDisk;
            await files.saveJson(join(resourceDir, "resource.json"), data);

            active = data;
          }

          return { resource, active };
        })
      )
    );
    // Drain all work before propagating failures; merge in source order.
    for (const result of loaded) {
      if (result.status === "rejected") throw result.reason;
      if (!result.value) continue;
      const { resource, active } = result.value;
      allResources.push(active);
      if (active.id && active.saveToDisk) idsToSlugs[active.id] = { slug: resource.slug, type: resource.type };
      // Record all paths at the end, the rewrite should have happened by now.
      if (resource.source && resource.source.type === "disk") {
        editable[resource.slug] = resource.source.filePath;
      }
      if (resource.source.type === "disk" && resource.source.alias) {
        overrides[resource.source.alias] = `${resource.slug}/manifest.json`;
      }
      if (resource.source.type === "remote" && resource.saveToDisk) {
        overrides[resource.slug] = `${resource.slug}/manifest.json`;
      }

      allPaths[resource.path] = resource.slug;
      if (resource.subFiles) {
        for (const subFile of resource.subFiles) {
          allPaths[subFile] = resource.slug;
        }
      }

      progress.increment();
      await progressEvents?.onResourceProcessed?.({
        slug: resource.slug,
        storeId: store,
      });
    }
    progress.stop();
  }

  return {
    allResources,
    editable,
    allPaths,
    overrides,
    rewrites,
    idsToSlugs,
    stats: {
      validCount,
      invalidCount,
    },
  };
}
