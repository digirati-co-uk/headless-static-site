import type { CollectionFinalizer, FinalCollection } from "../util/finalize-collection.ts";

function breadcrumbs(ancestors: FinalCollection[]) {
  return ancestors.map((parent) => ({
    id: parent.id,
    type: "Collection" as const,
    label: structuredClone(parent.label),
    ...(parent.background !== undefined ? { background: parent.background } : {}),
    "hss:slug": parent["hss:slug"],
  }));
}

export const featuredPartOf: CollectionFinalizer<{
  searchRecords?: boolean;
  searchRecordMode?: "top-level" | "full";
  paths: Map<string, FinalCollection[]>;
}> = {
  id: "featured-part-of",
  name: "Featured collection breadcrumbs",
  search: {
    manifests: {
      schema: {
        enable_nested_fields: true,
        fields: [
          { name: "partOf", type: "object[]", optional: true, index: false },
          { name: "background", type: "string", optional: true, index: false },
          { name: "collectionSlugs", type: "string[]", optional: true, facet: true },
        ],
      },
    },
  },
  configure({ collections, searchRecords }, options) {
    const mode = options.searchRecordMode ?? "full";
    if (mode !== "top-level" && mode !== "full")
      throw new Error('featured-part-of.searchRecordMode must be "top-level" or "full"');
    const paths = new Map<string, FinalCollection[]>();
    const root = collections.featured;
    if (!root) return { paths };
    const byId = new Map(Object.values(collections).map((collection) => [collection.id, collection]));
    const visited = new Set<string>();
    const updatedRecords = new Set<string>();
    const updateSearch = (slug: string, ancestors: FinalCollection[], ownCollection?: FinalCollection) => {
      const top = ancestors[1] || ownCollection;
      const record = options.searchRecords && searchRecords?.get(slug);
      if (!record || updatedRecords.has(slug)) return;
      updatedRecords.add(slug);
      record.partOf = breadcrumbs(mode === "full" ? ancestors : top ? [top] : []);
      record.collectionSlugs = [...ancestors.slice(1), ...(ownCollection ? [ownCollection] : [])].map(
        (parent) => parent["hss:slug"]
      );
      // The featured section owns the result colour, even if a child has its own colour.
      if (typeof top?.background === "string") record.background = top.background;
      else delete record.background;
    };
    const pending = [{ collection: root, ancestors: [] as FinalCollection[] }];
    while (pending.length) {
      const { collection, ancestors } = pending.pop()!;
      if (visited.has(collection.id)) continue;
      visited.add(collection.id);
      if (collection !== root) {
        paths.set(collection.id, ancestors);
        updateSearch(collection["hss:slug"], ancestors, collection);
      }
      const next = [...ancestors, collection];
      // Reverse the stack insertion to follow authored item order.
      for (const item of [...(collection.items || [])].reverse()) {
        if (item.type === "Manifest") updateSearch((item as any)["hss:slug"], next);
        const child = byId.get(item.id);
        if (!child || visited.has(child.id)) continue;
        pending.push({ collection: child, ancestors: next });
      }
    }
    return { paths };
  },
  handler(collection, _api, { paths }) {
    const ancestors = paths.get(collection.id);
    if (ancestors) collection.partOf = breadcrumbs(ancestors);
  },
};
