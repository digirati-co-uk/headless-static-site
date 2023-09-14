import { LazyValue } from "./lazy-value";
import { ActiveResourceJson } from "./store";
import { BuildConfig } from "../commands/build.ts";
import { IIIFRC } from "./get-config.ts";

export interface ExtractionInvalidateApi {
  caches: LazyValue<Record<string, string>>;
  resource: any;
  build: BuildConfig;
}

export interface Extraction {
  name: string;
  types: string[];
  invalidate: (
    resource: ActiveResourceJson,
    api: ExtractionInvalidateApi,
  ) => Promise<boolean>;
  handler: (
    resource: ActiveResourceJson,
    api: {
      resource: any;
      meta: LazyValue<any>;
      indicies: LazyValue<Record<string, string[]>>;
      caches: LazyValue<Record<string, any>>;
      config: IIIFRC;
      build: BuildConfig;
    },
  ) => Promise<{
    caches?: Record<string, string>;
    meta?: any;
    indicies?: Record<string, string[]>;
  }>;
}
