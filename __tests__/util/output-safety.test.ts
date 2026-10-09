import fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createCollection } from "../../src/util/create-collection.ts";
import { createResourceHandler } from "../../src/util/create-resource-handler.ts";
import { FileHandler } from "../../src/util/file-handler.ts";

describe("output safety", () => {
  let testDir = "";

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("refuses to create canonical resources without a server URL", () => {
    expect(() => createCollection({ label: "Broken" })).toThrow(/canonical server URL/);
  });

  test("rejects copied files that overwrite generated output", async () => {
    testDir = await mkdtemp(join(tmpdir(), "iiif-hss-output-safety-"));
    const files = new FileHandler(fs as any, testDir);
    const customDir = join(testDir, "custom");
    await mkdir(join(customDir, "meta"), { recursive: true });
    await writeFile(join(customDir, "meta", "sitemap.json"), "custom");

    await files.saveJson("build/meta/sitemap.json", { generated: true });
    await files.copy(customDir, "build", { overwrite: true });

    await expect(files.saveAll()).rejects.toThrow(/Output collision.*sitemap\.json/);
  });

  test("rejects two plugins producing the same resource file", async () => {
    testDir = await mkdtemp(join(tmpdir(), "iiif-hss-plugin-collision-"));
    const files = new FileHandler(fs as any, testDir);
    await createResourceHandler("cache/files", files, "extraction:first").writeFile("data.json", "first");
    await expect(
      createResourceHandler("cache/files", files, "enrichment:second").writeFile("data.json", "second")
    ).rejects.toThrow(/extraction:first conflicts with enrichment:second/);
  });

  test("reports failed buffered writes", async () => {
    testDir = await mkdtemp(join(tmpdir(), "iiif-hss-output-failure-"));
    const files = new FileHandler(fs as any, testDir);
    await writeFile(join(testDir, "blocked"), "not a directory");
    await files.saveJson("blocked/output.json", { value: true });

    const result = await files.saveAll();
    expect(result.failedToWrite).toHaveLength(1);
    expect(await readFile(join(testDir, "blocked"), "utf-8")).toBe("not a directory");
  });
});

test("buffered and directory copies preserve final bytes and expose matching digests", async () => {
  const root = await mkdtemp(join(tmpdir(), "iiif-hss-copy-digests-"));
  try {
    const files = new FileHandler(fs as any, root);
    await files.saveJson("cache/data.json", { value: "generated" });
    await mkdir(join(root, "cache"), { recursive: true });
    await writeFile(join(root, "cache/raw.txt"), "raw");
    await files.copy("cache/data.json", "build/direct.json", { overwrite: true });
    await files.copy("cache", "build/folder", { overwrite: true });
    await mkdir(join(root, "build"), { recursive: true });
    await writeFile(join(root, "build/existing.json"), "existing");
    await files.copy("cache/data.json", "build/existing.json", { overwrite: false });
    await files.copy("cache/data.json", "build/filtered.json", { overwrite: true, filter: () => false });
    const result = await files.saveAll(false, 2);
    expect(result.failedToWrite).toEqual([]);
    const { createHash } = await import("node:crypto");
    for (const path of ["build/direct.json", "build/folder/data.json"]) {
      const data = await readFile(join(root, path));
      expect(files.writtenHashes.get(join(root, path))).toEqual({
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      });
      expect(JSON.parse(data.toString())).toEqual({ value: "generated" });
    }
    expect(await readFile(join(root, "build/folder/raw.txt"), "utf8")).toBe("raw");
    expect(await readFile(join(root, "build/existing.json"), "utf8")).toBe("existing");
    expect(files.writtenHashes.has(join(root, "build/existing.json"))).toBe(false);
    expect(files.writtenHashes.has(join(root, "build/filtered.json"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
