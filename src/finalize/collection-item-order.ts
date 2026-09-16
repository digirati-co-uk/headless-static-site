import type { CollectionFinalizer, CollectionOrder, FinalCollection } from "../util/finalize-collection.ts";

export interface CollectionItemOrderConfig {
  byCollection?: Record<string, "preserve" | "label" | "source">;
  language?: string;
}

export const collectionItemOrder: CollectionFinalizer<
  CollectionItemOrderConfig & { collator: Intl.Collator; byId: Map<string, FinalCollection> }
> = {
  id: "collection-item-order",
  name: "Collection item ordering",
  configure({ collections }, config) {
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error("Invalid collection-item-order config");
    if (config.byCollection && (typeof config.byCollection !== "object" || Array.isArray(config.byCollection)))
      throw new Error("collection-item-order.byCollection must be an object");
    for (const [slug, mode] of Object.entries(config.byCollection || {})) {
      if (!Object.prototype.hasOwnProperty.call(collections, slug))
        throw new Error(`Unknown collection "${slug}" in collection-item-order`);
      if (!["preserve", "label", "source"].includes(mode))
        throw new Error(`Invalid collection order "${mode}" for "${slug}"`);
    }
    if (config.language !== undefined && (typeof config.language !== "string" || !config.language))
      throw new Error("collection-item-order.language must be a language tag");
    // Validate the locale during setup, including for empty sites.
    return {
      ...config,
      collator: new Intl.Collator(config.language || "en"),
      byId: new Map(Object.values(collections).map((collection) => [collection.id, collection])),
    };
  },
  handler(collection, { slug, sourceOrder, orderPolicies }, config) {
    const mode: CollectionOrder =
      config.byCollection && Object.prototype.hasOwnProperty.call(config.byCollection, slug)
        ? config.byCollection[slug]
        : orderPolicies?.get(slug) || "preserve";
    if (mode === "preserve" || !collection.items?.length) return;
    const { collator } = config;
    const identity = (item: any) => String(item["hss:slug"] || item.id || "");
    const stable = (a: any, b: any) => (identity(a) < identity(b) ? -1 : identity(a) > identity(b) ? 1 : 0);
    const label = (item: any) => {
      const value = config.byId.get(item.id)?.label || item.label;
      return typeof value === "string"
        ? value
        : String((value?.[config.language || "en"] || Object.values(value || {})[0] || [])[0] || identity(item));
    };
    const byLabel = (a: any, b: any) => collator.compare(label(a), label(b)) || stable(a, b);
    const bySource = (a: any, b: any) =>
      (sourceOrder?.get(a["hss:slug"]) ?? Number.MAX_SAFE_INTEGER) -
        (sourceOrder?.get(b["hss:slug"]) ?? Number.MAX_SAFE_INTEGER) || stable(a, b);
    collection.items.sort(
      mode === "label"
        ? byLabel
        : mode === "source"
          ? bySource
          : (a, b) =>
              a.type !== b.type
                ? a.type === "Manifest"
                  ? -1
                  : 1
                : a.type === "Manifest"
                  ? bySource(a, b)
                  : byLabel(a, b)
    );
  },
};
