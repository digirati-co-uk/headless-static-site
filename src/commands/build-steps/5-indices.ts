import fs from "node:fs";
import { dirname, join } from "node:path";
import type { Collection, InternationalString } from "@iiif/presentation-3";
import slug from "slug";
import { stringify } from "yaml";
import { createCollection } from "../../util/create-collection.ts";
import type { SearchIndexes } from "../../util/extract.ts";
import { loadJson } from "../../util/load-json.ts";
import type { ActiveResourceJson } from "../../util/store.ts";
import type { BuildConfig } from "../build.ts";
// import { macro } from "../../macro.ts" assert { type: "macro" };

export async function indices(
  {
    allResources,
    indexCollection,
    manifestCollection,
    storeCollections,
    siteMap,
    editable,
    overrides,
    collections,
    searchIndexes,
    allIndices,
  }: {
    allResources: Array<ActiveResourceJson>;
    indexCollection?: Record<string, any>;
    manifestCollection?: any[];
    storeCollections?: Record<string, Array<any>>;
    siteMap?: Record<
      string,
      { type: string; source?: any; label?: string; canvases?: number; hasCanvasData?: boolean }
    >;
    editable?: Record<string, string>;
    overrides?: Record<string, string>;
    collections?: Record<string, string[]>;
    searchIndexes?: SearchIndexes;
    allIndices?: Record<string, string[]>;
  },
  { options, configUrl, buildDir, config, cacheDir, topicsDir, collectionRewrites, files, trace }: BuildConfig
) {
  if (options.exact || options.stores?.length) {
    return;
  }

  // File helpers.
  function write(file: string, content: any) {
    return files.writeFile(file, content);
  }
  function writeJson(file: string, content: any) {
    return files.saveJson(file, content);
  }
  async function readJson(path: string) {
    return await files.loadJson(path);
  }

  const topLevelCollection: any[] = [];
  const resourcesBySlug = new Map(allResources.map((resource) => [resource.slug, resource]));
  const resourceOrdinal = new Map(allResources.map((resource, index) => [resource.slug, index]));
  const bySourceOrder = (a: any, b: any) =>
    (resourceOrdinal.get(a?.["hss:slug"]) ?? Number.MAX_SAFE_INTEGER) -
      (resourceOrdinal.get(b?.["hss:slug"]) ?? Number.MAX_SAFE_INTEGER) ||
    String(a?.["hss:slug"] || "").localeCompare(String(b?.["hss:slug"] || ""));
  const byLabel = (a: any, b: any) => getLabel(a).localeCompare(getLabel(b));
  function getLabel(item: any) {
    const label = item?.label;
    if (typeof label === "string") return label;
    return String(Object.values(label || {})[0]?.[0] || item?.["hss:slug"] || "");
  }
  const folderCollectionsConfig = (config.config?.["folder-collections"] || {}) as {
    labelStrategy?: "folderName" | "metadata" | "customMap";
    customMap?: Record<string, string | InternationalString>;
  };

  function titleCaseFolder(value: string) {
    return value
      .split(/[-_\s]+/g)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  async function getFolderCollectionLabel(originalCollectionSlug: string, manifestSlugs: string[]) {
    const labelStrategy = folderCollectionsConfig.labelStrategy || "folderName";
    const folderLeaf = originalCollectionSlug.split("/").filter(Boolean).pop() || originalCollectionSlug;

    if (labelStrategy === "customMap") {
      const customValue = folderCollectionsConfig.customMap?.[originalCollectionSlug];
      if (customValue) {
        return customValue;
      }
    }

    if (labelStrategy === "metadata") {
      for (const manifestSlug of manifestSlugs) {
        const resource = resourcesBySlug.get(manifestSlug);
        if (!resource || resource.source.type !== "disk") {
          continue;
        }

        const candidates = [
          join(resource.source.path, originalCollectionSlug, "_collection.yml"),
          join(resource.source.path, originalCollectionSlug, "_collection.yaml"),
          join(dirname(resource.source.filePath), "_collection.yml"),
          join(dirname(resource.source.filePath), "_collection.yaml"),
        ];

        for (const candidate of candidates) {
          if (!fs.existsSync(candidate)) {
            continue;
          }
          const loaded = await files.readYaml(candidate);
          if (loaded?.label) {
            return loaded.label;
          }
        }
      }
    }

    return titleCaseFolder(folderLeaf);
  }

  if (collections && indexCollection) {
    const collectionSlugs = Object.keys(collections).sort();
    for (const originalCollectionSlug of collectionSlugs) {
      const manifestSlugs = collections[originalCollectionSlug];
      let collectionSlug = originalCollectionSlug; // @todo rewrite
      if (!collectionSlug.startsWith("collections/")) {
        collectionSlug = `collections/${collectionSlug}`;
      }

      for (const rewrite of collectionRewrites) {
        if (rewrite.rewrite) {
          const newSlug = await rewrite.rewrite(collectionSlug, {
            id: collectionSlug,
            type: "Collection",
          });
          if (newSlug) {
            collectionSlug = newSlug;
          }
        }
      }

      if (!indexCollection[collectionSlug]) {
        const collectionLabel = await getFolderCollectionLabel(originalCollectionSlug, manifestSlugs);
        const collectionSnippet = createCollection({
          configUrl,
          slug: collectionSlug,
          label: collectionLabel,
        });
        (collectionSnippet as any)["hss:totalItems"] = manifestSlugs.filter((slug) => indexCollection[slug]).length;
        const collection = {
          ...collectionSnippet,
          items: manifestSlugs
            .map((slug) => {
              return indexCollection[slug];
            })
            .filter(Boolean)
            .sort(bySourceOrder),
        };
        indexCollection[collectionSlug] = collectionSnippet;
        await files.mkdir(join(buildDir, collectionSlug));
        await writeJson(join(buildDir, collectionSlug, "collection.json"), collection);

        topLevelCollection.push(collectionSnippet);
      }
    }
  }

  const indexMap: Record<string, Record<string, string[]>> = {};
  for (const resource of allResources) {
    const indices = join(cacheDir, resource.slug, "indices.json");
    const file = await readJson(indices);
    const subjectTypes = Object.keys(file).sort();
    for (const subjectType of subjectTypes) {
      indexMap[subjectType] = indexMap[subjectType] || {};
      for (const subject of [...file[subjectType]].sort()) {
        indexMap[subjectType][subject] = indexMap[subjectType][subject] || [];
        // const indices = file[subjectType][subject];
        if (indexMap[subjectType][subject].includes(resource.slug)) {
          continue;
        }
        indexMap[subjectType][subject].push(resource.slug);
      }
    }
  }

  // Now build each collection in the index

  if (indexCollection) {
    const baseTopicTypeCollectionSnippet = createCollection({
      label: "Topics",
      ...(config.collections?.topics || {}),
      configUrl,
      slug: "topics",
    });

    topLevelCollection.push(baseTopicTypeCollectionSnippet);
    const baseTopicTypeCollection: Collection = {
      ...baseTopicTypeCollectionSnippet,
      items: [],
    };
    const topicTypeKeys = Object.keys(indexMap).sort();
    const normalizedTopicTypes = new Map<string, string>();
    for (const topicTypeKey of topicTypeKeys) {
      const topicTypeId = slug(topicTypeKey);
      const existingTopicType = normalizedTopicTypes.get(topicTypeId);
      if (existingTopicType && existingTopicType !== topicTypeKey) {
        throw new Error(
          `Topic type keys "${existingTopicType}" and "${topicTypeKey}" both normalize to "${topicTypeId}"`
        );
      }
      normalizedTopicTypes.set(topicTypeId, topicTypeKey);
      const topicType = indexMap[topicTypeKey];
      const topicKeys = Object.keys(topicType).sort();

      let baseTopicTypeMeta = {};
      const topicTypeMetaDisk = join(topicsDir, topicTypeId, "_meta.yaml");
      if (fs.existsSync(topicTypeMetaDisk)) {
        baseTopicTypeMeta = files.readYaml(topicTypeMetaDisk) || {};
      }
      const topicTypeMeta = Object.assign(
        {
          id: topicTypeId,
          label: topicTypeKey,
          slug: `topics/${topicTypeId}`,
        },
        baseTopicTypeMeta
      );

      const topicTypeCollectionSnippet = createCollection({
        configUrl,
        slug: topicTypeMeta.slug,
        label: topicTypeMeta.label,
      });

      indexCollection[topicTypeMeta.slug] = topicTypeCollectionSnippet;
      baseTopicTypeCollection.items.push(topicTypeCollectionSnippet as any);

      const topicTypeCollection: Collection = {
        ...topicTypeCollectionSnippet,
        items: [],
      };

      const normalizedTopics = new Map<string, string>();
      for (const topicKey of topicKeys) {
        const topic = topicType[topicKey];
        const topicId = slug(topicKey);
        const existingTopic = normalizedTopics.get(topicId);
        if (existingTopic && existingTopic !== topicKey) {
          throw new Error(
            `Topics "${existingTopic}" and "${topicKey}" in "${topicTypeKey}" both normalize to "${topicId}"`
          );
        }
        normalizedTopics.set(topicId, topicKey);
        const topicMetaDisk = join(topicsDir, topicTypeId, `${topicId}.yaml`);
        let baseMeta = {};
        if (fs.existsSync(topicMetaDisk)) {
          baseMeta = files.readYaml(topicMetaDisk) || {};
        }

        const topicMeta: any = Object.assign(
          {
            id: topicId,
            label: topicKey,
            slug: `topics/${topicTypeId}/${topicId}`,
          },
          baseMeta
        );
        if (options.topics) {
          await fs.promises.mkdir(join(topicsDir, topicTypeId), { recursive: true });
          await write(topicMetaDisk, stringify(topicMeta));
        }

        const topicCollectionSnippet = createCollection({
          configUrl,
          slug: topicMeta.slug,
          label: topicMeta.label,
        });

        topicTypeCollection.items.push(topicCollectionSnippet as any);

        indexCollection[topicMeta.slug] = topicCollectionSnippet;

        if (topicMeta.thumbnail) {
          (topicCollectionSnippet as any).thumbnail = [
            {
              id: topicMeta.thumbnail,
              type: "Image",
            },
          ];
        }

        const topicCollection: Collection = {
          ...topicCollectionSnippet,
          items: topic
            .map((slug: string) => {
              return indexCollection[slug];
            })
            .filter((e) => e)
            .sort(bySourceOrder),
        };

        await files.mkdir(join(buildDir, "topics", topicTypeId, topicId));

        (topicCollection as any)["hss:totalItems"] = topicCollection.items.length;
        (topicCollectionSnippet as any)["hss:totalItems"] = topicCollection.items.length;
        await writeJson(join(buildDir, "topics", topicTypeId, topicId, "collection.json"), topicCollection);
        await writeJson(join(buildDir, "topics", topicTypeId, topicId, "meta.json"), topicMeta);
      }

      await files.mkdir(join(buildDir, "topics", topicTypeId));
      (topicTypeCollection as any)["hss:totalItems"] = topicTypeCollection.items.length;
      (topicTypeCollectionSnippet as any)["hss:totalItems"] = topicTypeCollection.items.length;
      await writeJson(join(buildDir, "topics", topicTypeId, "collection.json"), topicTypeCollection);
      await writeJson(join(buildDir, "topics", topicTypeId, "meta.json"), topicTypeMeta);
    }

    await files.mkdir(join(buildDir, "topics"));
    (baseTopicTypeCollection as any)["hss:totalItems"] = baseTopicTypeCollection.items.length;
    (baseTopicTypeCollectionSnippet as any)["hss:totalItems"] = baseTopicTypeCollection.items.length;
    indexCollection.topics = baseTopicTypeCollectionSnippet;
    await writeJson(join(buildDir, "topics", "collection.json"), baseTopicTypeCollection);
  }

  await files.mkdir(join(buildDir, "meta"));

  await writeJson(join(buildDir, "meta", "indices.json"), indexMap);
  await writeJson(
    join(buildDir, "meta", "facets.json"),
    Object.fromEntries(
      Object.entries(indexMap).map(([type, values]) => [
        type,
        Object.fromEntries(Object.entries(values).map(([value, slugs]) => [value, slugs.length])),
      ])
    )
  );

  if (trace && options.debug) {
    await writeJson(join(buildDir, "meta", "trace.json"), trace.toJSON());
  }

  if (indexCollection) {
    const indexCollectionJson = createCollection({
      label: "Index",
      ...(config.collections?.index || {}),
      configUrl,
    }) as Collection;

    const indexCollectionJsonCollections = Object.values(indexCollection).filter((t) => t.type === "Collection");
    const indexCollectionJsonManifests = Object.values(indexCollection).filter((t) => t.type === "Manifest");

    indexCollectionJson.items = [
      // Manifests then Collections.
      ...indexCollectionJsonManifests.sort(bySourceOrder),
      ...indexCollectionJsonCollections.sort(byLabel),
    ];
    (indexCollectionJson as any)["hss:totalItems"] = indexCollectionJson.items.length;

    await writeJson(join(buildDir, "collection.json"), indexCollectionJson);
  }

  if (manifestCollection) {
    const manifestCollectionJson = createCollection({
      label: "Manifests",
      ...(config.collections?.manifests || {}),
      configUrl,
      slug: "manifests",
    }) as Collection;

    manifestCollectionJson.items = [...manifestCollection].sort(bySourceOrder);
    (manifestCollectionJson as any)["hss:totalItems"] = manifestCollection.length;
    indexCollection.manifests = {
      ...manifestCollectionJson,
      items: undefined,
    };

    await writeJson(join(buildDir, "manifests", "collection.json"), manifestCollectionJson);
  }

  if (storeCollections) {
    await files.mkdir(join(buildDir, "stores"));
    const storeCollectionSnippets: Collection[] = [];
    const storeCollectionsJson = Object.entries(storeCollections)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([storeId, items]) => {
        const storeCollectionSnippet = createCollection({
          configUrl,
          slug: `stores/${storeId}`,
          label: config.stores[storeId]?.metadata?.label || storeId,
        }) as Collection;
        (storeCollectionSnippet as any)["hss:totalItems"] = items.length;

        storeCollectionSnippets.push(storeCollectionSnippet);
        indexCollection[`stores/${storeId}`] = storeCollectionSnippet;

        await files.mkdir(join(buildDir, "stores", storeId));

        return writeJson(join(buildDir, "stores", `${storeId}/collection.json`), {
          ...storeCollectionSnippet,
          items: [...items].sort(bySourceOrder),
        });
      });

    const topLevelCollectionJson = createCollection({
      label: "Collections",
      ...(config.collections?.collections || {}),
      slug: "collections",
      configUrl,
    }) as Collection;

    const storeCollectionsCollectionJson = createCollection({
      label: "Stores",
      ...(config.collections?.collections?.stores || {}),
      slug: "collections/stores",
      configUrl,
    }) as Collection;
    storeCollectionsCollectionJson.items = storeCollectionSnippets.sort(byLabel);
    (storeCollectionsCollectionJson as any)["hss:totalItems"] = storeCollectionSnippets.length;
    topLevelCollection.push(storeCollectionsCollectionJson);
    indexCollection["collections/stores"] = {
      ...storeCollectionsCollectionJson,
      items: undefined,
    };

    topLevelCollectionJson.items = topLevelCollection.sort(byLabel);
    (topLevelCollectionJson as any)["hss:totalItems"] = topLevelCollection.length;
    indexCollection.collections = {
      ...topLevelCollectionJson,
      items: undefined,
    };
    await files.mkdir(join(buildDir, "collections"));
    await writeJson(join(buildDir, "collections/collection.json"), topLevelCollectionJson);
    await files.mkdir(join(buildDir, "collections", "stores"));
    await writeJson(join(buildDir, "collections", "stores", "collection.json"), storeCollectionsCollectionJson);

    await Promise.all(storeCollectionsJson);
  }

  // Search indexes.
  if (searchIndexes) {
    const searchRoot = join(buildDir, "meta/search");
    await files.mkdir(searchRoot);

    const indexes = Object.keys(searchIndexes).sort();
    const allIndiciesKeys = Object.keys(allIndices || {}).sort();
    for (const index of indexes) {
      const searchIndex = searchIndexes[index];
      const schema = join(searchRoot, `${index}.schema.json`);
      const data = join(searchRoot, `${index}.jsonl`);
      const mapping = join(searchRoot, `${index}.mapping.json`);
      const indiciesToAddToIndex = searchIndex.allIndices ? allIndiciesKeys : searchIndex.indices || [];

      // Need to add dynamic indices.
      for (const indicesToAdd of indiciesToAddToIndex) {
        if (allIndices?.[indicesToAdd]) {
          searchIndex.schema.fields.push({
            name: `topic_${indicesToAdd}`,
            type: "string[]",
            facet: true,
            optional: true,
          });
        }
      }

      await writeJson(schema, {
        name: index,
        ...searchIndex.schema,
      });
      if (searchIndex.emitCombined !== false) {
        await files.writeFile(
          data,
          [...searchIndex.records]
            .sort((a, b) => String(a.slug || a.id || "").localeCompare(String(b.slug || b.id || "")))
            .map((record) => JSON.stringify(record))
            .join("\n")
        );
      }
      await writeJson(mapping, {
        name: index,
        format: "record-jsonl",
        scope: "resource",
        idStrategy: "resource-id",
        schema: `meta/search/${index}.schema.json`,
        data: searchIndex.emitCombined === false ? undefined : `meta/search/${index}.jsonl`,
        facets: searchIndex.schema.fields.filter((field) => field.facet).map((field) => field.name),
        canvasRegistry: "meta/canvas-search-index.json",
      });
    }
  }

  // Standard files
  await files.mkdir(join(buildDir, "config"));
  await writeJson(join(buildDir, "config", "slugs.json"), config.slugs || {});

  if (config.output?.includeSourceConfig) {
    await writeJson(join(buildDir, "config", "stores.json"), config.stores);
  }

  await writeJson(join(buildDir, "meta/all-indices.json"), allIndices);

  if (siteMap) {
    await writeJson(join(buildDir, "meta/sitemap.json"), siteMap);
  }

  if (editable && config.output?.includeDebugMetadata) {
    await writeJson(join(buildDir, "meta/editable.json"), editable);
  }

  if (overrides && config.output?.includeDebugMetadata) {
    await writeJson(join(buildDir, "meta/overrides.json"), overrides);
  }

  if (indexCollection) {
    await writeJson(
      join(buildDir, "meta", "resources.json"),
      Object.fromEntries(Object.entries(indexCollection).sort(([a], [b]) => a.localeCompare(b)))
    );
  }

  // if (options.client || options.html) {
  //   const files = await macro();
  //   // // This needs to work with compile.
  //   if (options.client) {
  //     await write(join(buildDir, "client.js"), files.client);
  //   }
  //
  //   if (options.html) {
  //     await write(join(buildDir, "index.html"), files.indexProd);
  //     await write(join(buildDir, "explorer.html"), files.explorer);
  //     await write(join(buildDir, "clover.html"), files.clover);
  //   }
  // }

  //   const bundle = await Bun.build({
  //     entrypoints: ["./src/lib/client.ts"],
  //     sourcemap: "none",
  //     target: "browser",
  //     minify: true,
  //   });
  //   const script = bundle.outputs[0];
  //   const scriptPath = join(buildDir, "client.js");
  //   await write(scriptPath, script);
  // }
}
