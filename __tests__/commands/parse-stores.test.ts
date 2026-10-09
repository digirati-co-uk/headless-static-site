import { describe, expect, test } from "vitest";
import { parseStores } from "../../src/commands/build-steps/0-parse-stores.ts";
import { loadStores } from "../../src/commands/build-steps/1-load-stores.ts";

function createFilesMock() {
  const jsonData = new Map<string, any>();
  return {
    async loadJson(path: string) {
      return jsonData.get(path) || {};
    },
    async mkdir(_path: string) {
      return;
    },
    async saveJson(path: string, data: any) {
      jsonData.set(path, data);
    },
  };
}

function createBuildConfig() {
  const files = createFilesMock();
  const storeType = {
    async parse(_storeConfig: any, { storeId }: { storeId: string }) {
      return [
        {
          type: "Manifest",
          path: `${storeId}/manifest.json`,
          slug: `manifests/${storeId}`,
          storeId,
          saveToDisk: true,
          source: {
            type: "remote",
            url: `https://example.org/${storeId}/manifest.json`,
          },
        },
      ];
    },
    async invalidate() {
      return true;
    },
    async load(_storeConfig: any, resource: any) {
      return {
        "resource.json": {
          id: `https://example.org/${resource.slug}`,
          type: resource.type,
          path: resource.path,
          slug: resource.slug,
          storeId: resource.storeId,
          saveToDisk: true,
          source: resource.source,
        },
        "vault.json": {},
        "meta.json": {},
        "caches.json": {},
        "indices.json": {},
      };
    },
  };

  return {
    config: {
      stores: {
        primary: {
          type: "iiif-json",
          path: "./content",
        },
      },
      generators: {
        generated: {},
      },
    },
    stores: ["primary"],
    options: {
      cache: false,
      ui: false,
    },
    requestCacheDir: "/tmp/iiif-request-cache",
    cacheDir: "/tmp/iiif-cache",
    storeTypes: {
      "iiif-json": storeType,
    },
    slugs: {},
    manifestRewrites: [],
    collectionRewrites: [],
    files,
    log: () => undefined,
    canvasExtractions: [],
    canvasEnrichment: [],
  };
}

describe("parseStores generated store handling", () => {
  test("derives generator stores without mutating build config", async () => {
    const buildConfig: any = createBuildConfig();

    const first = await parseStores(buildConfig, { storeRequestCaches: {} });
    const second = await parseStores(buildConfig, { storeRequestCaches: {} });

    expect(first.storeIds).toEqual(["primary", "generated"]);
    expect(first.storeConfigs.generated.type).toBe("iiif-json");
    expect(first.storeConfigs.generated.path.endsWith("/generated/build")).toBe(true);
    expect(second.storeIds.filter((storeId: string) => storeId === "generated")).toHaveLength(1);

    expect(buildConfig.stores).toEqual(["primary"]);
    expect(buildConfig.config.stores.generated).toBeUndefined();
  });

  test("loadStores can process derived generator stores", async () => {
    const buildConfig: any = createBuildConfig();
    const parsed = await parseStores(buildConfig, { storeRequestCaches: {} });
    const loaded = await loadStores(parsed, buildConfig);

    expect(loaded.allResources).toHaveLength(2);
    expect(loaded.allResources.map((resource) => resource.storeId).sort()).toEqual(["generated", "primary"]);
    expect(buildConfig.config.stores.generated).toBeUndefined();
  });

  test("publishes early resource estimates for remote store roots", async () => {
    const buildConfig: any = createBuildConfig();
    buildConfig.config.generators = undefined;
    buildConfig.config.stores = {
      remote: {
        type: "iiif-remote",
        urls: ["https://example.org/collections/a.json", "https://example.org/collections/b.json"],
      },
    };
    buildConfig.stores = ["remote"];
    buildConfig.storeTypes["iiif-remote"] = {
      async parse(_storeConfig: any, api: any) {
        api.reportEstimatedResources?.(3);
        return [];
      },
      async invalidate() {
        return true;
      },
      async load() {
        return null;
      },
    };

    const estimates: number[] = [];
    await parseStores(buildConfig, { storeRequestCaches: {} }, undefined, {
      onResourcesDiscovered({ total }) {
        estimates.push(total);
      },
    });

    expect(estimates.some((total) => total >= 2)).toBe(true);
    expect(estimates.some((total) => total >= 5)).toBe(true);
  });
});

