import { createStoreRequestCache } from "../../util/store-request-cache.ts";
import { ParsedResource, Store } from "../../util/store.ts";
import { BuildConfig } from "../build.ts";
import { mkdirp } from "mkdirp";
import { makeGetSlugHelper } from "../../util/make-slug-helper.ts";

export async function parseStores(buildConfig: BuildConfig) {
  const {
    //
    options,
    config,
    stores,
    requestCacheDir,
    storeTypes,
    log,
    slugs,
  } = buildConfig;

  await mkdirp(requestCacheDir);

  const uniqueSlugs: string[] = [];
  const allPaths: Record<string, string> = {};
  const storeResources: Record<string, ParsedResource[]> = {};
  const overrides: Record<string, string> = {};

  for (const storeId of stores) {
    const requestCache = createStoreRequestCache(storeId, requestCacheDir);
    storeResources[storeId] = [];

    const storeConfig = config.stores[storeId];
    const storeType: Store<any> = (storeTypes as any)[storeConfig.type];
    if (!storeType) {
      throw new Error("Unknown store type: " + storeConfig.type);
    }

    const getSlug = makeGetSlugHelper(storeConfig, slugs);

    // Parse the store using the plugin definition. This will return one or more resources.
    const resources = await storeType.parse(storeConfig as any, {
      storeId,
      requestCache,
      getSlug,
      build: buildConfig,
    });

    // Loop through the resources.
    for (const resource of resources) {
      allPaths[resource.path] = resource.slug;
      if (resource.source.type === "disk" && resource.source.alias) {
        overrides[resource.source.alias] = resource.slug + "/manifest.json";
      }
      if (resource.source.type === "remote" && resource.saveToDisk) {
        overrides[resource.slug] = resource.slug + "/manifest.json";
      }

      if (resource.subFiles) {
        for (const subFile of resource.subFiles) {
          allPaths[subFile] = resource.slug;
        }
      }
      const slug = resource.slug;
      if (uniqueSlugs.includes(slug)) {
        log(
          "WARNING: Duplicate slug found: " +
            slug +
            " in resource: " +
            resource.path,
        );
        continue;
      }
      if (options.exact && slug !== options.exact) {
        continue;
      }
      uniqueSlugs.push(slug);
      storeResources[storeId].push(resource);
    }
    storeResources[storeId] = resources;
  }

  return {
    allPaths,
    storeResources,
    overrides,
  };
}
