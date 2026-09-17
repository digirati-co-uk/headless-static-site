import { hydrateCollectionItems } from "../../util/hydrate-collection-items.ts";
import { join } from "node:path";
import { getValue } from "../../extract/extract-label-string.ts";
import type { BuildConfig } from "../build.ts";
import type { FinalCollection } from "../../util/finalize-collection.ts";
import type { ActiveResourceJson } from "../../util/store.ts";

export async function finalizeCollections(
  {
    indexCollection: resources,
    collectionItems,
    siteMap,
  }: {
    indexCollection?: Record<string, any>;
    collectionItems?: Record<string, any[]>;
    siteMap?: Record<string, any>;
  },
  sourceResources: ActiveResourceJson[],
  { options, collectionFinalizers = [], files, buildDir, config, collectionOrder }: BuildConfig,
  searchRecords: ReadonlyMap<string, Record<string, any>> = new Map()
) {
  if (!options.emit || options.exact || options.stores?.length || !resources) return;
  const hydrate = config.collections?.hydrate === undefined ? [] : config.collections.hydrate;
  if (!Array.isArray(hydrate) || hydrate.some((slug) => typeof slug !== "string"))
    throw new Error("collections.hydrate must be a list of collection slugs");
  if (new Set(hydrate).size !== hydrate.length) throw new Error("Duplicate slug in collections.hydrate");
  if (!collectionFinalizers.length && !hydrate.length) return;
  const remote = new Set(sourceResources.filter((resource) => !resource.saveToDisk).map((resource) => resource.slug));
  const paths = new Map<string, string>([["", join(buildDir, "collection.json")]]);
  for (const [slug, resource] of Object.entries(resources)) {
    if (resource.type === "Collection" && !remote.has(slug)) paths.set(slug, join(buildDir, slug, "collection.json"));
  }
  for (const slug of hydrate) {
    if (!paths.has(slug)) throw new Error(`Invalid local collection slug "${slug}" in collections.hydrate`);
  }
  const collections: Record<string, FinalCollection> = Object.fromEntries(
    await Promise.all([...paths].map(async ([slug, path]) => [slug, await files.loadJson(path)]))
  );
  const api = {
    collections,
    config,
    searchRecords,
    orderPolicies: collectionOrder,
    sourceOrder: new Map(sourceResources.map((resource, index) => [resource.slug, index])),
  };
  const snippet = ({ items, "@context": context, annotations, structures, ...metadata }: any) => metadata;
  for (const step of collectionFinalizers) {
    const before = structuredClone(collections);
    const identities = new Map(
      [...searchRecords].map(([slug, record]) => [slug, { record, id: record.id, slug: record.slug }])
    );
    const stepConfig = step.configure
      ? await step.configure(api, config.config?.[step.id] || {})
      : config.config?.[step.id];
    try {
      for (const [slug, collection] of Object.entries(collections)) {
        await step.handler(collection, { ...api, slug }, stepConfig);
      }
      if (searchRecords.size !== identities.size)
        throw new Error(`Collection finalizer "${step.id}" cannot change search record membership`);
      for (const [slug, record] of searchRecords) {
        const identity = identities.get(slug);
        if (!identity || record !== identity.record || record.id !== identity.id || record.slug !== identity.slug)
          throw new Error(`Collection finalizer "${step.id}" cannot change search record id or slug (${slug})`);
      }
      const changes = new Map<string, Record<string, any>>();
      for (const [slug, collection] of Object.entries(collections)) {
        const previous = before[slug];
        if (
          collection.id !== previous.id ||
          collection.type !== "Collection" ||
          collection["hss:slug"] !== previous["hss:slug"]
        )
          throw new Error(`Collection finalizer "${step.id}" cannot change id, type or slug (${slug})`);
        if (collection.items !== undefined && !Array.isArray(collection.items))
          throw new Error(`Collection finalizer "${step.id}" must leave items as an array (${slug})`);
        if (JSON.stringify(collection.items) !== JSON.stringify(previous.items))
          collection["hss:totalItems"] = collection.items?.length || 0;
        const old = snippet(previous),
          current = snippet(collection);
        changes.set(
          collection.id,
          Object.fromEntries(
            [...new Set([...Object.keys(old), ...Object.keys(current)])]
              .filter((key) => JSON.stringify(old[key]) !== JSON.stringify(current[key]))
              .map((key) => [key, current[key]])
          )
        );
      }
      const byId = new Map(Object.values(collections).map((collection) => [collection.id, collection]));
      const visited = new WeakSet<object>();
      const refresh = (reference: any, ancestor = false) => {
        if (!reference || typeof reference !== "object" || visited.has(reference)) return;
        visited.add(reference);
        const canonical = byId.get(reference.id);
        if (canonical && reference !== canonical) {
          for (const [key, value] of Object.entries(changes.get(reference.id) || {})) {
            if (
              ancestor &&
              (key === "partOf" || (key !== "background" && !Object.prototype.hasOwnProperty.call(reference, key)))
            )
              continue;
            if (value === undefined) delete reference[key];
            else Object.defineProperty(reference, key, { value, writable: true, enumerable: true, configurable: true });
          }
          // Featured sections embed immediate members, never their descendants.
          if (!ancestor && Array.isArray(reference.items)) reference.items = (canonical.items || []).map(snippet);
        }
        if (!ancestor) {
          for (const item of reference.items || []) refresh(item);
          for (const parent of reference.partOf || []) refresh(parent, true);
        }
      };
      for (const collection of Object.values(collections)) refresh(collection);
      for (const resource of Object.values(resources)) refresh(resource);
    } finally {
      await step.close?.(stepConfig);
    }
  }
  // Hydrate detached output copies: selecting both parent and child must not deepen either document.
  const members = {
    ...collectionItems,
    ...Object.fromEntries(Object.entries(collections).map(([slug, collection]) => [slug, collection.items || []])),
  };
  const canonical = { ...resources, ...collections };
  const hydrated = new Set(hydrate);
  for (const [slug, path] of paths) {
    const collection = hydrated.has(slug)
      ? {
          ...collections[slug],
          items: hydrateCollectionItems(collections[slug].items || [], canonical, members, false),
        }
      : collections[slug];
    await files.saveJson(path, collection);
    if (collectionItems) collectionItems[slug] = collection.items || [];
    if (siteMap?.[slug]) siteMap[slug].label = getValue(collection.label);
  }
  if (siteMap) await files.saveJson(join(buildDir, "meta/sitemap.json"), siteMap);
  await files.saveJson(
    join(buildDir, "meta/resources.json"),
    Object.fromEntries(Object.entries(resources).sort(([a], [b]) => a.localeCompare(b)))
  );
}
