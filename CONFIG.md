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
Source IIIF, `_collection.yml` / `_collection.yaml`, and ordinary collection
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

### Folder collection authoring

Sidecars are discovered independently of a JSON-only store pattern, including
when `subFiles: true`. Both extensions are supported; two sidecars defining the
same folder fail clearly. A sidecar can contain IIIF `label`, `summary`,
`thumbnail`, `behavior`, and `metadata`; strings in labels/summaries/metadata are
converted to language maps. Identity, type and inferred items remain generated.

```yaml
label: Scientific instruments
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
```

Automatic folders now materialise before extraction/enrichment too, retaining
`collections/<relative-folder>` slugs and existing collection rewrites. Explicit
sidecars use configured store `base`/`destination` slug rules, or the same
`collections/<relative-folder>` default when neither is configured. `customMap` labels take
precedence over sidecar labels; absent authored labels fall back to the folder
name. Automatic generation respects the folder extraction's enable, depth and
ignore settings; explicit sidecars are authored resources even if automatic
folder grouping is disabled.

Folder collections include direct resources and immediate child folder collections.
This adds parent-child navigation and can increase direct item counts compared
with the earlier flat folder grouping. Sidecars and source resource changes are
picked up by normal builds and watch mode. Conflicting generated slugs fail instead
of silently choosing one folder.

See [the Vite featured homepage example](examples/vite-featured/README.md) for a
working page, authoring examples and one runnable build verification script.
