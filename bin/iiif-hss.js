#!/usr/bin/env node

import { existsSync } from "node:fs";

const entrypoint = new URL("../build/index.js", import.meta.url);

if (!existsSync(entrypoint)) {
  console.error("iiif-hss has not been built yet. Run `pnpm build` in the iiif-hss package directory first.");
  process.exit(1);
}

await import(entrypoint.href);
