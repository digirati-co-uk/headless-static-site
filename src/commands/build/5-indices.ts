import { BuildConfig } from "../build.ts";
import { join } from "node:path";
import { mkdirp } from "mkdirp";
import { ActiveResourceJson } from "../../util/store.ts";
import slug from "slug";
import { existsSync } from "fs";
import { Collection } from "@iiif/presentation-3";
import { dump } from "js-yaml";
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
  }: {
    allResources: Array<ActiveResourceJson>;
    indexCollection?: Record<string, any>;
    manifestCollection?: any[];
    storeCollections?: Record<string, Array<any>>;
    siteMap?: Record<string, { type: string; source: any; label?: string }>;
    editable?: Record<string, string>;
    overrides?: Record<string, string>;
  },
  { options, server, buildDir, config, cacheDir, topicsDir }: BuildConfig,
) {
  if (options.exact || options.stores) {
    return;
  }

  const topLevelCollection: any[] = [];
  const configUrl = server?.url;

  const indexMap: Record<string, Record<string, string[]>> = {};
  for (const resource of allResources) {
    const indices = join(cacheDir, resource.slug, "indices.json");
    const file = await Bun.file(indices).json();
    const subjectTypes = Object.keys(file);
    for (const subjectType of subjectTypes) {
      indexMap[subjectType] = indexMap[subjectType] || {};
      for (const subject of file[subjectType]) {
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
    const baseTopicTypeCollection: Collection & { "hss:slug": string } = {
      "@context": "http://iiif.io/api/presentation/3/context.json",
      id: `${configUrl}/topics/collection.json`,
      type: "Collection" as const,
      label: { en: ["Topics"] },
      "hss:slug": "topics",
      items: [],
    };
    const topicTypeKeys = Object.keys(indexMap);
    for (const topicTypeKey of topicTypeKeys) {
      const topicTypeId = slug(topicTypeKey);
      const topicType = indexMap[topicTypeKey];
      const topicKeys = Object.keys(topicType);

      let baseTopicTypeMeta = {};
      const topicTypeMetaDisk = join(topicsDir, topicTypeKey, `_meta.yaml`);
      if (existsSync(topicTypeMetaDisk)) {
        baseTopicTypeMeta = (await import(topicTypeMetaDisk)) || {};
      }
      const topicTypeMeta = Object.assign(
        {
          id: topicTypeId,
          label: topicTypeKey,
          slug: "topics/" + topicTypeId,
        },
        baseTopicTypeMeta,
      );

      const topicTypeCollectionSnippet = {
        "@context": "http://iiif.io/api/presentation/3/context.json",
        id: `${configUrl}/${topicTypeMeta.slug}/collection.json`,
        type: "Collection" as const,
        label: { en: [topicTypeMeta.label] },
        "hss:slug": topicTypeMeta.slug,
      };

      indexCollection[topicTypeMeta.slug] = topicTypeCollectionSnippet;
      topLevelCollection.push(topicTypeCollectionSnippet);
      baseTopicTypeCollection.items.push(topicTypeCollectionSnippet);

      const topicTypeCollection: Collection = {
        ...topicTypeCollectionSnippet,
        items: [],
      };

      for (const topicKey of topicKeys) {
        const topic = topicType[topicKey];
        const topicId = slug(topicKey);
        const topicMetaDisk = join(topicsDir, topicTypeKey, `${topicId}.yaml`);
        let baseMeta = {};
        if (existsSync(topicMetaDisk)) {
          baseMeta = (await import(topicMetaDisk)) || {};
        }

        const topicMeta: any = Object.assign(
          {
            id: topicId,
            label: topicKey,
            slug: "topics/" + topicTypeKey + "/" + topicId,
          },
          baseMeta,
        );
        if (options.topics) {
          await mkdirp(join(topicsDir, topicTypeKey));
          await Bun.write(topicMetaDisk, dump(topicMeta));
        }

        const topicCollectionSnippet = {
          "@context": "http://iiif.io/api/presentation/3/context.json",
          id: `${configUrl}/${topicMeta.slug}/collection.json`,
          type: "Collection" as const,
          label: { en: [topicMeta.label] },
          "hss:slug": topicMeta.slug,
        };

        topicTypeCollection.items.push(topicCollectionSnippet);

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
            .filter((e) => e),
        };

        await mkdirp(join(buildDir, "topics", topicTypeKey, topicId));

        (topicCollection as any)["hss:totalItems"] =
          topicCollection["items"].length;
        (topicCollectionSnippet as any)["hss:totalItems"] =
          topicCollection["items"].length;
        await Bun.write(
          join(buildDir, "topics", topicTypeKey, topicId, "collection.json"),
          JSON.stringify(topicCollection, null, 2),
        );
        await Bun.write(
          join(buildDir, "topics", topicTypeKey, topicId, "meta.json"),
          JSON.stringify(topicMeta, null, 2),
        );
      }

      await mkdirp(join(buildDir, "topics", topicTypeKey));
      await Bun.write(
        join(buildDir, "topics", "collection.json"),
        JSON.stringify(baseTopicTypeCollection, null, 2),
      );
      (topicTypeCollection as any)["hss:totalItems"] =
        topicTypeCollection["items"].length;
      (topicTypeCollectionSnippet as any)["hss:totalItems"] =
        topicTypeCollection["items"].length;
      await Bun.write(
        join(buildDir, "topics", topicTypeKey, "collection.json"),
        JSON.stringify(topicTypeCollection, null, 2),
      );
      await Bun.write(
        join(buildDir, "topics", topicTypeKey, "meta.json"),
        JSON.stringify(topicTypeMeta, null, 2),
      );
    }
  }

  await Bun.write(
    join(buildDir, "indices.json"),
    JSON.stringify(indexMap, null, 2),
  );

  if (indexCollection) {
    const indexCollectionJson = {
      "@context": "http://iiif.io/api/presentation/3/context.json",
      id: `${configUrl}/collection.json`,
      type: "Collection",
      label: { en: ["Index"] },
      items: Object.values(indexCollection),
    };
    await Bun.write(
      join(buildDir, "collection.json"),
      JSON.stringify(indexCollectionJson, null, 2),
    );
  }

  if (manifestCollection) {
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
  }

  if (storeCollections) {
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
  }

  // Standard files
  await mkdirp(join(buildDir, "config"));
  await Bun.write(
    join(buildDir, "config", "slugs.json"),
    JSON.stringify(config.slugs || {}, null, 2),
  );

  await Bun.write(
    join(buildDir, "config", "stores.json"),
    JSON.stringify(config.stores, null, 2),
  );

  if (siteMap) {
    await Bun.write(
      join(buildDir, "sitemap.json"),
      JSON.stringify(siteMap, null, 2),
    );
  }

  if (editable) {
    await Bun.write(
      join(buildDir, "editable.json"),
      JSON.stringify(editable, null, 2),
    );
  }

  if (overrides) {
    await Bun.write(
      join(buildDir, "overrides.json"),
      JSON.stringify(overrides, null, 2),
    );
  }

  // if (options.client || options.html) {
  //   const files = await macro();
  //   // // This needs to work with compile.
  //   if (options.client) {
  //     await Bun.write(join(buildDir, "client.js"), files.client);
  //   }
  //
  //   if (options.html) {
  //     await Bun.write(join(buildDir, "index.html"), files.indexProd);
  //     await Bun.write(join(buildDir, "explorer.html"), files.explorer);
  //     await Bun.write(join(buildDir, "clover.html"), files.clover);
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
  //   await Bun.write(scriptPath, script);
  // }
}
