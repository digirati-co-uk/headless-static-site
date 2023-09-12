// @ts-ignore
import { IIIFBuilder } from "iiif-builder";
// @ts-ignore
import { Vault } from "@iiif/vault";
// @ts-ignore
import { createThumbnailHelper } from "@iiif/vault-helpers";
import { Command } from "commander";
import { getConfig } from "../util/get-config";
import { IIIFJSONStore } from "../stores/iiif-json";
import { ActiveResourceJson, ParsedResource, Store } from "../util/store";
import { mkdirp } from "mkdirp";
import { join } from "node:path";
import { existsSync } from "fs";
import { extractLabelString } from "../extract/extract-label-string";
import { mergeIndices } from "../util/merge-indices";
import { loadJson } from "../util/load-json";
import { lazyValue } from "../util/lazy-value";
import { homepageProperty } from "../enrich/homepage-property";
import { readFile } from "node:fs/promises";
import { copy } from "fs-extra/esm";
import { isEmpty } from "../util/is-empty";
import { watch } from "fs/promises";
import { cwd } from "process";
import { readAllFiles } from "../util/read-all-files";
import { IIIFRemoteStore } from "../stores/iiif-remote";
import { getNodeGlobals } from "../util/get-node-globals";
import { createStoreRequestCache } from "../util/store-request-cache";
import { compileSlugConfig } from "../util/slug-engine";
import { extractSlugSource } from "../extract/extract-slug-source";

export type BuildOptions = {
  config?: string;
  cache?: boolean;
  exact?: string;
  watch?: boolean;
  debug?: boolean;
  scripts?: string;
  stores?: string[];
  dev?: boolean;
};

const defaultCacheDir = ".iiif/cache";
const defaultBuildDir = ".iiif/build";
const devCache = ".iiif/dev/cache";
const devBuild = ".iiif/dev/build";

const builtInExtractions = [extractLabelString, extractSlugSource];
const buildInEnrichments = [homepageProperty /*, translateMetadata , pdiiif*/];

const storeTypes = {
  "iiif-json": IIIFJSONStore,
  "iiif-remote": IIIFRemoteStore,
};

