import { describe, expect, test, vi } from "vitest";
import { IIIFRemoteStore } from "../../src/stores/iiif-remote";
import { discoverCollectionChildren } from "../../src/stores/iiif-remote-discovery";
import { warmRemoteStores } from "../../src/commands/build-steps/-1-warm-remote";

const root = "https://example.org/root";
const page = "https://example.org/page";
const child = "https://example.org/child";
function api(documents: Record<string, any>) {
  return {
    storeId: "remote",
    files: {} as any,
    build: { log: vi.fn() } as any,
    getSlug: ({ id }: any) => [id.split("/").pop(), "default:example.org"] as const,
    requestCache: {
      fetch: vi.fn(async (url: string) => {
        if (!documents[url]) throw new Error("offline");
        return documents[url];
      }),
    },
  } as any;
}
function warm(store: any, requestCache: any) {
  return warmRemoteStores(
    {
      stores: ["remote"],
      config: { stores: { remote: store } },
      options: {},
      network: { concurrency: 2 },
      log: vi.fn(),
      requestCacheDir: "/unused",
    } as any,
    { storeRequestCaches: { remote: requestCache } }
  );
}

test("preserves url list precedence including an empty list and repeated parse calls", async () => {
  const context = api({ [root]: { id: root, type: "Manifest" }, [child]: { id: child, type: "Manifest" } });
  for (let i = 0; i < 2; i++) {
    const result = await IIIFRemoteStore.parse({ type: "iiif-remote", url: root, urls: [child] }, context);
    expect(result.map((r) => r.id)).toEqual([child]);
  }
  expect(await IIIFRemoteStore.parse({ type: "iiif-remote", url: root, urls: [] }, context)).toEqual([]);
  const warmed = await warm({ type: "iiif-remote", url: root, urls: [] }, context.requestCache);
  expect(warmed.urls).toBe(0);
  expect(context.requestCache.fetch.mock.calls.every(([url]: string[]) => url === child)).toBe(true);
});

test("default parsing remains permissive; strict parsing is explicit", async () => {
  const context = api({ [root]: { id: root, type: "Collection", next: { id: page } } });
  expect(await IIIFRemoteStore.parse({ type: "iiif-remote", url: root }, context)).toHaveLength(1);
  await expect(
    IIIFRemoteStore.parse({ type: "iiif-remote", url: root, validation: { strict: true } }, context)
  ).rejects.toThrow("Failed to load");
  context.requestCache.fetch.mockResolvedValue({ type: "Manifest" });
  expect(await IIIFRemoteStore.parse({ type: "iiif-remote", url: root }, context)).toEqual([]);
  await expect(
    IIIFRemoteStore.parse({ type: "iiif-remote", url: root, validation: { strict: true } }, context)
  ).rejects.toThrow("Invalid IIIF");
});

test("strict discovery can retain default slugs; project metadata has no policy effect", async () => {
  const context = api({ [root]: { id: root, type: "Manifest" } });
  expect(
    await IIIFRemoteStore.parse(
      { type: "iiif-remote", url: root, validation: { strict: true }, config: { foundry: { strictSlugs: true } } },
      context
    )
  ).toHaveLength(1);
  await expect(
    IIIFRemoteStore.parse({ type: "iiif-remote", url: root, validation: { requireSlugTemplate: true } }, context)
  ).rejects.toThrow("No configured slug rule");
});

test("canonical membership is ordered and unique across aliases, cycles and previously visited roots", async () => {
  const alias = "https://example.org/alias";
  const context = api({
    [root]: { id: root, type: "Collection", items: [{ id: child }, { id: alias }, { id: root }] },
    [child]: { id: child, type: "Manifest" },
    [alias]: { id: child, type: "Manifest" },
  });
  const result = await IIIFRemoteStore.parse({ type: "iiif-remote", urls: [child, root] }, context);
  expect(result.map((r) => r.id)).toEqual([child, root]);
  expect(result[1].remoteChildren).toEqual([child]);
});

describe.each(["parse", "warm"])("%s discovery budgets", (mode) => {
  async function run(store: any, context: any) {
    return mode === "parse" ? IIIFRemoteStore.parse(store, context) : warm(store, context.requestCache);
  }
  test("limits attempted resource URLs before fetching, even with cached data", async () => {
    const context = api({
      [root]: { id: root, type: "Collection", items: [{ id: child }] },
      [child]: { id: child, type: "Manifest" },
    });
    await expect(run({ type: "iiif-remote", url: root, discovery: { maxResources: 1 } }, context)).rejects.toThrow(
      "1 resource URLs"
    );
    expect(context.requestCache.fetch).toHaveBeenCalledTimes(1);
  });
  test("counts linked pages across all roots and does not count roots as pages", async () => {
    const second = "https://example.org/second";
    const context = api({
      [root]: { id: root, type: "Collection", next: { id: page } },
      [page]: { id: page, type: "CollectionPage", items: [] },
      [second]: { id: second, type: "Collection", next: { id: `${page}2` } },
    });
    await expect(
      run({ type: "iiif-remote", urls: [root, second], discovery: { maxCollectionPages: 1 } }, context)
    ).rejects.toThrow("1 collection pages");
    expect(context.requestCache.fetch).not.toHaveBeenCalledWith(`${page}2`);
  });
  test("limits children across pages before loading the children", async () => {
    const context = api({
      [root]: { id: root, type: "Collection", items: [{ id: child }], next: { id: page } },
      [page]: { id: page, type: "CollectionPage", items: [{ id: `${child}2` }] },
    });
    await expect(run({ type: "iiif-remote", url: root, discovery: { maxChildren: 1 } }, context)).rejects.toThrow(
      "1 children"
    );
    expect(context.requestCache.fetch).not.toHaveBeenCalledWith(child);
  });
});

test("discovery has no implicit cap and preserves the caller's page error callback", async () => {
  const resource = {
    id: root,
    type: "Collection",
    items: Array.from({ length: 10001 }, (_, i) => ({ id: `${child}/${i}` })),
  };
  expect(await discoverCollectionChildren(root, resource, vi.fn())).toHaveLength(10001);
  const onError = vi.fn();
  await discoverCollectionChildren(
    root,
    { next: { id: page } },
    async () => {
      throw new Error("offline");
    },
    onError
  );
  expect(onError).toHaveBeenCalledWith(page, expect.any(Error));
  await expect(discoverCollectionChildren(root, {}, vi.fn(), undefined, { strict: true })).rejects.toThrow(
    "Invalid IIIF"
  );
  await expect(discoverCollectionChildren(root, resource, vi.fn(), undefined, { maxChildren: -1 })).rejects.toThrow(
    "Invalid IIIF discovery limit"
  );
});
