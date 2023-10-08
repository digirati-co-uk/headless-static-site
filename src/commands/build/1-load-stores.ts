import { BuildConfig } from "../build.ts";
import { ActiveResourceJson, ParsedResource, Store } from "../../util/store.ts";
import { createStoreRequestCache } from "../../util/store-request-cache.ts";
import { join } from "node:path";
import { existsSync } from "fs";
import { loadJson } from "../../util/load-json.ts";
import { mkdirp } from "mkdirp";
import { SingleBar } from "cli-progress";
import { makeProgressBar } from "../../util/make-progress-bar.ts";

export async function loadStores(
  { storeResources }: { storeResources: Record<string, ParsedResource[]> },
  buildConfig: BuildConfig,
) {
  const {
    options,
    config,
    stores,
    cacheDir,
    storeTypes,
    requestCacheDir,
    log,
    canvasExtractions,
    canvasEnrichment,
  } = buildConfig;

  const allResources: Array<ActiveResourceJson> = [];
  const editable: Record<string, string> = {};

  for (const store of stores) {
    const requestCache = createStoreRequestCache(store, requestCacheDir);
    const storeConfig = config.stores[store];
    const resources = storeResources[store];

    const progress = makeProgressBar("Loading store", resources.length);

    for (const resource of resources) {
      if (options.exact && resource.slug !== options.exact) {
        progress.increment();
        continue;
      }

      if (resource.source && resource.source.type === "disk") {
        editable[resource.slug] = resource.source.path;
      }

      // Here we need to actually load the existing folder from the cache if possible.
      const resourceDir = join(cacheDir, resource.slug);
      const cachesFile = join(resourceDir, "caches.json");
      const caches = existsSync(cachesFile) ? await loadJson(cachesFile) : {};
      const storeType: Store<any> = (storeTypes as any)[storeConfig.type];
      const valid =
        !options.cache ||
        (await storeType.invalidate(storeConfig as any, resource, caches));

      if (valid) {
        log("Building " + resource.path);
        await mkdirp(resourceDir);
        const data = await storeType.load(
          storeConfig as any,
          resource,
          resourceDir,
          { requestCache, storeId: resource.storeId, build: buildConfig },
        );

        allResources.push(data["resource.json"]);

        await Promise.all([
          Bun.write(
            join(resourceDir, "resource.json"),
            JSON.stringify(data["resource.json"], null, 2),
          ),
          Bun.write(
            join(resourceDir, "vault.json"),
            JSON.stringify(data["vault.json"], null, 2),
          ),
          Bun.write(
            join(resourceDir, "meta.json"),
            JSON.stringify(data["meta.json"], null, 2),
          ),
          Bun.write(
            join(resourceDir, "caches.json"),
            JSON.stringify(data["caches.json"], null, 2),
          ),
          Bun.write(
            join(resourceDir, "indices.json"),
            JSON.stringify(data["indices.json"], null, 2),
          ),
        ]);
      } else {
        const resourceJson = await loadJson(join(resourceDir, "resource.json"));
        allResources.push(resourceJson);
      }
      progress.increment();
    }
    progress.stop();
  }

  return { allResources, editable };
}
