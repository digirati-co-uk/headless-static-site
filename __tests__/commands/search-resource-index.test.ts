import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { searchIndexCommand } from "../../src/commands/search-index.ts";

test("resource index CLI validates emitted JSONL without a canvas registry or Typesense", async () => {
  const root = await mkdtemp(join(tmpdir(), "hss-search-cli-"));
  try {
    await mkdir(join(root, "meta/search"), { recursive: true });
    await writeFile(
      join(root, "meta/search/manifests.schema.json"),
      JSON.stringify({ fields: [{ name: "label", type: "string" }] })
    );
    const path = join(root, "meta/search/manifests.jsonl");
    const options = { iiifBuildDir: root, resourceIndex: "manifests", typesense: false, frozenLockfile: false };
    await writeFile(path, '{"id":"one","label":"Object"}\n\n');
    await expect(searchIndexCommand(options)).resolves.toBeUndefined();
    await writeFile(path, '{"id":"one"}\n{"id":"one"}\n');
    await expect(searchIndexCommand(options)).rejects.toThrow("unique");
    await expect(searchIndexCommand({ ...options, resourceIndex: "../outside" })).rejects.toThrow(
      "Invalid resource index name"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
