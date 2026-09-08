import fs from "node:fs";
import { FileHandler } from "../../src/util/file-handler.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { indices } from "../../src/commands/build-steps/5-indices.ts";

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

describe("build indices", () => {
  let testDir = "";

  afterEach(async () => {
    if (!testDir) {
      return;
    }
    await rm(testDir, { recursive: true, force: true });
    testDir = "";
  });

  test.each([
    { items: undefined, expected: ["example", "topics"] },
    { items: ["stores/local", "example", "manifests", "collections"], expected: ["stores/local", "example", "manifests", "collections"] },
    { items: [], expected: [] },
    { items: ["missing"], error: 'Unknown slug "missing"' },
    { items: "example", error: "must be a list of slugs" },
    { items: [42], error: "must be a list of slugs" },
  ])("supports index items $items alongside collection metadata", async ({ items, expected, error }) => {
    testDir = await mkdtemp(join(tmpdir(), "iiif-hss-index-items-"));
    const buildDir = join(testDir, "build");
    const files = new FileHandler(fs, testDir);
    const manifest = { id: "https://example.org/example/manifest.json", type: "Manifest", "hss:slug": "example" };
    const label = { en: ["Featured"] };
    const summary = { en: ["Selected resources"] };
    const result = indices({
      allResources: [], indexCollection: { example: manifest },
      manifestCollection: [manifest], storeCollections: { local: [manifest] }, allIndices: {},
    }, {
      options: {}, configUrl: "https://example.org/iiif", buildDir,
      cacheDir: join(testDir, "cache"), topicsDir: join(testDir, "topics"),
      collectionRewrites: [], files,
      config: { stores: {}, collections: { index: { items, label, summary }, manifests: { label: { en: ["All manifests"] } } } },
    } as any);
    if (error) {
      await expect(result).rejects.toThrow(error);
      return;
    }
    await result;
    await files.saveAll();
    const collection = JSON.parse(await readFile(join(buildDir, "collection.json"), "utf8"));
    expect(collection.items.map((item: any) => item["hss:slug"])).toEqual(expected);
    expect(collection["hss:totalItems"]).toBe(expected!.length);
    expect(collection.label).toEqual(label);
    expect(collection.summary).toEqual(summary);
    if (items?.length) {
      expect(collection.items[1]).toEqual(manifest);
      expect(collection.items[2].label).toEqual({ en: ["All manifests"] });
    }
  });

  test("always writes topics/collection.json even when there are no extracted topics", async () => {
    testDir = await mkdtemp(join(tmpdir(), "iiif-hss-build-indices-"));
    const buildDir = join(testDir, ".iiif", "build");
    const cacheDir = join(testDir, ".iiif", "cache");
    const topicsDir = join(testDir, "content", "topics");

    const files = {
      async writeFile(path: string, content: string) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      },
      async saveJson(path: string, content: unknown) {
        await writeJson(path, content);
      },
      async loadJson(path: string) {
        return JSON.parse(await readFile(path, "utf-8"));
      },
      async mkdir(path: string) {
        await mkdir(path, { recursive: true });
      },
      readYaml() {
        return {};
      },
    };

    await indices(
      {
        allResources: [],
        indexCollection: {},
        siteMap: {},
        allIndices: {},
        editable: {},
        overrides: {},
      },
      {
        options: {
          exact: undefined,
          stores: undefined,
          topics: false,
          debug: false,
        },
        configUrl: "https://example.org/iiif",
        buildDir,
        cacheDir,
        topicsDir,
        collectionRewrites: [],
        files,
        config: {
          slugs: {},
          stores: {},
          collections: {},
        },
      } as any
    );

    const topicsCollection = JSON.parse(await readFile(join(buildDir, "topics", "collection.json"), "utf-8"));

    expect(topicsCollection.type).toBe("Collection");
    expect(topicsCollection["hss:slug"]).toBe("topics");
    expect(topicsCollection["hss:totalItems"]).toBe(0);
    expect(topicsCollection.items).toEqual([]);
    expect(JSON.parse(await readFile(join(buildDir, "meta", "resources.json"), "utf-8"))).toHaveProperty("topics");
    await expect(readFile(join(buildDir, "config", "stores.json"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects topic type normalization collisions", async () => {
    testDir = await mkdtemp(join(tmpdir(), "iiif-hss-topic-collision-"));
    const files = {
      async writeFile(path: string, content: string) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      },
      async saveJson(path: string, content: unknown) {
        await writeJson(path, content);
      },
      async loadJson(path: string) {
        return path.includes("first") ? { "Topic Type": ["One"] } : { "topic-type": ["Two"] };
      },
      async mkdir(path: string) {
        await mkdir(path, { recursive: true });
      },
      readYaml() {
        return {};
      },
    };

    await expect(
      indices(
        {
          allResources: [
            { slug: "first", source: { type: "disk" } },
            { slug: "second", source: { type: "disk" } },
          ] as any,
          indexCollection: {
            first: { id: "https://example.org/first", type: "Manifest", "hss:slug": "first" },
            second: { id: "https://example.org/second", type: "Manifest", "hss:slug": "second" },
          },
          allIndices: {},
        },
        {
          options: {},
          configUrl: "https://example.org/iiif",
          buildDir: join(testDir, "build"),
          cacheDir: join(testDir, "cache"),
          topicsDir: join(testDir, "topics"),
          collectionRewrites: [],
          files,
          config: { stores: {}, collections: {} },
        } as any
      )
    ).rejects.toThrow(/both normalize to "topic-type"/);
  });

  test("merges topic URL collisions only when opted in, preserving aliases and members", async () => {
    testDir = await mkdtemp(join(tmpdir(), "iiif-hss-topic-merge-"));
    const buildDir = join(testDir, "build");
    const cacheDir = join(testDir, "cache");
    await writeJson(join(cacheDir, "first", "indices.json"), { date: ["1912", "1912?"] });
    await writeJson(join(cacheDir, "second", "indices.json"), { date: ["1912?"] });
    const data = {
      allResources: ["first", "second"].map((slug) => ({ slug, source: { type: "disk" } })) as any,
      indexCollection: Object.fromEntries(["first", "second"].map((slug) => [slug, {
        id: `https://example.org/${slug}`, type: "Manifest", "hss:slug": slug,
      }])),
      allIndices: {},
    };
    const config = {
      options: {}, configUrl: "https://example.org/iiif", buildDir, cacheDir,
      topicsDir: join(testDir, "topics"), collectionRewrites: [],
      files: new FileHandler(fs, testDir), config: { stores: {}, collections: {}, output: {} },
    } as any;
    await expect(indices(data, config)).rejects.toThrow(/both normalize to "1912"/);
    config.config.output.topicSlugCollisions = "merge";
    await indices(data, config);
    await config.files.saveAll();
    const collection = JSON.parse(await readFile(join(buildDir, "topics/date/1912/collection.json"), "utf8"));
    const meta = JSON.parse(await readFile(join(buildDir, "topics/date/1912/meta.json"), "utf8"));
    expect(collection.items.map((item: any) => item["hss:slug"])).toEqual(["first", "second"]);
    expect(meta.label).toBe("1912");
    expect(meta.aliases).toEqual(["1912?"]);
    const rawIndices = JSON.parse(await readFile(join(buildDir, "meta/indices.json"), "utf8"));
    expect(rawIndices.date["1912?"]).toEqual(["first", "second"]);
  });

  test("uses normalized topic paths for spaces, punctuation, and Unicode", async () => {
    testDir = await mkdtemp(join(tmpdir(), "iiif-hss-topic-paths-"));
    const buildDir = join(testDir, "build");
    const files = {
      async writeFile(path: string, content: string) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      },
      async saveJson(path: string, content: unknown) {
        await writeJson(path, content);
      },
      async loadJson() {
        return { "Média Type!": ["Café & Tea"] };
      },
      async mkdir(path: string) {
        await mkdir(path, { recursive: true });
      },
      readYaml() {
        return {};
      },
    };

    await indices(
      {
        allResources: [{ slug: "manifest", source: { type: "disk" } }] as any,
        indexCollection: {
          manifest: { id: "https://example.org/manifest", type: "Manifest", "hss:slug": "manifest" },
        },
        allIndices: {},
      },
      {
        options: {},
        configUrl: "https://example.org/iiif",
        buildDir,
        cacheDir: join(testDir, "cache"),
        topicsDir: join(testDir, "topics"),
        collectionRewrites: [],
        files,
        config: { stores: {}, collections: {} },
      } as any
    );

    const leaf = JSON.parse(
      await readFile(join(buildDir, "topics", "media-type", "cafe-tea", "collection.json"), "utf-8")
    );
    expect(leaf.id).toBe("https://example.org/iiif/topics/media-type/cafe-tea/collection.json");
    expect(leaf["hss:slug"]).toBe("topics/media-type/cafe-tea");
  });
});
