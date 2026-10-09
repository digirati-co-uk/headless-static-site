import { join } from "node:path";
import type { BuildConfig } from "../build.ts";
import type { SearchIndexes } from "../../util/extract.ts";
import { projectSearchRecord, type ResourceSearchRecords } from "../../util/resource-search-records.ts";

export async function emitSearch(
  records: ResourceSearchRecords,
  searchIndexes: SearchIndexes | undefined,
  allIndices: Record<string, string[]> | undefined,
  { files, buildDir, options, search }: BuildConfig
) {
  // Replace only resource contributions; canvas records retain their existing ownership.
  const previous = new Set([...records.values()].flatMap((entry) => entry.indexedRecords));
  for (const index of Object.values(searchIndexes || {}))
    index.records = index.records.filter((record) => !previous.has(record));
  for (const [slug, entry] of records) {
    for (const name of entry.search.indexes || []) {
      const index = searchIndexes?.[name];
      if (!index || !entry.search.record) continue;
      const projected = projectSearchRecord(entry.search.record, index, entry.indices);
      if (Object.keys(projected).length) index.records.push(projected);
    }
    if (options.emit && search.emitRecord)
      await files.saveJson(join(buildDir, slug, "search-record.json"), entry.search);
  }
  if (!options.emit || options.exact || options.stores?.length) return;
  const writeJson = (path: string, value: any) => files.saveJson(path, value);
  // Search indexes.
  if (searchIndexes) {
    const searchRoot = join(buildDir, "meta/search");
    await files.mkdir(searchRoot);

    const indexes = Object.keys(searchIndexes).sort();
    const allIndiciesKeys = Object.keys(allIndices || {}).sort();
    for (const index of indexes) {
      const searchIndex = searchIndexes[index];
      const schema = join(searchRoot, `${index}.schema.json`);
      const data = join(searchRoot, `${index}.jsonl`);
      const mapping = join(searchRoot, `${index}.mapping.json`);
      const indiciesToAddToIndex = searchIndex.allIndices ? allIndiciesKeys : searchIndex.indices || [];

      // Need to add dynamic indices.
      for (const indicesToAdd of indiciesToAddToIndex) {
        if (allIndices?.[indicesToAdd]) {
          searchIndex.schema.fields.push({
            name: `topic_${indicesToAdd}`,
            type: "string[]",
            facet: true,
            optional: true,
          });
        }
      }

      await writeJson(schema, {
        name: index,
        ...searchIndex.schema,
      });
      if (searchIndex.emitCombined !== false) {
        await files.writeFile(
          data,
          [...searchIndex.records]
            .sort((a, b) => String(a.slug || a.id || "").localeCompare(String(b.slug || b.id || "")))
            .map((record) => JSON.stringify(record))
            .join("\n")
        );
      }
      await writeJson(mapping, {
        name: index,
        format: "record-jsonl",
        scope: "resource",
        idStrategy: "resource-id",
        schema: `meta/search/${index}.schema.json`,
        data: searchIndex.emitCombined === false ? undefined : `meta/search/${index}.jsonl`,
        facets: searchIndex.schema.fields.filter((field) => field.facet).map((field) => field.name),
        canvasRegistry: "meta/canvas-search-index.json",
      });
    }
  }
}
