import { join } from "node:path";
import type { BuildConfig } from "../commands/build.ts";
import type { SearchIndexes, SearchRecordReturn } from "./extract.ts";
import type { ActiveResourceJson } from "./store.ts";

export type ResourceSearchRecords = Map<
  string,
  {
    search: Partial<SearchRecordReturn>;
    indices: Record<string, string[]>;
    indexedRecords: Record<string, any>[];
  }
>;

export function projectSearchRecord(
  record: Record<string, any>,
  index: SearchIndexes[string],
  indices: Record<string, string[]>
) {
  const projected = Object.fromEntries(Object.entries(record).filter(([key]) => index.keys.includes(key)));
  for (const key of index.allIndices ? Object.keys(indices) : index.indices || []) {
    if (indices[key]) projected[`topic_${key}`] = indices[key];
  }
  return projected;
}

/** Cache data is an extraction baseline; finalizers only edit detached output copies. */
export async function loadResourceSearchRecords(
  resources: ActiveResourceJson[],
  { files, cacheDir }: BuildConfig,
  records: ResourceSearchRecords = new Map()
) {
  for (const resource of resources) {
    if (records.has(resource.slug)) continue;
    const path = join(cacheDir, resource.slug, "search-record.json");
    if (!files.exists(path)) continue;
    records.set(resource.slug, {
      search: structuredClone(await files.loadJson(path)),
      indices: await files.loadJson(join(cacheDir, resource.slug, "indices.json")),
      indexedRecords: [],
    });
  }
  return records;
}
