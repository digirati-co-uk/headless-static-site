import type { OutputFile, ResourceOutputDescriptor } from "../output-contract.ts";
import type { ActiveResourceJson } from "./store.ts";

function pick(paths: Set<string>, candidate: string) {
  return paths.has(candidate) ? candidate : undefined;
}

export async function createResourceOutputDescriptors(
  _outputRoot: string,
  resources: ActiveResourceJson[],
  inventory: OutputFile[],
  snippets: Record<string, any> = {}
) {
  const inventoryPaths = new Set(inventory.map(({ path }) => path));
  const descriptors: Record<string, ResourceOutputDescriptor> = {};

  const provenanceFor = (resource: ActiveResourceJson): ResourceOutputDescriptor["provenance"] => {
    if (resource.source.type === "remote") {
      return { type: "remote", url: resource.source.url };
    }
    if (resource.source.upstream) {
      return { type: "override", upstream: resource.source.upstream };
    }
    return { type: "local" };
  };

  for (const resource of resources) {
    const outputSlug = resource.slug.split("\\").join("/").replace(/^\/+/, "");
    const prefix = `${outputSlug}/`;
    const resourcePaths = [...inventoryPaths].filter((path) => path.startsWith(prefix));
    const iiif = pick(
      inventoryPaths,
      `${outputSlug}/${resource.type === "Manifest" ? "manifest.json" : "collection.json"}`
    );
    const meta = pick(inventoryPaths, `${outputSlug}/meta.json`);
    const indices = pick(inventoryPaths, `${outputSlug}/indices.json`);
    const canvasIndex = pick(inventoryPaths, `${outputSlug}/canvases/index.json`);
    const searchRecord = pick(inventoryPaths, `${outputSlug}/search-record.json`);
    const searchData = resourcePaths.filter((path) => path.endsWith(".search.jsonl")).sort();
    const named = new Set([iiif, meta, indices, canvasIndex, searchRecord, ...searchData].filter(Boolean));

    descriptors[resource.slug] = {
      "hss:slug": resource.slug,
      id: snippets[resource.slug]?.id || resource.id,
      type: resource.type as "Manifest" | "Collection",
      inputKey: resource.inputKey,
      origin: "source",
      provenance: provenanceFor(resource),
      saved: Boolean(iiif),
      files: {
        iiif,
        meta,
        indices,
        canvasIndex,
        searchRecord,
        searchData,
        extracted: resourcePaths.filter((path) => !named.has(path)).sort(),
      },
    };
  }

  const slugById = new Map(resources.map((resource) => [resource.id, resource.slug]));
  const slugByPath = new Map(resources.map((resource) => [resource.path, resource.slug]));
  for (const collectionResource of resources) {
    if (collectionResource.type !== "Collection") {
      continue;
    }
    try {
      const collection = collectionResource.vault?.getObject(collectionResource.id);
      const children: string[] = (collection?.items || [])
        .map((item: any) =>
          [item?.["hss:slug"], slugById.get(item?.id || item?.["@id"]), slugByPath.get(item?.path)].find(
            (slug) => typeof slug === "string" && Boolean(descriptors[slug])
          )
        )
        .filter((slug: unknown): slug is string => typeof slug === "string");
      if (children.length) {
        const uniqueChildren = [...new Set(children)].sort();
        const descriptor = descriptors[collectionResource.slug];
        descriptor.children = uniqueChildren;
        for (const child of uniqueChildren) {
          descriptors[child].parents = [
            ...new Set([...(descriptors[child].parents || []), descriptor["hss:slug"]]),
          ].sort();
        }
      }
    } catch {
      // A malformed source graph does not make otherwise valid output unusable.
    }
  }

  return Object.fromEntries(Object.entries(descriptors).sort(([a], [b]) => a.localeCompare(b)));
}
