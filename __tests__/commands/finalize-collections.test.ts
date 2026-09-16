import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { build, defaultBuiltIns } from "../../src/commands/build.ts";
import { featuredPartOf } from "../../src/finalize/featured-part-of.ts";
import { validateBuildOutput } from "../../src/output-validation.ts";
import type { FinalCollection } from "../../src/util/finalize-collection.ts";

let root = "";
const originalRegistry = (global as any).__hss;
afterEach(async () => {
  (global as any).__hss = originalRegistry;
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "hss-finalize-"));
  const write = async (path: string, value: any) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  await write("content/a/_collection.yml", 'label: A\nbackground: "#f00"\n');
  await write("content/a/b/_collection.json", { label: "B" });
  await write("content/a/b/c/_collection.yaml", "label: C\n");
  await write("content/a/b/c/d/_collection.yml", "label: D\n");
  await write("content/a/b/c/d/object.json", {
    id: "https://example.org/object",
    type: "Manifest",
    label: { en: ["Object"] },
    items: [],
  });
  const config = {
    server: { url: "https://example.org/iiif" },
    run: ["featured-part-of"],
    collections: { featured: { items: ["collections/a"] } },
    stores: { local: { type: "iiif-json" as const, path: "./content" } },
  };
  const run = (builtIns = defaultBuiltIns) =>
    build({ cwd: root, cache: true, dev: true, ui: false }, builtIns, { customConfig: config });
  const read = async (result: Awaited<ReturnType<typeof run>>, path: string) =>
    JSON.parse(await readFile(join(result.buildConfig.files.resolve(result.buildConfig.buildDir), path), "utf8"));
  return { config, run, read, write };
}

const slugs = (resource: any) => resource.partOf?.map((ancestor: any) => ancestor["hss:slug"]);

test("featured breadcrumbs follow the full graph, update snippets, and reset on cached dev builds", async () => {
  const { config, run, read } = await fixture();
  for (let i = 0; i < 2; i++) {
    const result = await run();
    expect(slugs(await read(result, "collections/a/b/c/d/collection.json"))).toEqual([
      "featured",
      "collections/a",
      "collections/a/b",
      "collections/a/b/c",
    ]);
    const featured = await read(result, "featured/collection.json");
    expect(slugs(featured.items[0])).toEqual(["featured"]);
    expect(slugs(featured.items[0].items[0])).toEqual(["featured", "collections/a"]);
    expect(featured.items[0].items[0].items).toBeUndefined();
    const resources = await read(result, "meta/resources.json");
    expect(slugs(resources["collections/a/b/c"])).toEqual(["featured", "collections/a", "collections/a/b"]);
    expect((await read(result, "collections/a/b/c/d/collection.json")).items[0].partOf).toBeUndefined();
    expect((await read(result, "featured/collection.json")).partOf).toBeUndefined();
    await expect(
      validateBuildOutput(result.buildConfig.files.resolve(result.buildConfig.buildDir), { sha256: true })
    ).resolves.toMatchObject({ status: "complete" });
  }
  config.collections.featured.items = ["collections/a/b"];
  const moved = await run();
  expect((await read(moved, "collections/a/collection.json")).partOf).toBeUndefined();
  expect(slugs(await read(moved, "collections/a/b/c/collection.json"))).toEqual(["featured", "collections/a/b"]);
  config.run = [];
  expect((await read(await run(), "collections/a/b/c/collection.json")).partOf).toBeUndefined();
});

test("registered finalizers run in configured order on aggregates and keep metadata and embedded membership in sync", async () => {
  const { config, read, write } = await fixture();
  const scriptsUrl = pathToFileURL(join(process.cwd(), "lib/scripts.js")).href;
  await write(
    "scripts/finalize.mjs",
    `
    import { finalizeCollection } from ${JSON.stringify(scriptsUrl)};
    finalizeCollection({ id: "edit-collections", name: "Edit collections" }, (collection, { slug }, config) => {
      if (slug === "collections/a") {
        collection.label = { en: [config.label] };
        delete collection.background;
        collection.items = [];
      }
      collection.customFinalized = true;
    });
  `
  );
  config.run = ["edit-collections", "featured-part-of"];
  Object.assign(config, { config: { "edit-collections": { label: "Edited late" } } });
  const result = await build({ cwd: root, scripts: "./scripts", cache: true, ui: false }, defaultBuiltIns, {
    customConfig: config,
  });
  const featured = await read(result, "featured/collection.json");
  expect(featured.customFinalized).toBe(true);
  expect(featured.items[0]).toMatchObject({ label: { en: ["Edited late"] }, items: [], "hss:totalItems": 0 });
  expect(featured.items[0].background).toBeUndefined();
  const resources = await read(result, "meta/resources.json");
  expect(resources["collections/a"].background).toBeUndefined();
  expect(resources["collections/a"].label).toEqual({ en: ["Edited late"] });
  expect((await read(result, "meta/sitemap.json"))["collections/a"].label).toBe("Edited late");
  expect(result.emitted.collectionItems?.["collections/a"]).toEqual([]);
  expect((await read(result, "collection.json")).customFinalized).toBe(true);
  expect((await read(result, "topics/collection.json")).customFinalized).toBe(true);
  expect((await read(result, "collections/a/b/collection.json")).partOf).toBeUndefined();
});

