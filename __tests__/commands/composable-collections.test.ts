import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { build, defaultBuiltIns } from "../../src/commands/build.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hss-composable-"));
  const write = async (path: string, value: any) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const manifest = (name: string) => ({
    id: `https://example.org/${name}`,
    type: "Manifest",
    label: { en: [name] },
    items: [],
  });
  const store = (path: string, extra = {}) => ({
    type: "iiif-json",
    path: join(root, path),
    pattern: "**/*.json",
    ...extra,
  });
  const run = (stores: any, cache = false) =>
    build({ cwd: root, emit: true, cache, ui: false }, defaultBuiltIns, {
      customConfig: { server: { url: "https://example.org/iiif" }, run: ["flat-manifests"], stores },
    });
  const read = async (slug: string) =>
    JSON.parse(await readFile(join(root, ".iiif/build", slug, "collection.json"), "utf8"));
  return { root, write, manifest, store, run, read };
}

test("curated slugs merge with folders across stores, formats, rewrites and cached rebuilds", async () => {
  const { root, write, manifest, store, run, read } = await fixture();
  try {
    await write(
      "curated/exhibition/collection.yml",
      `label: Exhibition\nsummary: Curated first, discovered next.\nitems:\n  - manifests/shared\n  - collections/nested\n  - manifests/local\n  - id: https://external.example/collection\n    type: Collection\n    label: { en: [External collection] }\n`
    );
    await write("curated/exhibition/local.json", manifest("local"));
    await write("curated/exhibition/nested/collection.json", {
      label: "Nested",
      summary: "JSON and YAML compose.",
      items: ["manifests/shared"],
    });
    await write("curated/exhibition/automatic/deep/object.json", manifest("object"));
    await write("curated/exhibition/empty/_collection.yaml", { label: "Empty", items: [] });
    await write("shared/shared.json", manifest("shared"));
    const stores = { curated: store("curated", { subFiles: true }), shared: store("shared") };
    const result = await run(stores);
    const collection = await read("collections/exhibition");
    expect(collection.summary).toEqual({ none: ["Curated first, discovered next."] });
    expect(collection.items.map((item: any) => item["hss:slug"] || item.id)).toEqual([
      "manifests/shared",
      "collections/nested",
      "manifests/local",
      "https://external.example/collection",
      "collections/empty",
      "collections/automatic",
    ]);
    expect((await read("collections/automatic")).items[0]["hss:slug"]).toBe("collections/deep");
    expect((await read("collections/deep")).items[0]["hss:slug"]).toBe("manifests/object");
    expect((await read("collections/empty")).items).toEqual([]);
    expect(result.parsed.filesToWatch).toContain(join(root, "curated/exhibition/collection.yml"));
    await write("curated/exhibition/collection.yml", "label: Revised\nitems: [manifests/local]\n");
    await rm(join(root, "curated/exhibition/automatic"), { recursive: true });
    await run(stores, true);
    const revised = await read("collections/exhibition");
    expect(revised.label).toEqual({ none: ["Revised"] });
    expect(revised.items.map((item: any) => item["hss:slug"])).toEqual([
      "manifests/local",
      "collections/empty",
      "collections/nested",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("root declarations, explicit namespaces, ignores and v2 collection.json", async () => {
  const { root, write, manifest, store, run, read } = await fixture();
  try {
    await write("root/collection.json", { label: "Store root", summary: "Root declaration" });
    await write("root/item.json", manifest("root-item"));
    await write("other/collection.yml", "label: Other root\n");
    await write("legacy/archive/collection.json", {
      "@context": "http://iiif.io/api/presentation/2/context.json",
      "@id": "https://example.org/archive",
      "@type": "sc:Collection",
      label: "Legacy archive",
      manifests: [{ "@id": "https://example.org/legacy-item", "@type": "sc:Manifest", label: "Legacy item" }],
    });
    await write("legacy/archive/item.json", manifest("legacy-item"));
    await write("legacy/archive/ignored/collection.yml", "label: Ignored\n");
    await run({ root: store("root"), other: store("other"), legacy: store("legacy", { ignore: "**/ignored/**" }) });
    expect((await read("collections/root")).items).toHaveLength(1);
    expect((await read("collections/other")).items).toHaveLength(0);
    expect((await read("collections/archive")).items).toHaveLength(1);
    expect((await read("collections/archive")).label).toEqual({ none: ["Legacy archive"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["items: [manifests/missing]", /Unknown collection item slug/],
  ["items: nope", /items must be an array/],
  ["items: [42]", /Invalid collection item/],
  ["items: [collections/example]", /cannot include itself/],
])("invalid authored collection fails clearly: %s", async (content, message) => {
  const { root, write, store, run } = await fixture();
  try {
    await write("curated/example/collection.yml", content);
    await expect(run({ curated: store("curated") })).rejects.toThrow(message);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("competing declaration formats fail instead of silently replacing a collection", async () => {
  const { root, write, store, run } = await fixture();
  try {
    await write("curated/example/collection.yml", "label: First");
    await write("curated/example/_collection.json", { label: "Second" });
    await expect(run({ curated: store("curated") })).rejects.toThrow(/Multiple collection sidecars/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store namespaces apply equally to root declarations and automatic descendants", async () => {
  const { root, write, manifest, read } = await fixture();
  try {
    await write("content/collection.yml", "label: Root\n");
    await write("content/objects/deep/object.json", manifest("object"));
    const result = await build({ cwd: root, emit: true, cache: false, ui: false }, defaultBuiltIns, {
      customConfig: {
        server: { url: "https://example.org/iiif" },
        run: [],
        stores: {
          local: {
            type: "iiif-json",
            path: "./content",
            base: "./content",
            destination: "collections/namespaced",
            pattern: "**/*.json",
            run: ["folder-collections"],
          },
        },
      },
    });
    expect(result.stores.allResources.map((item) => item.slug).sort()).toEqual([
      "collections/namespaced",
      "collections/namespaced/objects",
      "collections/namespaced/objects/deep",
      "collections/namespaced/objects/deep/object",
    ]);
    expect((await read("collections/namespaced")).items[0]["hss:slug"]).toBe("collections/namespaced/objects");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("curated slugs resolve remote and memory inputs using their owning store", async () => {
  const { root, write, manifest, store, read } = await fixture();
  try {
    await write("curated/collection.yml", "label: Curated\nitems: [manifests/remote, manifests/memory]\n");
    await build({ cwd: root, emit: true, cache: false, ui: false }, defaultBuiltIns, {
      fetch: async () =>
        new Response(JSON.stringify(manifest("remote")), { headers: { "Content-Type": "application/json" } }),
      customConfig: {
        server: { url: "https://example.org/iiif" },
        run: ["flat-manifests"],
        stores: {
          curated: store("curated") as any,
          remote: { type: "iiif-remote", url: "https://example.org/remote", saveManifests: false },
          memory: { type: "iiif-memory", inputs: [{ resource: manifest("memory") }] },
        },
      },
    });
    const items = (await read("collections/curated")).items;
    expect(items.map((item: any) => item.id)).toEqual([
      "https://example.org/remote",
      "https://example.org/iiif/manifests/memory/manifest.json",
    ]);
    expect(items.map((item: any) => item.label)).toEqual([{ en: ["remote"] }, { en: ["memory"] }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