export async function build(options: BuildOptions, command: Command) {
  const config = await getConfig();
  const extractions = [...builtInExtractions];
  const enrichments = [...buildInEnrichments];

  const cacheDir = options.dev ? devCache : defaultCacheDir;
  const buildDir = options.dev ? devBuild : defaultBuildDir;

  const server = options.dev ? { url: "http://localhost:7111" } : config.server;

  if (options.dev) {
    await mkdirp(cacheDir);
    await mkdirp(buildDir);
  }

  const slugs = Object.fromEntries(
    Object.entries(config.slugs || {}).map(([key, value]) => {
      return [key, { info: value, compile: compileSlugConfig(value) }];
    }),
  );

  const log = (...args: any[]) => {
    options.debug && console.log(...args);
  };

  // Step 1: Parse stores
  const stores = Object.keys(config.stores).filter((s) => {
    if (!options.stores || options.stores.length === 0) return true;
    return options.stores.includes(s);
  });
  if (stores.length === 0) {
    if (options.stores && options.stores.length > 0) {
      throw new Error("No stores found matching: " + options.stores.join(", "));
    }
    throw new Error("No stores defined in config");
  }

  if (options.scripts) {
    const scriptsPath = join(cwd(), options.scripts);
    if (existsSync(scriptsPath)) {
      const allFiles = await readAllFiles(scriptsPath);
      for (const file of allFiles) {
        await import(file);
      }
    }
  }

  const globals = getNodeGlobals();

  extractions.push(...globals.extractions);
  enrichments.push(...globals.enrichments);

  const uniqueSlugs: string[] = [];
  const allPaths: Record<string, string> = {};
  const siteMap: Record<string, { type: string; source: any }> = {};
  const storeResources: Record<string, ParsedResource[]> = {};
  const requestCacheDirectory = join(cacheDir, "_requests");

  await mkdirp(requestCacheDirectory);

  const storeParseStartTime = Date.now();
  // const parsedStores = [];
  for (const store of stores) {
    const requestCache = createStoreRequestCache(store, requestCacheDirectory);
    storeResources[store] = [];

    const storeConfig = config.stores[store];
    const storeType: Store<any> = (storeTypes as any)[storeConfig.type];
    if (!storeType) {
      throw new Error("Unknown store type: " + storeConfig.type);
    }

    const getSlug = storeConfig.slugTemplates
      ? (resource: { id: string; type: string }) => {
          for (const slugTemplate of storeConfig.slugTemplates || []) {
            const compiled = slugs[slugTemplate];
            if (compiled && compiled.info.type === resource.type) {
              const [slug] = compiled.compile(resource.id);
              if (slug) {
                return [slug, slugTemplate] as const;
              }
            }
          }
          return [resource.id, "@none"] as const;
        }
      : (resource: { id: string; type: string }) => {
          return [resource.id, "@none"] as const;
        };
    const resources = await storeType.parse(storeConfig as any, {
      storeId: store,
      requestCache,
      getSlug,
    });
    for (const resource of resources) {
      allPaths[resource.path] = resource.slug;
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
      storeResources[store].push(resource);
    }
    storeResources[store] = resources;
  }

  log("Parsed stores in " + (Date.now() - storeParseStartTime) + "ms");

  // Prepare cache directory
  await mkdirp(cacheDir);

  const loadStoreStartTime = Date.now();
  const allResources: Array<ActiveResourceJson> = [];

  for (const store of stores) {
    const requestCache = createStoreRequestCache(store, requestCacheDirectory);
    const storeConfig = config.stores[store];
    const resources = storeResources[store];
    for (const resource of resources) {
      if (options.exact && resource.slug !== options.exact) {
        continue;
      }
      siteMap[resource.slug] = {
        type: resource.type,
        source: resource.source,
      };
      // Here we need to actually load the existing folder from the cache if possible.
      const resourceDir = join(cacheDir, resource.slug);
      const cachesFile = join(resourceDir, "caches.json");
      const caches = existsSync(cachesFile) ? await loadJson(cachesFile) : {};
      const storeType: Store<any> = (storeTypes as any)[storeConfig.type];
      const valid =
        !options.cache ||
        (await storeType.invalidate(storeConfig as any, resource, caches));
      if (valid) {
        // log('Building ' + resource.path);
        await mkdirp(resourceDir);
        const data = await storeType.load(
          storeConfig as any,
          resource,
          resourceDir,
          { requestCache, storeId: resource.storeId },
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
            join(resourceDir, "indicies.json"),
            JSON.stringify(data["indicies.json"], null, 2),
          ),
        ]);
      } else {
        // log('Skipping ' + resource.path + ' because it is not modified');

        const resourceJson = await loadJson(join(resourceDir, "resource.json"));
        allResources.push(resourceJson);
      }
    }
  }

  log("Loaded stores in " + (Date.now() - loadStoreStartTime) + "ms");

  // Step 2: Extract data from stores
  const manifestExtractions = extractions.filter((e) =>
    e.types.includes("Manifest"),
  );
  const collectionExtractions = extractions.filter((e) =>
    e.types.includes("Collection"),
  );

  let savingFiles = [];

  const extractionsStartTime = Date.now();
  for (const manifest of allResources) {
    const vaultData = loadJson(join(cacheDir, manifest.slug, "vault.json"));
    const caches = lazyValue(() =>
      loadJson(join(cacheDir, manifest.slug, "caches.json")),
    );
    const meta = lazyValue(() =>
      loadJson(join(cacheDir, manifest.slug, "meta.json")),
    );
    const indicies = lazyValue(() =>
      loadJson(join(cacheDir, manifest.slug, "indicies.json")),
    );
    const newMeta = {};
    const newCaches = {};
    const newIndicies = {};

    manifest.vault = new Vault();
    manifest.vault.getStore().setState(await vaultData);
    const resource = manifest.vault.getObject(manifest.id);

    const extractions =
      manifest.type === "Manifest"
        ? manifestExtractions
        : collectionExtractions;
    for (const extraction of extractions) {
      const valid =
        !options.cache ||
        (await extraction.invalidate(manifest, { caches, resource }));
      if (!valid) {
        // console.log('Skipping "' + extraction.name + '" for "' + manifest.slug + '" because it is not modified');
        continue;
      }

      const result = await extraction.handler(manifest, {
        resource,
        meta,
        indicies,
        caches,
        config,
      });
      if (result.meta) {
        Object.assign(newMeta, result.meta);
      }
      if (result.caches) {
        Object.assign(newCaches, result.caches);
      }
      if (result.indicies) {
        mergeIndices(newIndicies, result.indicies);
      }
    }

    if (Object.keys(newMeta).length > 0) {
      savingFiles.push(
        Bun.write(
          join(cacheDir, manifest.slug, "meta.json"),
          JSON.stringify(Object.assign(await meta.value, newMeta), null, 2),
        ),
      );
    }
    if (Object.keys(newIndicies).length > 0) {
      savingFiles.push(
        Bun.write(
          join(cacheDir, manifest.slug, "indicies.json"),
          JSON.stringify(
            mergeIndices(await indicies.value, newIndicies),
            null,
            2,
          ),
        ),
      );
    }
    if (Object.keys(newCaches).length > 0) {
      savingFiles.push(
        Bun.write(
          join(cacheDir, manifest.slug, "caches.json"),
          JSON.stringify(Object.assign(await caches.value, newCaches), null, 2),
        ),
      );
    }
  }

  log("Saving " + savingFiles.length + " files");
  await Promise.all(savingFiles);
  savingFiles = [];

  log(
    "Extracted " +
      allResources.length +
      " resources in " +
      (Date.now() - extractionsStartTime) +
      "ms",
  );

  // 3. Enrichment
  const manifestEnrichment = enrichments.filter((e) =>
    e.types.includes("Manifest"),
  );
  const collectionEnrichment = enrichments.filter((e) =>
    e.types.includes("Collection"),
  );
  const enrichmentStartTime = Date.now();

  for (const manifest of allResources) {
    if (!manifest.vault) continue;

    const caches = lazyValue(() =>
      loadJson(join(cacheDir, manifest.slug, "caches.json")),
    );
    const meta = lazyValue(() =>
      loadJson(join(cacheDir, manifest.slug, "meta.json")),
    );
    const indicies = lazyValue(() =>
      loadJson(join(cacheDir, manifest.slug, "indicies.json")),
    );
    const builder = new IIIFBuilder(manifest.vault);
    const newMeta = {};
    const newCaches = {};
    const newIndicies = {};
    let didChange = false;
    const resource = manifest.vault.getObject(manifest.id);

    const enrichmentList =
      manifest.type === "Manifest" ? manifestEnrichment : collectionEnrichment;
    for (const enrichment of enrichmentList) {
      const filesDir = join(cacheDir, manifest.slug, "files");
      const valid =
        !options.cache ||
        (await enrichment.invalidate(manifest, {
          caches,
          resource,
          config,
          files: filesDir,
        }));
      if (!valid) {
        // console.log('Skipping "' + enrichment.name + '" for "' + manifest.slug + '" because it is not modified');
        continue;
      }

      const result = await enrichment.handler(manifest, {
        meta,
        indicies,
        caches,
        config,
        builder,
        resource,
        files: filesDir,
      });
      if (result.meta) {
        Object.assign(newMeta, result.meta);
      }
      if (result.caches) {
        Object.assign(newCaches, result.caches);
      }
      if (result.indicies) {
        mergeIndices(newIndicies, result.indicies);
      }
      didChange = didChange || result.didChange || false;
    }

    if (didChange && manifest.vault) {
      savingFiles.push(
        Bun.write(
          join(cacheDir, manifest.slug, "vault.json"),
          JSON.stringify(manifest.vault.getStore().getState(), null, 2),
        ),
      );
    }

    if (Object.keys(newMeta).length > 0) {
      savingFiles.push(
        Bun.write(
          join(cacheDir, manifest.slug, "meta.json"),
          JSON.stringify(Object.assign(await meta.value, newMeta), null, 2),
        ),
      );
    }
    if (Object.keys(newIndicies).length > 0) {
      savingFiles.push(
        Bun.write(
          join(cacheDir, manifest.slug, "indicies.json"),
          JSON.stringify(
            mergeIndices(await indicies.value, newIndicies),
            null,
            2,
          ),
        ),
      );
    }
    if (Object.keys(newCaches).length > 0) {
      savingFiles.push(
        Bun.write(
          join(cacheDir, manifest.slug, "caches.json"),
          JSON.stringify(Object.assign(await caches.value, newCaches), null, 2),
        ),
      );
    }
  }

  log("Saving " + savingFiles.length + " files");
  await Promise.all(savingFiles);
  savingFiles = [];

  log(
    "Enriched " +
      allResources.length +
      " resources in " +
      (Date.now() - enrichmentStartTime) +
      "ms",
  );

  // 4. Tag collections (FUTURE)

  // 5. Save to disk

  // @todo last enrichment step - update Identifiers for resources.
  // @todo Create reverse indices + save to disk
  // @todo create top level mappings
  // @todo create collections from indices and top level collection

  const buildStartTime = Date.now();
  const configUrl = config.server?.url;
  await mkdirp(buildDir);

  // Available variables
  // - manifest
  // - uniqueSlugs: string[] = [];
  // - allPaths: Record<string, string> = {};
  // - storeResources: Record<string, ParsedResource[]> = {};
  // - requestCacheDirectory = join(cacheDir, "_requests");

  // const allPathIds = Object.values(allPaths);
  // const contentCollections = treeFromDirectories(allPathIds);
  //
  // const navigationCollections = allDirectories(Object.keys(contentCollections));
  // const navigationCollection: Record<string, string[]> = {};
  //
  // for (const collection of navigationCollections) {
  //   for (const p of allPathIds) {
  //     if (p.startsWith(collection)) {
  //       const withoutStart = p.replace(collection + "/", "");
  //       if (withoutStart && !withoutStart.includes("/")) {
  //         navigationCollection[collection] =
  //           navigationCollection[collection] || [];
  //         if (!navigationCollection[collection].includes(p)) {
  //           navigationCollection[collection].push(p);
  //         }
  //       }
  //     }
  //   }
  // }

  // 3 types of collections. Index collection + Top level collection.

  const indexCollection: any[] = [];
  const storeCollections: Record<string, Array<any>> = {};
  const topLevelCollection: any[] = [];
  const manifestCollection: any[] = [];

  for (const manifest of allResources) {
    // Data.

    const { slug } = manifest;
    let url = manifest.saveToDisk
      ? `${configUrl}/${slug}/manifest.json`
      : manifest.path;
    // const folderPath = allPaths[manifest.path];
    // const source = manifest.source;

    // Still always load the resource.
    const vaultJson = await loadJson(
      join(cacheDir, manifest.slug, "vault.json"),
    );
    const vault = new Vault();
    vault.getStore().setState(vaultJson);
    const helper = createThumbnailHelper(vault);
    const resource = vault.toPresentation3({
      id: manifest.id,
      type: manifest.type,
    });

    const thumbnail = resource.thumbnail
      ? null
      : await helper.getBestThumbnailAtSize(
          resource,
          {
            maxWidth: 300,
            maxHeight: 300,
          },
          false,
        );

    const snippet = {
      id: url,
      type: manifest.type,
      label: resource.label,
      thumbnail:
        resource.thumbnail ||
        (thumbnail && thumbnail.best
          ? [
              {
                id: thumbnail.best.id,
                type: "Image",
                width: thumbnail.best.width,
                height: thumbnail.best.height,
              },
            ]
          : null) ||
        undefined,
    };
    // Store collection.
    if (manifest.storeId) {
      storeCollections[manifest.storeId] =
        storeCollections[manifest.storeId] || [];
      storeCollections[manifest.storeId].push(snippet);
    }

    // Index collection.
    indexCollection.push(snippet);

    if (manifest.type === "Manifest") {
      manifestCollection.push(snippet);
    }

    // 1. create build directory
    await mkdirp(join(buildDir, manifest.slug));

    if (manifest.saveToDisk) {
      const fileName =
        manifest.type === "Manifest" ? "manifest.json" : "collection.json";

      // @todo allow raw preprocessing here.
      //   This is a weak part of the system for now.
      if (configUrl) {
        resource.id = `${configUrl}/${manifest.slug}/${fileName}`;
      }
      if (resource.type === "Collection") {
        resource.items = resource.items.map((item: any) => {
          if (item.type === "Manifest") {
            item.id = `${configUrl}/${allPaths[item.path]}/manifest.json`;
          } else {
            item.id = `${configUrl}/${allPaths[item.path]}/collection.json`;
          }
          return item;
        });
      }

      await Bun.write(
        join(buildDir, manifest.slug, fileName),
        JSON.stringify(resource, null, 2),
      );
    }

    // 3. Save the meta file to disk
    const meta = await readFile(join(cacheDir, manifest.slug, "meta.json"));
    await Bun.write(join(buildDir, manifest.slug, "meta.json"), meta);

    // 4. Copy the contents of `files/`
    const filesDir = join(cacheDir, manifest.slug, "files");
    if (existsSync(filesDir) && !isEmpty(filesDir)) {
      await copy(filesDir, join(buildDir, manifest.slug), { overwrite: true });
    }
  }

  if (!options.exact && !options.stores) {
    const indexCollectionJson = {
      "@context": "http://iiif.io/api/presentation/3/context.json",
      id: `${configUrl}/collection.json`,
      type: "Collection",
      label: { en: ["Index"] },
      items: indexCollection,
    };
    await Bun.write(
      join(buildDir, "collection.json"),
      JSON.stringify(indexCollectionJson, null, 2),
    );

    const manifestCollectionJson = {
      "@context": "http://iiif.io/api/presentation/3/context.json",
      id: `${configUrl}/manifests.json`,
      type: "Collection",
      label: { en: ["Manifests"] },
      items: manifestCollection,
    };
    await Bun.write(
      join(buildDir, "manifests.json"),
      JSON.stringify(manifestCollectionJson, null, 2),
    );

    await mkdirp(join(buildDir, "stores"));
    const storeCollectionsJson = Object.entries(storeCollections).map(
      ([storeId, items]) => {
        topLevelCollection.push({
          id: `${configUrl}/stores/${storeId}.json`,
          type: "Collection",
          label: { en: [storeId] },
        });

        return Bun.write(
          join(buildDir, "stores", `${storeId}.json`),
          JSON.stringify(
            {
              "@context": "http://iiif.io/api/presentation/3/context.json",
              id: `${configUrl}/stores/${storeId}.json`,
              type: "Collection",
              label: { en: [storeId] },
              items,
            },
            null,
            2,
          ),
        );
      },
    );

    const topLevelCollectionJson = {
      "@context": "http://iiif.io/api/presentation/3/context.json",
      id: `${configUrl}/top.json`,
      type: "Collection",
      label: { en: ["Top"] },
      items: topLevelCollection,
    };
    await Bun.write(
      join(buildDir, "top.json"),
      JSON.stringify(topLevelCollectionJson, null, 2),
    );

    await Promise.all(storeCollectionsJson);

    // Standard files
    await mkdirp(join(buildDir, "config"));
    await Bun.write(
      join(buildDir, "config", "slugs.json"),
      JSON.stringify(config.slugs, null, 2),
    );
    await Bun.write(
      join(buildDir, "config", "stores.json"),
      JSON.stringify(config.stores, null, 2),
    );
    await Bun.write(
      join(buildDir, "sitemap.json"),
      JSON.stringify(siteMap, null, 2),
    );
  }

  log(
    "Built " +
      allResources.length +
      " resources in " +
      (Date.now() - buildStartTime) +
      "ms",
  );

  log("");
  console.log("Done in " + (Date.now() - storeParseStartTime) + "ms");

  if (options.watch) {
    const watcher = watch(join(cwd(), "content"), { recursive: true });
    const { watch: _watch, scripts, cache, ...nonWatchOptions } = options;
    for await (const event of watcher) {
      if (event.eventType === "change" && event.filename) {
        const file = join("content", event.filename);
        console.log(
          `Detected ${event.eventType} in ${event.filename} (${allPaths[file]})`,
        );
        await build({ ...nonWatchOptions, exact: allPaths[file] }, command);
      }
    }
  }
}
