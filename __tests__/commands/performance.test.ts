import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { build, defaultBuiltIns } from "../../src/commands/build.ts";
import { validateBuildOutput } from "../../src/output-validation.ts";

test("unchanged folder resources stay cached; child edits refresh collections and featured cards", async () => {
  const root = await mkdtemp(join(tmpdir(), "hss-performance-"));
  try {
    const folder = join(root, "content", "exhibition");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "collection.yml"), 'label: Exhibition\nbehavior: [hss:featured]\nbackground: "#f00"\n');
    const manifestPath = join(folder, "object.json");
    const manifest = (label: string) =>
      JSON.stringify({ id: "https://example.org/object", type: "Manifest", label: { en: [label] }, background: "#0f0", items: [] });
    await writeFile(manifestPath, manifest("First"));
    const config = {
      server: { url: "https://example.org/iiif" },
      run: ["flat-manifests"],
      collections: { featured: {} },
      stores: { local: { type: "iiif-json" as const, path: "./content", pattern: "**/*.json" } },
    };
    const run = () => build({ cwd: root, cache: true, ui: false }, defaultBuiltIns, { customConfig: config });
    const first = await run();
    const generated = first.parsed.storeResources.local.find((resource) => resource.virtual)!;
    const before = await stat(generated.path);
    const second = await run();
    expect((await stat(generated.path)).mtimeMs).toBe(before.mtimeMs);
    expect(second.stores.stats).toEqual({ validCount: 2, invalidCount: 0 });
    expect(second.result.status).toBe("complete");
    if (second.result.status !== "complete") throw new Error("Missing output");
    expect(second.result.manifest.entrypoints.resourceDescriptors).toBeUndefined();
    await expect(validateBuildOutput(second.result.directory, { sha256: true })).resolves.toMatchObject({
      status: "complete",
    });
    await writeFile(manifestPath, manifest("Other"));
    const third = await run();
    const featured = JSON.parse(
      await readFile(
        join(third.buildConfig.files.resolve(third.buildConfig.buildDir), "featured/collection.json"),
        "utf8"
      )
    );
    expect(featured.items[0].background).toBe("#f00");
    expect(featured.items[0].items[0].background).toBe("#0f0");
    expect(featured.items[0].items[0].label).toEqual({ en: ["Other"] });
    expect(third.stores.stats.invalidCount).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("descriptors are opt-in, validated when present, and removed when disabled in dev", async () => {
  const root = await mkdtemp(join(tmpdir(), "hss-descriptors-"));
  try {
    const config = {
      server: { url: "https://example.org/iiif" },
      run: [],
      stores: {
        supplied: {
          type: "iiif-memory" as const,
          inputs: [
            { resource: { id: "https://example.org/object", type: "Manifest", label: { en: ["Object"] }, items: [] } },
          ],
        },
      },
    };
    const events: any[] = [];
    const run = (enabled: boolean) =>
      build({ cwd: root, dev: true, cache: true, ui: false }, defaultBuiltIns, {
        customConfig: { ...config, output: { includeResourceDescriptors: enabled } },
        onEvent(event) {
          events.push(event);
        },
      });
    const first = await run(true);
    const output = first.buildConfig.files.resolve(first.buildConfig.buildDir);
    expect(
      events.some(
        (event) => event.type === "diagnostic" && event.level === "warning" && /descriptors/.test(event.message)
      )
    ).toBe(true);
    await expect(validateBuildOutput(output, { sha256: true })).resolves.toMatchObject({ status: "complete" });
    await run(false);
    await expect(readFile(join(output, "meta/resource-descriptors.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(validateBuildOutput(output, { sha256: true })).resolves.toMatchObject({ status: "complete" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
