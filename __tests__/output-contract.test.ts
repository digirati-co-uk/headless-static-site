import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { OUTPUT_FORMAT_VERSION } from "../src/output-contract.ts";
import { HssOutputValidationError, isSafeOutputPath, validateBuildManifest } from "../src/output-validation.ts";

describe("output contract schemas", () => {
  test("publishes parseable versioned JSON Schemas", async () => {
    const schemaDir = join(process.cwd(), "schemas", `output-v${OUTPUT_FORMAT_VERSION}`);
    const names = (await readdir(schemaDir)).filter((name) => name.endsWith(".schema.json"));
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const name of names) {
      const schema = JSON.parse(await readFile(join(schemaDir, name), "utf-8"));
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.$id).toContain(`/output-v${OUTPUT_FORMAT_VERSION}/`);
      expect(schema.type).toBeDefined();
    }
  });

  test("rejects unsafe inventory paths with file and field details", () => {
    expect(isSafeOutputPath("../private.json")).toBe(false);
    expect(isSafeOutputPath("C:/private.json")).toBe(false);
    try {
      validateBuildManifest({
        formatVersion: 1,
        contractVersion: "1.2",
        hssVersion: "test",
        mode: "full",
        canonicalBaseUrl: "https://example.org",
        completedAt: new Date().toISOString(),
        stores: [],
        features: [],
        search: [],
        analysis: [],
        entrypoints: {},
        resources: { manifests: 0, collections: 0, canvases: 0 },
        files: [{ path: "../private.json", bytes: 1, sha256: "0".repeat(64) }],
      });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HssOutputValidationError);
      expect(error).toMatchObject({ file: "meta/build.json", field: "files[0].path" });
    }
  });
});
