import type { Collection } from "@iiif/presentation-3";
import type { IIIFRC } from "./get-config.ts";
import { createCollection } from "./create-collection.ts";

import { hydrateCollectionItems } from "./hydrate-collection-items.ts";

export function createFeaturedCollection(
  config: NonNullable<NonNullable<IIIFRC["collections"]>["featured"]>,
  configUrl: string | undefined,
  resources: Record<string, any>,
  collectionItems: Record<string, any[]>,
  finalize: { order?: boolean; thumbnail?: boolean } = {}
) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("collections.featured must be an object");
  }
  const { items, ...metadata } = config;
  if (items !== undefined && (!Array.isArray(items) || items.some((slug) => typeof slug !== "string"))) {
    throw new Error("collections.featured.items must be a list of collection slugs");
  }
  const selected =
    items ??
    Object.keys(resources)
      .filter(
        (slug) =>
          slug !== "featured" &&
          resources[slug].type === "Collection" &&
          resources[slug].behavior?.includes("hss:featured")
      )
      .sort((a, b) => {
        if (finalize.order) return 0;
        const label = (slug: string) => String(Object.values(resources[slug].label || {})[0]?.[0] || slug);
        return label(a).localeCompare(label(b)) || a.localeCompare(b);
      });
  if (new Set(selected).size !== selected.length) throw new Error("Duplicate slug in collections.featured.items");
  const sections = selected.map((slug) => {
    if (
      slug === "featured" ||
      !Object.prototype.hasOwnProperty.call(resources, slug) ||
      resources[slug].type !== "Collection"
    ) {
      throw new Error(`Invalid collection slug "${slug}" in collections.featured.items`);
    }
    return resources[slug];
  });
  return {
    ...createCollection({ label: "Featured collections", ...metadata, configUrl, slug: "featured" }),
    items: hydrateCollectionItems(sections, resources, collectionItems, !finalize.thumbnail),
    "hss:totalItems": sections.length,
  } as Collection;
}
