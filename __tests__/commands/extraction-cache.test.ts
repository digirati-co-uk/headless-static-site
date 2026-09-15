import fs from "node:fs";
import { FileHandler } from "../../src/util/file-handler.ts";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { build, defaultBuiltIns } from "../../src/commands/build.ts";
import type { Extraction } from "../../src/util/extract.ts";
import { EXTRACTION_CACHE } from "../../src/util/extraction-cache.ts";
import { validateBuildOutput } from "../../src/output-validation.ts";

test("replays contributions, invalidates declared inputs, and removes obsolete fields and resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "hss-result-cache-"));
  try {
    await mkdir(join(root, "content"));
    const input = (label: string) =>
      JSON.stringify({ id: `https://example.org/${label}`, type: "Manifest", label: { en: [label] }, items: [] });
    await writeFile(join(root, "content/a.json"), input("A"));
    await writeFile(join(root, "content/b.json"), input("B"));
    await writeFile(join(root, "dependency.txt"), "first");
    let calls = 0;
    let collected: any;
    let bypass = false;
    let removeField = false;
    const step: Extraction = {
      id: "cached-demo",
      name: "Cached demo",
      types: ["Manifest"],
      cache: { version: "1", key: async () => (bypass ? undefined : readFile(join(root, "dependency.txt"), "utf8")) },
      invalidate: async () => {
        throw new Error("Opt-in result cache replaces invalidate");
      },
      handler: async (manifest, api) => {
        calls++;
        return {
          temp: { label: api.resource.label },
          meta: removeField ? {} : { owned: "value" },
          indices: removeField ? {} : { owned: ["one"] },
          search: { record: removeField ? {} : { owned: "value" } },
          collections: ["curated"],
        };
      },
      collect: async (temp) => {
        collected = structuredClone(temp);
        for (const value of Object.values(temp) as any[]) value.label = "mutated by collector";
        return undefined;
      },
    };
    const config: any = {
      server: { url: "https://example.org/iiif" },
      run: [step.id],
      config: {},
      stores: { local: { type: "iiif-json", path: "./content", pattern: "**/*.json" } },
    };
    const run = (cache = true, extractionCache = true) =>
      build(
        { cwd: root, cache, extractionCache, ui: false },
        { ...defaultBuiltIns, extractions: [...defaultBuiltIns.extractions, step] },
        { customConfig: config }
      );
    const first = await run();
    expect(calls).toBe(2);
    const all = structuredClone(collected);
    const second = await run();
    expect(calls).toBe(2);
    expect(collected).toEqual(all);
    expect(second.extractions.cacheStats[step.id]).toEqual({ hits: 2, misses: 0, bypassed: 0 });
    expect(second.extractions.collections).toEqual(first.extractions.collections);
    const forced = await run(true, false);
    expect(forced.stores.stats).toEqual({ validCount: 2, invalidCount: 0 });
    expect(forced.extractions.cacheStats[step.id].bypassed).toBe(2);
    expect((await run()).extractions.cacheStats[step.id].hits).toBe(2);
    await validateBuildOutput(second.result.directory!, { sha256: true });
    await writeFile(join(root, "content/a.json"), input("Changed"));
    expect((await run()).extractions.cacheStats[step.id]).toEqual({ hits: 1, misses: 1, bypassed: 0 });
    await writeFile(join(root, "dependency.txt"), "second");
    expect((await run()).extractions.cacheStats[step.id].misses).toBe(2);
    config.config[step.id] = { mode: "changed" };
    expect((await run()).extractions.cacheStats[step.id].misses).toBe(2);
    step.cache!.version = "2";
    removeField = true;
    const removed = await run();
    expect(removed.extractions.cacheStats[step.id].misses).toBe(2);
    const slug = removed.stores.allResources[0].slug;
    const cached = join(removed.buildConfig.cacheDir, slug);
    for (const filename of ["meta.json", "indices.json", "search-record.json"]) {
      const value = JSON.parse(await readFile(join(root, cached, filename), "utf8"));
      expect(filename === "search-record.json" ? value.record?.owned : value.owned).toBeUndefined();
    }
    const originalHandler = step.handler;
    step.handler = async (...args) => originalHandler(...args);
    expect((await run()).extractions.cacheStats[step.id].misses).toBe(2);
    expect((await run(false)).extractions.cacheStats[step.id].bypassed).toBe(2);
    bypass = true;
    expect((await run()).extractions.cacheStats[step.id].bypassed).toBe(2);
    bypass = false;
    await run();
    const cacheSettings = step.cache;
    step.cache = undefined;
    step.invalidate = async () => false;
    const beforeOptOut = calls;
    await run();
    expect(calls).toBe(beforeOptOut + 2);
    step.cache = cacheSettings;
    await run();
    const cachePath = join(root, cached, "caches.json");
    const cache = JSON.parse(await readFile(cachePath, "utf8"));
    cache[EXTRACTION_CACHE][step.id].digest = "broken";
    await writeFile(cachePath, JSON.stringify(cache));
    expect((await run()).stores.stats.invalidCount).toBe(1);
    const missing = JSON.parse(await readFile(cachePath, "utf8"));
    delete missing[EXTRACTION_CACHE];
    await writeFile(cachePath, JSON.stringify(missing));
    expect((await run()).stores.stats.invalidCount).toBe(1);
    await rm(join(root, "content/b.json"));
    const deleted = await run();
    expect(Object.keys(collected)).toHaveLength(1);
    expect(deleted.extractions.collections.curated).toHaveLength(1);
    removeField = false;
    step.cache!.version = "3";
    await run();
    config.run = [];
    const disabled = await run();
    expect(disabled.extractions.collections.curated).toBeUndefined();
    const survivor = disabled.stores.allResources[0].slug;
    expect(
      JSON.parse(await readFile(join(root, disabled.buildConfig.cacheDir, survivor, "meta.json"), "utf8")).owned
    ).toBeUndefined();
    await validateBuildOutput(disabled.result.directory!, { sha256: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("failed handlers and collectors do not publish result cache entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "hss-result-cache-failure-"));
  try {
    let failure = "handler";
    let calls = 0;
    const step: Extraction = {
      id: "failure",
      name: "Failure",
      types: ["Manifest"],
      cache: { version: "1" },
      invalidate: async () => true,
      handler: async () => {
        calls++;
        if (failure === "handler") throw new Error("handler failed");
        return { temp: "value" };
      },
      collect: async () => {
        if (failure === "collector") throw new Error("collector failed");
        return undefined;
      },
    };
    const config: any = {
      server: { url: "https://example.org" },
      run: [step.id],
      stores: {
        memory: {
          type: "iiif-memory",
          inputs: [{ resource: { id: "https://example.org/a", type: "Manifest", items: [] } }],
        },
      },
    };
    const run = () =>
      build(
        { cwd: root, cache: true, ui: false },
        { ...defaultBuiltIns, extractions: [...defaultBuiltIns.extractions, step] },
        { customConfig: config }
      );
    await expect(run()).rejects.toThrow("handler failed");
    failure = "collector";
    await expect(run()).rejects.toThrow("collector failed");
    failure = "";
    const recovered = await run();
    expect(calls).toBe(3);
    expect(recovered.extractions.cacheStats[step.id].misses).toBe(1);
    expect((await run()).extractions.cacheStats[step.id].hits).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed output save cannot commit new cache entries; cacheable fields cannot overlap", async () => {
  const root = await mkdtemp(join(tmpdir(), "hss-result-cache-commit-"));
  try {
    const step: Extraction = {
      id: "owned",
      name: "Owned",
      types: ["Manifest"],
      cache: { version: "1" },
      invalidate: async () => true,
      handler: async () => ({ meta: { owned: "one" } }),
    };
    const config: any = {
      server: { url: "https://example.org" },
      run: [step.id],
      stores: {
        memory: {
          type: "iiif-memory",
          inputs: [{ resource: { id: "https://example.org/a", type: "Manifest", items: [] } }],
        },
      },
    };
    class FailingOutput extends FileHandler {
      async writeFile(path: string, data: any, producer?: string) {
        if (path.endsWith("meta/build.json")) throw new Error("output failed");
        return super.writeFile(path, data, producer);
      }
    }
    const run = (fileHandler?: FileHandler, extra: Extraction[] = []) =>
      build(
        { cwd: root, cache: true, ui: false },
        { ...defaultBuiltIns, extractions: [...defaultBuiltIns.extractions, step, ...extra] },
        { customConfig: config, fileHandler }
      );
    await run();
    step.cache!.version = "2";
    await expect(run(new FailingOutput(fs as any, root))).rejects.toThrow("output failed");
    const recovered = await run();
    expect(recovered.stores.stats.invalidCount).toBe(1);
    expect(recovered.extractions.cacheStats[step.id].misses).toBe(1);
    const conflicting: Extraction = {
      id: "conflict",
      name: "Conflict",
      types: ["Manifest"],
      invalidate: async () => true,
      handler: async () => ({ meta: { owned: "two" } }),
    };
    config.run.push(conflicting.id);
    await expect(run(undefined, [conflicting])).rejects.toThrow("Cacheable extraction output collision");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fingerprints the current Vault after intervening uncached steps", async () => {
  const root = await mkdtemp(join(tmpdir(), "hss-cache-vault-"));
  try {
    await mkdir(join(root, "content"));
    const id = "https://example.org/manifest";
    await writeFile(join(root, "content/a.json"), JSON.stringify({ id, type: "Manifest", items: [] }));
    let label = "First";
    const cached: Extraction = {
      id: "before", name: "Before", types: ["Manifest"], cache: { version: "1" },
      invalidate: async () => true, handler: async () => ({}),
    };
    const mutate: Extraction = {
      id: "mutate", name: "Mutate", types: ["Manifest"], invalidate: async () => true,
      handler: async (resource) => {
        resource.vault!.get<any>(id).label = { en: [label] };
        return { didChange: true };
      },
    };
    const after: Extraction = {
      ...cached, id: "after", name: "After",
      handler: async (resource) => ({ meta: { observed: resource.vault!.get<any>(id).label } }),
    };
    const run = () => build({ cwd: root, cache: true, ui: false },
      { ...defaultBuiltIns, extractions: [cached, mutate, after] },
      { customConfig: { server: { url: "https://example.org/iiif" }, run: ["before", "mutate", "after"],
        stores: { local: { type: "iiif-json", path: "./content", pattern: "**/*.json" } } } });
    await run();
    await run();
    expect((await run()).extractions.cacheStats.after.hits).toBe(1);
    label = "Changed";
    const changed = await run();
    expect(changed.extractions.cacheStats.after.misses).toBe(1);
    const slug = changed.stores.allResources[0].slug;
    const meta = JSON.parse(await readFile(join(root, changed.buildConfig.cacheDir, slug, "meta.json"), "utf8"));
    expect(meta.observed).toEqual({ en: ["Changed"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
