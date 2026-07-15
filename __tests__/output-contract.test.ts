import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { OUTPUT_FORMAT_VERSION } from "../src/output-contract.ts";

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
});
