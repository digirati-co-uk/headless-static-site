# Featured collection homepage (Vite)

A complete static collection homepage driven by one generated IIIF document:
`/iiif/featured/collection.json`. Its hero, section headings, descriptions, cards,
images, metadata and counts come from the build output. Custom behaviours select
yellow, blue and orange sections and horizontal carousels.

From the repository root, after `pnpm install`:

```sh
pnpm --dir examples/vite-featured dev
# Open http://localhost:5173/collections (use the URL Vite prints).
pnpm --dir examples/vite-featured build
pnpm --dir examples/vite-featured preview
```

Use Node 22 or later. The Vite config imports the checkout's source plugin so you
can develop HSS without rebuilding its package first. The example has no frontend
framework or additional UI dependencies. Vite copies the generated IIIF output to
`dist/iiif`. Serve `dist` with SPA fallback for `/collections` and its query-string
detail routes. For a real deployment, change `serverUrl` in `vite.config.ts` to the
canonical IIIF base URL. Images are local static assets; the optional Google Fonts
stylesheet falls back to system sans-serif when offline.

## Try the features

- Open `/collections`: three automatically featured sections with keyboard/touch
  carousels, collection search, responsive cards and links to detail pages.
- Change a label, summary or metadata in `fixtures/**/_collection.yml`. Watch mode
  rebuilds the IIIF and reloads the page; descriptions have no duplicate definition
  in frontend code or configuration.
- `scripts/feature-heritage.js` marks the heritage section through ordinary
  collection enrichment and updates its summary. The other sections are marked
  directly in their sidecars. `images/_collection.yaml` demonstrates the alternate
  extension. The store intentionally uses `**/*.json` and `subFiles: true`.
- Remove or change a section's theme/carousel behaviour: the page falls back to
  neutral cards / a grid. Unknown behaviours are ignored by the frontend.
- `fixtures/images/details` has no sidecar: HSS creates it as an automatic folder
  collection. `heritage/navigation` inherits a thumbnail from its immediate item.
- Images mixes a direct Manifest card with collection cards, including an item
  without a thumbnail or summary to show the fallback state.
- Cards display authored “Objects in collection” metadata separately from the
  computed direct member count. The sample holdings/descriptions are illustrative.
- The root index explicitly references `featured` and `manifests`.

To replace automatic selection and change the section order, add to `.iiifrc.yml`:

```yaml
collections:
  featured:
    # Keep the existing label, summary and thumbnail here too.
    items: [collections/images, collections/heritage]
```

Unmarked collections can also be selected explicitly. `items: []` demonstrates
empty output; omit `items` to restore marker-based selection. Unknown, duplicate,
Manifest or self-referencing slugs produce build errors. Removing the entire
featured configuration disables output; remove `featured` from the root index's
explicit list at the same time.

`pnpm build` runs `verify.mjs` after Vite: a small assertion script checking the
actual generated sections, enrichment, source summaries, metadata, counts,
thumbnail fallbacks, automatic folders and bounded embedding. It expects the
original fixture/configuration; restore those after trying editorial changes.

## Images

Two historic prints are bundled for a reproducible demo:

- `astronomy.jpg`: [1769 astronomical diagrams, Library of Congress](https://loc.gov/item/2013593153), downloaded via its IIIF image service.
- `delft.jpg`: [historic Delft map, Essential Vermeer](https://www.essentialvermeer.com/delft/view-of-delt-archive.html).

The website is a demonstration archive, not an official university website.
