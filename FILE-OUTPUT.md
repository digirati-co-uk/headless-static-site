# Generated file output

This document describes output format version 1, emitted by `iiif-hss` builds. JSON Schemas for HSS-owned files are published in `schemas/output-v1`; IIIF resources continue to follow the IIIF Presentation API.

## Output locations

The normal production build is written to `.iiif/build`. `--out <directory>` changes the production location. Development integrations write to `.iiif/dev/build`; in development this takes precedence in the Astro server helper when both trees exist.

Vite and Astro copy the production tree into the frontend build by default. The public destination is the integration's `basePath` (normally `/iiif`), or `outSubDir` when configured. For example:

```text
.iiif/build/manifests/example/manifest.json
        -> dist/iiif/manifests/example/manifest.json
        -> https://example.org/iiif/manifests/example/manifest.json
```

The configured `server.url`, `SERVER_URL`, or integration `serverUrl` is not the directory location. It is the canonical public base used to construct `id` values inside generated IIIF resources. Emitting without one fails before output is written.

A full production build reconciles the destination before emission, so deleted and renamed content cannot remain deployable. `--exact` and a non-empty `--stores` selection are explicit partial builds and retain merge semantics.

The cache trees (`.iiif/cache` and `.iiif/dev/cache`) are intermediate state, not deployment artifacts. They contain normalized `resource.json`, IIIF Vault state in `vault.json`, invalidation state in `caches.json`, request caches, and extraction/enrichment working files. Only the selected public metadata, indices, search records, and generated files described below are copied into the published build.

Generated JSON is UTF-8 and pretty-printed with two-space indentation. Generated JSONL has one compact JSON value per line and no enclosing array. HSS uses forward-slash URL/slug conventions even though local filesystem paths are resolved with the host platform's path implementation.

## Output at a glance

A full build can have the following shape. Names in angle brackets are variable; entries marked “conditional” are explained later.

```text
<build>/
├── collection.json
├── config/
│   ├── slugs.json
│   └── stores.json                       (opt-in source config)
├── manifests/
│   ├── collection.json
│   └── <manifest-slug>/
│       ├── manifest.json                 (when saved locally)
│       ├── meta.json
│       ├── indices.json
│       ├── search-record.json            (conditional)
│       ├── <index>.search.jsonl          (conditional canvas search data)
│       ├── <extraction-created files>    (conditional)
│       └── canvases/
│           ├── index.json
│           └── <zero-based-index>/
│               ├── meta.json             (conditional)
│               └── <extraction-created files>
├── collections/
│   ├── collection.json
│   ├── stores/collection.json
│   └── <collection-slug>/
│       ├── collection.json               (when saved or generated locally)
│       ├── meta.json                     (for source resources)
│       ├── indices.json                  (for source resources)
│       └── <extraction-created files>
├── stores/
│   └── <store-id>/collection.json
├── topics/
│   ├── collection.json
│   └── <topic-type>/
│       ├── collection.json
│       ├── meta.json
│       └── <topic>/
│           ├── collection.json
│           └── meta.json
├── meta/
│   ├── sitemap.json
│   ├── build.json                        (written last)
│   ├── resources.json
│   ├── resource-descriptors.json
│   ├── indices.json
│   ├── facets.json
│   ├── all-indices.json
│   ├── canvas-search-index.json
│   ├── editable.json                     (opt-in debug metadata)
│   ├── overrides.json                    (opt-in debug metadata)
│   ├── metadata-analysis.json            (conditional)
│   ├── trace.json                        (debug builds)
│   └── search/
│       ├── <index>.schema.json
│       ├── <index>.mapping.json
│       └── <index>.jsonl                 (conditional)
└── <global extraction/enrichment files>  (conditional)
```

Slugs can contain multiple path segments. `<manifest-slug>` above might therefore be `manifests/cookbook/0001`, not just one directory name.

## Core IIIF resources

### `collection.json`

