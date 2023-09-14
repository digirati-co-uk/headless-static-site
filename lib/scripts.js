export function extract(config, handler) {
  if (!config) return;
  global.__hss = global.__hss ? global.__hss : {};
  global.__hss.extractions = global.__hss.extractions
    ? global.__hss.extractions
    : [];
  global.__hss.extractions.push({
    invalidate: async () => true,
    ...config,
    handler: handler,
  });
}

export function enrich(config, handler) {
  if (!config || !handler) return;
  global.__hss = global.__hss ? global.__hss : {};
  global.__hss.enrichments = global.__hss.enrichments
    ? global.__hss.enrichments
    : [];
  global.__hss.enrichments.push({
    invalidate: async () => true,
    ...config,
    handler: handler,
  });
}
