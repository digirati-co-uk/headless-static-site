import type { CollectionFinalizer, FinalCollection } from "../util/finalize-collection.ts";

export const featuredPartOf: CollectionFinalizer<Map<string, FinalCollection[]>> = {
  id: "featured-part-of",
  name: "Featured collection breadcrumbs",
  configure({ collections }) {
    const paths = new Map<string, FinalCollection[]>();
    const root = collections.featured;
    if (!root) return paths;
    const byId = new Map(Object.values(collections).map((collection) => [collection.id, collection]));
    const visited = new Set<string>();
    const pending = [{ collection: root, ancestors: [] as FinalCollection[] }];
    while (pending.length) {
      const { collection, ancestors } = pending.pop()!;
      if (visited.has(collection.id)) continue;
      visited.add(collection.id);
      if (collection !== root) paths.set(collection.id, ancestors);
      const next = [...ancestors, collection];
      // Reverse the stack insertion to follow authored item order.
      for (const item of [...(collection.items || [])].reverse()) {
        const child = byId.get(item.id);
        if (!child || visited.has(child.id)) continue;
        pending.push({ collection: child, ancestors: next });
      }
    }
    return paths;
  },
  handler(collection, _api, paths) {
    const ancestors = paths.get(collection.id);
    if (ancestors) {
      collection.partOf = ancestors.map((parent) => ({
        id: parent.id,
        type: "Collection",
        label: parent.label,
        "hss:slug": parent["hss:slug"],
      }));
    }
  },
};