The root file is an IIIF Presentation 3 Collection labelled `Index`. Its `items` contain every parsed Manifest followed by generated and source Collections in deterministic order. `hss:totalItems` is the direct item count.

Compact entries include values already known at build time: `label`, `summary`, `rights`, `requiredStatement`, `provider`, `homepage`, `navDate`, `behavior`, `thumbnail`, and `hss:totalItems` where applicable. Missing values are omitted. A typical entry is:

```json
{
  "id": "https://example.org/iiif/manifests/example/manifest.json",
  "type": "Manifest",
  "label": { "en": ["Example"] },
  "hss:slug": "manifests/example",
  "thumbnail": [{ "id": "https://example.org/image.jpg", "type": "Image", "width": 512, "height": 320 }]
}
```

`thumbnail` is omitted when none can be found. `hss:slug` is an HSS extension and is the stable bridge from a collection item to files below the build root. Consumers should not derive a slug by parsing `id`: remote resources may retain a remote `id`, while local output is still keyed by the HSS slug.

The root collection is the broadest inventory of parsed source resources. Use `manifests/collection.json` when only Manifests are wanted and `collections/collection.json` when presenting synthetic navigational/grouping collections.

### `<slug>/manifest.json`

This is the full IIIF Presentation 3 Manifest after linking, extraction, and enrichment. It exists for disk resources and for remote resources configured to be saved locally. When emitted:

- its `id` is rewritten to `<server-url>/<slug>/manifest.json` when a server URL is available;
- `hss:slug` is added if not already present;
- any enrichment changes to the resource are included;
- IIIF Canvas and annotation structures remain embedded in the Manifest.

A remote Manifest with `saveToDisk: false` intentionally has no local `manifest.json`. Its directory can still contain `meta.json`, `indices.json`, search records, and extracted files. Runtime helpers use `meta.json` to identify the remote source and fetch it on demand.

### `<slug>/collection.json`

This is the full IIIF Presentation 3 Collection for a locally saved source Collection or an HSS-generated folder/topic collection. Source Collection items are rewritten where possible to point at locally emitted Manifest or Collection JSON. HSS also fills missing item labels, thumbnails, and `hss:slug` values from the corresponding resource snippets.

If the Collection itself has no thumbnail, the first item thumbnail is used when available. Remote Collections that are not saved locally follow the same metadata-only pattern as remote Manifests.

### `manifests/collection.json`

This generated IIIF Collection, labelled `Manifests` by default, contains compact entries for every Manifest across all selected stores. The Astro and Vite examples use this as their primary listing API. Its label and other supported IIIF Collection properties can be overridden with `collections.manifests` configuration.

### `collections/collection.json`

This is the top-level navigation Collection, labelled `Collections` by default. It contains folder Collections plus exactly one `topics` branch and one `stores` branch. Topic types and individual stores appear only beneath those branches, avoiding duplicate navigation entries. Items are label-sorted.

### `collections/stores/collection.json`

This generated Collection contains one compact Collection entry per store. Each entry points to `stores/<store-id>/collection.json`.

### `stores/<store-id>/collection.json`

Each store Collection contains compact Manifest and Collection entries loaded from that store. Its ID comes from the config key and its label uses `metadata.label` when configured. This supports source-specific navigation without loading the complete root inventory.

### Folder collections

When `folder-collections` extraction assigns local Manifests to source folders, HSS emits:

```text
collections/<source-folder>/collection.json
```

Items are compact Manifest entries. The label is derived using the configured `folderName`, `metadata`, or `customMap` strategy. `hss:totalItems` reports the number of direct items. The generated Collection also appears in the higher-level collection exports.

### Topic collections

Resource `indices.json` values are inverted into browsable IIIF Collections:

```text
topics/collection.json
topics/<topic-type>/collection.json
topics/<topic-type>/meta.json
topics/<topic-type>/<topic>/collection.json
topics/<topic-type>/<topic>/meta.json
```

