const publicFields = [
  "id",
  "type",
  "label",
  "summary",
  "thumbnail",
  "behavior",
  "background",
  "metadata",
  "rights",
  "requiredStatement",
  "provider",
  "homepage",
  "navDate",
  "partOf",
  "hss:slug",
  "hss:totalItems",
];

/** Embed one level of collection members, leaving manifests and deeper collections as references. */
export function hydrateCollectionItems(
  items: any[],
  resources: Record<string, any>,
  collectionItems: Record<string, any[]>,
  deriveThumbnail = true
) {
  const byId = new Map(Object.entries(resources).map(([slug, resource]) => [resource.id, { slug, resource }]));
  const resolve = (item: any) =>
    byId.get(item.id) ||
    (Object.prototype.hasOwnProperty.call(resources, item["hss:slug"])
      ? { slug: item["hss:slug"], resource: resources[item["hss:slug"]] }
      : undefined);
  const reference = (item: any) => {
    const merged = { ...item, ...resolve(item)?.resource };
    return Object.fromEntries(
      publicFields.filter((field) => merged[field] !== undefined).map((field) => [field, merged[field]])
    );
  };
  return items.map((item) => {
    const section = reference(item);
    const canonical = resolve(item);
    const members =
      canonical && Object.prototype.hasOwnProperty.call(collectionItems, canonical.slug)
        ? collectionItems[canonical.slug]
        : undefined;
    if (section.type === "Collection" && members) {
      section.items = members.map(reference);
      section["hss:totalItems"] = members.length;
      if (deriveThumbnail) section.thumbnail ||= section.items.find((child: any) => child.thumbnail?.length)?.thumbnail;
    }
    return section;
  });
}
