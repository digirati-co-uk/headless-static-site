import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = async (path) => JSON.parse(await readFile(`dist/iiif/${path}`, "utf8"));
const rows = (await readFile("dist/iiif/meta/search/manifests.jsonl", "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const objects = rows.filter((row) => row.type === "Manifest");
assert.equal(objects.length, 16);
const featured = await read("featured/collection.json");
const sectionCounts = Object.fromEntries(
  featured.items.map((section) => [
    section["hss:slug"],
    objects.filter((row) => row.collectionSlugs.includes(section["hss:slug"])).length,
  ])
);
assert.deepEqual(Object.values(sectionCounts), [6, 4, 3, 3]);
for (const object of objects) {
  assert.equal(object.partOf[0]["hss:slug"], "featured");
  assert.equal(object.partOf.length, 3);
  const section = featured.items.find((section) => section["hss:slug"] === object.collectionSlugs[0]);
  assert.equal(object.background, section.background);
  const { topic_material, topic_objectType, ...record } = object;
  assert.deepEqual(record, (await read(`${object.slug}/search-record.json`)).record);
}
const geodesie = objects.find((row) => row.collectionSlugs.includes("collections/heritage/geodesie"));
assert.notEqual(geodesie.background, geodesie.partOf.at(-1).background);
const schema = await read("meta/search/manifests.schema.json");
assert.ok(schema.fields.some((field) => field.name === "collectionSlugs" && field.facet));
assert.ok(schema.fields.some((field) => field.name === "topic_material" && field.facet));
const key = (await readFile(".env.local", "utf8")).match(/VITE_TYPESENSE_SEARCH_KEY=(.+)/)[1];
const search = async (parameters) => {
  const response = await fetch(
    `http://localhost:18108/collections/delft-demo/documents/search?${new URLSearchParams({ q: "*", query_by: "label,plaintext", filter_by: "type:=Manifest", per_page: "50", ...parameters })}`,
    { headers: { "X-TYPESENSE-API-KEY": key } }
  );
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
const all = await search({ facet_by: "collectionSlugs,topic_material,topic_objectType" });
assert.equal(all.found, 16);
assert.ok(all.hits.every(({ document }) => document.background && document.partOf.length === 3));
const counts = all.facet_counts.find((facet) => facet.field_name === "collectionSlugs").counts;
for (const [slug, count] of Object.entries(sectionCounts))
  assert.equal(counts.find((item) => item.value === slug).count, count);
const selected = await search({
  filter_by: "type:=Manifest && collectionSlugs:=collections/heritage && topic_material:=glas",
});
assert.equal(
  selected.found,
  objects.filter((row) => row.collectionSlugs.includes("collections/heritage") && row.topic_material?.includes("glas"))
    .length
);
assert.ok(selected.found > 0);
assert.equal((await search({ q: "afstandsmeter" })).found, 1);
assert.equal((await search({ q: "zzzznonexistentzzzz", num_typos: "0", drop_tokens_threshold: "0" })).found, 0);
const forbidden = await fetch("http://localhost:18108/collections/delft-demo/documents", {
  method: "POST",
  headers: { "X-TYPESENSE-API-KEY": key, "Content-Type": "application/json" },
  body: JSON.stringify({ id: "must-not-write" }),
});
assert.equal(forbidden.status, 401, "Browser key must not allow writes");
console.log(
  "Verified 16 Delft objects: IIIF → finalized search records → CLI import → Typesense hits, facets, colours, labels, and search-only permissions."
);