`topics/collection.json` lists topic types. A topic-type Collection lists its topic values. A leaf topic Collection lists the resource snippets tagged with that value. Topic keys, YAML directories, advertised slugs, IDs, and output directories all use the same normalized path; collisions fail the build by default. With `output.topicSlugCollisions: merge`, colliding topic labels share a collection with deduplicated members; the first sorted label is displayed and other labels appear in its metadata's `aliases` array. Raw indices and facets retain the original labels. Topic type collisions still fail. Topic and topic-type Collections include direct `hss:totalItems` counts.

## Per-resource application data

### `<slug>/meta.json`

`meta.json` is a merged object produced by enabled extractions and enrichments. It is intentionally application-oriented rather than a IIIF standard document. Keys depend on configuration and plugins, so consumers must tolerate missing and additional keys.

Common built-in keys include:

| Key                 | Source                          | Meaning                                                                                             |
| ------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `label`             | label extraction                | A convenient single-language label string.                                                          |
| `slugSource`        | slug-source extraction          | The slug rule/template that matched, when known.                                                    |
| `totalItems`        | slug-source extraction          | Parsed sub-resource count, usually Canvas count.                                                    |
| `thumbnail`         | thumbnail extraction/enrichment | The selected thumbnail descriptor. Its shape is extraction-dependent.                               |
| `url`               | remote-source extraction        | Original URL for a remote resource.                                                                 |
| `partOfCollections` | optional collection extraction  | Compact parent Collection references.                                                               |
| `files`             | files-list extraction           | Relative names of emitted resource files.                                                           |
| `filesDetail`       | files-list extraction           | Configured metadata for known emitted files.                                                        |
| `hss:runtime`       | always-on runtime hints         | Resource type, portable source descriptor, and whether full JSON is saved locally.                  |
| `hss:thumbnail`     | thumbnail extraction            | Stable `{ source, image }` thumbnail shape. The legacy `thumbnail` field remains for compatibility. |

The `hss:runtime` value has this shape:

```json
{
  "type": "Manifest",
  "source": { "type": "remote", "url": "https://remote.example/manifest" },
  "saveToDisk": false
}
```

Astro server/client helpers use it to choose local JSON or the remote source. Disk hints contain only `{ "type": "disk" }`; absolute and relative source paths are never published. This makes `meta.json` part of the runtime resolution contract, not merely display metadata.

### `<slug>/indices.json`

This maps facet or topic types to the values assigned to one resource:

```json
{
  "material": ["paper", "ink"],
  "creator": ["Example Person"]
}
```

Values come from enabled extractions and enrichments. Empty output is `{}`. Use this for resource-level tags, filter chips, related-content lookups, or breadcrumbs. The Astro and Vite clients return it as `loaded.indices` alongside `loaded.resource` and `loaded.meta`.

### `<slug>/search-record.json`

When `search.emitRecord` is true (the default) and a search extraction created a record, this contains the resource's intermediate search contribution. It can include `indexes`, `record`, and `remoteRecords`; it is not the same shape as a Typesense document alone.

The built-in Manifest record commonly contains `id`, `type`, `slug`, plain and multilingual labels, summary, thumbnail, URL, plaintext, item count, collections, and dynamic facet fields. Prefer `meta/search/<index>.jsonl` for bulk indexing and this file for inspecting or incrementally processing one resource.

### Extracted and enriched files

An extraction or enrichment can write arbitrary files into a resource's `files` working directory. At emission, the contents are copied directly beside `meta.json`—the `files` directory itself is not retained. For example, a cached `files/thumbnail.jpg` becomes:

```text
<build>/<slug>/thumbnail.jpg
```

Use `meta.files` and `meta.filesDetail` to discover these files when the files-list extraction is enabled. File names and formats otherwise belong to the plugin that created them.

## Canvas output

Enabled Canvas extractions and enrichments produce one directory per zero-based Canvas position:

```text
<slug>/canvases/0/meta.json
<slug>/canvases/0/<extracted-file>
<slug>/canvases/1/meta.json
```

Canvas `meta.json` is the same merge model as resource metadata. The built-in canvas-dimensions extraction contributes `width` and `height`; other steps can add thumbnails, OCR information, or custom fields. Canvas files are flattened from their working `files` directory into the Canvas directory.

With `output.includeCanvasIndex: true`, each emitted Manifest also has `<slug>/canvases/index.json`. It is disabled by default to keep builds small. Each entry contains the Canvas ID, zero-based position, label, dimensions, thumbnail, metadata/file links, and local or remote search availability. Use `getCanvasIndex(slug)` instead of inferring positional paths.

The Canvas's full IIIF JSON is not emitted separately. It remains inside its parent `manifest.json` or remote Manifest. Canvas `indices.json`, `search-record.json`, and invalidation caches are also not copied as individual files; relevant Canvas search data is emitted through the search files described below.

## Site-wide metadata and indices

### `meta/sitemap.json`

The sitemap is a slug-keyed inventory used by routing helpers and validation:

```json
{
  "manifests/example": {
    "type": "Manifest",
    "source": { "type": "remote", "url": "https://remote.example/manifest" },
    "label": "Example",
    "canvases": 12,
    "hasCanvasData": true
  }
}
```

`canvases` is set for Manifests. `hasCanvasData` is set only when a Canvas working directory exists. `source` is omitted by default because it may reveal local paths or private topology. Set `output.includeSourceConfig: true` only when those descriptors and the store configuration are safe to publish. Runtime local/remote resolution remains in per-resource `meta.json`.

### `meta/indices.json`

This is the inverse of every resource-level `indices.json`:

```json
{
  "material": {
    "paper": ["manifests/one", "manifests/two"],
    "ink": ["manifests/one"]
  }
}
```

It supports site-wide facets, counts, related-resource lookups, and topic generation without scanning every resource. Values are slugs, not resource URLs.

### `meta/facets.json`

This mirrors `meta/indices.json` but stores the resource count for each value. It supports filter UIs without loading or counting every slug array.

### `meta/all-indices.json`

This is the enrichment pipeline's accumulated map from each index name to all distinct values encountered. Search schema generation uses its keys to add dynamic `topic_<index>` facet fields. Unlike `meta/indices.json`, it contains value lists rather than value-to-resource mappings.

### `meta/build.json`

This is written only after every other output write succeeds. It declares the format, contract, and HSS versions, full/partial mode, canonical base URL, completion time, selected stores, features, counts, search descriptors, analysis artifacts, typed `entrypoints`, and a sorted SHA-256 file inventory. Entrypoints only advertise files that exist in the inventory. The manifest excludes its own checksum. Its presence marks a completed build.

### `meta/resources.json`

This final slug-to-snippet lookup includes parsed and synthetic resources. It replaces the old, misleading `meta/index-collection.json`, which was an intermediate object written repeatedly during folder generation.

### `meta/resource-descriptors.json`

This lookup contains one descriptor per parsed source resource. Each descriptor records `hss:slug`, canonical IIIF ID, type, optional opaque caller `inputKey`, local-save status, exact emitted file links, and known parent/child source slugs. Portable `provenance` distinguishes local, remote, and locally overridden resources; overrides include only their upstream URL. `origin: "source"` distinguishes these entries from HSS-generated navigation and topic Collections in `meta/resources.json`. It never includes source paths, headers, credentials, or store configuration.

All descriptor links are normalized paths relative to the output root and occur in the build manifest inventory. Use this file for caller correlation and per-resource artifact lists instead of recursively scanning output JSON.

### `meta/editable.json`

This maps a disk-backed resource slug to its source file path. It is emitted only with `output.includeDebugMetadata: true`.

### `meta/overrides.json`

This maps local aliases and saved remote-resource slugs to emitted Manifest paths. It is emitted only with `output.includeDebugMetadata: true`.

