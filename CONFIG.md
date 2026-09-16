# IIIF HSS config files

This package supports two config styles:

1. A single root config file (`.iiifrc.yml`, `.iiifrc.yaml`, `iiif.config.js`, or `iiif.config.ts`)
2. A folder config (`iiif-config/`) with split files

When both exist, root files win over `iiif-config/`.

## JSON Schemas

These schemas are in `./schemas`:

- `schemas/iiif-hss.root-config.schema.json`
- `schemas/iiif-hss.store.schema.json`
- `schemas/iiif-hss.plugin-config.schema.json`

They currently use a placeholder hosted ID:

- `https://schemas.example.org/iiif-hss/...`

Replace that host/path with your final location before publishing.

## 1) Root config file (`.iiifrc.yml` / `iiif-config/config.yml`)

Use `schemas/iiif-hss.root-config.schema.json`.

Typical keys:

- `server`
- `run`
- `builtInScripts`
- `generators`
- `stores`
- `slugs`
- `config`
- `collections`
- `search`
- `network`
- `concurrency`
- `fileTemplates`
- `output`

Set `builtInScripts: false` to use only project scripts from the scripts directory.
This removes all built-in extractions (including runtime hints), enrichments, rewrites,
and linkers, and disables the default run list. Select project scripts explicitly in
`run` or each store's `run`. Within each build phase, scripts run in `run` order;
store-only steps follow the global steps. Projects using runtime helpers should provide their own
`extract-runtime-hints` step to emit `hss:runtime` metadata.

Production output omits source store configuration, editable source paths, and overrides by default. Opt in only when those operational details are safe to publish:

```yaml
output:
  includeSourceConfig: true
  includeDebugMetadata: true
```

Per-Manifest Canvas indexes are also disabled by default because they can add significantly to large builds. Enable them when clients use `getCanvasIndex(slug)`:

```yaml
output:
  includeCanvasIndex: true
```

Topic labels that normalize to the same URL fail by default. For legacy datasets,
`output.topicSlugCollisions: merge` combines their resources into one topic collection,
deduplicates members, and records alternate labels in the topic metadata's `aliases`.
The first label in sorted order is displayed; raw indices and search facets retain
the original labels. Topic type collisions still fail.

YAML example:

```yaml
$schema: https://schemas.example.org/iiif-hss/iiif-hss.root-config.schema.json

stores:
  local:
    type: iiif-json
    path: ./content
```

Set `collections.index.items` to replace the root collection's default items with
collection or manifest slugs in the given order. Other collection customisations
still apply. Omit `items` to keep the defaults, or use `items: []` for an empty
index. Unknown slugs fail the build. Generated collection slugs such as `topics`,
`manifests`, `collections`, and `stores/<store-id>` can also be included.

```yaml
collections:
  index:
    label:
      en: [Featured items]
    items:
      - stores/local
      - my-manifest
```

## 2) Store files (`iiif-config/stores/*.json`)

Use `schemas/iiif-hss.store.schema.json`.

Supported store types:

- `iiif-json`
- `iiif-remote`

Important: `remote-json` is not a supported type.

Remote store example:

```json
{
  "$schema": "https://schemas.example.org/iiif-hss/iiif-hss.store.schema.json",
  "type": "iiif-remote",
  "url": "https://example.org/iiif/collection.json",
  "network": {
    "concurrency": 1,
    "minDelayMs": 300,
    "maxRetries": 6
  },
  "slugTemplate": {
    "type": "Manifest",
    "domain": "example.org",
    "prefix": "/iiif/manifests/",
    "suffix": "-manifest.json"
  }
}
```

`network` can also be set globally in root config. Useful options are:

- `prefetch` (default `true`) - run warm-up automatically in `iiif-hss build`
- `concurrency` - max concurrent remote fetches
- `minDelayMs` - minimum delay between request starts
- `maxRetries`, `baseDelayMs`, `maxDelayMs`, `retryStatuses`, `respectRetryAfter`

CLI:

- `iiif-hss warm` warms the remote request cache
- `iiif-hss build --no-prefetch` skips warm-up for one run

`slugTemplate` can be inline on the store (object or array). `slugTemplates` still works for referencing entries from top-level `slugs`.

Local store example:

```json
{
  "$schema": "https://schemas.example.org/iiif-hss/iiif-hss.store.schema.json",
  "type": "iiif-json",
  "path": "./content",
  "pattern": "**/*.json"
}
```

## 3) Nested store files (`iiif-config/stores/<name>/_store.json`)

Use the same store schema: `schemas/iiif-hss.store.schema.json`.

For nested `iiif-json` stores, if `path` is omitted, it defaults to:

- `iiif-config/stores/<name>/manifests`

## 4) Plugin config fragments (`iiif-config/config/*.json`)

