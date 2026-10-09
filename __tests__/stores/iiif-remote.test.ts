import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { IIIFRemoteStore } from "../../src/stores/iiif-remote";

describe("IIIFRemoteStore.parse", () => {
  test("follows paged collection links and returns all manifests", async () => {
    const rootUrl = "https://example.org/collection.json";
    const nextPageUrl = "https://example.org/collection/page/2.json";
    const manifestUrl1 = "https://example.org/manifest-1.json";
    const manifestUrl2 = "https://example.org/manifest-2.json";

    const responses: Record<string, any> = {
      [rootUrl]: {
        id: rootUrl,
        type: "Collection",
        items: [{ id: manifestUrl1, type: "Manifest" }],
        next: { id: nextPageUrl, type: "CollectionPage" },
      },
      [nextPageUrl]: {
        id: nextPageUrl,
        type: "CollectionPage",
        items: [{ id: manifestUrl2, type: "Manifest" }],
      },
      [manifestUrl1]: { id: manifestUrl1, type: "Manifest" },
      [manifestUrl2]: { id: manifestUrl2, type: "Manifest" },
    };

    const fetchMock = vi.fn(async (url: string) => responses[url]);

    const resources = await IIIFRemoteStore.parse(
      {
        type: "iiif-remote",
        url: rootUrl,
      },
      {
        storeId: "remote",
        requestCache: {
          fetch: fetchMock,
          didChange: async () => true,
          getKey: async () => null,
        },
        getSlug: ({ id, type }: { id: string; type: string }) => {
          const suffix = id.split("/").pop() || "resource";
          return [type === "Collection" ? `collections/${suffix}` : `manifests/${suffix}`, "test-slug"];
        },
        files: {} as any,
        build: {
          log: () => undefined,
        } as any,
      } as any
    );

    expect(resources).toHaveLength(3);
    expect(resources.filter((resource) => resource.type === "Collection")).toHaveLength(1);
    expect(resources.filter((resource) => resource.type === "Manifest")).toHaveLength(2);
    expect(resources.map((resource) => resource.path)).toEqual(expect.arrayContaining([manifestUrl1, manifestUrl2]));
  });

  test("deduplicates cyclic collections shared across roots and aliases", async () => {
    const root = "https://example.org/root",
      child = "https://example.org/child",
      alias = "https://example.org/alias";
    const documents: Record<string, any> = {
      [root]: { id: root, type: "Collection", items: [{ id: child, type: "Collection" }] },
      [child]: { id: child, type: "Collection", items: [{ id: root, type: "Collection" }] },
      [alias]: { id: root, type: "Collection", items: [] },
    };
    const fetch = vi.fn(async (url: string) => documents[url]);
    const api: any = {
      storeId: "remote",
      requestCache: { fetch },
      getSlug: ({ id, type }: any) => [`${type.toLowerCase()}s/${id.split("/").pop()}`, "test"],
      files: {},
      build: { log: () => {} },
    };
    const result = await IIIFRemoteStore.parse({ type: "iiif-remote", urls: [root, child, alias] }, api);
    expect(result.map((resource) => resource.path)).toEqual([root, child]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  test("fails missing identifiers and unavailable collection pages", async () => {
    const api: any = {
      storeId: "remote",
      requestCache: { fetch: vi.fn(async () => ({ type: "Manifest" })) },
      getSlug: () => ["manifests/id", "test"],
      files: {},
      build: { log: () => {} },
    };
    await expect(
      IIIFRemoteStore.parse(
        { type: "iiif-remote", url: "https://example.org/invalid", validation: { strict: true } },
        api
      )
    ).rejects.toThrow("Invalid IIIF");
    const root = "https://example.org/root";
    const next: any = {
      ...api,
      requestCache: {
        fetch: vi
          .fn()
          .mockResolvedValueOnce({
            id: root,
            type: "Collection",
            next: { id: "https://example.org/page", type: "CollectionPage" },
          })
          .mockRejectedValueOnce(new Error("offline")),
      },
    };

    await expect(
      IIIFRemoteStore.parse({ type: "iiif-remote", url: root, validation: { strict: true } }, next)
    ).rejects.toThrow("Failed to load IIIF collection page");
  });

  test("fails opted-in builds when upstream additions have no configured slug rule", async () => {
    const api: any = {
      storeId: "remote",
      requestCache: { fetch: async () => ({ id: "https://new.example/item", type: "Manifest" }) },
      getSlug: () => ["item", "default:new.example"],
      files: {},
      build: { log: () => {} },
    };
    await expect(
      IIIFRemoteStore.parse(
        { type: "iiif-remote", url: "https://new.example/item", validation: { requireSlugTemplate: true } },
        api
      )
    ).rejects.toThrow("No configured slug rule");
  });

  test("retains the upstream URL when a local override exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "iiif-hss-override-"));
    try {
      const upstream = "https://upstream.example/manifest.json";
      const overrides = join(directory, "overrides");
      await mkdir(overrides, { recursive: true });
      const override = join(overrides, "manifest.json.json");
      await writeFile(override, JSON.stringify({ id: upstream, type: "Manifest", items: [] }));
      const resources = await IIIFRemoteStore.parse({ type: "iiif-remote", url: upstream, overrides }, {
        storeId: "remote",
        requestCache: {
          fetch: async () => ({ id: upstream, type: "Manifest", items: [] }),
          didChange: async () => true,
          getKey: async () => null,
        },
        getSlug: () => ["manifests/manifest.json", "test-slug"],
        files: {} as any,
        build: { log: () => undefined } as any,
      } as any);

      expect(resources[0].source).toEqual({
        type: "disk",
        path: override,
        alias: "manifests/manifest.json",
        filePath: override,
        upstream,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("checks override containment before reading a pre-rewrite slug", async () => {
  await expect(
    IIIFRemoteStore.parse({ type: "iiif-remote", url: "https://example.org/root", overrides: "/tmp/overrides" }, {
      requestCache: { fetch: async () => ({ id: "https://example.org/root", type: "Manifest" }) },
      getSlug: () => ["../../outside", "test"],
    } as any)
  ).rejects.toThrow("override escapes");
});