### `meta/metadata-analysis.json`

When the optional metadata-analysis extraction runs, this summarizes metadata keys, common values, comma-split values, languages, and keys whose values remain mostly unique. It is written as a global extraction file and copied into the build. Its purpose is configuration discovery: it helps identify promising facets and topic mappings.

### `meta/trace.json`

This exists when a tracer is present and `debug` output is enabled. It contains internal build trace data for inspection and is not a stable content API.

## Search output

### `meta/search/<index>.schema.json`

For each configured search index, HSS emits a Typesense-compatible schema:

```json
{
  "name": "manifests",
  "enable_nested_fields": true,
  "fields": [
    { "name": "id", "type": "string" },
    { "name": "label", "type": "string" }
  ]
}
```

Configured and dynamic topic facets are included. This file describes the companion combined JSONL records and can be used to provision an external search service.

### `meta/search/<index>.jsonl`

Unless that index has `emitCombined: false`, this newline-delimited JSON file contains one search document per line. JSONL is intended for streaming and bulk import; it is not a JSON array and should be parsed line by line.

### `meta/search/<index>.mapping.json`

The descriptor links the schema and optional combined data file, declares record scope and ID strategy, lists facets, and links the Canvas search registry. `meta/build.json` lists every descriptor, so clients do not need to infer behavior from file names.

### `<manifest-slug>/<index>.search.jsonl`

When Canvas enrichment produces local records for an index, they are grouped per Manifest into a JSONL file. This allows Canvas/OCR indexing without one site-wide in-memory file.

### `meta/canvas-search-index.json`

This manifest-keyed registry tells the `search-index` command where Canvas records live. Each entry is either local:

```json
{
  "index": "canvases",
  "type": "file",
  "format": "record-jsonl",
  "path": "manifests/example/canvases.search.jsonl"
}
```

or remote:

```json
{
  "index": "canvases",
  "type": "remote",
  "format": "alto-xml",
  "url": "https://example.org/ocr.xml",
  "recordId": "page-1",
  "canvasIndex": 0,
  "canvas": { "w": 2000, "h": 3000 }
}
```

The file is always emitted and is `{}` when there is no Canvas search data. Supported format handling includes individual records, JSONL, and ALTO XML; custom format strings can be registered in the contract but need corresponding downstream handling.

## Configuration snapshots

### `config/slugs.json`

This is the resolved `slugs` configuration, or `{}`. Runtime helpers use it to reverse a local slug into a possible remote URL when source metadata alone is insufficient.

### `config/stores.json`

This is the resolved store configuration and exists only with `output.includeSourceConfig: true`. It can include source paths, remote URLs, plugin settings, headers, and credentials; audit it before enabling the option.

These files are build inputs copied into the output for runtime/debug use; they are not JSON Schema files. The authoring schemas remain in the package's `schemas/` directory.

## Global generated files

Extraction and enrichment collectors can write to the global working `files` directory. Its contents are copied recursively into the build root before individual resources are emitted. `meta/metadata-analysis.json` is one built-in example. Custom scripts can therefore add arbitrary site-level assets or datasets; their paths, formats, and stability are defined by those scripts.

Generator output is separate. `iiif-hss generate` writes generator-specific resources below `.iiif/_generator/<generator>/build`, and those resources only enter the static site when a configured store reads that directory in the subsequent build.

## Partial-build behavior

`--exact <slug-or-path>` loads and emits only the matching resource. `--stores <store...>` restricts input stores. In both modes the site-wide index stage is skipped, so aggregate Collections, configuration snapshots, and global metadata are not regenerated. Resource output and `meta/canvas-search-index.json` can still be written.

These modes update an existing output directory rather than creating a self-contained complete site. Files not touched by the partial build remain on disk. The final `meta/build.json` identifies the result as `mode: "partial"` and lists the resulting tree.

`emit: false` skips the emission stage and the final buffered write, although extraction/enrichment work can still update cache state. It does not produce a deployable build.

