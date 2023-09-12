import { LazyValue } from './lazy-value';
import { IIIFRC } from './get-config';
import { IIIFBuilder } from 'iiif-builder';
import { ActiveResourceJson } from './store';


export interface EnrichmentHandlerApi {
  meta: LazyValue<Record<string, any>>;
  indicies: LazyValue<Record<string, any>>;
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
  indicies?: Record<string, any>;
  caches?: Record<string, any>;
}

export interface Enrichment {
  name: string;
  types: string[];
  invalidate: (resource: ActiveResourceJson, api: EnrichmentInvalidateApi) => Promise<boolean>;
  handler(resource: ActiveResourceJson, api: EnrichmentHandlerApi): Promise<EnrichmentResult>;
}
