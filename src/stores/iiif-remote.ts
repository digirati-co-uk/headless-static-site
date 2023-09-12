import {
  createProtoDirectory,
  ParsedResource,
  ProtoResourceDirectory,
  Store,
} from "../util/store";
// @ts-ignore
import { Vault } from "@iiif/vault";
import { writeFile } from "fs/promises";
import { join } from "node:path";
import { mkdirp } from "mkdirp";
import { existsSync } from "fs";
import { cwd } from "process";
import { stat } from "node:fs/promises";
import { copy, pathExists } from "fs-extra/esm";
import { isEmpty } from "../util/is-empty";

interface IIIFRemoteStore {
  type: "iiif-remote";
  url: string;
  overrides?: string;
  saveManifests?: boolean;
}

export const IIIFRemoteStore: Store<IIIFRemoteStore> = {
  async parse(store, api) {
    const collection = await api.requestCache.fetch(store.url);

    // We support v2 and v3 collections.
    const identifier = collection["@id"] || collection["id"] || "";
    const isCollection =
      collection["@type"] === "sc:Collection" ||
      collection["type"] === "Collection";
    const isManifest =
      collection["@type"] === "sc:Manifest" ||
      collection["type"] === "Manifest";

    if ((!isCollection && !isManifest) || !identifier) {
      return [];
    }

    const [slug, slugSource] = api.getSlug({
      id: collection["@id"] || collection["id"] || "",
      type: isManifest ? "Manifest" : "Collection",
    });

    const override = store.overrides
      ? `${store.overrides}/${slug}.json`
      : undefined;

    if (isManifest) {
      let source: ParsedResource["source"] = { type: "remote", url: store.url };

      if (override && existsSync(join(cwd(), override))) {
        source = { type: "disk", path: override };
      }
      // This is a manifest, probably shouldn't have requested it...
      return [
        {
          type: "Manifest",
          slug,
          slugSource,
          path: store.url,
          storeId: api.storeId,
          source,
        },
      ];
    }

    const allResources: ParsedResource[] = [
      {
        type: "Collection",
        slug,
        slugSource,
        path: store.url,
        storeId: api.storeId,
        source: { type: "remote", url: store.url },
      },
    ];
    // We need to loop through.
    const vault = new Vault();
    const collectionVault = await vault.loadCollection(identifier, collection);
    if (!collectionVault) {
      return [];
    }
    const loading = [];
    for (const manifestItem of collectionVault.items) {
      loading.push(
        IIIFRemoteStore.parse({ ...store, url: manifestItem.id }, api),
      );
    }

    const results = await Promise.all(loading);
    for (const result of results) {
      allResources.push(...result);
    }

    return allResources;
  },
  async invalidate(
    store: IIIFRemoteStore,
    resource: ParsedResource,
    caches: ProtoResourceDirectory["caches.json"],
  ) {
    if (!caches.load) {
      return true;
    }

    if (resource.source.type === "disk") {
      const file = await stat(resource.source.path);
      const key = file.mtime + "-" + file.ctime + "-" + file.size;
      return key !== caches.load;
    }

    return true;
  },
  async load(store: IIIFRemoteStore, resource: ParsedResource, directory, api) {
    const json =
      resource.source.type === "disk"
        ? ((await Bun.file(resource.source.path).json()) as any)
        : await api.requestCache.fetch(resource.path);

    const id = json.id || json["@id"];

    if (!id) {
      throw new Error("No id found in json");
    }

    const vault = new Vault();
    await vault.load(id, json);

    await mkdirp(directory);
    await writeFile(
      join(directory, "resource.json"),
      JSON.stringify(json, null, 2),
    );

    // Copy any sub files.
    const caches: any = {};
    if (resource.source.type === "disk") {
      const file = await stat(resource.source.path);
      caches.load = file.mtime + "-" + file.ctime + "-" + file.size;

      const pathWithoutExtension = resource.source.path.replace(".json", "");
      const subFilesFolder = existsSync(join(cwd(), pathWithoutExtension));
      if (subFilesFolder) {
        if (
          subFilesFolder &&
          (await pathExists(resource.slug)) &&
          !isEmpty(resource.slug)
        ) {
          const destination = join(cwd(), directory, "files");
          await copy(resource.slug, destination, { overwrite: true });
        }
      }
    }

    return createProtoDirectory(
      {
        id,
        type: resource.type,
        path: resource.path,
        slug: resource.slug,
        storeId: api.storeId,
        slugSource: resource.slugSource,
        saveToDisk:
          resource.source.type === "disk" || store.saveManifests || false,
        source: resource.source,
      },
      vault,
      caches,
    );
  },
};
