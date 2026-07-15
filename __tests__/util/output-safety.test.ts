import fs from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createCollection } from "../../src/util/create-collection.ts";
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
