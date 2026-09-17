import type { SearchExtractionConfig } from "./extract.ts";
import type { Collection } from "@iiif/presentation-3";
import type { IIIFRC } from "./get-config.ts";

export type CollectionOrder = "preserve" | "source" | "label" | "index";

export type FinalCollection = Collection & Record<string, any>;

export interface CollectionFinalizerApi {
  /** All emitted collections, keyed by slug; the root index uses an empty slug. */
  collections: Readonly<Record<string, FinalCollection>>;
  config: IIIFRC;
  /** Mutable output records keyed by resource slug, including manifests. Missing records are not synthesized. */
  searchRecords?: ReadonlyMap<string, Record<string, any>>;
  sourceOrder?: ReadonlyMap<string, number>;
  orderPolicies?: ReadonlyMap<string, CollectionOrder>;
}

/** Runs on output JSON after aggregate construction, before publication. */
export interface CollectionFinalizer<Config = any> {
  id: string;
  name: string;
  search?: Record<string, SearchExtractionConfig>;
  configure?: (api: CollectionFinalizerApi, config: Partial<Config>) => Config | Promise<Config>;
  handler: (
    collection: FinalCollection,
    api: CollectionFinalizerApi & { slug: string },
    config: Config
  ) => void | Promise<void>;
  close?: (config: Config) => void | Promise<void>;
}
