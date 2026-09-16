import type { Collection } from "@iiif/presentation-3";
import type { IIIFRC } from "./get-config.ts";

export type FinalCollection = Collection & Record<string, any>;

export interface CollectionFinalizerApi {
  /** All emitted collections, keyed by slug; the root index uses an empty slug. */
  collections: Readonly<Record<string, FinalCollection>>;
  config: IIIFRC;
}

/** Runs on output JSON after aggregate construction, before publication. */
export interface CollectionFinalizer<Config = any> {
  id: string;
  name: string;
  configure?: (api: CollectionFinalizerApi, config: Partial<Config>) => Config | Promise<Config>;
  handler: (
    collection: FinalCollection,
    api: CollectionFinalizerApi & { slug: string },
    config: Config
  ) => void | Promise<void>;
  close?: (config: Config) => void | Promise<void>;
}
