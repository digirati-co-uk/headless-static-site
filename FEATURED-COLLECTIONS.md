# Proposal: featured collections for static collection pages

Status: implemented. See CONFIG.md and examples/vite-featured for usage.
The document below records the design and its intended scope.

Use an ordinary IIIF Collection as the page model, with richer embedded collection
references. A generated featured collection gathers collections explicitly marked
with a behaviour, then includes their descriptive fields and immediate children.
The child collection remains the source of truth for its label, summary, images,
metadata and styling hints.

For the supplied design, the featured collection describes the page header; each
featured member describes a section such as “Centrale Erfgoedcollectie”; that
member’s children describe the cards in its carousel.

## Configuration and selection

Add `collections.featured`, using the same metadata customisation shape as
`collections.index`. Emit it only when configured, at
`featured/collection.json`, with slug `featured`. A site can consume this from its
`/collections` route; the page URL and the IIIF URL are independent.

```json
{
  "collections": {
    "featured": {
      "label": { "en": ["Collections"] },
      "summary": {
        "en": ["Explore our academic heritage: museum objects, rare books, maps and photographs."]
      },
      "thumbnail": [
        {
          "id": "https://example.org/images/collections-hero.jpg",
          "type": "Image",
          "width": 1800,
          "height": 700
        }
      ],
      "behavior": ["https://example.org/behaviors/collections-home"]
    }
  }
}
```

Without `items`, select every built Collection whose own final `behavior` array
contains `hss:featured`. This is a proposed HSS extension value, not a standard
IIIF behaviour. Selection checks the explicitly stored value, not inherited
behaviours: marking a parent must not automatically feature every descendant.
Manifests can be cards inside a featured section, but are not automatically
selected as sections.

For editorial ordering, support the same explicit slug-list override as the root
index:

```json
{
  "collections": {
    "featured": {
      "label": { "en": ["Collections"] },
      "items": [
        "collections/academic-heritage",
        "collections/early-printed-books",
        "collections/images"
      ]
    },
    "index": {
      "items": ["featured", "manifests"]
    }
  }
}
```

Explicit `items` replaces automatic selection, including unmarked collections,
and preserves its order. Require collection slugs here; reject unknown slugs,
manifest slugs, duplicates and the generated `featured` slug itself. `items: []`
produces an empty page collection. With automatic selection, use deterministic
label order with slug as the tie-breaker. Do not introduce a separate priority
field initially.

Do not add configuration for overriding individual cards. Editing a section’s
summary means editing that section’s source collection or its enrichment.

The root index and featured collection share configuration conventions and
reference-building code. Keep their output roles separate initially: the root
index retains its current compact behaviour and defaults. It may explicitly
reference `featured`, as above. Do not silently replace the existing
`collections/collection.json` catalogue.

## Authoring a featured section

A source collection, or its final state after enrichment, could contain:

```json
{
  "id": "https://example.org/iiif/collections/academic-heritage/collection.json",
  "type": "Collection",
  "label": { "en": ["Academic heritage"] },
  "summary": { "en": ["Objects and stories from the university’s collections."] },
  "behavior": [
    "hss:featured",
    "https://example.org/behaviors/carousel",
    "https://example.org/behaviors/theme-yellow"
  ],
  "items": [
    {
      "id": "https://example.org/iiif/collections/scientific-instruments/collection.json",
      "type": "Collection",
      "label": { "en": ["Scientific instruments"] }
    }
  ]
}
```

An enrichment uses the existing collection builder API to append `hss:featured`
without discarding other behaviours, and reports its change through the existing
`didChange` mechanism. The aggregation reads the final resource, not the original
source or a pre-enrichment metadata snapshot. No new enrichment result field or
separate featured registry is needed.

The website maps recognised behaviour values to components or styles. Unknown
values have no special visual effect. HSS preserves custom values without
interpreting them as CSS classes. The page can choose a grid or carousel, accent
colour and image treatment without making those choices build-system features.

