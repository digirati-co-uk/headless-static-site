import { BuildConfig } from "../build.ts";
import { loadJson } from "../../util/load-json.ts";
import { join } from "node:path";
import { lazyValue } from "../../util/lazy-value.ts";
//@ts-ignore
import { Vault } from "@iiif/vault";
import { getValue } from "../../extract/extract-label-string.ts";
import { mergeIndices } from "../../util/merge-indices.ts";
import { ActiveResourceJson } from "../../util/store.ts";

export async function extract(
  {
    allResources,
  }: {
    allResources: Array<ActiveResourceJson>;
  },
  buildConfig: BuildConfig,
) {
  const {
    options,
    config,
    cacheDir,
    log,
    manifestExtractions,
    collectionExtractions,
  } = buildConfig;
  if (!options.extract) {
    // This is to remind us that we _cant_ export a site map without extracting.
    return {};
  }

  // Caches.
  let savingFiles = [];

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
        (await extraction.invalidate(manifest, {
          caches,
          resource,
          build: buildConfig,
        }));
      if (!valid) {
        // console.log('Skipping "' + extraction.name + '" for "' + manifest.slug + '" because it is not modified');
        continue;
      }

      log("Running extract: " + extraction.name + " for " + manifest.slug);

      const result = await extraction.handler(manifest, {
        resource,
        meta,
        indicies,
        caches,
        config,
        build: buildConfig,
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

  return {};
}
