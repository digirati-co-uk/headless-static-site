import { describe, test, expect } from "bun:test";
import {
  compileReverseSlugConfig,
  compileSlugConfig,
  SlugConfig,
} from "../../src/util/slug-engine";

describe("slug-engine", () => {
  test("should be able to compile a config", () => {
    const config: SlugConfig = {
      type: "Manifest",
      prefix: "https://example.org/iiif",
      pattern: "/:id/manifest.json",
      slugTemplate: `/manifests/:id`,
    };

    const compiled = compileSlugConfig(config);

    const test1 = compiled("https://example.org/iiif/123/manifest.json");

    expect(test1).toEqual(["/manifests/123", { id: "123" }]);
  });

  test("should work with collections", () => {
    const config: SlugConfig = {
      type: "Collection",
      prefix: "https://view.nls.uk/collections/",
      pattern: "/:id1/:id2.json",
      slugTemplate: "nls-:id1-:id2",
      examples: ["https://view.nls.uk/collections/7446/74466699.json"],
    };

    const compiled = compileSlugConfig(config);

    const test1 = compiled(
      "https://view.nls.uk/collections/7446/74466699.json",
    );

    expect(test1).toEqual([
      "nls-7446-74466699",
      { id1: "7446", id2: "74466699" },
    ]);
  });

  test("wellcome collection", () => {
    // Test this config:
    //   wellcome-collection:
    //     type: Collection
    //     prefix: https://iiif.wellcomecollection.org/
    //     pattern: /presentation/collections/:id+
    //     slugTemplate: wellcome/collections/:id+
    //     examples:
    //       - https://iiif.wellcomecollection.org/presentation/collections/digitalcollections/digpaintings
    const config: SlugConfig = {
      type: "Collection",
      prefix: "https://iiif.wellcomecollection.org/",
      pattern: "/presentation/collections/:a/:b?",
      slugTemplate: "wellcome/collections/:a/:b?",
      examples: [
        "https://iiif.wellcomecollection.org/presentation/collections/digitalcollections/digpaintings",
      ],
    };

    const compiled = compileSlugConfig(config);
    const reverse = compileReverseSlugConfig(config);

    const test1 = compiled(
      "https://iiif.wellcomecollection.org/presentation/collections/digitalcollections/digpaintings",
    );

    expect(test1).toEqual([
      "wellcome/collections/digitalcollections/digpaintings",
      { a: "digitalcollections", b: "digpaintings" },
    ]);

    const test2 = reverse(
      "/wellcome/collections/digitalcollections/digpaintings",
    );
    expect(test2).toEqual([
      "https://iiif.wellcomecollection.org/presentation/collections/digitalcollections/digpaintings",
      { a: "digitalcollections", b: "digpaintings" },
    ]);

    const test3 = reverse("/wellcome/collections/digitalcollections");
    expect(test3).toEqual([
      "https://iiif.wellcomecollection.org/presentation/collections/digitalcollections",
      { a: "digitalcollections" },
    ]);
  });
});