test("bounded loading preserves source order and drains failures before returning", async () => {
  const config: any = createBuildConfig();
  config.concurrency = { load: 2 };
  config.config.generators = undefined;
  const type = config.storeTypes["iiif-json"];
  const original = type.load;
  let active = 0,
    maximum = 0,
    fail = false;
  type.load = async (...args: any[]) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, args[1].slug.endsWith("slow") ? 15 : 1));
      if (fail && args[1].slug.endsWith("fast")) throw new Error("load failed");
      return await original(...args);
    } finally {
      active--;
    }
  };
  const parsed: any = {
    storeResources: {
      primary: ["slow", "fast", "last"].map((slug) => ({
        type: "Manifest",
        slug: `manifests/${slug}`,
        path: slug,
        storeId: "primary",
        saveToDisk: true,
        source: { type: "remote", url: `https://example.org/${slug}` },
      })),
    },
  };
  const result = await loadStores(parsed, config);
  expect(maximum).toBe(2);
  expect(result.allResources.map((resource) => resource.slug)).toEqual([
    "manifests/slow",
    "manifests/fast",
    "manifests/last",
  ]);
  fail = true;
  await expect(loadStores(parsed, config)).rejects.toThrow("load failed");
  expect(active).toBe(0);
});

test("rejects collisions between different stores after rewrites", async () => {
  const config: any = createBuildConfig();
  config.config.generators = {};
  config.config.stores.secondary = { type: "iiif-json", path: "./other", validation: { strict: true } };
  config.stores.push("secondary");
  config.manifestRewrites = [{ rewrite: () => "manifests/shared" }];
  await expect(parseStores(config, { storeRequestCaches: {} })).rejects.toThrow("Conflicting resource slug");
  config.config.stores.primary.validation = { strict: true };
  config.config.stores.primary.type = "iiif-remote";
  config.config.stores.secondary.type = "iiif-remote";
  config.storeTypes["iiif-remote"] = config.storeTypes["iiif-json"];
  config.manifestRewrites = [{ rewrite: () => "../outside" }];
  await expect(parseStores(config, { storeRequestCaches: {} })).rejects.toThrow("Unsafe IIIF slug");
});

test.each(["primary", "secondary"])("strict collisions are independent of store order (%s)", async (strictId) => {
  const config: any = createBuildConfig();
  config.config.generators = {};
  config.config.stores.secondary = { type: "iiif-remote", url: "https://example.org/secondary" };
  config.config.stores.primary.type = "iiif-remote";
  config.storeTypes["iiif-remote"] = config.storeTypes["iiif-json"];
  config.stores.push("secondary");
  config.manifestRewrites = [{ rewrite: () => "manifests/shared" }];
  // Existing consumers retain first-wins behavior at load time.
  await expect(parseStores(config, { storeRequestCaches: {} })).resolves.toBeDefined();
  config.config.stores[strictId].validation = { strict: true };
  await expect(parseStores(config, { storeRequestCaches: {} })).rejects.toThrow("Conflicting resource slug");
});

test("cached loading refreshes upstream membership including removal of all children", async () => {
  const config: any = createBuildConfig();
  config.options.cache = true;
  config.config.generators = {};
  config.storeTypes["iiif-json"].invalidate = async () => false;
  const parsed = await parseStores(config, { storeRequestCaches: {} });
  const resource = parsed.storeResources.primary[0];
  resource.type = "Collection";
  await config.files.saveJson(`${config.cacheDir}/${resource.slug}/resource.json`, {
    ...resource,
    remoteChildren: ["old"],
  });
  for (const children of [["new"], []]) {
    resource.remoteChildren = children;
    const loaded = await loadStores(parsed, config);
    expect(loaded.allResources[0].remoteChildren).toEqual(children);
  }
});

test("validates containment after rewrites for every store without banning intermediate slugs", async () => {
  const config: any = createBuildConfig();
  config.config.generators = {};
  config.manifestRewrites = [{ rewrite: () => "../outside" }];
  await expect(parseStores(config, { storeRequestCaches: {} })).rejects.toThrow("Unsafe IIIF slug");
  config.manifestRewrites.push({ rewrite: () => "manifests/safe" });
  await expect(parseStores(config, { storeRequestCaches: {} })).resolves.toBeDefined();
});