IIIF supports extension behaviours, descriptive metadata, and embedded collection
resources with their own identifiers. The HSS selection rule above is an explicit
application convention. See the [IIIF Presentation 3 specification](https://iiif.io/api/presentation/3.0/#behavior).

## The generated “fat” collection

Example output, reduced to one section and one card:

```json
{
  "@context": "http://iiif.io/api/presentation/3/context.json",
  "id": "https://example.org/iiif/featured/collection.json",
  "type": "Collection",
  "hss:slug": "featured",
  "label": { "en": ["Collections"] },
  "summary": { "en": ["Explore our academic heritage."] },
  "thumbnail": [
    {
      "id": "https://example.org/images/collections-hero.jpg",
      "type": "Image",
      "width": 1800,
      "height": 700
    }
  ],
  "hss:totalItems": 1,
  "items": [
    {
      "id": "https://example.org/iiif/collections/academic-heritage/collection.json",
      "type": "Collection",
      "hss:slug": "collections/academic-heritage",
      "label": { "en": ["Academic heritage"] },
      "summary": { "en": ["Objects and stories from the university’s collections."] },
      "behavior": [
        "hss:featured",
        "https://example.org/behaviors/carousel",
        "https://example.org/behaviors/theme-yellow"
      ],
      "hss:totalItems": 1,
      "items": [
        {
          "id": "https://example.org/iiif/collections/scientific-instruments/collection.json",
          "type": "Collection",
          "hss:slug": "collections/scientific-instruments",
          "label": { "en": ["Scientific instruments"] },
          "summary": { "en": ["Instruments used in teaching and research."] },
          "thumbnail": [
            {
              "id": "https://example.org/images/instruments.jpg",
              "type": "Image",
              "width": 1000,
              "height": 750
            }
          ],
          "hss:totalItems": 42,
          "metadata": [
            { "label": { "en": ["Objects in collection"] }, "value": { "en": ["56"] } },
            { "label": { "en": ["Online"] }, "value": { "en": ["42"] } }
          ]
        }
      ]
    }
  ]
}
```

This provides the page heading, section text, carousel cards, images and displayed
counts in one request. “Read more” and card links use the site’s existing slug
routing; the canonical `id` remains the IIIF resource URL. “View all” links to the
section’s page. Include all immediate cards initially; the frontend controls how
many are visible at once.

Embedding rules:

- The featured collection embeds each selected section and its immediate items.
- Cards carry `id`, `type`, `label`, `summary`, `thumbnail`, `behavior`, `metadata`,
  `hss:slug` and collection counts where available. Preserve existing descriptive
  reference fields such as rights, requiredStatement, provider and homepage.
- Collection cards do not embed their own `items`. Manifest cards never embed
  canvases. This bounds expansion even if source collections contain cycles.
- Preserve the section’s member order. Membership comes from its final collection,
  not a fresh lookup of everything sharing a folder or topic.
- For known resources, hydrate from their final built description. For unresolved
  external references, preserve available reference fields and omit unknown
  counts. Do not fetch external collections during this aggregation.
- Missing optional summaries and metadata stay absent. Prefer an explicit
  thumbnail, then the existing extracted thumbnail, then the first available
  immediate child thumbnail in member order. If none exists, omit it and let the
  page show a placeholder.
- Do not copy all internal `meta.json` fields into public output. Retain the
  existing public-field selection and add the missing descriptive fields.

The shallow card reference deliberately omits `items`; it is not asserting that
the linked collection is empty. Its full collection remains available at `id`.

## Counts and metadata

Keep `hss:totalItems` consistent: it counts immediate members of the complete
collection represented by that reference. It is not a recursive object count.
The root count is the number of featured sections; a section count is its number
of cards; a card collection’s count is its own direct member count.

The screenshot’s “56 objects / 42 online” requires two different facts. HSS can
count direct members, but cannot infer a physical collection’s holdings from its
online manifests. Author those display values in the child collection’s
`metadata`, or populate them from a catalogue through enrichment, as in the
example. Do not manufacture the physical count from `items.length`.

`metadata` is for display, not a machine-readable count contract. A website should
not parse translated metadata labels to implement filtering or arithmetic. Add a
separate documented numeric extension only if that use case is actually needed.
For nested collections, do not label direct child counts as “objects”.

## Fix `_collection.yml` as part of this work

There are currently two paths with different capabilities:

1. `src/stores/iiif-json.ts` can materialise `_collection.yml` as a virtual
   Collection before enrichment. It already converts label, summary and metadata,
   and passes through other fields. However, discovery depends on the store’s
   file pattern; `subFiles` currently filters these files out. Its inferred items
   only cover files in the same directory, not child-folder collections.
2. `src/commands/build-steps/5-indices.ts` constructs automatic folder collections
   after enrichment. Its sidecar lookup only reads `label`, and only for the
   `metadata` label strategy. These collections cannot currently be marked by an
   ordinary collection enrichment because they do not exist yet.

Use the existing virtual-resource approach as the single construction path for
folder collections, and materialise them before collection extraction/enrichment.
Keep the existing enable, ignore, depth, label-strategy and slug-rewrite settings.
Avoid implementing a second late enrichment runner just for featured output.

Required changes:

- Discover `_collection.yml` and `_collection.yaml` independently of JSON resource
  patterns, consistently with `subFiles`, while respecting ignored folders.
- For each eligible folder, create one collection with optional sidecar metadata.
  Preserve existing published IDs/slugs and avoid duplicates with explicit source
  collections. Fail clearly for ambiguous competing definitions.
- Apply sidecar summary, metadata, behaviour and thumbnail regardless of the label
  strategy. Retain custom-map label precedence, then sidecar/folder fallback as
  appropriate to the configured strategy.
- Make parent folders reference immediate child collections, so section folders
  can contain card folders. Preserve existing direct-manifest membership; do not
  recursively flatten descendants into every parent.
- Protect generated identity, type and inferred membership from accidental
  sidecar overrides. Leave explicit membership authoring to source IIIF
  collections for this version.
- Track sidecar edits, additions/removals and member changes for rebuilds. Summary,
  behaviour and thumbnail updates must reach featured output on cached builds.

The JSON-equivalent content of a section sidecar would be:

```json
{
  "label": { "en": ["Academic heritage"] },
  "summary": { "en": ["Objects and stories from the university’s collections."] },
  "behavior": [
    "hss:featured",
    "https://example.org/behaviors/theme-yellow"
  ],
  "thumbnail": [
    { "id": "https://example.org/images/heritage.jpg", "type": "Image" }
  ]
}
```

Moving folder construction earlier is the substantial part of this proposal.
Treat it as a separately reviewable change with output compatibility tests, not
an incidental tweak to the featured emitter. New parent-child folder membership
also needs an explicit compatibility decision before release, since it changes
existing collection contents and counts.

## Build integration and implementation order

1. **Unify folder materialisation.** Register folder collections early enough to
   use the ordinary extraction and enrichment pipeline. Preserve identity and
   direct membership, then add/test child-folder relationships.
2. **Complete public references.** Reuse the existing emit-stage snippets, adding
   `metadata` and ensuring final labels, summaries, behaviours, thumbnails and
   counts are available for both source and generated collections. Keep a lookup
   of final immediate membership for assembling the richer document; do not
   expand the global resource registry into a full nested tree.
3. **Generate featured output.** After source, folder, topic and store collections
   are final, select featured sections and assemble the two-level document.
   Register its compact reference before resolving `collections.index.items` so
   `featured` works there. Generated aggregates must be excluded from automatic
   self-selection; explicit self-reference fails.
4. **Expose and document.** Add configuration types, JSON schema, output-contract
   documentation and a static-site consumption example. Verify existing client
   helpers can read the resulting Collection without a bespoke endpoint.

Generated topic/store aggregates currently also appear after enrichment. Their
existing configuration can supply the marker for selection. If ordinary
collection enrichment must target those aggregates too, move their materialisation
earlier in a follow-up; do not claim the new emitter alone enables that. Source
collections and folder collections are the required enrichment targets for this
version.

Verification should cover marker addition/removal through enrichment; mixed
custom behaviours; explicit ordering and invalid selections; no matches; complete
metadata and thumbnails on nested cards; direct-count semantics; external
references; cycles stopping at the embedding boundary; and source-summary changes
appearing in both canonical and featured output. Folder integration tests should
cover both sidecar extensions, `subFiles`, JSON-only patterns, slug stability,
child-folder membership, duplicate prevention and cached rebuilds.

Do not add configurable embedding depth, arbitrary selectors, recursive counts,
remote crawling, per-card config overrides or a page-layout schema initially.
The section-and-card model covers the supplied design while keeping the authored
IIIF collections useful outside that page.
