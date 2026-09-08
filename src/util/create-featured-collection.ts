import type { Collection } from "@iiif/presentation-3";
import type { IIIFRC } from "./get-config.ts";
import { createCollection } from "./create-collection.ts";

const publicFields = [
  "id",
  "type",
  "label",
  "summary",
  "thumbnail",
  "behavior",
  "metadata",
  "rights",
  "requiredStatement",
  "provider",
  "homepage",
  "navDate",
  "hss:slug",
  "hss:totalItems",
];

export function createFeaturedCollection(
  config: NonNullable<NonNullable<IIIFRC["collections"]>["featured"]>,
  configUrl: string | undefined,
  resources: Record<string, any>,
  collectionItems: Record<string, any[]>
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
        const label = (slug: string) => String(Object.values(resources[slug].label || {})[0]?.[0] || slug);
        return label(a).localeCompare(label(b)) || a.localeCompare(b);
      });
  if (new Set(selected).size !== selected.length) throw new Error("Duplicate slug in collections.featured.items");
  const byId = new Map(Object.values(resources).map((resource) => [resource.id, resource]));
  const reference = (item: any) => {
    const canonical = byId.get(item.id) || (item["hss:slug"] && resources[item["hss:slug"]]);
    const merged = { ...item, ...canonical };
    return Object.fromEntries(
      publicFields.filter((field) => merged[field] !== undefined).map((field) => [field, merged[field]])
    );
  };
  const sections = selected.map((slug) => {
    if (
      slug === "featured" ||
      !Object.prototype.hasOwnProperty.call(resources, slug) ||
      resources[slug].type !== "Collection"
    ) {
      throw new Error(`Invalid collection slug "${slug}" in collections.featured.items`);
    }
    const section = reference(resources[slug]);
    const members = collectionItems[slug];
    if (members) {
      section.items = members.map(reference);
      section["hss:totalItems"] = members.length;
      section.thumbnail ||= section.items.find((item: any) => item.thumbnail?.length)?.thumbnail;
    }
    return section;
  });
  return {
    ...createCollection({ label: "Featured collections", ...metadata, configUrl, slug: "featured" }),
    items: sections,
    "hss:totalItems": sections.length,
  } as Collection;
}
