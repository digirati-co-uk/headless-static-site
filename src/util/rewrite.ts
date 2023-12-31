import { ParsedResource } from "./store.ts";

export interface Rewrite {
  id: string;
  name: string;
  types: string[];
  rewrite?: (
    slug: string,
    resource: ParsedResource,
  ) => string | Promise<string>;
}
