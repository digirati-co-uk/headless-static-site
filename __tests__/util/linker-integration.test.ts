import fs from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { enrich, extract, linker } from "../../lib/scripts.js";
import { build, defaultBuiltIns } from "../../src/commands/build.ts";
import { validateBuildOutput } from "../../src/output-validation.ts";
import { FileHandler } from "../../src/util/file-handler.ts";
import type { HssBuildEvent } from "../../src/util/build-progress.ts";

describe("linker integration", () => {
  const originalCwd = cwd();
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "iiif-hss-linker-"));
    chdir(testDir);
    (global as any).__hss = undefined;
    await mkdir(join(testDir, "content"), { recursive: true });
    await writeFile(
      join(testDir, "content", "demo.json"),
      JSON.stringify(
        {
          id: "https://example.org/iiif/demo/manifest",
          type: "Manifest",
          label: { en: ["Demo"] },
          items: [],
        },
        null,
        2
      )
    );
  });

  afterEach(async () => {
    (global as any).__hss = undefined;
    chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true });
  });

  test("finishes asynchronous metadata injections before enrichment and emission", async () => {
    extract(
      {
        id: "delayed-inject",
        types: ["Manifest"],
        collect: async (temp: any) => ({ temp }),
        injectManifest: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { meta: {
            partOfCollections: [{ slug: "collections/demo" }],
            thumbnail: { id: "https://example.org/thumb.jpg" },
          } };
        },
      },
      async () => ({ temp: {} })
    );
    let observed: any;
    enrich({ id: "observe-injection", types: ["Manifest"] }, async (_resource: any, api: any) => {
      observed = structuredClone(await api.meta.value);
      return {};
    });
    const output = await build(
      { emit: true, cache: false, ui: false },
      defaultBuiltIns,
      { customConfig: {
        run: ["delayed-inject", "extract-search-record", "observe-injection"],
        stores: { local: { type: "iiif-json", path: "./content", pattern: "**/*.json" } },
        server: { url: "https://example.org/iiif" },
        search: { indexNames: ["manifests"] },
      }, fileHandler: new FileHandler(fs as any, testDir, false) }
    );
    expect(observed.partOfCollections).toEqual([{ slug: "collections/demo" }]);
    expect(observed.thumbnail.id).toBe("https://example.org/thumb.jpg");
    expect(observed.searchTime).toBeGreaterThanOrEqual(0);
    const slug = output.stores.allResources[0].slug;
    const search = JSON.parse(await readFile(join(testDir, ".iiif/build", slug, "search-record.json"), "utf8"));
    expect(search.record.collections).toEqual(["collections/demo"]);
    expect(search.record.thumbnail).toBe("https://example.org/thumb.jpg");
  });

  test("linker can write files and merge meta before extraction/enrichment", async () => {
    linker(
      {
        id: "demo-linker",
        name: "Demo linker",
        types: ["Manifest"],
      },
      async (resource, api) => {
        await api.resourceFiles.writeFile("linked/source.txt", "raw-linked-data");
        api.trackFile("./content/demo.json");
        return {
          meta: {
            linkedBy: "demo-linker",
            resourceId: resource.id,
          },
        };
      }
    );

    const customConfig = {
      run: ["demo-linker"],
      stores: {
        local: {
          type: "iiif-json" as const,
          path: "./content",
          pattern: "**/*.json",
        },
      },
      server: {
        url: "http://localhost:7111",
      },
    };

    const output = await build(
      {
        emit: true,
        cache: false,
        debug: false,
        ui: false,
      },
      defaultBuiltIns,
      {
        customConfig,
        fileHandler: new FileHandler(fs as any, testDir, false),
      }
    );

    expect(output.linked?.stats?.linked).toBe(1);
    const linkedResource = output.stores.allResources[0];
    expect(linkedResource?.slug).toBeDefined();

    const slug = linkedResource.slug;
    const metaPath = join(testDir, ".iiif/cache", slug, "meta.json");
    const linkedPath = join(testDir, ".iiif/cache", slug, "files", "linked", "source.txt");
    const linkerCachePath = join(testDir, ".iiif/cache", "_linkers", "demo-linker.json");

    const meta = JSON.parse(await readFile(metaPath, "utf-8"));
    const linkedContent = await readFile(linkedPath, "utf-8");
    const linkerCache = JSON.parse(await readFile(linkerCachePath, "utf-8"));

    expect(meta.linkedBy).toBe("demo-linker");
    expect(meta.resourceId).toBe("https://example.org/iiif/demo/manifest");
    expect(linkedContent).toBe("raw-linked-data");
    expect(linkerCache.resources[slug]).toBeDefined();
    const inventory = JSON.parse(await readFile(join(testDir, ".iiif/build/meta/build.json"), "utf8")).files;
    expect(inventory.map((file: any) => file.path)).toEqual(
      inventory.map((file: any) => file.path).sort((a: string, b: string) => a.localeCompare(b))
    );
    expect(inventory.filter((file: any) => file.path === "meta/resource-descriptors.json")).toHaveLength(1);
    for (const file of inventory) {
      const bytes = await readFile(join(testDir, ".iiif/build", file.path));
      expect(file.bytes).toBe(bytes.byteLength);
      expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  test("linker prepare can map raw data to manifest before per-resource handler", async () => {
    await mkdir(join(testDir, "raw"), { recursive: true });
    await writeFile(
      join(testDir, "raw", "annotations.json"),
      JSON.stringify(
        {
          manifest: "https://example.org/iiif/demo/manifest",
          annotationIds: ["anno-1", "anno-2"],
        },
        null,
        2
      )
    );

    linker(
      {
        id: "prepare-linker",
        name: "Prepare linker",
        types: ["Manifest"],
        prepare: async (api) => {
          api.trackFile("./raw/annotations.json");
          const raw = JSON.parse(await readFile(join(testDir, "raw", "annotations.json"), "utf-8"));
          return {
            byResourceId: {
              [raw.manifest]: raw,
            },
          };
        },
      },
      async (_resource, api) => {
        if (!api.prepared) {
          return {};
        }
        await api.resourceFiles.writeFile("linked/prepare.json", JSON.stringify(api.prepared, null, 2));
        return {
          meta: {
            preparedAnnotations: api.prepared.annotationIds.length,
          },
        };
      }
    );

    const customConfig = {
      run: ["prepare-linker"],
      stores: {
        local: {
          type: "iiif-json" as const,
          path: "./content",
          pattern: "**/*.json",
        },
      },
      server: {
        url: "http://localhost:7111",
      },
    };

    const output = await build(
      {
        emit: true,
        cache: false,
        debug: false,
        ui: false,
      },
      defaultBuiltIns,
      {
        customConfig,
        fileHandler: new FileHandler(fs as any, testDir, false),
      }
    );

    expect(output.linked?.stats?.linked).toBe(1);
    const slug = output.stores.allResources[0].slug;
    const preparedPath = join(testDir, ".iiif/cache", slug, "files", "linked", "prepare.json");
    const metaPath = join(testDir, ".iiif/cache", slug, "meta.json");

    const prepared = JSON.parse(await readFile(preparedPath, "utf-8"));
    const meta = JSON.parse(await readFile(metaPath, "utf-8"));

    expect(prepared.annotationIds).toEqual(["anno-1", "anno-2"]);
    expect(meta.preparedAnnotations).toBe(2);
  });

  test("linker cache skips unchanged tracked inputs", async () => {
    linker(
      {
        id: "demo-linker",
        name: "Demo linker",
        types: ["Manifest"],
      },
      async (_resource, api) => {
        api.trackFile("./content/demo.json");
        return {
          meta: {
            linkedBy: "demo-linker",
          },
        };
      }
    );

    const customConfig = {
      run: ["demo-linker"],
      stores: {
        local: {
          type: "iiif-json" as const,
          path: "./content",
          pattern: "**/*.json",
        },
      },
      server: {
        url: "http://localhost:7111",
      },
    };

    const first = await build(
      {
        emit: true,
        cache: true,
        debug: false,
        ui: false,
      },
      defaultBuiltIns,
      {
        customConfig,
        fileHandler: new FileHandler(fs as any, testDir, false),
      }
    );

    const second = await build(
      {
        emit: true,
        cache: true,
        debug: false,
        ui: false,
      },
      defaultBuiltIns,
      {
        customConfig,
        fileHandler: new FileHandler(fs as any, testDir, false),
      }
    );

    expect(first.linked?.stats?.linked).toBe(1);
    expect(second.linked?.stats?.linked).toBe(0);
    expect(second.linked?.stats?.cacheHit).toBe(1);
  });

  test("full builds remove stale output", async () => {
    const stalePath = join(testDir, ".iiif", "build", "removed", "manifest.json");
    await mkdir(join(testDir, ".iiif", "build", "removed"), { recursive: true });
    await writeFile(stalePath, "stale");

    const output = await build({ emit: true, cache: false, debug: false, ui: false }, defaultBuiltIns, {
      customConfig: {
        stores: {
          local: {
            type: "iiif-json",
            path: "./content",
            pattern: "**/*.json",
            inputKeys: { "demo.json": "site-resource-1" },
          },
        },
        server: { url: "http://localhost:7111" },
      },
      fileHandler: new FileHandler(fs as any, testDir, false),
    });

    await expect(readFile(stalePath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    const buildManifest = JSON.parse(await readFile(join(testDir, ".iiif", "build", "meta", "build.json"), "utf-8"));
    expect(buildManifest).toMatchObject({
      formatVersion: 1,
      contractVersion: "1.2",
      mode: "full",
      canonicalBaseUrl: "http://localhost:7111",
      resources: { manifests: 1, canvases: 0 },
      entrypoints: {
        rootCollection: "collection.json",
        resources: "meta/resources.json",
        resourceDescriptors: "meta/resource-descriptors.json",
      },
    });
    expect(output.result).toMatchObject({
      resultVersion: 1,
      status: "complete",
      manifestPath: "meta/build.json",
      manifest: buildManifest,
    });
    await expect(validateBuildOutput(join(testDir, ".iiif", "build"), { sha256: true })).resolves.toMatchObject({
      status: "complete",
    });
    const descriptors = JSON.parse(
      await readFile(join(testDir, ".iiif", "build", "meta", "resource-descriptors.json"), "utf-8")
    );
    const outputSlug = output.stores.allResources[0].slug.replace(/^\/+/, "");
    expect(descriptors[output.stores.allResources[0].slug]).toMatchObject({
      inputKey: "site-resource-1",
      origin: "source",
      provenance: { type: "local" },
      saved: true,
      files: {
        iiif: `${outputSlug}/manifest.json`,
        meta: `${outputSlug}/meta.json`,
        indices: `${outputSlug}/indices.json`,
      },
    });
    expect(buildManifest.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "meta/sitemap.json", sha256: expect.any(String) })])
    );
    expect(buildManifest.files.some((file: any) => file.path === "meta/build.json")).toBe(false);
    const manifestsCollection = JSON.parse(
      await readFile(join(testDir, ".iiif", "build", "manifests", "collection.json"), "utf-8")
    );
    expect(manifestsCollection["hss:totalItems"]).toBe(1);
    const navigationCollection = JSON.parse(
      await readFile(join(testDir, ".iiif", "build", "collections", "collection.json"), "utf-8")
    );
    expect(navigationCollection.items.map((item: any) => item["hss:slug"])).toEqual(["collections/stores", "topics"]);
    const sitemap = JSON.parse(await readFile(join(testDir, ".iiif", "build", "meta", "sitemap.json"), "utf-8"));
    expect(Object.values(sitemap)[0]).not.toHaveProperty("source");
    await expect(readFile(join(testDir, ".iiif", "build", "config", "stores.json"), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(testDir, ".iiif", "build", output.stores.allResources[0].slug, "canvases", "index.json"), "utf-8")
    ).rejects.toMatchObject({ code: "ENOENT" });

    const metaPath = join(testDir, ".iiif", "build", outputSlug, "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    meta["hss:runtime"].source.path = "/Users/private/content";
    const unsafeMeta = JSON.stringify(meta, null, 2);
    await writeFile(metaPath, unsafeMeta);
    buildManifest.files.find((item: any) => item.path === `${outputSlug}/meta.json`).bytes = Buffer.byteLength(unsafeMeta);
    await writeFile(join(testDir, ".iiif", "build", "meta", "build.json"), JSON.stringify(buildManifest, null, 2));
    await expect(validateBuildOutput(join(testDir, ".iiif", "build"))).rejects.toMatchObject({
      file: `${outputSlug}/meta.json`,
      field: "hss:runtime.source",
    });
  });

  test("canvas indexes can be enabled", async () => {
    const output = await build({ emit: true, cache: false, debug: false, ui: false }, defaultBuiltIns, {
      customConfig: {
        stores: { local: { type: "iiif-json", path: "./content", pattern: "**/*.json" } },
        server: { url: "http://localhost:7111" },
        output: { includeCanvasIndex: true },
      },
      fileHandler: new FileHandler(fs as any, testDir, false),
    });

    expect(
      JSON.parse(
        await readFile(
          join(testDir, ".iiif", "build", output.stores.allResources[0].slug, "canvases", "index.json"),
          "utf-8"
        )
      )
    ).toEqual([]);
  });

  test("programmatic inputs use injected fetch and emit awaited structured events", async () => {
    const remoteUrl = "https://example.org/remote/manifest.json";
    const request = async (url: string | URL | Request) => {
      expect(String(url)).toBe(remoteUrl);
      return new Response(JSON.stringify({ id: "https://example.org/remote/manifest", type: "Manifest", items: [] }), {
        headers: { "content-type": "application/json" },
      });
    };
    const events: HssBuildEvent[] = [];
    let handlingEvent = false;
    const output = await build(
      { emit: true, cache: false, networkCache: false, debug: false, ui: false },
      defaultBuiltIns,
      {
        customConfig: {
          stores: {
            supplied: {
              type: "iiif-memory",
              inputs: [
                {
                  resource: { id: "https://example.org/local/manifest", type: "Manifest", items: [] },
                  inputKey: "local-1",
                },
                { url: remoteUrl, inputKey: "remote-1", saveToDisk: false },
              ],
            },
          },
          server: { url: "https://site.example" },
        },
        fetch: request as typeof fetch,
        fileHandler: new FileHandler(fs as any, testDir, false),
        async onEvent(event) {
          expect(handlingEvent).toBe(false);
          handlingEvent = true;
          await Promise.resolve();
          events.push(event);
          handlingEvent = false;
        },
      }
    );

    expect(events[0]?.type).toBe("build-started");
    expect(events.at(-1)).toMatchObject({ type: "build-completed", result: output.result });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "phase-started", phase: "parse-stores" }),
        expect.objectContaining({ type: "phase-completed", phase: "save-files" }),
        expect.objectContaining({ type: "resource-progress", processed: 2, total: 2 }),
      ])
    );
    const descriptors = JSON.parse(
      await readFile(join(testDir, ".iiif", "build", "meta", "resource-descriptors.json"), "utf8")
    );
    expect(Object.values(descriptors).map((descriptor: any) => descriptor.inputKey)).toEqual(["local-1", "remote-1"]);
    expect(Object.values(descriptors).map((descriptor: any) => descriptor.saved)).toEqual([true, false]);
  });

  test("cached programmatic inputs refresh and persist caller policy", async () => {
    const resource = { id: "https://example.org/cached/manifest", type: "Manifest", items: [] };
    const fileHandler = new FileHandler(fs as any, testDir, false);
    const configFor = (input: Record<string, any>) => ({
      stores: { supplied: { type: "iiif-memory" as const, inputs: [{ resource, ...input }] } },
      server: { url: "https://site.example" },
    });

    const first = await build({ emit: true, cache: true, debug: false, ui: false }, defaultBuiltIns, {
      customConfig: configFor({ inputKey: "stale-key", saveToDisk: false }),
      fileHandler,
    });
    const slug = first.stores.allResources[0].slug;
    const second = await build({ emit: true, cache: true, debug: false, ui: false }, defaultBuiltIns, {
      customConfig: configFor({ saveToDisk: true }),
      fileHandler,
    });
    const descriptors = JSON.parse(
      await readFile(join(testDir, ".iiif", "build", "meta", "resource-descriptors.json"), "utf8")
    );
    const cachedResource = JSON.parse(
      await readFile(join(testDir, ".iiif", "cache", slug, "resource.json"), "utf8")
    );

    expect(second.stores.stats.invalidCount).toBe(1);
    expect(descriptors[slug]).toMatchObject({ saved: true, provenance: { type: "local" } });
    expect(descriptors[slug]).not.toHaveProperty("inputKey");
    expect(cachedResource).toMatchObject({ saveToDisk: true });
    expect(cachedResource).not.toHaveProperty("inputKey");
  });

  test("emit false returns a non-deployable result", async () => {
    const events: HssBuildEvent[] = [];
    const output = await build(
      { emit: false, cache: false, networkCache: false, ui: false },
      defaultBuiltIns,
      {
        customConfig: {
          stores: {
            supplied: {
              type: "iiif-memory",
              inputs: [{ resource: { id: "https://example.org/manifest", type: "Manifest", items: [] } }],
            },
          },
        },
        fileHandler: new FileHandler(fs as any, testDir, false),
        onEvent(event) {
          events.push(event);
        },
      }
    );

    expect(output.result).toEqual({ resultVersion: 1, status: "not-emitted" });
    expect(events.at(-1)).toMatchObject({ type: "build-completed", result: output.result });
    await expect(readFile(join(testDir, ".iiif", "build", "meta", "build.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("structured failure events preserve the build error", async () => {
    const events: HssBuildEvent[] = [];
    const promise = build(
      { emit: false, cache: false, networkCache: false, ui: false },
      defaultBuiltIns,
      {
        customConfig: {
          stores: { supplied: { type: "iiif-memory", inputs: [{ resource: { type: "Manifest" } }] } },
        },
        fileHandler: new FileHandler(fs as any, testDir, false),
        onEvent(event) {
          events.push(event);
        },
      }
    );

    await expect(promise).rejects.toThrow("Programmatic IIIF inputs must have an id");
    expect(events.at(-1)).toMatchObject({
      type: "build-failed",
      error: { message: "Programmatic IIIF inputs must have an id and Presentation resource type" },
    });
  });

  test("selected-store builds preserve existing output and declare partial mode", async () => {
    const retainedPath = join(testDir, ".iiif", "build", "retained.json");
    await mkdir(join(testDir, ".iiif", "build"), { recursive: true });
    await writeFile(retainedPath, "retained");

    await build({ emit: true, cache: false, debug: false, ui: false, stores: ["local"] }, defaultBuiltIns, {
      customConfig: {
        stores: { local: { type: "iiif-json", path: "./content", pattern: "**/*.json" } },
        server: { url: "http://localhost:7111" },
      },
      fileHandler: new FileHandler(fs as any, testDir, false),
    });

    expect(await readFile(retainedPath, "utf-8")).toBe("retained");
    expect(JSON.parse(await readFile(join(testDir, ".iiif", "build", "meta", "build.json"), "utf-8")).mode).toBe(
      "partial"
    );
  });

  test("builds with a caller-owned external cache", async () => {
    const cacheRoot = join(testDir, "shared-cache");
    const output = await build(
      { emit: true, cache: true, cacheRoot, networkCache: true, debug: false, ui: false },
      defaultBuiltIns,
      {
        customConfig: {
          stores: { local: { type: "iiif-json", path: "./content", pattern: "**/*.json" } },
          server: { url: "http://localhost:7111" },
        },
        fileHandler: new FileHandler(fs as any, testDir, false),
      }
    );

    expect(output.result).toMatchObject({ status: "complete", diagnostics: { cache: "enabled" } });
    expect(output.buildConfig.cacheDir).toMatch(new RegExp(`^${cacheRoot}/cache-v1/output-v1/hss-[^/]+/build$`));
    await expect(stat(join(output.buildConfig.cacheDir, "file-types.json"))).resolves.toBeDefined();
    await expect(stat(join(output.buildConfig.cacheDir, ".build-lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("retries uncached when external cache I/O fails after locking", async () => {
    const cacheRoot = join(testDir, "failing-cache");
    const events: HssBuildEvent[] = [];
    class FailingCacheHandler extends FileHandler {
      failed = false;

      async mkdir(path: string) {
        const resolved = this.resolve(path);
        if (!this.failed && (resolved === cacheRoot || resolved.startsWith(`${cacheRoot}/`))) {
          this.failed = true;
          throw Object.assign(new Error("simulated cache I/O failure"), { code: "EIO", path: resolved });
        }
        return super.mkdir(path);
      }
    }

    const output = await build(
      { emit: true, cache: true, cacheRoot, networkCache: true, debug: false, ui: false },
      defaultBuiltIns,
      {
        customConfig: {
          stores: { local: { type: "iiif-json", path: "./content", pattern: "**/*.json" } },
          server: { url: "http://localhost:7111" },
        },
        fileHandler: new FailingCacheHandler(fs as any, testDir, false),
        onEvent(event) {
          events.push(event);
        },
      }
    );

    expect(output.result).toMatchObject({ status: "complete", diagnostics: { cache: "disabled" } });
    expect(output.buildConfig.cacheDir).toBe(".iiif/cache");
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CACHE_FALLBACK" })]));
  });
});
