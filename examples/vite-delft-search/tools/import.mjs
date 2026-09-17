import { spawnSync } from "node:child_process";
// These local-only defaults match compose.yaml. Never expose the admin key to Vite.
const env = {
  ...process.env,
  TYPESENSE_HOST: "localhost",
  TYPESENSE_PORT: "18108",
  TYPESENSE_PROTOCOL: "http",
  TYPESENSE_API_KEY: "delft-demo-local-admin",
  SEARCH_INDEX_MAPPING: "manifests:delft-demo",
};
let healthy = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    healthy = (await (await fetch("http://localhost:18108/health")).json()).ok;
  } catch {}
  if (healthy) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!healthy) throw new Error("Typesense is unavailable. Run docker compose up -d first.");
const result = spawnSync(
  process.execPath,
  ["../../bin/iiif-hss.js", "index", "--iiif-build-dir", "dist/iiif", "--resource-index", "manifests", "--typesense"],
  { env, stdio: "inherit" }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
