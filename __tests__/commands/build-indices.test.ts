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
