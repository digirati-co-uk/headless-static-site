import { expect, test } from "vitest";
import { hydrateCollectionItems } from "../../src/util/hydrate-collection-items.ts";

test("hydration bounds cycles and shared children, retaining external refs and excluding manifest canvases", () => {
  const a = { id: "a", type: "Collection", label: { en: ["A"] }, background: "#f00" };
  const b = { id: "b", type: "Collection", label: { en: ["B"] } };
  const manifest = { id: "m", type: "Manifest", label: { en: ["M"] }, items: [{ id: "canvas", type: "Canvas" }] };
  const external = { id: "https://example.org/external", type: "Collection", label: { en: ["External"] } };
  const resources = { a, b, m: manifest };
  const members = { a: [b, manifest, external], b: [a] };
  const result = hydrateCollectionItems([a, b, manifest, external], resources, members);
  expect(result[0].items.map((item: any) => item.id)).toEqual(["b", "m", external.id]);
  expect(result[1].items[0]).toMatchObject({ id: "a", background: "#f00" });
  expect(result[0].items.every((item: any) => item.items === undefined)).toBe(true);
  expect(result[1].items[0].items).toBeUndefined();
  expect(result[2].items).toBeUndefined();
  expect(result[3]).toEqual(external);
  expect(manifest.items).toHaveLength(1);
});