Use `schemas/iiif-hss.plugin-config.schema.json`.

These files are mounted into `config.<fileName>` and are intentionally plugin-specific, so the schema only enforces valid object JSON.

## Featured collections

Configure `collections.featured` to emit `featured/collection.json`. It gathers
Collections whose final, explicitly authored `behavior` includes `hss:featured`.
Source IIIF, folder declarations (`collection.json`, `collection.yml`,
`collection.yaml` and their `_collection` equivalents), and ordinary collection
enrichment can supply that marker. Inherited behaviours do not select children.

```yaml
collections:
  featured:
    label: { en: [Collections] }
    summary: { en: [Explore our collections.] }
    thumbnail:
      - id: https://example.org/images/collections.jpg
        type: Image
  index:
    items: [featured, manifests]
```

Automatic selection sorts by label, then slug. Optional `collections.featured.items`
replaces it with collection slugs in your chosen order; unmarked collections can
be included. An empty list produces an empty collection. Unknown, duplicate,
Manifest and self-referencing (`featured`) selections fail the build. Omit the
whole `featured` configuration to disable this output. The slug `featured` is
reserved while it is enabled.

```yaml
collections:
  featured:
    items:
      - collections/academic-heritage
      - collections/printed-works
```

Sections embed their immediate members as rich cards, including label, summary,
thumbnail, custom behaviours, metadata and direct collection counts. Cards do not
embed further descendants or Manifest canvases. Update card/section descriptions
on the source collection or through enrichment, not in page configuration. Custom
behaviours can drive frontend styles; HSS only interprets `hss:featured` for selection.
Generated topic/store aggregate collections are selected after construction and
can carry behaviours via their existing configuration; they do not run through
ordinary collection enrichment.

### Late collection finalizers

Collection finalizers run after all output collections (including folders, topics,
stores, the root index and featured collections) exist, before files are saved and
hashed. Enable them in the project-level `run` list, in execution order. They run
on every full emitting build, including cached/dev builds; partial (`exact` or
store-filtered) builds and builds without emission skip this phase. Store-level
`run`/`skip` do not select finalizers because they operate on the site-wide graph.
Remote collections without a local output document are not finalized or fetched.

The first built-in is `featured-part-of`:

```yaml
run:
  - folder-collections
  - featured-part-of
collections:
  featured:
    items: [collections/archive]
```

It follows the complete collection graph starting at `featured`, beyond featured
output's two embedded levels. For a path Featured → A → B → C, C receives:

```json
{
  "partOf": [
    { "id": "https://example.org/iiif/featured/collection.json", "type": "Collection", "label": { "en": ["Featured"] }, "hss:slug": "featured" },
    { "id": "https://example.org/iiif/collections/a/collection.json", "type": "Collection", "label": { "en": ["A"] }, "hss:slug": "collections/a" },
    { "id": "https://example.org/iiif/collections/b/collection.json", "type": "Collection", "label": { "en": ["B"] }, "hss:slug": "collections/b" }
  ]
}
```

Ancestors are ordered root-first, excluding the current collection. The step
replaces authored `partOf` on reachable descendants with one breadcrumb path.
Shared descendants use the first depth-first path encountered; cycles are skipped.
Unreachable collections, the featured root and manifests retain their existing
metadata. No featured output means no breadcrumb changes. This is a site-navigation
convention on `partOf`, rather than a list of only immediate IIIF parents.

Register your own finalizer from a JS/TS file in the configured scripts directory:

```js
import { finalizeCollection } from "iiif-hss";

finalizeCollection(
  { id: "collection-style", name: "Collection style" },
  (collection, { slug, collections }, config) => {
    if (slug === "collections/archive") collection.background = config.background;
  }
);
```

Select `collection-style` in `run` and put its options under
`config.collection-style` (for example `background: "#f00"`). The handler receives
mutable output JSON, an API with `slug`, `collections` (keyed by slug; root index
uses `""`) and the project `config`, plus the step's options as its third argument.
Optional `configure(api, options)` runs once and supplies the handler's third
argument; optional `close(options)` runs after the step, including handler failures.
Programmatic builds can supply `BuildBuiltIns.collectionFinalizers`.

Edit the collection document once. The phase propagates metadata additions,
changes and deletions to collection references in aggregate output and
`meta/resources.json`. Membership edits refresh counts and the immediate members
of embedded featured sections, without embedding their descendants. Identity
(`id`, `type`, `hss:slug`) must remain unchanged; routing and resource creation
belong to earlier phases. This phase does not rerun extraction/search indexing or
modify manifest documents. Put membership-editing steps before `featured-part-of`
so breadcrumbs reflect the final hierarchy.

### Folder collection authoring

