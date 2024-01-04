import { LazyValue } from "./lazy-value";
import { ActiveResourceJson } from "./store";
import { BuildConfig } from "../commands/build.ts";
import { IIIFRC } from "./get-config.ts";

export interface ExtractionInvalidateApi {
  caches: LazyValue<Record<string, any>>;
  resource: any;
  build: BuildConfig;
}

interface ExtractionSetupApi {
  build: BuildConfig;
  config: IIIFRC;
}

export interface ExtractionReturn {
  temp?: any;
  caches?: Record<string, any>;
  meta?: any;
  indices?: Record<string, string[]>;
  collections?: string[];
}

export interface Extraction<Config = any, Temp = any> {
  id: string;
  name: string;
  types: string[];
  close?: (config: Config) => Promise<void>;
  collect?: (
    temp: Record<string, Temp>,
    api: ExtractionSetupApi,
    config: Partial<Config>,
  ) => Promise<void>;
  configure?: (
    api: ExtractionSetupApi,
    config: Partial<Config>,
  ) => Promise<Config>;
  invalidate: (
    resource: ActiveResourceJson,
    api: ExtractionInvalidateApi,
    config: Config,
  ) => Promise<boolean>;
  handler: (
    resource: ActiveResourceJson,
    api: {
      resource: any;
      meta: LazyValue<any>;
      indices: LazyValue<Record<string, string[]>>;
      caches: LazyValue<Record<string, any>>;
      config: IIIFRC;
      build: BuildConfig;
    },
    config: Config,
  ) => Promise<ExtractionReturn>;
}
