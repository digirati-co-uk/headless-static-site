import fs from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Vault } from "@iiif/helpers";
import type { Manifest } from "@iiif/presentation-3";
import { copy, pathExists } from "fs-extra/esm";
import { isEmpty } from "../util/is-empty";
import type { NetworkConfig } from "../util/network.ts";
import type { SlugConfig } from "../util/slug-engine.ts";
import {
  type ParsedResource,
  type ProtoResourceDirectory,
  type Store,
  type StoreApi,
  createProtoDirectory,
} from "../util/store";
import {
  createDiscoveryBudget,
  discoverCollectionChildren,
  type RemoteDiscoveryLimits,
} from "./iiif-remote-discovery.ts";

export interface IIIFRemoteStore {
  run?: string[];
  skip?: string[];
  type: "iiif-remote";
  url?: string;
  urls?: string[];
  overrides?: string;
  saveManifests?: boolean;
  slugTemplate?: SlugConfig | SlugConfig[];
  slugTemplates?: string[];
  config?: any;
  network?: NetworkConfig;
  validation?: { strict?: boolean; requireSlugTemplate?: boolean };
  discovery?: RemoteDiscoveryLimits;
  /** Maps a source URL to an opaque public caller key. */
  inputKeys?: Record<string, string>;
}

function assertWithinOverrides(root: string, file: string) {
  const path = relative(root, file);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`IIIF override escapes its directory: ${file}`);
  }
}

async function parseRemote(
  store: IIIFRemoteStore,
  api: StoreApi,
  traversal: { budget: ReturnType<typeof createDiscoveryBudget>; ids: Set<string>; canonical: Map<string, string> }
): Promise<ParsedResource[]> {
  if (store.urls) {
    const toReturn = [];
    for (const url of new Set(store.urls)) {
      toReturn.push(...(await parseRemote({ ...store, url, urls: undefined }, api, traversal)));
    }
    return toReturn;
  }
  if (!store.url) {
    return [];
  }

  if (!traversal.budget.resource(store.url)) return [];
  const collection = await api.requestCache.fetch(store.url);
  // We support v2 and v3 collections.
  const identifier = collection?.["@id"] || collection?.id || "";
  const isCollection = collection?.["@type"] === "sc:Collection" || collection?.type === "Collection";
  const isManifest = collection?.["@type"] === "sc:Manifest" || collection?.type === "Manifest";

  if ((!isCollection && !isManifest) || !identifier || (store.validation?.strict && typeof identifier !== "string")) {
    if (store.validation?.strict) throw new Error(`Invalid IIIF Manifest or Collection at ${store.url}`);
    console.log("ERROR: Could not parse collection", store.url);
    return [];
  }

  traversal.canonical.set(store.url, identifier);
  if (traversal.ids.has(identifier)) return [];
  traversal.ids.add(identifier);
  const [slug, slugSource] = api.getSlug({
    id: collection?.["@id"] || collection?.id || "",
    type: isManifest ? "Manifest" : "Collection",
  });

  if (store.validation?.requireSlugTemplate && slugSource.startsWith("default:"))
    throw new Error(`No configured slug rule matches ${identifier}.`);

  const override = store.overrides
    ? `${store.overrides}/${
        slug.startsWith(isManifest ? "manifests/" : "collections/")
          ? slug.slice((isManifest ? "manifests/" : "collections/").length)
          : slug
      }.json`
    : undefined;

  if (override) {
    assertWithinOverrides(resolve(store.overrides!), resolve(override));
    // Existing overrides may be symlinks; check the actual file before reading it.
    if (fs.existsSync(override)) assertWithinOverrides(fs.realpathSync(store.overrides!), fs.realpathSync(override));
  }

  if (isManifest) {
    let source: ParsedResource["source"] = {
      type: "remote",
      url: store.url,
      overrides: store.overrides,
    };

    if (override && fs.existsSync(override)) {
      source = {
        type: "disk",
        path: override,
        alias: slug,
        filePath: override,
        upstream: store.url,
      };
    }
    // This is a manifest, probably shouldn't have requested it...
    return [
      {
        type: "Manifest",
        id: identifier,
        slug,
        slugSource,
        path: store.url,
        storeId: api.storeId,
        source,
        saveToDisk: store.saveManifests || false,
        inputKey: store.inputKeys?.[store.url],
      },
    ];
  }

  const allResources: ParsedResource[] = [
    {
      type: "Collection",
      id: identifier,
      remoteChildren: [],
      slug,
      slugSource,
      path: store.url,
      storeId: api.storeId,
      saveToDisk: store.saveManifests || false,
      source: { type: "remote", url: store.url, overrides: store.overrides },
      inputKey: store.inputKeys?.[store.url],
    },
  ];
  const children = await discoverCollectionChildren(
    store.url,
    collection,
    (url) => api.requestCache.fetch(url),
    (url, error) => {
      if (store.validation?.strict) throw new Error(`Failed to load IIIF collection page ${url}`, { cause: error });
      api.build.log(`Warning: failed to load collection page ${url}`, error);
    },
    { ...store.discovery, strict: store.validation?.strict, budget: traversal.budget }
  );
  await api.reportEstimatedResources?.(children.length);
  const membership = new Set<string>();
  for (const child of children) {
    const parsed = await parseRemote({ ...store, url: child.id }, api, traversal);
    const canonical = traversal.canonical.get(child.id);
    if (canonical && canonical !== identifier) membership.add(canonical);
    allResources.push(...parsed);
  }

  allResources[0].remoteChildren = [...membership];
  return allResources;
}

export const IIIFRemoteStore: Store<IIIFRemoteStore> = {
  parse(store, api) {
    return parseRemote(store, api, {
      budget: createDiscoveryBudget(store.discovery),
      ids: new Set(),
      canonical: new Map(),
    });
  },
  async invalidate(store: IIIFRemoteStore, resource: ParsedResource, caches: ProtoResourceDirectory["caches.json"]) {
    if (!caches.load && !caches.urls) {
      return true;
    }

    if (resource.source.type === "disk") {
      const file = await fs.promises.stat(resource.source.path);
      const key = `${file.mtime}-${file.ctime}-${file.size}`;
      return key !== caches.load;
    }

    if (caches.urls && resource.source.type === "remote" && resource.source.url) {
      return !caches.urls.includes(resource.source.url);
    }

    return true;
  },
  async load(store: IIIFRemoteStore, resource: ParsedResource, directory, api) {
    const files = api.files;

    const json =
      resource.source.type === "disk"
        ? ((await files.loadJson(resource.source.path)) as any)
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
      const file = await fs.promises.stat(resource.source.path);
      caches.load = `${file.mtime}-${file.ctime}-${file.size}`;

      const pathWithoutExtension = resource.source.path.replace(".json", "");
      const subFilesFolder = fs.existsSync(pathWithoutExtension);
      if (subFilesFolder) {
        if (subFilesFolder && (await pathExists(resource.slug)) && !isEmpty(resource.slug)) {
          const destination = api.files.resolve(join(directory, "files"));
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
        saveToDisk: resource.source.type === "disk" || store.saveManifests || false,
        inputKey: resource.inputKey,
        remoteChildren: resource.remoteChildren,
        source: resource.source,
      },
      vault,
      caches
    );
  },
};
