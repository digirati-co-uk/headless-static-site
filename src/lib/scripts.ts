import { Extraction } from "../util/extract";
import { Enrichment } from "../util/enrich";

declare global {
  namespace __hss {
    let extractions: Extraction[] | undefined;
    let enrichments: Enrichment[] | undefined;
  }
}

export function extract(
  config: Omit<Extraction, "handler" | "invalidate"> & {
    invalidate?: Extraction["invalidate"];
  },
  handler: Extraction["handler"],
) {
  if (!config) return;
  global.__hss = global.__hss ? global.__hss : ({} as typeof __hss);
  global.__hss.extractions = global.__hss.extractions
    ? global.__hss.extractions
    : [];
  global.__hss.extractions.push({
    invalidate: async () => true,
    ...config,
    handler: handler,
  });
}

export function enrich(
  config: Omit<Enrichment, "handler" | "invalidate"> & {
    invalidate?: Enrichment["invalidate"];
  },
  handler: Enrichment["handler"],
) {
  if (!config || !handler) return;
  global.__hss = global.__hss ? global.__hss : ({} as typeof __hss);
  global.__hss.enrichments = global.__hss.enrichments
    ? global.__hss.enrichments
    : [];
  global.__hss.enrichments.push({
    invalidate: async () => true,
    ...config,
    handler: handler,
  });
}