Folder declarations may be named `collection.json`, `collection.yml`,
`collection.yaml`, `_collection.json`, `_collection.yml` or `_collection.yaml`.
They are discovered independently of a JSON-only store pattern, including when
`subFiles: true`. Only one declaration may define a folder. Declarations support
arbitrary properties, including custom fields such as `background`, alongside
IIIF `label`, `summary`, `thumbnail`, `behavior`, `metadata` and `items`; strings in
labels/summaries/metadata become language maps. IDs are generated when omitted;
existing IDs are preserved internally and rewritten to public output URLs.
Presentation 2 declarations are upgraded to Presentation 3. Custom properties
are preserved in emitted resources and collection/index snippets, including
properties in ordinary manifest JSON. Snippets omit resource bodies (`items`,
`annotations`, `structures`) and the JSON-LD context; generated public IDs and
`hss:slug` still follow the configured output routing.

```yaml
label: Scientific instruments
background: "#f00" # Quote colours: an unquoted # starts a YAML comment.
summary: Instruments used in teaching and research.
behavior:
  - hss:featured
  - https://example.org/behaviors/theme-yellow
metadata:
  - label: Objects in collection
    value: '56'
thumbnail:
  - id: https://example.org/images/instruments.jpg
    type: Image
items:
  - manifests/telescope
  - collections/teaching
  - id: https://example.org/external/collection.json
    type: Collection
    label: { en: [External collection] }
```

Folder collections materialise before extraction/enrichment. Both explicit and
implicit folders use configured store `base`/`destination` slug rules, or
`collections/<relative-folder>` when neither is configured. A store-root
declaration defaults to `collections/<store-id>` to avoid the generated collection
index. Existing collection rewrites apply afterwards. `customMap` labels take
precedence over sidecar labels; absent authored labels fall back to the folder
name. Automatic generation respects the folder extraction's enable, depth and
ignore settings; explicit sidecars are authored resources even if automatic
folder grouping is disabled.

Folder collections merge authored `items`, direct resources and immediate child
folder collections, in that order. Discovery is sorted by source path; duplicate
IIIF IDs keep their first entry. Slug strings resolve after all stores and rewrites,
so they can reference local, remote or in-memory resources in any store order.
Unknown slugs, invalid entries and self-references fail clearly. External IIIF
reference objects do not import or fetch content. Slugs must identify parsed source
resources; later-generated aggregates such as topics/featured are not available here.

An authored folder discovers implicit descendant collections even without enabling
`folder-collections`; configured ignore/depth limits still apply. Empty collections
are supported with an explicit declaration. Ordinary collection enrichment can
populate or sort their items without changing the source files. Sidecars and source resource changes are
picked up by normal builds and watch mode. If an automatic folder shares its final
slug with an authored collection inside that folder (or an adjacent JSON file with
the same name), the authored collection supplies the membership and metadata.
Generated parents link to that collection without appending unlisted folder items.
Explicit sidecar conflicts and unrelated generated slug collisions still fail.

See [the composable stores example](examples/vite-collections/README.md) for both
client folder layouts, eight separately configured recipes and build verification.

See [the Vite featured homepage example](examples/vite-featured/README.md) for a
working page, authoring examples and one runnable build verification script.


### Build performance controls

`output.includeResourceDescriptors` defaults to `false`. Enable it when debugging
per-resource artifact ownership or using caller `inputKey` correlation:

```yaml
output:
  includeResourceDescriptors: true
concurrency:
  load: 4
```

Enabling descriptors emits a warning about additional processing and output size.
The dev server and standard HSS clients do not need them; output validation checks
them when present. Disabling the flag removes stale descriptors in dev/partial
output too. `concurrency.load` bounds simultaneous resource loads and local JSON
reads (default at most four, respecting a lower `concurrency.io`). Source order is
preserved; set it to `1` for a custom store requiring serial loads.

The programmatic `build()` return value includes `timings` in milliseconds, with
phase durations and separate `copy-preflight`, `writes`, `copies`, `inventory` and
`descriptors` timings. The output contract in `meta/build.json` stays focused on
published files. Run `node benchmarks/build.mjs --cwd <fixture> --report <report.json>`
after building HSS to record a benchmark. `--no-cache` disables resource-cache
reuse; it does not clear OS caches or delete the fixture cache.

Folder collections retain their cache-file timestamps when final membership and
metadata are unchanged. Aggregate collections and featured cards still rebuild,
so changes to referenced objects are reflected without a dependency graph.
Delft-owned steps that always invalidate still run. This is not a full incremental
pipeline: production builds still recreate output to remove deleted resources.

To disable a project-owned SQLite step, remove `manifest-sqlite` from its `run`
lists. It is already absent from HSS's default steps. The benchmark's
`--no-sqlite` option applies this change only to its in-memory config. Remove a
previously generated `files/meta/manifests.db` from the project cache once (or use
a clean cache), because arbitrary project-script files are otherwise copied again.

