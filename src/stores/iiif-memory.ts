import { Vault } from "@iiif/helpers";
import objectHash from "object-hash";
import { type ParsedResource, type ProtoResourceDirectory, type Store, createProtoDirectory } from "../util/store.ts";

export type HssProgrammaticInput =
  | { resource: Record<string, any>; url?: never; inputKey?: string; saveToDisk?: boolean }
  | { url: string; resource?: never; inputKey?: string; saveToDisk?: boolean };

export interface IIIFMemoryStore {
  type: "iiif-memory";
  inputs: HssProgrammaticInput[];
  skip?: string[];
  run?: string[];
  config?: Record<string, any>;
}

function getIdentity(resource: any) {
  const id = resource?.id || resource?.["@id"];
  const rawType = resource?.type || resource?.["@type"];
  const type = String(rawType || "").includes("Collection")
    ? "Collection"
    : String(rawType || "").includes("Manifest")
      ? "Manifest"
      : null;
  if (!id || !type) {
    throw new Error("Programmatic IIIF inputs must have an id and Presentation resource type");
  }
  return { id, type };
}

export const IIIFMemoryStore: Store<IIIFMemoryStore> = {
  async parse(store, api) {
    const parsed: ParsedResource[] = [];
    for (let index = 0; index < store.inputs.length; index++) {
      const input = store.inputs[index];
      const resource = input.resource || (await api.requestCache.fetch(input.url));
      const { id, type } = getIdentity(resource);
      const [slug, slugSource] = api.getSlug({ id, type });
      parsed.push({
        type,
        slug,
        slugSource,
        path: input.url || `memory:${index}:${id}`,
        storeId: api.storeId,
        source: input.url ? { type: "remote", url: input.url } : { type: "memory", index },
        saveToDisk: input.saveToDisk ?? !input.url,
        inputKey: input.inputKey,
      });
    }
    return parsed;
  },

  async invalidate(store, resource, caches) {
    if (resource.source.type === "remote") {
      return !caches.urls?.includes(resource.source.url);
    }
    const input = resource.source.type === "memory" ? store.inputs[resource.source.index] : undefined;
    return caches.load !== objectHash(input?.resource || null);
  },

  async load(store, resource, _directory, api): Promise<ProtoResourceDirectory> {
    const input = resource.source.type === "memory" ? store.inputs[resource.source.index] : undefined;
    const json = input?.resource || (await api.requestCache.fetch(resource.path));
    const { id, type } = getIdentity(json);
    const vault = new Vault();
    const loaded: any = await vault.load(id, json);
    const caches =
      resource.source.type === "remote"
        ? { urls: [resource.source.url] }
        : { load: objectHash(input?.resource || null) };
    return createProtoDirectory(
      {
        id,
        type,
        path: resource.path,
        slug: resource.slug,
        storeId: api.storeId,
        slugSource: resource.slugSource,
        subResources: (loaded?.items || []).length,
        saveToDisk: resource.saveToDisk,
        inputKey: resource.inputKey,
        source: resource.source,
      },
      vault,
      caches
    );
  },
};
