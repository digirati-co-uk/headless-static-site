# iiif-hss

Build and serve a headless static IIIF site from local JSON or remote IIIF resources. Node.js 20 or newer is required.

## Install

```sh
pnpm add iiif-hss
```

## Vite

```ts
import { defineConfig } from "vite";
import { iiifPlugin } from "iiif-hss/vite-plugin";

export default defineConfig({
  plugins: [
    iiifPlugin({
      collection: "https://example.org/iiif/collection.json",
      onBuild(event) {
        console.log(event.type, event);
      },
    }),
  ],
});
```

During development, the IIIF routes are mounted at `/iiif` and the inspection UI is available at `/iiif/_debug/`. Configure local and remote stores in `.iiifrc.yml`, `iiif.config.js`, or an `iiif-config` folder; see [CONFIG.md](./CONFIG.md).

For the complete generated directory and file contract, including conditional outputs and consumption patterns, see [FILE-OUTPUT.md](./FILE-OUTPUT.md).

The Vite-only `onBuild` callback is awaited for production and development builds. It receives `start`, `success`, `error`, or `skipped` events; development events include initial, watched, and debug-triggered rebuilds.

## Programmatic builds

Programmatic callers can inject a fetch-compatible request function. Every build-time network request, including remote stores, pagination, retries, extraction, enrichment, generators, and image services, uses this function. CLI, Vite, and Astro callers continue to use `globalThis.fetch`.

```ts
import { build } from "iiif-hss/library";

await build(options, builtIns, {
  fetch: secureFetch,
});
```

## Schema status

The published schemas currently retain placeholder `$id` values. Selecting and publishing canonical stable schema URLs is release-blocking debt before those identifiers are treated as stable.
