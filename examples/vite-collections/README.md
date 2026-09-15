# Composable collection stores

Eight runnable recipes, each with its own store and an explanatory collection
summary. Two additional stores supply shared local and in-memory objects. The
fixtures are illustrative and build offline; the external link is an example URL.

From the repository root, with dependencies installed (Node 22+):

```sh
pnpm --dir examples/vite-collections dev
pnpm --dir examples/vite-collections build
pnpm --dir examples/vite-collections preview
```

Open the local URL Vite prints. Browse a recipe, follow its children, inspect its
IIIF JSON, or expand the configuration. The build runs `verify.mjs`, which checks
membership, summaries, order, deduplication and every emitted internal link.
The Vite plugin imports this checkout, so library edits take effect immediately.

## Featured homepage

The homepage renders `/iiif/featured/collection.json`: eight ordered sections with
collection summaries, direct item counts and embedded child cards. Jump links
navigate the recipes; each card opens the full collection or manifest. The same
presentation is available at `?slug=featured`.

`collections.featured.items` in `.iiifrc.yml` selects and orders the sections.
Their membership comes from the ordinary collection pipeline: folder discovery,
curated cross-store references and script enrichment all happen before the
featured document is assembled. The frontend makes one IIIF request for the
homepage; child cards do not embed further descendants or canvases.

Reorder the featured list to change the homepage, or edit a source summary to
change its section description. For automatic selection instead, remove the list
and add `behavior: [hss:featured]` to the collections you want to feature.
`verify.mjs` checks section order, canonical summaries/counts, merged and enriched
membership, and bounded child embedding alongside the eight recipe checks.

## Recipes

| Store | Demonstrates |
| --- | --- |
| `option-a` | `collection.json` without `items`, three sibling IIIF collection files, and an `objects/` folder containing manifests. |
| `option-b` | Nested folders, each with `collection.json` without `items` and three manifests. |
| `mixed` | `collection.yml` with ordered slugs, a local manifest, and nested `_collection.json`; JSON-only discovery with `subFiles: true`. |
| `cross-store` | `_collection.yaml` selects objects from other stores, a collection folder, an in-memory object, and an external IIIF reference. Automatic grouping is disabled. |
| `automatic` | `_collection.yml`, implicit descendant folders, a per-store `folder-collections` step, and custom folder labels. |
| `scripted` | An empty `collection.json` populated and sorted by ordinary collection enrichment. |
| `legacy` | Presentation 2 `collection.json` upgraded to Presentation 3, then merged with a local manifest with the same ID. |
| `filtered` | `collection.yaml`, a published subtree, an intentionally empty collection and an ignored draft subtree. |

The stores use separate `base`/`destination` namespaces, so repeated filenames
such as `manifest-a.json` stay distinct. Slugs describe output paths, not resource
types: a manifest can live at `collections/option-b/inner-collection-1/manifest-a`.
Its resource endpoint still ends in `/manifest.json`.

## The client layouts

Both proposed structures work directly. In Option A, the parent contains the three
collection files **and an Objects child collection**. The objects are not inferred
to belong to any of the three sibling collections. Populate those through explicit
IIIF references or a script when their grouping is known.

In Option B, each child collection gets its own three manifests and the parent gets
the three child collections. No membership lists are needed.

A reserved declaration (`collection.json`, `collection.yml`, `collection.yaml`,
or any of their `_collection` equivalents) may omit `id`, `type` and `items`.
Ordinary files such as `inner-collection-1.json` remain IIIF resources: include their
`id`, `type: Collection` and label; their `items` may be absent or empty.

Objects can stay in the existing catalogue. For a fixed selection, use their final
public slugs in a declaration:

```yaml
label: Central Heritage Collection
items:
  - manifests/map
  - collections/option-b/inner-collection-2
```

Use `scripts/fill-empty-collection.js` when selection depends on rules. It reads
objects from another directory, sorts them by label, and adds references through
the collection builder. It leaves authored files untouched. A real selection can
read generated data or query an API instead.

## Composition rules

- Explicit `items` appear first, in authored order. Discovered direct files follow,
  then immediate child folder collections. Discovery is sorted by source path.
- Entries with the same IIIF ID appear once, keeping the first entry.
- Slug entries resolve against parsed resources from every store after slug rewrites;
  declaration order is irrelevant. Local, remote and in-memory sources work.
- External references use `{ id, type, label }`; they do not fetch or import content.
- An authored folder discovers descendants even without enabling the automatic
  folder extraction. An empty folder needs a declaration to be a collection.
- Store `ignore` and folder `ignorePaths`/`minDepth` govern discovery. Explicit
  declarations remain resources when automatic extraction is disabled.
- One declaration per folder. Competing formats, unknown slugs, invalid entries,
  self-references and conflicting generated slugs fail with errors.
- Refer to source resources with slug entries. Build-generated aggregates such as
  `topics` and `featured` are created later and are not source-resource slugs.

Try adding a manifest to a child folder, reordering `mixed/collection.yml`, or
changing a selection in `cross-store/_collection.yaml`. Watch mode rebuilds the
output. Fixed verification assertions describe the supplied fixtures; update them
when deliberately changing the recipes.
