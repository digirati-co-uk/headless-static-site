import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { build, defaultBuiltIns } from "../../src/commands/build.ts";

test("an authored collection owns its rewritten folder slug and parent references", async () => {
  const root = await mkdtemp(join(tmpdir(), "hss-folder-source-"));
  const folder = join(root, "content", "archive", "journal");
  try {
    await mkdir(folder, { recursive: true });
    const authored = {
      "@context": "http://iiif.io/api/presentation/2/context.json",
      "@id": "https://example.org/journal", "@type": "sc:Collection", label: "Authored journal",
      manifests: [{ "@id": "https://example.org/year", "@type": "sc:Manifest", label: "A curated year" }],
    };
    const sourcePath = join(folder, "journal.json");
    await writeFile(sourcePath, JSON.stringify(authored));
    for (const name of ["year", "unlisted"]) {
      await writeFile(join(folder, `${name}.json`), JSON.stringify({
        id: `https://example.org/${name}`, type: "Manifest", label: { en: [name] }, items: [],
      }));
    }
    const result = await build({ cwd: root, emit: true, cache: false, ui: false }, defaultBuiltIns, {
      customConfig: {
        server: { url: "https://example.org/iiif" }, run: ["flat-manifests", "folder-collections"],
        stores: { local: { type: "iiif-json", path: join(root, "content"), pattern: "**/*.json" } },
      },
    });
    expect(result.stores.allResources.filter((item) => item.slug === "collections/journal")).toHaveLength(1);
    const read = async (slug: string) => JSON.parse(await readFile(join(root, ".iiif/build", slug, "collection.json"), "utf8"));
    const journal = await read("collections/journal");
    expect(journal.label).toEqual({ none: ["Authored journal"] });
    expect(journal.items.map((item: any) => item["hss:slug"])).toEqual(["manifests/year"]);
    const parent = await read("collections/archive");
    expect(parent.items.map((item: any) => item.id)).toEqual([journal.id]);
    expect(JSON.parse(await readFile(sourcePath, "utf8"))).toEqual(authored);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
