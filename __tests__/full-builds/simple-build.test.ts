import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Volume } from "memfs";
import { type IFS, Union } from "unionfs";
import { describe, expect, test } from "vitest";
import { FileHandler, build, defaultBuiltIns } from "../../src/library";

describe("Simple full build", () => {
  test("simple in memory full build", async () => {
    const memory = new Volume();
    const ufs = new Union();
    ufs.use(memory as any as IFS);

    const requests = await readFile(
      "./__tests__/full-builds/cache/requests.json",
    );

    // Load network cache.
    memory.fromJSON(JSON.parse(requests.toString()));

    const path = join("/test-example");

    memory.mkdirSync(path, { recursive: true });
    memory.mkdirSync(join(path, "/content"), { recursive: true });

    memory.writeFileSync(
      join(path, "/.iiifrc.yml"),
      `
    server:
      url: http://localhost:7111

    run:
      - flat-manifests
      - extract-remote-source
      - extract-slug-source
      - extract-label-string
      - extract-thumbnail
      - metadata-analysis
      - folder-collections

    stores:
      bridges:
        type: iiif-remote
        url: https://view.nls.uk/collections/7446/74466699.json
        slugTemplates:
          - nls-manifests
          - nls-collections
        skip:
          - manifest-sqlite

    slugs:
      nls-manifests:
        type: Manifest
        domain: view.nls.uk
        prefix: /manifest/
        suffix: /manifest.json
        addedPrefix: nls-
        examples:
          - https://view.nls.uk/manifest/7446/74464117/manifest.json
        pathSeparator: "-"

      nls-collections:
        type: Collection
        domain: view.nls.uk
        prefix: /collections/
        suffix: .json
        addedPrefix: nls-
        examples:
          - https://view.nls.uk/collections/7446/74466699.json
    `,
    );

    const handler = new FileHandler(ufs, path, true);

    const enrichments = defaultBuiltIns.enrichments.filter(
      (t) => t.id !== "manifest-sqlite",
    );

    await build(
      {
        debug: false,
        config: join(path, ".iiifrc.yml"),
        emit: true,
        extract: true,
        enrich: true,
      },
      { ...defaultBuiltIns, enrichments },
      { fileHandler: handler },
    );

    expect(Array.from(handler.openBinaryMap.keys())).toMatchInlineSnapshot(`
      [
        "/test-example/.iiifrc.yml",
      ]
    `);

    expect(Array.from(handler.openJsonMap.keys())).toMatchInlineSnapshot(`
      [
        "/test-example/.iiif/cache/collections/74466699/resource.json",
        "/test-example/.iiif/cache/collections/74466699/vault.json",
        "/test-example/.iiif/cache/collections/74466699/meta.json",
        "/test-example/.iiif/cache/collections/74466699/caches.json",
        "/test-example/.iiif/cache/collections/74466699/indices.json",
        "/test-example/.iiif/cache/manifests/nls-7446-74464117/resource.json",
        "/test-example/.iiif/cache/manifests/nls-7446-74464117/vault.json",
        "/test-example/.iiif/cache/manifests/nls-7446-74464117/meta.json",
        "/test-example/.iiif/cache/manifests/nls-7446-74464117/caches.json",
        "/test-example/.iiif/cache/manifests/nls-7446-74464117/indices.json",
        "/test-example/.iiif/cache/manifests/nls-7446-74465507/resource.json",
        "/test-example/.iiif/cache/manifests/nls-7446-74465507/vault.json",
        "/test-example/.iiif/cache/manifests/nls-7446-74465507/meta.json",
        "/test-example/.iiif/cache/manifests/nls-7446-74465507/caches.json",
        "/test-example/.iiif/cache/manifests/nls-7446-74465507/indices.json",
        "/test-example/.iiif/build/meta/indices.json",
        "/test-example/.iiif/build/collection.json",
        "/test-example/.iiif/build/manifests/collection.json",
        "/test-example/.iiif/build/stores/bridges/collection.json",
        "/test-example/.iiif/build/collections/collection.json",
        "/test-example/.iiif/build/config/slugs.json",
        "/test-example/.iiif/build/config/stores.json",
        "/test-example/.iiif/build/meta/sitemap.json",
        "/test-example/.iiif/build/meta/editable.json",
        "/test-example/.iiif/build/meta/overrides.json",
      ]
    `);

    expect(memory.toTree({ depth: 100 })).toMatchInlineSnapshot(`
      "/
      └─ test-example/
         ├─ .iiif/
         │  ├─ build/
         │  │  ├─ collection.json
         │  │  ├─ collections/
         │  │  │  ├─ 74466699/
         │  │  │  │  ├─ indices.json
         │  │  │  │  └─ meta.json
         │  │  │  └─ collection.json
         │  │  ├─ config/
         │  │  │  ├─ slugs.json
         │  │  │  └─ stores.json
         │  │  ├─ manifests/
         │  │  │  ├─ collection.json
         │  │  │  ├─ nls-7446-74464117/
         │  │  │  │  ├─ indices.json
         │  │  │  │  └─ meta.json
         │  │  │  └─ nls-7446-74465507/
         │  │  │     ├─ indices.json
         │  │  │     └─ meta.json
         │  │  ├─ meta/
         │  │  │  ├─ editable.json
         │  │  │  ├─ indices.json
         │  │  │  ├─ metadata-analysis.json
         │  │  │  ├─ overrides.json
         │  │  │  └─ sitemap.json
         │  │  └─ stores/
         │  │     └─ bridges/
         │  │        └─ collection.json
         │  └─ cache/
         │     ├─ _requests/
         │     │  └─ bridges/
         │     │     ├─ 2ed329c70114ef8ae3df1c8daaa6da32a190449e9079c6697cb293da59b37914.json
         │     │     ├─ 98a629b26e33a6e9ac68a1c8426ef6cd6cd3ab6c49ba73f4531c64ca14958945.json
         │     │     └─ d2dfdad241ab9f71cf400929a890da1568da514f4211ec53e1d12b9f969016ea.json
         │     ├─ collections/
         │     │  └─ 74466699/
         │     │     ├─ caches.json
         │     │     ├─ indices.json
         │     │     ├─ meta.json
         │     │     ├─ resource.json
         │     │     └─ vault.json
         │     ├─ files/
         │     │  └─ meta/
         │     │     └─ metadata-analysis.json
         │     └─ manifests/
         │        ├─ nls-7446-74464117/
         │        │  ├─ caches.json
         │        │  ├─ indices.json
         │        │  ├─ meta.json
         │        │  ├─ resource.json
         │        │  └─ vault.json
         │        └─ nls-7446-74465507/
         │           ├─ caches.json
         │           ├─ indices.json
         │           ├─ meta.json
         │           ├─ resource.json
         │           └─ vault.json
         ├─ .iiifrc.yml
         └─ content/"
    `);

    expect(
      await handler.loadJson(
        "/test-example/.iiif/build/manifests/nls-7446-74464117/meta.json",
      ),
    ).toMatchInlineSnapshot(`
      {
        "label": "Forth Bridge illustrations 1886-1887",
        "slugSource": "nls-manifests",
        "thumbnail": {
          "height": 113,
          "id": "https://deriv.nls.uk/dcn4/7443/74438561.4.jpg",
          "type": "fixed",
          "unsafe": true,
          "width": 150,
        },
        "totalItems": 40,
        "url": "https://view.nls.uk/manifest/7446/74464117/manifest.json",
      }
    `);

    expect(
      await handler.loadJson(
        "/test-example/.iiif/build/manifests/collection.json",
      ),
    ).toMatchInlineSnapshot(`
      {
        "@context": "http://iiif.io/api/presentation/3/context.json",
        "hss:slug": "manifests",
        "id": "http://localhost:7111/manifests/collection.json",
        "items": [
          {
            "hss:slug": "manifests/nls-7446-74464117",
            "id": "https://view.nls.uk/manifest/7446/74464117/manifest.json",
            "label": {
              "none": [
                "Forth Bridge illustrations 1886-1887",
              ],
            },
            "thumbnail": [
              {
                "height": 113,
                "id": "https://deriv.nls.uk/dcn4/7443/74438561.4.jpg",
                "type": "Image",
                "width": 150,
              },
            ],
            "type": "Manifest",
          },
          {
            "hss:slug": "manifests/nls-7446-74465507",
            "id": "https://view.nls.uk/manifest/7446/74465507/manifest.json",
            "label": {
              "none": [
                "Tay Bridge enquiry",
              ],
            },
            "thumbnail": [
              {
                "height": 107,
                "id": "https://deriv.nls.uk/dcn4/7443/74438559.4.jpg",
                "type": "Image",
                "width": 150,
              },
            ],
            "type": "Manifest",
          },
        ],
        "label": {
          "en": [
            "Manifests",
          ],
        },
        "summary": undefined,
        "type": "Collection",
      }
    `);
  });
});
