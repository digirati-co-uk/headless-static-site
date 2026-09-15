import { Vault } from "@iiif/helpers";
import { expect, test } from "vitest";
import { extractSearchRecord } from "../../src/extract/extract-search-record.ts";

test("reads descriptive values without reactive traversal and keeps current metadata", async () => {
  const id = "https://example.org/manifest";
  const vault = new Vault();
  await vault.load(id, {
    id, type: "Manifest", label: { en: ["Object"] }, summary: { en: ["Description"] },
    metadata: [{ label: { en: ["Material"] }, value: { en: ["Wood", "Metal"] } }], items: [],
  });
  const resource = { id, vault, type: "Manifest", slug: "manifests/object" } as any;
  const meta = { thumbnail: { id: "https://example.org/thumb" }, url: "/object", totalItems: 3,
    partOfCollections: [{ slug: "collections/new" }] };
  const api = { resource: vault.getObject(id), meta: { value: Promise.resolve(meta) } } as any;
  const reference = await extractSearchRecord.handler({ ...resource, vault: undefined }, api, {});
  const result = await extractSearchRecord.handler(resource, {
    ...api, get resource() { throw new Error("Should not traverse reactive resources"); },
  }, {});
  expect(result.search).toEqual(reference.search);
  expect(result.search?.record).toMatchObject({
    label: "Object", summary: "Description", plaintext: "Wood\nMetal", collections: ["collections/new"],
    thumbnail: meta.thumbnail.id, totalItems: 3,
  });
  const minimal = await extractSearchRecord.handler({ ...resource, vault: undefined }, {
    resource: { label: { en: ["Empty"] } }, meta: { value: Promise.resolve({}) },
  } as any, {});
  expect(minimal.search?.record.plaintext).toBe("");
});
