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

await build({ ...options, cacheRoot: "/var/cache/iiif-hss" }, builtIns, {
  fetch: secureFetch,
  async onEvent(event) {
    await persistBuildEvent(event);
  },
});
```

`build()` keeps its existing detailed pipeline return for compatibility and exposes the portable contract as `output.result`. A result with `status: "not-emitted"` is never deployable. Use `readBuildResult()` or `validateBuildOutput()` from `iiif-hss/library` to read and validate an emitted tree; checksum verification is enabled with `{ sha256: true }`.

Already-loaded resources can use the programmatic `iiif-memory` store. Each input accepts either `resource` or `url`, plus an optional publishable `inputKey` and `saveToDisk` policy. URL inputs and every downstream build request use the injected `fetch`.

## Schema and compatibility policy

Output schemas have canonical `https://iiif-hss.dev/schemas/output-v1/` IDs and are available offline through `iiif-hss/schemas/output-v1/*`. `formatVersion` changes only for incompatible tree or semantic changes. Additive contract changes retain the format version and increment `contractVersion`; consumers must ignore unknown fields. `resultVersion` independently versions the portable programmatic build result. Readers and validators shipped by a release enforce that release's declared contract.
