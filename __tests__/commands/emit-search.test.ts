import { expect, test } from "vitest";
import { emitSearch } from "../../src/commands/build-steps/7-emit-search.ts";
import type { SearchIndexes } from "../../src/util/extract.ts";
import type { BuildConfig } from "../../src/commands/build.ts";

test("reprojects resource rows into every index while retaining canvas rows and topic facets", async () => {
  const old = { id: "shared", label: "Before" };
  const canvas = { id: "shared", label: "Canvas" };
  const indexes = Object.fromEntries(
    ["one", "two"].map((indexName) => [
      indexName,
      {
        indexName,
        schema: { fields: [] },
        keys: ["id", "featured"],
        allIndices: true,
        records: [old, canvas],
        remoteRecords: {},
      },
    ])
  ) as SearchIndexes;
  await emitSearch(
    new Map([
      [
        "resource",
        {
          search: { indexes: ["one", "two"], record: { id: "shared", featured: true } },
          indices: { subject: ["Art"] },
          indexedRecords: [old],
        },
      ],
    ]),
    indexes,
    {},
    { options: { emit: false }, search: {} } as BuildConfig
  );
  for (const index of Object.values(indexes))
    expect(index.records).toEqual([canvas, { id: "shared", featured: true, topic_subject: ["Art"] }]);
});
