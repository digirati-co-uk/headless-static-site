import { describe, expect, test, vi } from "vitest";
import { IIIFMemoryStore } from "../../src/stores/iiif-memory.ts";

const api = (fetch = vi.fn()) =>
  ({
    storeId: "memory",
    requestCache: { fetch, didChange: async () => false, getKey: async () => null },
    getSlug: () => ["manifests/item", "test-slug"],
    files: {} as any,
    build: {} as any,
  }) as any;

describe("IIIFMemoryStore", () => {
  test("represents a supplied resource with an upstream URL as an override", async () => {
    const fetch = vi.fn();
    const upstream = "https://upstream.example/manifest";
    const [parsed] = await IIIFMemoryStore.parse(
      {
        type: "iiif-memory",
        inputs: [{ resource: { id: upstream, type: "Manifest", items: [] }, url: upstream }],
      },
      api(fetch)
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(parsed).toMatchObject({
      source: { type: "memory", index: 0, upstream },
      saveToDisk: true,
    });
  });

  test("invalidates cached content when caller identity or save policy changes", async () => {
    const resource = {
      type: "Manifest",
      slug: "manifests/item",
      path: "memory:0:item",
      storeId: "memory",
      source: { type: "memory", index: 0 },
      saveToDisk: true,
      inputKey: "current",
    } as any;
    const store = {
      type: "iiif-memory" as const,
      inputs: [{ resource: { id: "item", type: "Manifest", items: [] }, inputKey: "current" }],
    };
    const loaded = await IIIFMemoryStore.load(store, resource, "", api());

    await expect(IIIFMemoryStore.invalidate(store, resource, loaded["caches.json"])).resolves.toBe(false);
    await expect(
      IIIFMemoryStore.invalidate(store, { ...resource, inputKey: undefined }, loaded["caches.json"])
    ).resolves.toBe(true);
    await expect(
      IIIFMemoryStore.invalidate(store, { ...resource, saveToDisk: false }, loaded["caches.json"])
    ).resolves.toBe(true);
  });
});
