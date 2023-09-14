// @ts-ignore
import { IIIFStore, Vault } from "@iiif/vault";
import { BuildConfig } from "../commands/build.ts";

export interface StoreApi {
  storeId: string;
  getSlug: (resource: {
    id: string;
    type: string;
  }) => readonly [string, string];
  requestCache: {
    fetch<T = any>(url: string): Promise<T>;
    didChange(url: string): Promise<boolean>;
    getKey(url: string): Promise<string | null>;
  };

  // Escape hatch, all config.
  build: BuildConfig;
}
export interface Store<T> {
  parse(store: T, api: StoreApi): Promise<ParsedResource[]> | ParsedResource[];

  invalidate(
    store: T,
    resource: ParsedResource,
    caches: ProtoResourceDirectory["caches.json"],
  ): Promise<boolean>;

  load(
    store: T,
    resource: ParsedResource,
    directory: string,
    api: Omit<StoreApi, "getSlug">,
  ): Promise<ProtoResourceDirectory>;
}

export interface ProtoResourceDirectory {
  "resource.json": {
    /**
     * The id of the resource.
     */
    id: string;
    /**
     * The location of the resource.
     */
    path: string;
    /**
     * The type of resource. (Manifest or Collection etc.)
     */
    type: string;
    /**
     * The path that the FINAL resource will be saved to.
     */
    slug: string;
    /**
     * The store id that the resource belongs to, defined as the key in the config file.
     */
    storeId: string;
    /**
     * Which "slug" configuration was used to generate the slug.
     */
    slugSource?: string;
    /**
     * If this should be saved to disk, or remain as a remote resource.
     */
    saveToDisk?: boolean;
    /**
     * Where this resource originated from.
     */
    source:
      | { type: "disk"; path: string; alias?: string }
      | { type: "remote"; url: string; overrides?: string };
  };
  "vault.json": IIIFStore;
  "meta.json": {
    [key: string]: any;
  };
  "indicies.json": {
    [key: string]: Array<any>;
  };
  "caches.json": {
    [key: string]: string;
  };
  __files?: Array<string>;
}

export type ParsedResource = Omit<
  ProtoResourceDirectory["resource.json"],
  "id" | "type"
> & {
  id?: string;
  type: string;
  subFiles?: string[];
};

export type ActiveResourceJson = ProtoResourceDirectory["resource.json"] & {
  vault?: Vault;
};

export function createProtoDirectory(
  resource: ProtoResourceDirectory["resource.json"],
  vault: Vault,
  caches: any = {},
  other: Partial<ProtoResourceDirectory> = {},
): ProtoResourceDirectory {
  return {
    "resource.json": resource,
    "vault.json": vault.getStore().getState(),
    "caches.json": caches,
    "indicies.json": {},
    "meta.json": {},
    ...other,
  };
}
