import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OutputFile, ResourceOutputDescriptor } from "../output-contract.ts";
import type { ActiveResourceJson } from "./store.ts";

function pick(paths: Set<string>, candidate: string) {
  return paths.has(candidate) ? candidate : undefined;
}

export async function createResourceOutputDescriptors(
  outputRoot: string,
  resources: ActiveResourceJson[],
  inventory: OutputFile[],
  snippets: Record<string, any> = {}
) {
  const inventoryPaths = new Set(inventory.map(({ path }) => path));
  const descriptors: Record<string, ResourceOutputDescriptor> = {};

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

  const descriptorSlugs = new Set(Object.keys(descriptors));
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.files.iiif || descriptor.type !== "Collection") {
      continue;
    }
    try {
      const collection = JSON.parse(await readFile(join(outputRoot, descriptor.files.iiif), "utf8"));
      const children: string[] = (collection.items || [])
        .map((item: any) => item?.["hss:slug"])
        .filter((slug: unknown): slug is string => typeof slug === "string" && descriptorSlugs.has(slug));
      if (children.length) {
        const uniqueChildren = [...new Set(children)].sort();
        descriptor.children = uniqueChildren;
        for (const child of uniqueChildren) {
          descriptors[child].parents = [
            ...new Set([...(descriptors[child].parents || []), descriptor["hss:slug"]]),
          ].sort();
        }
      }
    } catch {
      // The inventory validator reports unreadable files; relationships are optional.
    }
  }

  return Object.fromEntries(Object.entries(descriptors).sort(([a], [b]) => a.localeCompare(b)));
}
