import { BuildConfig } from "../build.ts";
import { join } from "node:path";
import { mkdirp } from "mkdirp";
import { macro } from "../../macro.ts" assert { type: "macro" };

export async function indices(
  {
    indexCollection,
    manifestCollection,
    storeCollections,
    siteMap,
    editable,
    overrides,
  }: {
    indexCollection?: any[];
    manifestCollection?: any[];
    storeCollections?: Record<string, Array<any>>;
    siteMap?: Record<string, { type: string; source: any; label?: string }>;
    editable?: Record<string, string>;
    overrides?: Record<string, string>;
  },
  { options, server, buildDir, config }: BuildConfig,
) {
  if (options.exact || options.stores) {
    return;
  }

  const topLevelCollection: any[] = [];
  const configUrl = server?.url;

  if (indexCollection) {
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
    JSON.stringify(config.slugs, null, 2),
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

  const files = await macro();
  // // This needs to work with compile.
  if (options.client) {
    await Bun.write(join(buildDir, "client.js"), files.client);
  }

  if (options.html) {
    await Bun.write(join(buildDir, "index.html"), files.indexProd);
    await Bun.write(join(buildDir, "explorer.html"), files.explorer);
    await Bun.write(join(buildDir, "clover.html"), files.clover);
  }

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