test("shared collections and cycles produce one finite ancestor path", async () => {
  const make = (id: string, children: string[]): FinalCollection => ({
    id,
    type: "Collection",
    label: { en: [id] },
    items: children.map((id) => ({ id, type: "Collection", label: { en: [id] }, items: [] })),
  });
  const collections = {
    featured: make("featured", ["a", "b"]),
    a: make("a", ["c"]),
    b: make("b", ["c"]),
    c: make("c", ["a", "featured"]),
  };
  const api = { collections, config: { stores: {} } };
  const paths = await featuredPartOf.configure!(api, {});
  for (const [slug, collection] of Object.entries(collections))
    await featuredPartOf.handler(collection, { ...api, slug }, paths);
  expect(collections.c.partOf?.map((item: any) => item.id)).toEqual(["featured", "a"]);
  expect(collections.featured.partOf).toBeUndefined();
  expect(collections.a.partOf?.map((item: any) => item.id)).toEqual(["featured"]);
});

test("identity changes fail before publication and close the selected finalizer", async () => {
  const { config, run } = await fixture();
  let closed = false;
  config.run = ["invalid-finalizer"];
  await expect(
    run({
      ...defaultBuiltIns,
      collectionFinalizers: [
        {
          id: "invalid-finalizer",
          name: "Invalid finalizer",
          handler(collection) {
            collection.id = "https://example.org/changed";
          },
          close() {
            closed = true;
          },
        },
      ],
    })
  ).rejects.toThrow(/cannot change id, type or slug/);
  expect(closed).toBe(true);
});

test("later renames update breadcrumb labels without nesting ancestor paths", async () => {
  const { config, run, read } = await fixture();
  config.run.push("rename");
  const result = await run({
    ...defaultBuiltIns,
    collectionFinalizers: [
      ...defaultBuiltIns.collectionFinalizers!,
      {
        id: "rename",
        name: "Rename",
        handler(collection, { slug }) {
          if (slug === "collections/a/b") collection.label = { en: ["New B"] };
        },
      },
    ],
  });
  const deep = await read(result, "collections/a/b/c/d/collection.json");
  expect(deep.partOf[2].label).toEqual({ en: ["New B"] });
  expect(deep.partOf.every((ancestor: any) => !ancestor.partOf && !ancestor.items)).toBe(true);
});

test("ordering precedes thumbnails and breadcrumbs, ignores legacy cached fallbacks, and propagates removals", async () => {
  const { config, run, read, write } = await fixture();
  await write("content/a/e/_collection.yml", "label: E\n");
  const image = (id: string) => ({ id: `https://example.org/${id}.jpg`, type: "Image" });
  const manifest = (id: string) => ({
    id: `https://example.org/${id}`,
    type: "Manifest",
    label: { en: [id] },
    thumbnail: [image(id)],
    items: [],
  });
  await write("content/a/e/object.json", manifest("e"));
  await write("content/a/b/c/d/object.json", manifest("b"));
  config.run = ["extract-collection-thumbnail"];
  expect((await read(await run(), "collections/a/collection.json")).thumbnail[0].id).toBe(image("b").id);
  const builtIns = {
    ...defaultBuiltIns,
    collectionFinalizers: [
      ...defaultBuiltIns.collectionFinalizers!,
      {
        id: "edit-members",
        name: "Edit members",
        handler(collection: FinalCollection, { slug }: { slug: string }) {
          if (slug === "collections/a/b") collection.label = { en: ["Z"] };
        },
      },
    ],
  };
  config.run = [
    "extract-collection-thumbnail",
    "edit-members",
    "collection-item-order",
    "collection-thumbnail",
    "featured-part-of",
  ];
  Object.assign(config, { config: { "collection-item-order": { byCollection: { "collections/a": "label" } } } });
  const result = await run(builtIns);
  const a = await read(result, "collections/a/collection.json");
  expect(a.items.map((item: any) => item["hss:slug"])).toEqual(["collections/a/e", "collections/a/b"]);
  expect(a.thumbnail).toEqual([image("e")]);
  const featured = await read(result, "featured/collection.json");
  expect(featured.items[0].thumbnail).toEqual(a.thumbnail);
  expect(featured.items[0].items.map((item: any) => item.id)).toEqual(a.items.map((item: any) => item.id));
  expect(featured.items[0].items.every((item: any) => item.items === undefined)).toBe(true);
  expect((await read(result, "meta/resources.json"))["collections/a"].thumbnail).toEqual(a.thumbnail);
  builtIns.collectionFinalizers[builtIns.collectionFinalizers.length - 1].handler = (collection, { slug }) => {
    if (slug === "collections/a") collection.items = [];
  };
  const removed = await run(builtIns);
  expect((await read(removed, "collections/a/collection.json")).thumbnail).toBeUndefined();
  expect((await read(removed, "featured/collection.json")).items[0].thumbnail).toBeUndefined();
  expect((await read(removed, "meta/resources.json"))["collections/a"].thumbnail).toBeUndefined();
  await write("content/a/_collection.yml", { label: "A", thumbnail: [image("authored"), image("second")] });
  expect((await read(await run(builtIns), "collections/a/collection.json")).thumbnail).toEqual([
    image("authored"),
    image("second"),
  ]);
});

test("default generated ordering matches legacy output and preserves authored member lists", async () => {
  const { config, run, read, write } = await fixture();
  await write("content/a/b/_collection.json", { label: "Zulu" });
  await write("content/a/e/_collection.yml", "label: Alpha\n");
  config.run = [];
  const legacy = await run();
  const resources = await read(legacy, "meta/resources.json");
  const paths = [
    "collection.json",
    ...Object.entries(resources)
      .filter(([, value]: any) => value.type === "Collection")
      .map(([slug]) => `${slug}/collection.json`),
  ];
  const previous = await Promise.all(
    paths.map(async (path) => (await read(legacy, path)).items.map((item: any) => item.id))
  );
  config.run = ["collection-item-order"];
  const migrated = await run();
  for (const [index, path] of paths.entries()) {
    expect(
      (await read(migrated, path)).items.map((item: any) => item.id),
      path
    ).toEqual(previous[index]);
  }
});
