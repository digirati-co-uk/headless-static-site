import {
  createProtoDirectory,
  ParsedResource,
  ProtoResourceDirectory,
  Store,
} from "../util/store";
import { Vault } from "@iiif/helpers";
import { join } from "node:path";
import { existsSync } from "fs";
import { cwd } from "process";
import { stat } from "node:fs/promises";
import { copy, pathExists } from "fs-extra/esm";
import { isEmpty } from "../util/is-empty";
import { Manifest } from "@iiif/presentation-3";

export interface IIIFRemoteStore {
  type: "iiif-remote";
  url?: string;
  urls?: string[];
  overrides?: string;
  saveManifests?: boolean;
}

export const IIIFRemoteStore: Store<IIIFRemoteStore> = {
  async parse(store, api) {
    if (store.urls) {
      const toReturn = [];
      for (const url of store.urls) {
        toReturn.push(
          ...(await IIIFRemoteStore.parse(
            { ...store, url, urls: undefined },
            api,
          )),
        );
      }
      return toReturn;
    }
    if (!store.url) {
      return [];
    }

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
      console.log("ERROR: Could not parse collection", store.url);
      return [];
    }

    let [slug, slugSource] = api.getSlug({
      id: collection["@id"] || collection["id"] || "",
      type: isManifest ? "Manifest" : "Collection",
    });

    let override = store.overrides
      ? `${store.overrides}/${slug}.json`
      : undefined;

    if (override && override.startsWith("manifests/manifests/")) {
      override = override.replace("manifests/manifests/", "manifests/");
    }

    if (override && override.startsWith("collections/collections/")) {
      override = override.replace("collections/collections/", "collections/");
    }

    if (isManifest) {
      let source: ParsedResource["source"] = {
        type: "remote",
        url: store.url,
        overrides: store.overrides,
      };

      if (override && existsSync(join(cwd(), override))) {
        source = { type: "disk", path: override, alias: slug };
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
          saveToDisk: store.saveManifests || false,
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
        saveToDisk: store.saveManifests || false,
        source: { type: "remote", url: store.url, overrides: store.overrides },
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
    if (!caches.load && !caches.urls) {
      return true;
    }

    if (resource.source.type === "disk") {
      const file = await stat(resource.source.path);
      const key = file.mtime + "-" + file.ctime + "-" + file.size;
      return key !== caches.load;
    } else if (caches.urls && resource.source.url) {
      return !caches.urls.includes(resource.source.url);
    }

    return true;
  },
  async load(store: IIIFRemoteStore, resource: ParsedResource, directory, api) {
    const json =
      resource.source.type === "disk"
        ? ((await Bun.file(resource.source.path).json()) as any)
        : await api.requestCache.fetch(resource.path);

    const id = json.id || json["@id"];
    const key = await api.requestCache.getKey(resource.path);

    if (!id) {
      throw new Error("No id found in json");
    }

    const vault = new Vault();
    const res = await vault.load<Manifest>(id, json);

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
    } else if (key) {
      caches.urls = caches.urls || [];
      if (!caches.urls.includes(key)) {
        caches.urls.push(key);
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
        subResources: (res?.items || []).length,
        saveToDisk:
          resource.source.type === "disk" || store.saveManifests || false,
        source: resource.source,
      },
      vault,
      caches,
    );
  },
};
