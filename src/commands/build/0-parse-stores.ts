import { createStoreRequestCache } from "../../util/store-request-cache.ts";
import { ParsedResource, Store } from "../../util/store.ts";
import { join } from "node:path";
import { cwd } from "process";
import { existsSync } from "fs";
import { readAllFiles } from "../../util/read-all-files.ts";
import { BuildConfig } from "../build.ts";
import { mkdirp } from "mkdirp";
import { GenericStore } from "../../util/get-config.ts";

function makeGetSlugHelper(store: GenericStore, slugs: BuildConfig["slugs"]) {
  if (store.slugTemplates) {
    return (resource: { id: string; type: string }) => {
      for (const slugTemplate of store.slugTemplates || []) {
        const compiled = slugs[slugTemplate];
        if (compiled && compiled.info.type === resource.type) {
          const [slug] = compiled.compile(resource.id);
          if (slug) {
            return [slug, slugTemplate] as const;
          }
        }
      }
      return [resource.id, "@none"] as const;
    };
  }
  return (resource: { id: string; type: string }) => {
    return [resource.id, "@none"] as const;
  };
}

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