A full production build removes the previous generated destination before emission. Development and partial builds retain merge behavior.

## How the bundled examples consume output

The Vite React example uses `createIiifViteClient()` to:

1. fetch `manifests/collection.json` for a listing;
2. read `hss:slug` from each compact entry;
3. load the corresponding Manifest through `loadManifest(slug)`;
4. pass the returned IIIF resource to `react-iiif-vault`;
5. link directly to `<slug>/meta.json` for inspection.

The Astro examples use `createIiifAstroServer()` during static generation to read the build tree directly. They derive routes from the sitemap or aggregate collection, load a resource with its `meta` and `indices`, and expose a client component that repeats the lookup through HTTP. The remote example demonstrates metadata-only resource directories; the save example demonstrates local `manifest.json` files.

The custom-routes Astro example uses the same output while mapping HSS `manifests/...` and `collections/...` slugs onto application routes such as `/objects/...` and `/browser/...`. This confirms that output slugs and website routes are separate concerns.

## Consumption guidance

The Astro server/client and Vite client expose `getBuildManifest()`, `getResources()`, `getIndices()`, `getIndex(type)`, `getFacetCounts()`, `getTopicCollection()`, `getStoreCollection(id)`, `getSearchDescriptors()`, and `getCanvasIndex(slug)`. `pagePathForResource()` centralizes route-prefix stripping and URL encoding. Static-path methods accept `{ props: true }` to attach the sitemap entry or compact snippet.

- Use an HSS client/server helper when possible. It handles development versus production paths, metadata-only remote resources, route prefixes, and local/remote links.
- For a listing, start with `manifests/collection.json`, `collections/collection.json`, or a store/topic Collection instead of scanning directories.
- Preserve and pass `hss:slug`; do not reconstruct it from `id`.
- Treat `meta.json`, `indices.json`, and all `meta/` files as extensible objects. Feature-detect keys rather than requiring one fixed schema.
- Treat generated IIIF Collections and resource JSON as public content. Source configuration and debug metadata are private by default, but custom files still require an audit.
- Serve `.json` as `application/json`, `.jsonl` as `application/x-ndjson` (or another JSONL media type accepted by the consumer), XML with its correct media type, and image/assets according to their extensions.
- Preserve the directory hierarchy when deploying. IDs, collection links, search registries, and client helper paths assume it remains intact.
- Deploy the completed tree marked by `meta/build.json` atomically when the hosting platform supports it.

## Stability boundaries

IIIF Presentation resources follow the IIIF Presentation 3 shape, with HSS extension properties such as `hss:slug` and `hss:totalItems`. The following are application/internal contracts and should currently be considered more changeable: `meta.json` keys, sitemap source descriptors, search-record intermediates, config snapshots, debug traces, and arbitrary plugin-created files.

Output format 1 is declared by `meta/build.json` and schemas in `schemas/output-v1`. Per-resource `meta.json` and plugin-created files remain extensible; consumers should validate and feature-detect the subset they use.

## Compatibility notes for output format 1

- A canonical server URL is mandatory for emitted builds.
- Full production builds remove stale destination content; partial builds continue merging.
- Failed writes and core/custom output collisions fail the build.
- `meta/index-collection.json` was replaced by final `meta/resources.json`.
- Store configuration, editable paths, overrides, and sitemap source descriptors are private by default. Use the `output` opt-ins only after auditing store/plugin values.
- Topic paths use normalized keys consistently; deployments relying on raw case, spaces, punctuation, or non-ASCII directory names must update links.
- Aggregate ordering is deterministic. Consumers must not rely on the previous queue-completion order.
- Existing `<index>.search.jsonl` Canvas names remain supported; new code should use descriptors rather than infer meaning from names.

Pagination and streaming of aggregate IIIF Collections remain threshold-gated: format 1 keeps compatible single-file Collections until profiling demonstrates a real memory or payload limit.
