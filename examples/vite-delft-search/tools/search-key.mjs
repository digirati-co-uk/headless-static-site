import { writeFile } from "node:fs/promises";
let healthy = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    healthy = (await (await fetch("http://localhost:18108/health")).json()).ok;
  } catch {}
  if (healthy) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!healthy) throw new Error("Typesense unavailable. Run docker compose up -d first.");
const response = await fetch("http://localhost:18108/keys", {
  method: "POST",
  headers: { "X-TYPESENSE-API-KEY": "delft-demo-local-admin", "Content-Type": "application/json" },
  body: JSON.stringify({
    description: "Delft demo browser search",
    actions: ["documents:search"],
    collections: ["delft-demo"],
    expires_at: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
  }),
});
if (!response.ok) throw new Error(`Search key creation failed: ${response.status} ${await response.text()}`);
const { value } = await response.json();
await writeFile(".env.local", `VITE_TYPESENSE_SEARCH_KEY=${value}\n`, { mode: 0o600 });
console.log("Search-only key saved to .env.local. Restart Vite (or rebuild) to use it.");
