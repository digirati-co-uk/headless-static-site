import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = async (path) => JSON.parse(await readFile(new URL(`./dist/iiif/${path}`, import.meta.url), "utf8"));
const featured = await read("featured/collection.json");
assert.deepEqual(
  featured.items.map((item) => item["hss:slug"]),
  ["collections/heritage", "collections/printed-works", "collections/images"]
);
assert.equal(featured["hss:totalItems"], 3);
assert.deepEqual(
  (await read("collection.json")).items.map((item) => item["hss:slug"]),
  ["featured", "manifests"]
);
for (const section of featured.items) {
  const canonical = await read(`${section["hss:slug"]}/collection.json`);
  assert.deepEqual(section.summary, canonical.summary);
  assert.equal(section.background, canonical.background);
  assert.deepEqual(section.partOf.map((parent) => parent["hss:slug"]), ["featured"]);
  assert.equal(section["hss:totalItems"], canonical.items.length);
  assert.ok(section.behavior.includes("hss:featured"));
  for (const card of section.items) {
    assert.equal(card.items, undefined, "Cards must not embed descendants or canvases");
    assert.ok(card.id && card.label);
  }
}
const heritage = featured.items[0];
assert.match(heritage.summary.en[0], /observatory/, "Enrichment must update the featured section");
assert.deepEqual(featured.items.map((item) => item.background), ["#f8d447", "#bad3f8", "#facba2"]);
assert.equal(heritage.items.find((item) => item["hss:slug"].endsWith("/astronomy")).background, "#d9c9f2");
assert.ok(heritage.items[0].metadata.length);
assert.ok(
  heritage.items.find((item) => item["hss:slug"].endsWith("/navigation")).thumbnail.length,
  "Thumbnail fallback"
);
const printed = featured.items[1];
const printedLabels = printed.items.map((item) => item.label.en[0]);
assert.deepEqual(printedLabels, [...printedLabels].sort(new Intl.Collator("en").compare));
assert.deepEqual(heritage.items.find((item) => item["hss:slug"].endsWith("/navigation")).partOf.map((parent) => parent["hss:slug"]), ["featured", "collections/heritage"]);
const images = featured.items[2];
assert.ok(images.items.some((item) => item.type === "Manifest"));
assert.ok(
  images.items.some((item) => item["hss:slug"] === "collections/images/details"),
  "Automatic folder without sidecar"
);
assert.ok(
  images.items.some((item) => !item.thumbnail),
  "Missing image fallback must be demonstrable"
);
console.log(
  "Featured homepage verified: selection, enrichment, metadata, backgrounds, counts, folders, thumbnails and bounded embedding."
);
