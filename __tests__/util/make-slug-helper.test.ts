import { describe, expect, test } from "vitest";
import { assertSafeSlug, makeGetSlugHelper } from "../../src/util/make-slug-helper.ts";

describe("makeGetSlugHelper default slug behavior", () => {
  test("removes trailing manifest.json from URL path", () => {
    const getSlug = makeGetSlugHelper({} as any, {} as any);
    const [slug] = getSlug({
      id: "https://iiif.io/api/cookbook/recipe/0001-mvm-image/manifest.json",
      type: "Manifest",
    });
    expect(slug).toBe("api/cookbook/recipe/0001-mvm-image");
  });

  test("removes trailing collection.json from URL path", () => {
    const getSlug = makeGetSlugHelper({} as any, {} as any);
    const [slug] = getSlug({
      id: "https://example.org/collections/demo/collection.json",
      type: "Collection",
    });
    expect(slug).toBe("collections/demo");
  });

  test("removes generic trailing .json when not manifest/collection filename", () => {
    const getSlug = makeGetSlugHelper({} as any, {} as any);
    const [slug] = getSlug({
      id: "https://example.org/cookbook-collection.json",
      type: "Collection",
    });
    expect(slug).toBe("cookbook-collection");
  });

  test("falls back to hostname when path collapses to empty", () => {
    const getSlug = makeGetSlugHelper({} as any, {} as any);
    const [slug] = getSlug({
      id: "https://example.org/manifest.json",
      type: "Manifest",
    });
    expect(slug).toBe("example.org");
  });

  test("supports inline slugTemplate on stores", () => {
    const getSlug = makeGetSlugHelper(
      {
        slugTemplate: {
          type: "Manifest",
          domain: "datasyllwr.llgc.org.uk",
          prefix: "/manifests/PeacePetition/loc/manifests/",
          suffix: "-manifest.json",
        },
      } as any,
      {} as any
    );

    const [slug, source] = getSlug({
      id: "https://datasyllwr.llgc.org.uk/manifests/PeacePetition/loc/manifests/6085440-manifest.json",
      type: "Manifest",
    });

    expect(slug).toBe("manifests/6085440");
    expect(source).toBe("inline-slug-template-1");
  });

  test("prefers named slugTemplates before inline slugTemplate", () => {
    const getSlug = makeGetSlugHelper(
      {
        slugTemplates: ["named-template"],
        slugTemplate: {
          type: "Manifest",
          domain: "example.org",
          prefix: "/inline/",
          suffix: ".json",
        },
      } as any,
      {
        "named-template": {
          info: {
            type: "Manifest",
            domain: "example.org",
            prefix: "/named/",
            suffix: ".json",
          },
          compile: (id: string) => [id.includes("/named/") ? "from-named" : null, {}] as const,
        },
      } as any
    );

    const [slug, source] = getSlug({
      id: "https://example.org/named/item.json",
      type: "Manifest",
    });

    expect(slug).toBe("manifests/from-named");
    expect(source).toBe("named-template");
  });
});

test.each([
  "../outside",
  "manifests/%2e%2e/private",
  "manifests/%2fetc",
  "manifests/a\\b",
  "manifests/",
  "manifests/a%00",
  "/absolute",
  "C:/absolute",
  "bad%escape",
])("rejects unsafe final output path %s", (slug) => {
  expect(() => assertSafeSlug(slug)).toThrow("Unsafe IIIF slug");
});

test("resolves candidates before validation and preserves ARK identifiers", () => {
  const resolve = makeGetSlugHelper({} as any, {});
  expect(resolve({ id: "https://example.org/ark:/12345/object", type: "Manifest" })[0]).toBe("ark:/12345/object");
  expect(assertSafeSlug("ark:/12345/object")).toBe("ark:/12345/object");
  const unsafe = makeGetSlugHelper(
    { slugTemplate: { type: "Manifest", domain: "example.org", prefix: "/", addedPrefix: "../" } } as any,
    {}
  );
  expect(unsafe({ id: "https://example.org/object", type: "Manifest" })[0]).toBe("manifests/../object");
});
