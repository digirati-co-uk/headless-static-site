import { Vault } from "@iiif/helpers";
import { expect, test } from "vitest";
import { getManifestImageServices } from "../../src/util/manifest-image-services.ts";

test("reads normalized references, multiple pages/bodies and choices without unrelated services", async () => {
  const image = (id: string, service: any) => ({ id, type: "Image", service });
  const v2 = { "@id": "https://example.org/image2", "@type": "ImageService2", profile: "level1" };
  const v3 = { id: "https://example.org/image3", type: "ImageService3", profile: "level1" };
  const annotation = (id: string, body: any) => ({
    id,
    type: "Annotation",
    motivation: "painting",
    body,
    target: "https://example.org/canvas",
  });
  const vault = new Vault();
  await vault.load("https://example.org/manifest", {
    id: "https://example.org/manifest",
    type: "Manifest",
    items: [
      {
        id: "https://example.org/canvas",
        type: "Canvas",
        width: 10,
        height: 10,
        thumbnail: [
          image("https://example.org/thumb", [{ id: "https://example.org/thumb-service", type: "ImageService3" }]),
        ],
        items: [
          {
            id: "https://example.org/page1",
            type: "AnnotationPage",
            items: [
              annotation("https://example.org/anno1", [
                image("https://example.org/i1", [v2, v3]),
                image("https://example.org/i2", [{ id: "https://example.org/search", type: "SearchService2" }]),
              ]),
            ],
          },
          {
            id: "https://example.org/page2",
            type: "AnnotationPage",
            items: [
              annotation("https://example.org/anno2", {
                type: "Choice",
                items: [
                  image("https://example.org/i3", v3),
                  { type: "SpecificResource", source: image("https://example.org/i4", v2) },
                ],
              }),
            ],
          },
        ],
      },
      { id: "https://example.org/external", type: "Canvas" },
    ],
  });
  expect(getManifestImageServices(vault, "https://example.org/manifest")).toEqual([
    { id: v2["@id"], canvasId: "https://example.org/canvas" },
    { id: v3.id, canvasId: "https://example.org/canvas" },
    { id: v3.id, canvasId: "https://example.org/canvas" },
    { id: v2["@id"], canvasId: "https://example.org/canvas" },
  ]);
  const entities = vault.getStore().getState().iiif.entities as any;
  entities.ContentResource["https://example.org/i1"]["iiif-parser:hasPart"] = [
    {
      "iiif-parser:partOf": "https://example.org/anno1",
      "@explicit": true,
      id: "https://example.org/i1",
      type: "Image",
      service: [v3],
    },
  ];
  expect(getManifestImageServices(vault, "https://example.org/manifest")).toHaveLength(3);
  entities.ContentResource.loop = { id: "loop", type: "Choice", items: [{ id: "loop", type: "ContentResource" }] };
  entities.Annotation["https://example.org/anno1"].body.push({ id: "loop", type: "ContentResource" });
  expect(getManifestImageServices(vault, "https://example.org/manifest")).toHaveLength(3);
  expect(getManifestImageServices(vault, "missing")).toEqual([]);
});
