import { expect, test } from "vitest";
import { collectionThumbnail } from "../../src/finalize/collection-thumbnail.ts";
import { collectionItemOrder } from "../../src/finalize/collection-item-order.ts";
import type { CollectionFinalizerApi, FinalCollection } from "../../src/util/finalize-collection.ts";

const collection = (id: string, items: any[] = []): FinalCollection => ({
  id,
  type: "Collection",
  label: { en: [id] },
  items,
});

test("thumbnail resolution handles deep graphs, shared children, cycles with exits and missing remote bodies", async () => {
  const collections: Record<string, FinalCollection> = {
    a: collection("a", [{ id: "b" }, { id: "image", thumbnail: "https://example.org/image.jpg" }]),
    b: collection("b", [{ id: "a" }]),
    empty: collection("empty", [{ id: "empty" }, { id: "https://example.org/remote" }]),
    shared: collection("shared", [{ id: "b" }]),
    explicit: { ...collection("explicit"), thumbnail: "https://example.org/explicit.jpg" } as any,
    legacy: collection("legacy", [
      { id: "external", thumbnail: { "@id": "https://example.org/legacy.jpg", width: 50 } },
    ]),
  };
  for (let i = 0; i < 12000; i++)
    collections[`deep-${i}`] = collection(`deep-${i}`, [{ id: i === 11999 ? "a" : `deep-${i + 1}` }]);
  const api = { collections, config: { stores: {} } };
  const resolved = await collectionThumbnail.configure!(api, {});
  for (const [slug, resource] of Object.entries(collections))
    await collectionThumbnail.handler(resource, { ...api, slug }, resolved);
  for (const slug of ["a", "b", "shared", "deep-0"])
    expect(collections[slug].thumbnail).toEqual([{ id: "https://example.org/image.jpg", type: "Image" }]);
  expect(collections.empty.thumbnail).toBeUndefined();
  expect(collections.explicit.thumbnail).toEqual([{ id: "https://example.org/explicit.jpg", type: "Image" }]);
  expect(collections.legacy.thumbnail?.[0]).toMatchObject({ id: "https://example.org/legacy.jpg", width: 50 });
});

test("label/source rules are stable, preserve is untouched, and invalid configuration fails", async () => {
  const items = [
    { id: "b", "hss:slug": "b", label: { en: ["First"], fr: ["Zulu"] } },
    { id: "a", "hss:slug": "a", label: { en: ["Last"], fr: ["Alpha"] } },
    { id: "c", "hss:slug": "c", label: { fr: ["Alpha"] } },
  ];
  const api: CollectionFinalizerApi = {
    collections: { target: collection("target", items) },
    config: { stores: {} },
    sourceOrder: new Map([
      ["b", 0],
      ["a", 1],
    ]),
    orderPolicies: new Map([["target", "preserve"]]),
  };
  const run = async (mode: "label" | "source" | "preserve") => {
    const config = await collectionItemOrder.configure!(api, { language: "fr", byCollection: { target: mode } });
    await collectionItemOrder.handler(api.collections.target, { ...api, slug: "target" }, config);
    return api.collections.target.items.map((item) => item.id);
  };
  expect(await run("preserve")).toEqual(["b", "a", "c"]);
  expect(await run("label")).toEqual(["a", "c", "b"]);
  expect(await run("source")).toEqual(["b", "a", "c"]);
  expect(() => collectionItemOrder.configure!(api, { byCollection: { missing: "label" } })).toThrow(
    /Unknown collection/
  );
  expect(() => collectionItemOrder.configure!(api, { byCollection: { target: "random" as any } })).toThrow(
    /Invalid collection order/
  );
});
