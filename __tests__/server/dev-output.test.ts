import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { resolveConfigSource } from "../../src/util/get-config";
import { createServer } from "../../src/create-server";
import { FileHandler } from "../../src/util/file-handler";
import fs from "node:fs";

test("publishes fresh dev output, preserves the last successful response on failure, and updates aggregates after edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "hss-dev-output-"));
  const manifest = (label: string) => ({ id: "https://example.org/a", type: "Manifest", label: { en: [label] }, items: [] });
  const config: any = {
    server: { url: "http://localhost:7111" }, run: ["extract-part-of-collection"],
    collections: { featured: { items: ["collections/section"] } },
    stores: {
      objects: { type: "iiif-json", path: "./content", base: "./content", destination: "manifests", pattern: "**/*.json" },
      groups: { type: "iiif-json", path: "./groups", base: "./groups", destination: "collections/section" },
    },
  };
  const server = await createServer(config, { projectRoot: root });
  try {
    await mkdir(join(root, "content"));
    await mkdir(join(root, "groups"));
    await writeFile(join(root, "groups/_collection.yml"), 'label: Section\nitems: [manifests/a]\n');
    await writeFile(join(root, "content/a.json"), JSON.stringify(manifest("First")));
    await writeFile(join(root, "content/b.json"), JSON.stringify({ ...manifest("Second"), id: "https://example.org/b" }));
    const run = () => server._extra.cachedBuild({ dev: true, cache: true, emit: true });
    const featured = async () => (await server.request("/featured/collection.json")).json();
    await run();
    expect((await featured()).items[0].items[0].label.en).toEqual(["First"]);
    expect((await server.request("/manifests/b/manifest.json")).status).toBe(200);
    await writeFile(join(root, "content/a.json"), JSON.stringify(manifest("Changed")));
    await rm(join(root, "content/b.json"));
    const second = await run();
    expect(second.dev.writes.skipped).toBeGreaterThan(0);
    const current = await featured();
    expect(current.items[0].items[0].label.en).toEqual(["Changed"]);
    expect((await server.request("/manifests/b/manifest.json")).status).toBe(404);
    await expect(stat(join(root, ".iiif/dev/build/manifests/b/manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    config.collections.featured.items = ["collections/missing"];
    await expect(run()).rejects.toThrow("Invalid collection slug");
    expect(await featured()).toEqual(current);
    config.collections.featured.items = ["collections/section"];
    const edited = await server.request("/manifests/a/manifest.json", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(manifest("Edited")),
    });
    expect(edited.status).toBe(200);
    expect((await featured()).items[0].items[0].label.en).toEqual(["Edited"]);
    expect(JSON.parse(await readFile(join(root, "content/a.json"), "utf8")).label.en).toEqual(["Edited"]);
    const response = await server.request("/featured/collection.json");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const created = await server.request("/create?json=true", {
      method: "POST", body: new URLSearchParams({ slug: "nested/new", store: "objects" }),
    });
    expect(created.status).toBe(200);
    const createdInfo = await created.json();
    expect((await server.request(new URL(createdInfo.manifestUrl).pathname)).status).toBe(200);
    const invalid = await server.request("/create?json=true", {
      method: "POST", body: new URLSearchParams({ slug: "../escape", store: "objects" }),
    });
    expect(invalid.status).toBe(400);
  } finally {
    server._extra.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("write reuse verifies disk identity and repairs external edits or deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "hss-dev-writes-"));
  try {
    const first = new FileHandler(fs as any, root);
    first.savedFiles = new Map();
    await first.writeFile("file.json", "original");
    const next = new FileHandler(fs as any, root);
    next.savedFiles = new Map(first.savedFiles);
    await next.writeFile("file.json", "original");
    expect(next.writeStats.skipped).toBe(1);
    await writeFile(join(root, "file.json"), "modified");
    await next.writeFile("file.json", "original");
    expect(await readFile(join(root, "file.json"), "utf8")).toBe("original");
    await rm(join(root, "file.json"));
    await next.writeFile("file.json", "original");
    expect(await readFile(join(root, "file.json"), "utf8")).toBe("original");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("reloads standalone config and updates watch roots when a store is added", async () => {
  const root = await mkdtemp(join(tmpdir(), "hss-dev-config-"));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await mkdir(join(root, "content"));
    await mkdir(join(root, "other"));
    const manifest = (label: string) => JSON.stringify({ id: "https://example.org/other", type: "Manifest", label: { en: [label] }, items: [] });
    const config: any = { server: { url: "http://localhost:7111" }, run: [],
      stores: { original: { type: "iiif-json", path: "./content", pattern: "**/*.json" } } };
    const configPath = join(root, ".iiifrc.yml");
    await writeFile(configPath, JSON.stringify(config));
    const { config: loaded, ...configSource } = await resolveConfigSource(undefined, root);
    server = await createServer(loaded, { projectRoot: root, configSource });
    await server._extra.cachedBuild({ dev: true, cache: true });
    await server.request("/watch");
    await writeFile(join(root, "other/object.json"), manifest("First"));
    config.stores.added = { type: "iiif-json", path: "./other", base: "./other", destination: "manifests", pattern: "**/*.json" };
    await writeFile(configPath, JSON.stringify(config));
    await vi.waitFor(async () => {
      expect((await (await server!.request("/manifests/object/manifest.json")).json()).label.en).toEqual(["First"]);
    }, { timeout: 5000 });
    await writeFile(join(root, "other/object.json"), manifest("Changed"));
    await vi.waitFor(async () => {
      expect((await (await server!.request("/manifests/object/manifest.json")).json()).label.en).toEqual(["Changed"]);
    }, { timeout: 5000 });
    expect((await (await server.request("/config")).json()).stores.added).toBeDefined();
  } finally {
    server?._extra.close();
    await rm(root, { recursive: true, force: true });
  }
});
