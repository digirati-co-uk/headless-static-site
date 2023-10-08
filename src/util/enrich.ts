import { LazyValue } from "./lazy-value";
import { IIIFRC } from "./get-config";
// @ts-ignore
import { IIIFBuilder } from "iiif-builder";
import { ActiveResourceJson } from "./store";
import { BuildConfig } from "../commands/build.ts";

export interface EnrichmentHandlerApi {
  meta: LazyValue<Record<string, any>>;
  indices: LazyValue<Record<string, any>>;
  caches: LazyValue<Record<string, any>>;
  config: IIIFRC;
  builder: IIIFBuilder;
  resource: any;
  files: string;
}

interface EnrichmentInvalidateApi {
  config: IIIFRC;
  resource: any;
  caches: LazyValue<Record<string, any>>;
  files: string;
}

export interface EnrichmentResult {
  didChange?: boolean;
  meta?: Record<string, any>;
  indices?: Record<string, any>;
  caches?: Record<string, any>;
}

export interface EnrichmentSetupApi {
  build: BuildConfig;
  config: IIIFRC;
}

export interface Enrichment<Config = any> {
  id: string;
  name: string;
  types: string[];
  close?: (config: Config) => Promise<void>;
  configure?: (
    api: EnrichmentSetupApi,
    config: Partial<Config>,
  ) => Promise<Config>;
  invalidate: (
    resource: ActiveResourceJson,
    api: EnrichmentInvalidateApi,
    config: Config,
  ) => Promise<boolean>;
  handler(
    resource: ActiveResourceJson,
    api: EnrichmentHandlerApi,
    config: Config,
  ): Promise<EnrichmentResult>;
}