### Cacheable extraction results

Manifest and Collection extractions can opt into result caching. Existing scripts
keep their `invalidate()` behaviour unless they declare `cache`:

```js
extract(
  {
    id: "image-summary",
    name: "Image summary",
    types: ["Manifest"],
    cache: { version: "1" },
    async collect(temp, api) {
      // Includes every current resource, even when its handler was cached.
      await api.fileHandler.saveJson(`${api.build.filesDir}/meta/image-summary.json`, temp);
    },
  },
  async (_, api) => ({ temp: { canvases: api.resource.items.length } })
);
```

The key includes normalized Vault state, source/slug, build configuration,
effective step configuration, handler code and the explicit version. Bump `version`
when imported helpers or closed-over behaviour changes. Declare other inputs with
`cache.key(resource, api, config)`; its returned value becomes part of the key. For
example, a step reading generated schema data can return
`api.resourceFiles.loadJson("schema.json")`. Include upstream metadata read by the
handler too. Returning `undefined` bypasses reuse for that invocation.

For an opted-in step, this key replaces `invalidate()`. `build({cache: false})`
bypasses reuse and records fresh results. Use `extractionCache: false` (CLI:
`iiif-hss build --no-extraction-cache`) to recompute opted-in handlers while keeping
source and network caches. Fresh results remain reusable on the next build. `result.extractions.cacheStats` reports
per-step `hits`, `misses` and `bypassed` counts; the benchmark includes these counts.

**Eligibility:** the handler must return JSON data, must not mutate the resource
or Vault, and must not write files or perform other side effects. Its output fields
must be exclusively owned by that step: metadata keys, index keys, cache keys,
search-record fields, remote-record groups and search-index membership it returns.
HSS detects overlapping fields returned by per-resource extraction handlers, but cannot detect direct
mutations or dependencies read through arbitrary user code. Leave such scripts on
manual invalidation. Canvas extraction and enrichment result caching are not yet
supported; opting a Canvas extraction into this cache produces an error.

On a hit HSS replays `temp`, `collections`, `meta`, `indices`, `caches` and `search`.
Collectors still run using all current resources in source order. Previous owned
fields are cleared before extraction, so removed outputs/steps do not retain old
values. Snapshots are isolated from collector mutations. Collectors remain
responsible for rewriting/removing their own generated files.

Missing or corrupt entries rebuild the source resource to discard stale derived
state. Entries are committed only after output has been saved successfully. A
partial build can invalidate untouched entries on the next build because the
commit marker is shared by the cache directory; this is a conservative fallback,
not a dependency graph. Builds with `emit: false` do not commit reusable entries.
Resource cache saves are now coalesced to once per resource after its extraction
steps; steps should use `api.meta`, `api.indices` and `api.caches` to read preceding
results, not inspect intermediate files as a synchronization mechanism.

This cache avoids handler work. It currently still loads the resource's Vault and
hashes normalized content to establish identity; it does not make Vault loading
lazy or skip collection/index rebuilding.

### Image-service discovery

`getManifestImageServices(vault, manifestId)` from `iiif-hss/library` returns ordered
`{ id, canvasId }` pairs by following the Vault's normalized entity references.
It covers all canvas item pages, multiple annotation bodies, Choices and
SpecificResources; recognizes ImageService2/3 (including `@type`) and the Image API
protocol; and respects context-specific entity frames. It excludes thumbnails and
unreferenced services. Repeated uses are retained. It neither mutates the Vault nor
loads external pages. Apply project-specific URL rewrites after discovery.

```js
import { getManifestImageServices } from "iiif-hss/library";

// Inside a Manifest extraction handler:
const services = getManifestImageServices(resource.vault, resource.id);
return services.length ? { temp: services } : {};
```

## Development serving and rebuilds

The dev server publishes a snapshot of generated output in memory after a
successful build. Requests keep using the previous successful snapshot while a
build runs or fails. Generated files still exist on disk for Node clients and
scripts; private cache metadata remains disk-backed. Memory use grows with public
output size (about 282 MB for the measured Delft fixture).

Within a server session, unchanged generated writes are skipped after checking
that the destination's file identity and timestamps still match. External edits
and deleted destinations are repaired. Full dev builds remove obsolete paths
from the previous output inventory; explicit partial builds retain unrelated
files. Editing a manifest through the server performs a full cached rebuild so
collections, featured cards and indexes stay current.

Watch events are debounced, with at most one follow-up for edits during a watch
build. The standalone server reloads its configuration before rebuilding and
refreshes watch roots as stores change. It watches root configuration sidecars,
including YAML read by a JavaScript config, and the configured scripts directory.
Arbitrary transitive JavaScript imports still follow Node's module cache; restart
the server after changing an imported helper if necessary.
