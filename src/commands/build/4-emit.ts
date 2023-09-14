import { BuildConfig } from "../build.ts";
import { loadJson } from "../../util/load-json.ts";
import { join } from "node:path";
// @ts-ignore
import { Vault } from "@iiif/vault";
// @ts-ignore
import { createThumbnailHelper } from "@iiif/vault-helpers";
import { mkdirp } from "mkdirp";
import { readFile } from "node:fs/promises";
import { existsSync } from "fs";
import { isEmpty } from "../../util/is-empty.ts";
import { copy } from "fs-extra/esm";
import { ActiveResourceJson } from "../../util/store.ts";

export async function emit(
  {
    allResources,
    allPaths,
  }: {
    allResources: Array<ActiveResourceJson>;
    allPaths?: Record<string, string>;
  },
  { options, server, cacheDir, buildDir, log, imageServiceLoader }: BuildConfig,
) {
  if (!options.emit) {
    return {};
  }

  const savingFiles = [];
  const saveJson = (file: string, contents: any) => {
    savingFiles.push(Bun.write(file, JSON.stringify(contents, null, 2)));
  };

  const configUrl = server?.url;
  const indexCollection: any[] = [];
  const storeCollections: Record<string, Array<any>> = {};
  const manifestCollection: any[] = [];

  for (const manifest of allResources) {
    const { slug } = manifest;
    let url = manifest.saveToDisk
      ? `${configUrl}/${slug}/manifest.json`
      : manifest.path;

    const manifestBuildDirectory = join(buildDir, slug);
    const manifestCacheDirectory = join(cacheDir, slug);
    const cache = {
      "vault.json": join(manifestCacheDirectory, "vault.json"),
      "meta.json": join(manifestCacheDirectory, "meta.json"),
    };

    // const folderPath = allPaths[manifest.path];
    // const source = manifest.source;

    // Still always load the resource.
    const vaultJson = await loadJson(cache["vault.json"]);
    const vault = new Vault();
    vault.getStore().setState(vaultJson);

    // @todo thumbnail extraction step and use this.
    // const getThumbnail = async () => {
    //   if (resource.thumbnail) {
    //     return resource.thumbnail;
    //   }
    //
    //   const metaJson = await loadJson(cache["meta.json"]);
    //   return metaJson.thumbnail;
    // };

    const helper = createThumbnailHelper(vault, { imageServiceLoader });
    const resource = vault.toPresentation3({
      id: manifest.id,
      type: manifest.type,
    });

    let thumbnail = resource.thumbnail
      ? null
      : await helper.getBestThumbnailAtSize(
          resource,
          {
            maxWidth: 300,
            maxHeight: 300,
          },
          false,
        );

    if (!thumbnail?.best && !resource.thumbnail) {
      thumbnail = await helper.getBestThumbnailAtSize(
        resource,
        {
          maxWidth: 300,
          maxHeight: 300,
        },
        true,
      );
    }

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
    await mkdirp(manifestBuildDirectory);

    if (manifest.saveToDisk) {
      const fileName =
        manifest.type === "Manifest" ? "manifest.json" : "collection.json";

      // @todo allow raw preprocessing here.
      //   This is a weak part of the system for now.
      if (configUrl) {
        resource.id = `${configUrl}/${manifest.slug}/${fileName}`;
      }

      if (resource.type === "Collection") {
        if (!allPaths) {
          log(`WARNING: Skipping Collection generation`);
          continue;
        }

        resource.items = resource.items.map((item: any) => {
          if (item.type === "Manifest") {
            item.id = `${configUrl}/${allPaths[item.path]}/manifest.json`;
          } else {
            item.id = `${configUrl}/${allPaths[item.path]}/collection.json`;
          }
          return item;
        });
      }

      saveJson(join(manifestBuildDirectory, fileName), resource);
    }

    // 3. Save the meta file to disk
    const meta = await readFile(join(cacheDir, manifest.slug, "meta.json"));
    savingFiles.push(
      Bun.write(join(manifestBuildDirectory, "meta.json"), meta),
    );

    // 4. Copy the contents of `files/`
    const filesDir = join(cacheDir, manifest.slug, "files");
    if (existsSync(filesDir) && !isEmpty(filesDir)) {
      savingFiles.push(
        copy(filesDir, manifestBuildDirectory, { overwrite: true }),
      );
    }
  }

  await Promise.all(savingFiles);

  return {
    indexCollection,
    storeCollections,
    manifestCollection,
  };
}
