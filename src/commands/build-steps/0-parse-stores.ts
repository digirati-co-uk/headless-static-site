import { dirname, join } from "node:path";
import type { IFS } from "unionfs";
import type { BuildProgressCallbacks } from "../../util/build-progress.ts";
import { makeGetSlugHelper } from "../../util/make-slug-helper.ts";
import { resolveNetworkConfig } from "../../util/network.ts";
import { createStoreRequestCache } from "../../util/store-request-cache.ts";
import type { ParsedResource, Store } from "../../util/store.ts";
import type { BuildConfig } from "../build.ts";
import { defaultCacheDir } from "../generate.ts";

interface ParseStoresState {
  storeRequestCaches: Record<string, ReturnType<typeof createStoreRequestCache>>;
}

const EMPTY_CACHE: ParseStoresState = {
  storeRequestCaches: {},
};

function getRemoteStoreRootUrls(storeConfig: any): string[] {
  if (!storeConfig || storeConfig.type !== "iiif-remote") {
    return [];
  }
  if (Array.isArray(storeConfig.urls) && storeConfig.urls.length) {
    return storeConfig.urls.filter(Boolean);
  }
  if (typeof storeConfig.url === "string" && storeConfig.url) {
    return [storeConfig.url];
  }
  return [];
}

export async function parseStores(
  buildConfig: BuildConfig,
  cache: ParseStoresState = EMPTY_CACHE,
  customFs?: IFS,
  progress?: BuildProgressCallbacks
) {
  const {
    //
    config,
    stores,
    options,
    requestCacheDir,
    storeTypes,
    slugs,
    manifestRewrites,
    collectionRewrites,
    files,
  } = buildConfig;
  const resolveFilePath = typeof files.resolve === "function" ? files.resolve.bind(files) : (path: string) => path;

  const storeResources: Record<string, ParsedResource[]> = {};
  const storeRequestCaches: Record<string, ReturnType<typeof createStoreRequestCache>> = {};
  const filesToWatch: string[] = [];
  const effectiveStoreConfigs: Record<string, any> = Object.fromEntries(
    Object.entries(config.stores).map(([storeId, store]) => [
      storeId,
      {
        ...store,
        ...(store.type === "iiif-json" && store.path ? { path: resolveFilePath(store.path) } : {}),
        ...(store.type === "iiif-remote" && store.overrides ? { overrides: resolveFilePath(store.overrides) } : {}),
      },
    ])
  );
  const effectiveStores = Array.from(new Set(stores));
  let estimatedResources = 0;
  const parsedSlugs = new Map<string, ParsedResource>();

  const publishEstimatedResources = async () => {
    const parsedResources = Object.values(storeResources).reduce((total, all) => total + all.length, 0);
    await progress?.onResourcesDiscovered?.({
      total: Math.max(parsedResources, estimatedResources),
    });
  };

  // If there are generated stores, add them to local derived config/stores.
  // Do not mutate buildConfig.config/buildConfig.stores to avoid repeated-build side effects.
  if (config.generators) {
    const keys = Object.keys(config.generators);
    for (const key of keys) {
      const generator = config.generators[key];
      // Skip if there is a configured output. This is for the user to deal with.
      if (generator.output) continue;

      if (!effectiveStoreConfigs[key]) {
        effectiveStoreConfigs[key] = {
          type: "iiif-json",
          path: `./${join(defaultCacheDir, key, "build")}`,
        };
      }
      if (!effectiveStores.includes(key)) {
        effectiveStores.push(key);
      }
    }
  }

  for (const storeId of effectiveStores) {
    const storeConfig = effectiveStoreConfigs[storeId];
    if (!storeConfig) {
      throw new Error(`Missing store config for "${storeId}"`);
    }
    const network = resolveNetworkConfig(buildConfig.network, storeConfig.network);
    const useNetworkCache = options.networkCache ?? true;
    const requestCache =
      useNetworkCache && cache.storeRequestCaches[storeId]
        ? cache.storeRequestCaches[storeId]
        : createStoreRequestCache(
            storeId,
            resolveFilePath(requestCacheDir),
            !useNetworkCache,
            customFs,
            network,
            async (event) => {
              await progress?.onFetch?.({
                ...event,
                phase: "parse-stores",
              });
            },
            buildConfig.fetch
          );
    storeRequestCaches[storeId] = requestCache;
    storeResources[storeId] = [];

    const rootUrls = getRemoteStoreRootUrls(storeConfig);
    if (rootUrls.length) {
      estimatedResources += rootUrls.length;
      await publishEstimatedResources();
    }

    const storeType: Store<any> = (storeTypes as any)[storeConfig.type];
    if (!storeType) {
      throw new Error(`Unknown store type: ${storeConfig.type}`);
    }

    const getSlug = makeGetSlugHelper(storeConfig, slugs);

    // Parse the store using the plugin definition. This will return one or more resources.
    const resources = await storeType.parse(storeConfig as any, {
      storeId,
      requestCache,
      getSlug,
      build: buildConfig,
      files: files,
      progress,
      reportEstimatedResources: async (delta: number) => {
        if (delta <= 0) {
          return;
        }
        estimatedResources += delta;
        await publishEstimatedResources();
      },
    });

    const folderAliases = new Map<string, string>();

    // Loop through the resources.
    for (const resource of resources) {
      // Rewrite the slug.
      if (resource.type === "Manifest") {
        for (const rewrite of manifestRewrites) {
          if (rewrite.rewrite) {
            const newSlug = await rewrite.rewrite(resource.slug, resource);
            if (newSlug && typeof newSlug === "string") {
              resource.slug = newSlug;
            }
          }
        }
      }
      if (resource.type === "Collection") {
        for (const rewrite of collectionRewrites) {
          if (rewrite.rewrite) {
            const newSlug = await rewrite.rewrite(resource.slug, resource);
            if (newSlug && typeof newSlug === "string") {
              resource.slug = newSlug;
            }
          }
        }
      }

      const previous = parsedSlugs.get(resource.slug);
      if (previous && (previous.virtual || resource.virtual)) {
        const folder = resource.source.type === "disk" ? resource.source.filePath : null;
        const isAutomaticFolder = resource.virtual && resource.source.type === "disk" &&
          folder === join(resource.source.path, resource.source.relativePath || "");
        if (isAutomaticFolder && previous.type === "Collection" && !previous.virtual &&
          previous.storeId === resource.storeId && previous.source.type === "disk" &&
          (dirname(previous.source.filePath) === folder || previous.source.filePath.replace(/\.json$/i, "") === folder)) {
          // An authored collection owns this folder; retain its membership and metadata.
          const authored = await files.loadJson(previous.path, true);
          const generated = await files.loadJson(resource.path, true);
          const id = authored.id || authored["@id"];
          if (!id) throw new Error(`Missing IIIF id in ${previous.path}`);
          folderAliases.set(generated.id, id);
          continue;
        }
        throw new Error(`Conflicting collection slug "${resource.slug}": ${previous.path} and ${resource.path}`);
      }
      parsedSlugs.set(resource.slug, resource);

      if (resource.source?.type === "disk" && !resource.virtual) {
        filesToWatch.push(resource.path);
      }
      storeResources[storeId].push(resource);
    }
    if (folderAliases.size) {
      for (const resource of storeResources[storeId]) {
        if (!resource.virtual) continue;
        const collection = await files.loadJson(resource.path, true);
        const seen = new Set<string>();
        collection.items = (collection.items || []).filter((item: any) => {
          item.id = folderAliases.get(item.id) || item.id;
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
        // Virtual collections are loaded fresh from disk in the next build phase.
        await files.fs.promises.writeFile(files.resolve(resource.path), JSON.stringify(collection));
      }
    }
    const totalDiscovered = Object.values(storeResources).reduce((total, all) => total + all.length, 0);
    await progress?.onResourcesDiscovered?.({
      total: totalDiscovered,
      storeId,
    });
  }

  return {
    storeResources,
    storeRequestCaches,
    filesToWatch,
    storeIds: effectiveStores,
    storeConfigs: effectiveStoreConfigs,
  };
}
