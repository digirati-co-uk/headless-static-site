import { Extraction } from './extract';
import { Enrichment } from './enrich';

declare interface Global {
  __hss?: {
    extractions?: Extraction[];
    enrichments?: Enrichment[];
  };
}

export function getNodeGlobals() {
  const extractions: Extraction[] = [];
  const enrichments: Enrichment[] = [];
  const g = global as Global;

  if (g.__hss) {
    if (g.__hss.extractions) {
      extractions.push(...g.__hss.extractions);
    }
    if (g.__hss.enrichments) {
      enrichments.push(...g.__hss.enrichments);
    }
  }
  return { extractions, enrichments };
}
