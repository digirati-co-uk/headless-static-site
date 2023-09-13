// @ts-ignore
import { IIIFStore, Vault } from "@iiif/vault";

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

export interface ParsedResource {
  id?: string;
  type: "Manifest" | "Collection" | "Unknown";
  storeId: string;
  path: string;
  slugSource?: string;
  source: any;
  slug: string;
  subFiles?: string[];
}

export interface ProtoResourceDirectory {
  "resource.json": {
    id: string;
    path: string;
    type: string;
    slug: string;
    storeId: string;
    slugSource?: string;
    saveToDisk: boolean;
    source:
      | { type: "Collection"; id: string }
      | { type: "disk"; path: string }
      | { type: "remote"; url: string };
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
