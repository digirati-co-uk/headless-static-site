import { Vault } from "@iiif/helpers";
import { describe, expect, test } from "vitest";
import { createResourceOutputDescriptors } from "../../src/util/resource-output-descriptors.ts";

async function resource(json: any, slug: string, source: any, saveToDisk = false) {
  const vault = new Vault();
  await vault.load(json.id, json);
  return {
    id: json.id,
    type: json.type,
    path: json.id,
    slug,
    storeId: "remote",
    source,
    saveToDisk,
    vault,
  } as any;
}

describe("resource output descriptors", () => {
  test("derives nested relationships from unsaved remote resource graphs", async () => {
    const manifest = { id: "https://upstream.example/manifest", type: "Manifest", items: [] };
    const nested = {
      id: "https://upstream.example/nested",
      type: "Collection",
      items: [{ id: manifest.id, type: "Manifest" }],
    };
    const root = {
      id: "https://upstream.example/root",
      type: "Collection",
      items: [{ id: nested.id, type: "Collection", "hss:slug": "upstream/nested" }],
    };
    const resources = await Promise.all([
      resource(root, "collections/root", { type: "remote", url: root.id }),
      resource(nested, "collections/nested", { type: "remote", url: nested.id }),
      resource(manifest, "manifests/item", { type: "remote", url: manifest.id }),
    ]);

    const descriptors = await createResourceOutputDescriptors("", resources, []);

    expect(descriptors["collections/root"]).toMatchObject({
      saved: false,
      provenance: { type: "remote", url: root.id },
      children: ["collections/nested"],
    });
    expect(descriptors["collections/nested"]).toMatchObject({
      parents: ["collections/root"],
      children: ["manifests/item"],
    });
    expect(descriptors["manifests/item"].parents).toEqual(["collections/nested"]);
  });

  test("publishes portable local and override provenance", async () => {
    const local = { id: "https://example.org/local", type: "Manifest", items: [] };
    const overridden = { id: "https://example.org/override", type: "Manifest", items: [] };
    const descriptors = await createResourceOutputDescriptors(
      "",
      [
        await resource(local, "manifests/local", { type: "memory", index: 0 }, true),
        await resource(
          overridden,
          "manifests/override",
          {
            type: "disk",
            path: "/private/overrides",
            filePath: "/private/overrides/item.json",
            upstream: "https://upstream.example/item",
          },
          true
        ),
      ],
      []
    );

    expect(descriptors["manifests/local"].provenance).toEqual({ type: "local" });
    expect(descriptors["manifests/override"].provenance).toEqual({
      type: "override",
      upstream: "https://upstream.example/item",
    });
    expect(JSON.stringify(descriptors)).not.toContain("/private/overrides");
  });
});
