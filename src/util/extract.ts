import { LazyValue } from './lazy-value';
import { ActiveResourceJson } from './store';

export interface ExtractionInvalidateApi {
  caches: LazyValue<Record<string, string>>
  resource: any;
}

export interface Extraction {
  name: string;
  types: string[];
  invalidate: (resource: ActiveResourceJson, api: ExtractionInvalidateApi) => Promise<boolean>;
  handler: (resource: ActiveResourceJson, api: any) => Promise<{ caches?: Record<string, string>; meta?: any; indicies?: Record<string, string[]> }>;
}
