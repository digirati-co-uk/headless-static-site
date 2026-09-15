import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
const root = new URL("./dist/iiif/", import.meta.url);
const read = async (slug) => JSON.parse(await readFile(new URL(`${slug}/collection.json`, root), "utf8"));
const slugs = (collection) => collection.items.map((item) => item["hss:slug"] || item.id);
const featured = await read("featured");
assert.deepEqual(
  slugs(featured),
  ["option-a", "option-b", "mixed", "cross-store", "automatic", "scripted", "legacy", "filtered"].map(
    (name) => `collections/${name}`
  )
);
const index = JSON.parse(await readFile(new URL("collection.json", root), "utf8"));
assert.deepEqual(slugs(index), ["featured", "manifests"]);
for (const item of featured.items) {
  const collection = await read(item["hss:slug"]);
  assert.ok(Object.values(collection.summary).flat().join(" ").length > 30);
  assert.deepEqual(item.summary, collection.summary);
  assert.equal(item["hss:totalItems"], collection.items.length);
  assert.deepEqual(slugs(item), slugs(collection), "Featured sections retain merged and enriched membership order");
  for (const card of item.items) {
    assert.equal(card.items, undefined, "Featured cards must not embed further descendants or canvases");
    if (card.type === "Collection" && card["hss:slug"]) {
      const child = await read(card["hss:slug"]);
      assert.deepEqual(card.summary, child.summary);
      assert.equal(card["hss:totalItems"], child.items.length);
    }
  }
  assert.equal(collection["hss:totalItems"], collection.items.length);
  assert.equal(new Set(collection.items.map((item) => item.id)).size, collection.items.length);
}
assert.deepEqual(
  slugs(await read("collections/option-a")),
  [1, 2, 3].map((i) => `collections/option-a/inner-collection-${i}`).concat("collections/option-a/objects")
);
assert.equal((await read("collections/option-a/objects")).items.length, 2);
assert.equal((await read("collections/option-a/inner-collection-1")).items.length, 0);
assert.equal((await read("collections/option-b")).items.length, 3);
for (let i = 1; i <= 3; i++) assert.equal((await read(`collections/option-b/inner-collection-${i}`)).items.length, 3);
assert.deepEqual(slugs(await read("collections/mixed")), [
  "manifests/map",
  "collections/mixed/nested",
  "collections/mixed/local",
]);
assert.deepEqual(slugs(await read("collections/cross-store")), [
  "manifests/instrument",
  "collections/option-b/inner-collection-2",
  "manifests/programmatic",
  "https://example.org/external/collection.json",
]);
assert.deepEqual((await read("collections/automatic/instruments")).label, { none: ["Scientific instruments"] });
assert.equal((await read("collections/automatic/instruments/optics")).items.length, 1);
assert.deepEqual(slugs(await read("collections/scripted")), ["manifests/instrument", "manifests/map"]);
assert.equal((await read("collections/legacy")).items.length, 1);
assert.equal((await read("collections/filtered/empty")).items.length, 0);
assert.ok(!(await readdir(new URL("collections/filtered/", root))).includes("drafts"));
// All internal references must resolve to emitted output; no virtual IDs may leak.
const walk = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) await walk(file);
    else if (entry.name === "collection.json") {
      const collection = JSON.parse(await readFile(file, "utf8"));
      for (const item of collection.items || []) {
        assert.ok(!item.id.startsWith("virtual://"));
        if (item["hss:slug"])
          await readFile(
            new URL(`${item["hss:slug"]}/${item.type === "Collection" ? "collection" : "manifest"}.json`, root)
          );
      }
    }
  }
};
await walk(root);
console.log(
  "Verified featured sections, bounded child cards and eight recipes: both client layouts, merges, scripts, namespaces, filters, legacy and cross-store references."
);
