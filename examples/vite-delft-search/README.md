# Delft search: Vite + React + Typesense

A small end-to-end example using **16 original Delft manifests** (about 200 KB),
React InstantSearch and the Typesense adapter. No mocked results or facet counts.

The layout follows the supplied catalogue design: results on the left, coloured
collection filters on the right, material and object-type facets, removable filter
chips, pagination and a fixed search bar. Filters and queries persist in the URL.
The layout stacks on small screens. Result titles open the generated IIIF manifest.

## Run

Use Node 22+, pnpm and Docker Compose. From the repository root:

```sh
pnpm install
pnpm --dir examples/vite-delft-search install --ignore-workspace
pnpm --dir examples/vite-delft-search run setup
pnpm --dir examples/vite-delft-search dev
```

Open **http://localhost:5178**. `run setup` is intentional: `pnpm setup` alone is a
pnpm built-in command, not this example's setup script.

The example is a standalone pnpm project with its own lockfile; `--ignore-workspace`
ensures dependencies are installed in this example. The Vite plugin uses the
checkout's source so uncommitted finalizer changes are exercised.

`run setup` starts Typesense 30.2 at **127.0.0.1:18108**, builds the repository CLI,
creates a search-only browser key, builds the IIIF and React output, checks and
imports the resource index with the CLI, then runs live assertions. It uses its
own Compose project and named volume; port 8108 on the host is untouched.

The browser key is restricted to `documents:search` on `delft-demo`, expires after
one year, and is written to ignored `.env.local`. The deliberately public local
admin key lives only in Compose and Node tooling, not the frontend bundle. These
localhost credentials and ports are for this example, not a production deployment.

For a production-build preview after setup:

```sh
pnpm --dir examples/vite-delft-search preview
```

Stop the dev server before previewing; both use port 5178. Build again after changing
`.env.local`, as Vite embeds the search key into the browser bundle.

## Try it

- Select **Centrale Erfgoed Collectie**: 6 objects. Also select **glas**: 1 object.
- Clear filters and search for **afstandsmeter**: 1 object.
- Expand Heritage and select **Collectie Geodesie** alone: 4 objects.
- The Geodesie collection has its own lavender background, but its result badges
  inherit Heritage's yellow. The label still says **Collectie Geodesie**.
- Combine material and object-type filters, remove individual chips, paginate,
  reload the URL, and try a nonsense query to see the empty state.

Values within one facet combine with OR; different facets combine with AND.
Collection counts exclude the current collection selection but respect the query
and other facets, using InstantSearch's disjunctive faceting. The UI filters on
`type:=Manifest`, so collection records never inflate object counts.

## How the data flows

1. `fixtures/` contains byte-for-byte copies of 16 manifests from
   `../delft-performance/manifests/collective-access/objects/`. No runtime dependency
   on the large performance directory. `sample-sources.json` records every origin.
2. The `_collection.json` files author four **demo** featured sections and five
   child collections. These groupings and colours are illustrative, not a claim
   about the source catalogue's official classification. Original object metadata,
   attribution and image links are retained. External thumbnail servers are needed
   to display images; failed images have a fallback.
3. `.iiifrc.yml` extracts titles, thumbnails, material and object-type topics.
   `featured-part-of` finalizes full `partOf`, inherited `background`, and the
   `collectionSlugs` facet on the search records.
4. Vite emits `/iiif/featured/collection.json` for navigation plus
   `dist/iiif/meta/search/manifests.{schema.json,jsonl,mapping.json}` for search.
   Topic facets are added to combined index rows from extraction indices; individual
   `search-record.json` files contain the base record and finalizer fields.
5. The CLI imports the combined index into the Typesense collection `delft-demo`.
   React InstantSearch queries it through `typesense-instantsearch-adapter`.
   Sidebar labels, order and colours come from the featured IIIF tree. Counts come
   from Typesense. Result labels come from `partOf.at(-1)`; badge colours come from
   the record's `background`.

## Search CLI, explicitly

From this example directory, after the root CLI has been built:

```sh
# Parse the resource index and check record IDs, without contacting Typesense.
node ../../bin/iiif-hss.js index \
  --iiif-build-dir dist/iiif --resource-index manifests

# Import using the generated schema and a separate Typesense collection name.
TYPESENSE_HOST=localhost TYPESENSE_PORT=18108 TYPESENSE_PROTOCOL=http \
TYPESENSE_API_KEY=delft-demo-local-admin SEARCH_INDEX_MAPPING=manifests:delft-demo \
node ../../bin/iiif-hss.js index \
  --iiif-build-dir dist/iiif --resource-index manifests --typesense
```

`pnpm search:check` and `pnpm search:import` wrap those commands. The latter also
waits for the local server. `--resource-index` imports finalized resource JSONL;
without that option, the existing canvas/remote-file lockfile workflow is unchanged.
Resource imports use upserts, reject invalid records and can be repeated without
creating duplicates. They **do not remove records absent from a later build or
migrate an existing schema**. Reset this example's volume to test deletions/schema
changes from scratch; ordinary metadata, colour and membership edits need only:

```sh
pnpm build
pnpm search:import
pnpm verify
```

Watch mode rebuilds IIIF, but does not automatically import into Typesense. Use the
commands above to update search, then reload the browser to discard its short cache.

`pnpm verify` checks the generated records and live Typesense results: 16 objects,
section counts 6/4/3/3, colour inheritance, child labels, combined collection/material
filtering, text search, empty results, and rejection of writes with the browser key.

## Stop / reset

From this example directory:

```sh
docker compose stop       # retain the sample index
# Optional: remove only this example's containers and sample search data.
docker compose down -v
pnpm run setup            # recreate data and browser key
```

If Docker cannot start containers, resolve that before running setup; do not restart
unrelated services just for this demo. The same tools can target a native Typesense
30.2 process listening on 127.0.0.1:18108 with the same local admin key: run
`pnpm cli:build`, `pnpm search:key`, `pnpm build`, `pnpm search:import`, `pnpm verify`.

References: [React InstantSearch](https://www.algolia.com/doc/api-reference/widgets/instantsearch/react),
[Typesense adapter](https://github.com/typesense/typesense-instantsearch-adapter),
[Typesense field schemas](https://typesense.org/docs/30.0/api/collections.html).
