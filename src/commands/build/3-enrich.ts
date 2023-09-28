import { BuildConfig } from "../build.ts";
import { lazyLoadJson } from "../../util/load-json.ts";
import { join } from "node:path";
//@ts-ignore
import { IIIFBuilder } from "iiif-builder";
import { mergeIndices } from "../../util/merge-indices.ts";
import { ActiveResourceJson } from "../../util/store.ts";
import { Enrichment } from "../../util/enrich.ts";

export async function enrich(
  { allResources }: { allResources: Array<ActiveResourceJson> },
  {
    options,
    config,
    log,
    cacheDir,
    manifestEnrichment,
    collectionEnrichment,
  }: BuildConfig,
) {
  if (!options.enrich) {
    return {};
  }

  let savingFiles: Promise<any>[] = [];
  const saveJson = (file: string, contents: any) => {
    savingFiles.push(Bun.write(file, JSON.stringify(contents, null, 2)));
  };

  const processManifest = async (manifest: ActiveResourceJson) => {
    if (!manifest.vault) return;

    // Lazy files.
    const caches = lazyLoadJson(cacheDir, manifest.slug, "caches.json");
    const meta = lazyLoadJson(cacheDir, manifest.slug, "meta.json");
    const indicies = lazyLoadJson(cacheDir, manifest.slug, "indicies.json");

    // Output files.
    const files = {
      "meta.json": join(cacheDir, manifest.slug, "meta.json"),
      "indicies.json": join(cacheDir, manifest.slug, "indicies.json"),
      "caches.json": join(cacheDir, manifest.slug, "caches.json"),
      "vault.json": join(cacheDir, manifest.slug, "vault.json"),
    };

    const builder = new IIIFBuilder(manifest.vault);
    const resource = manifest.vault.getObject(manifest.id);

    const newMeta = {};
    const newCaches = {};
    const newIndicies = {};
    let didChange = false;

    const enrichmentList =
      manifest.type === "Manifest" ? manifestEnrichment : collectionEnrichment;

    const runEnrichment = async (enrichment: Enrichment) => {
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
        return;
      }

      log("Running enrichment: " + enrichment.name + " for " + manifest.slug);

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
    };

    const allEnrichments = [];
    for (const enrichment of enrichmentList) {
      allEnrichments.push(runEnrichment(enrichment));
    }

    const results = await Promise.allSettled(allEnrichments);
    const errors = results.filter((r) => r.status === "rejected");
    if (errors.length > 0) {
      throw new Error(
        "Enrichment failed for " +
          errors.length +
          " manifest(s): \n \n" +
          errors
            .map((e, n) => `  ${n + 1}) ` + (e as any)?.reason?.message)
            .join(", "),
      );
    }

    if (didChange && manifest.vault) {
      saveJson(files["vault.json"], manifest.vault.getStore().getState());
    }

    if (Object.keys(newMeta).length > 0) {
      const metaValue = await meta.value;
      saveJson(files["meta.json"], Object.assign({}, metaValue, newMeta));
    }

    if (Object.keys(newIndicies).length > 0) {
      saveJson(
        files["indicies.json"],
        mergeIndices(await indicies.value, newIndicies),
      );
    }

    if (Object.keys(newCaches).length > 0) {
      saveJson(
        files["caches.json"],
        Object.assign(await caches.value, newCaches),
      );
    }
  };

  const allManifestProcesses = [];
  for (const manifest of allResources) {
    allManifestProcesses.push(processManifest(manifest));
  }
  await Promise.all(allManifestProcesses);

  log("Saving " + savingFiles.length + " files");
  await Promise.all(savingFiles);
  savingFiles = [];
}
