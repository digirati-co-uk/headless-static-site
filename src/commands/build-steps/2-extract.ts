import { join } from "node:path";
import PQueue from "p-queue";
import objectHash from "object-hash";
import {
  EXTRACTION_CACHE,
  claimExtractionFields,
  cacheExtractionResult,
  clearExtractionContributions,
  digestExtraction,
  type ExtractionCache,
} from "../../util/extraction-cache.ts";
import type { BuildProgressCallbacks } from "../../util/build-progress.ts";
import { createCacheResource } from "../../util/cached-resource.ts";
import { createResourceHandler } from "../../util/create-resource-handler.ts";
import { makeProgressBar } from "../../util/make-progress-bar.ts";
import { createStoreRequestCache } from "../../util/store-request-cache.ts";
import type { ActiveResourceJson } from "../../util/store.ts";
import type { BuildConfig } from "../build.ts";

export async function extract(
  {
    allResources,
  }: {
    allResources: Array<ActiveResourceJson>;
  },
  buildConfig: BuildConfig,
  progressEvents?: BuildProgressCallbacks
) {
  const {
    options,
    config,
    cacheDir,
    log,
    extractions,
    files,
    manifestExtractions,
    collectionExtractions,
    canvasExtractions,
    allExtractions,
    requestCacheDir,
    concurrency,
  } = buildConfig;
  if (!options.extract) {
    // This is to remind us that we _cant_ export a site map without extracting.
    return {};
  }

  const startTime = performance.now();
  const useNetworkCache = options.networkCache ?? true;
  const requestCache = createStoreRequestCache(
    "_extract",
    requestCacheDir,
    !useNetworkCache,
    undefined,
    buildConfig.network,
    async (event) => {
      await progressEvents?.onFetch?.({
        ...event,
        phase: "extract-resources",
      });
    },
    buildConfig.fetch
  );
  const extractionConfigs: Record<string, any> = {};
  const stats: Record<string, number> = {};
  const cacheStats: Record<string, { hits: number; misses: number; bypassed: number }> = {};
  const configKey = objectHash(config);
  for (const extraction of allExtractions) {
    if (extraction.configure) {
      const extractionConfig = config.config?.[extraction.id];
      extractionConfigs[extraction.id] = await extraction.configure(
        { config, build: buildConfig, fileHandler: files },
        extractionConfig
      );
    } else {
      extractionConfigs[extraction.id] = config.config?.[extraction.id];
    }
    stats[extraction.id] = 0;
  }

  // Caches.
  const savingFiles: Promise<any>[] = [];
  const temp: Record<string, Record<string, any>> = {};

  let totalResources = allResources.length;
  for (const resource of allResources) {
    totalResources += resource.subResources || 0;
  }

  // Found Collections
  const collections: Record<string, string[]> = {};

  const progress = makeProgressBar("Extraction", totalResources, options.ui);

  const queue = new PQueue({ concurrency: concurrency.extract });
  const failures: unknown[] = [];
  const enqueue = (task: () => Promise<void>) => {
    void queue.add(task).catch((error) => failures.push(error));
  };

  for (const manifest of allResources) {
    enqueue(async () => {
      const resourceStoreConfig = config.stores[manifest.storeId] || {};
      const skipSteps = resourceStoreConfig.skip || [];
      const runSteps = resourceStoreConfig.run;

      const filesDir = join(cacheDir, manifest.slug, "files");

      buildConfig.trace?.startExtractions(manifest);

      const cachedResource = createCacheResource({
        resource: manifest,
        temp,
        resourcePath: join(cacheDir, manifest.slug),
        collections,
        fileHandler: files,
      });

      // Metadata is used by extraction and saving; overlap its read with the other cache files.
      const [storedCaches] = await Promise.all([cachedResource.caches.value, cachedResource.meta.value]);
      const previous: ExtractionCache = storedCaches[EXTRACTION_CACHE] || {};
      const next: ExtractionCache = Object.create(null);
      const outputClaims = new Map<string, { id: string; cached: boolean }>();
      await clearExtractionContributions(previous, cachedResource);
      if (EXTRACTION_CACHE in storedCaches) storedCaches[EXTRACTION_CACHE] = next;
      const resource = await cachedResource.attachVault();
      buildConfig.trace?.setResourceInfo(manifest, {
        label: resource?.label,
        thumbnail: resource?.thumbnail,
      });

      let extractions = manifest.type === "Manifest" ? manifestExtractions : collectionExtractions;

      // Add extra steps that might not be in already.
      if (runSteps) {
        // Need to make a copy in this case.
        extractions = [...extractions];
        for (const step of runSteps) {
          const found = allExtractions.find((e) => e.id === step);
          if (found?.types.includes(manifest.type) && !extractions.includes(found)) {
            extractions.push(found);
          }
        }
      }

      for (const extraction of extractions) {
        if (skipSteps.includes(extraction.id)) {
          // log(`Skipping ${extraction.id} for ${manifest.slug}`);
          continue;
        }
        const extractionConfig = config.config?.[extraction.id];
        const resourceFiles = createResourceHandler(filesDir, files, `extraction:${extraction.id}`);
        const storeConfig = extractionConfigs[extraction.id] || {};
        const extractConfig = Object.assign(
          {},
          extractionConfig,
          storeConfig,
          resourceStoreConfig.config?.[extraction.id] || {}
        );
        const invalidateApi = {
          caches: cachedResource.caches,
          resource,
          build: buildConfig,
          fileHandler: files,
          resourceFiles,
          filesDir,
          meta: cachedResource.meta,
          indices: cachedResource.indices,
          searchRecord: cachedResource.searchRecord,
        };
        let resultKey: string | undefined;
        let hit = false;
        if (extraction.cache) {
          if (!extraction.cache.version) throw new Error(`Missing cache version for ${extraction.id}`);
          const dependency = extraction.cache.key
            ? await extraction.cache.key(manifest, invalidateApi, extractConfig)
            : null;
          if (dependency !== undefined) {
            const resourceKey = digestExtraction(manifest.vault!.getStore().getState());
            resultKey = objectHash({
              format: 2,
              resourceKey,
              configKey,
              config: extractConfig,
              version: extraction.cache.version,
              handler: extraction.handler.toString(),
              dependency,
              slug: manifest.slug,
              source: manifest.source,
            });
          }
          const counts = (cacheStats[extraction.id] ||= { hits: 0, misses: 0, bypassed: 0 });
          const entry = previous[extraction.id];
          hit = Boolean(options.cache && options.extractionCache !== false && resultKey && entry?.key === resultKey);
          if (hit) {
            claimExtractionFields(outputClaims, extraction.id, true, entry.result);
            next[extraction.id] = { ...entry, generation: buildConfig.extractionCacheGeneration };
            cachedResource.handleResponse(structuredClone(entry.result), extraction);
            counts.hits++;
          } else if (!options.cache || options.extractionCache === false || !resultKey) counts.bypassed++;
          else counts.misses++;
        }
        const valid = extraction.cache
          ? !hit
          : !options.cache ||
            Boolean(previous[extraction.id]) ||
            (await extraction.invalidate(manifest, invalidateApi, extractConfig));
        if (valid) {
          log(`Running extract: ${extraction.name} for ${manifest.slug}`);
          const startExtract = performance.now();
          const result = await extraction.handler(
            manifest,
            {
              resource,
              meta: cachedResource.meta,
              indices: cachedResource.indices,
              caches: cachedResource.caches,
              searchRecord: cachedResource.searchRecord,
              config,
              build: buildConfig,
              requestCache,
              resourceFiles,
              filesDir,
            },
            extractConfig
          );
          buildConfig.trace?.extraction(manifest, extraction, result, startExtract, performance.now());
          stats[extraction.id] = (stats[extraction.id] || 0) + performance.now() - startExtract;

          if (extraction.cache) {
            const entry = cacheExtractionResult(resultKey || "", result, buildConfig.extractionCacheGeneration);
            claimExtractionFields(outputClaims, extraction.id, true, entry.result);
            next[extraction.id] = { ...entry, generation: buildConfig.extractionCacheGeneration };
            cachedResource.handleResponse(structuredClone(entry.result), extraction);
          } else {
            claimExtractionFields(outputClaims, extraction.id, false, result);
            cachedResource.handleResponse(result, extraction);
          }
        } else {
          buildConfig.trace?.extractionCacheHit(manifest, extraction);
        }
      }
      if (Object.keys(next).length || EXTRACTION_CACHE in storedCaches) {
        cachedResource.handleResponse({ caches: { [EXTRACTION_CACHE]: next } }, { id: EXTRACTION_CACHE });
        // Persist deleted fields even when a removed step no longer returns any data.
        for (const [field, filename] of [
          ["meta", "meta.json"],
          ["indices", "indices.json"],
          ["search", "search-record.json"],
        ] as const) {
          if (Object.values(previous).some(({ result }) => result[field])) {
            const data = field === "search" ? cachedResource.searchRecord : cachedResource[field];
            await files.saveJson(join(cacheDir, manifest.slug, filename), await data.value);
          }
        }
      }
      savingFiles.push(
        cachedResource.save().catch((error) => {
          failures.push(error);
        })
      );

      progress.increment();

      // Canvas extractions.
      if (manifest.type === "Manifest" && canvasExtractions.length) {
        // Canvas extractions
        // These will have to be saved alongside the manifest in the same folder. We could do:
        //  - manifest.json
        //  - canvases/0/meta.json
        //  - canvases/0/caches.json
        //  - canvases/0/indices.json
        //  - canvases/0/files/thumbnail.jpg
        //
        // Which would be translated to:
        // - manifest.json
        // - canvases/0/meta.json
        // - canvases/0/thumbnail.jpg
        const canvases = resource.items || [];
        let canvasIndex = 0;
        for (const canvas of canvases) {
          const canvasCache = createCacheResource({
            resource: canvas,
            temp,
            resourcePath: join(cacheDir, manifest.slug, "canvases", canvasIndex.toString()),
            collections,
            parentManifest: manifest,
            canvasIndex,
            fileHandler: files,
          });

          const canvasResource = canvasCache.getCanvasResource();

          for (const canvasExtraction of canvasExtractions) {
            if (canvasExtraction.cache)
              throw new Error("Result caching currently supports Manifest and Collection extractions only");
            const storeConfig = extractionConfigs[canvasExtraction.id] || {};
            const extractConfig = Object.assign(
              {},
              storeConfig,
              resourceStoreConfig.config?.[canvasExtraction.id] || {}
            );
            const resourceFiles = createResourceHandler(
              canvasCache.filesDir,
              files,
              `canvas-extraction:${canvasExtraction.id}`
            );
            const manifestResourceFiles = createResourceHandler(
              filesDir,
              files,
              `canvas-extraction:${canvasExtraction.id}`
            );
            const valid =
              !options.cache ||
              (await canvasExtraction.invalidate(
                canvasResource,
                {
                  caches: canvasCache.caches,
                  resource: canvas,
                  parentResource: manifest,
                  parentResourceFiles: manifestResourceFiles,
                  parent: resource,
                  build: buildConfig,
                  fileHandler: files,
                  resourceFiles,
                  filesDir: canvasCache.filesDir,
                },
                extractConfig
              ));
            if (!valid) {
              continue;
            }
            const startExtract = performance.now();
            const result = await canvasExtraction.handler(
              canvasResource,
              {
                resource: canvas,
                parentResource: manifest,
                parentResourceFiles: manifestResourceFiles,
                parent: resource,
                meta: canvasCache.meta,
                indices: canvasCache.indices,
                caches: canvasCache.caches,
                searchRecord: canvasCache.searchRecord,
                config,
                build: buildConfig,
                requestCache,
                resourceFiles,
                filesDir: canvasCache.filesDir,
              },
              extractConfig
            );
            stats[canvasExtraction.id] = (stats[canvasExtraction.id] || 0) + performance.now() - startExtract;

            canvasCache.handleResponse(result, canvasExtraction);
          }

          savingFiles.push(
            canvasCache.save().catch((error) => {
              failures.push(error);
            })
          );

          progress.increment();
          canvasIndex++;
        }

        for (const canvasExtraction of canvasExtractions) {
          if (
            canvasExtraction.collectManifest &&
            temp[canvasExtraction.id] &&
            temp[canvasExtraction.id][manifest.slug]
          ) {
            const extractionConfig = extractionConfigs[canvasExtraction.id] || {};
            const startExtract = performance.now();
            await canvasExtraction.collectManifest(
              manifest,
              temp[canvasExtraction.id][manifest.slug],
              { config, build: buildConfig, fileHandler: files },
              extractionConfig
            );
            stats[canvasExtraction.id] = (stats[canvasExtraction.id] || 0) + performance.now() - startExtract;
          }
        }
      } else {
        progress.increment(manifest.subResources || 0);
      }

      buildConfig.trace?.endExtractions(manifest);
    });
  }

  await queue.onIdle();
  log(`Saving ${savingFiles.length} files`);
  await Promise.all(savingFiles);
  if (failures.length) throw failures[0];
  // Cache hits must not change collector or generated membership order.
  const resourceOrder = new Map(allResources.map((resource, index) => [resource.slug, index]));
  const compareResources = (a: string, b: string) =>
    (resourceOrder.get(a) ?? Infinity) - (resourceOrder.get(b) ?? Infinity);
  for (const members of Object.values(collections)) members.sort(compareResources);
  for (const id of Object.keys(temp)) {
    temp[id] = Object.fromEntries(Object.entries(temp[id]).sort(([a], [b]) => compareResources(a, b)));
  }

  for (const extraction of allExtractions) {
    if (extraction.close) {
      const extractionConfig = extractionConfigs[extraction.id] || {};
      await extraction.close(extractionConfig);
    }
    if (extraction.collect && temp[extraction.id]) {
      const extractionConfig = extractionConfigs[extraction.id] || {};
      const resp = await extraction.collect(
        temp[extraction.id],
        { config, build: buildConfig, fileHandler: files },
        extractionConfig
      );
      if (extraction.injectManifest && resp && resp.temp) {
        const inject = extraction.injectManifest;
        for (const manifestSlug of Object.keys(resp.temp)) {
          enqueue(async () => {
            const extractionConfig = extractionConfigs[extraction.id] || {};
            const foundManifest = allResources.find((r) => r.slug === manifestSlug);
            if (!foundManifest) {
              return;
            }
            const manifestCache = createCacheResource({
              resource: foundManifest,
              temp,
              resourcePath: join(cacheDir, manifestSlug),
              collections,
              fileHandler: files,
            });
            const startExtract = performance.now();
            const manifestInjected = await inject(
              foundManifest,
              resp.temp[manifestSlug],
              { config, build: buildConfig, fileHandler: files },
              extractionConfig
            );
            stats[extraction.id] = (stats[extraction.id] || 0) + performance.now() - startExtract;
            manifestCache.handleResponse(manifestInjected, extraction);
            await manifestCache.save();
          });
        }
      }
    }
  }

  await queue.onIdle();
  if (failures.length) throw failures[0];

  progress.stop();

  stats._total = performance.now() - startTime;

  return { collections, stats, cacheStats };
}
