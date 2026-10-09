import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { build, defaultBuiltIns } from "../../src/commands/build";
import { IIIFRemoteStore } from "../../src/stores/iiif-remote";
import { validateBuildOutput } from "../../src/output-validation";

test("emits canonical paginated metadata without saved manifests and refreshes cached membership", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "hss-membership-"));
  const root = "https://example.org/root";
  const page = "https://example.org/page";
  const child = "https://example.org/child";
  const alias = "https://example.org/alias";
  const documents: Record<string, any> = {
    [root]: { id: root, type: "Collection", label: { en: ["Root"] }, first: { id: page, type: "CollectionPage" } },
    [page]: {
      id: page,
      type: "CollectionPage",
      items: [
        { id: alias, type: "Manifest" },
        { id: child, type: "Manifest" },
      ],
    },
    [alias]: { id: child, type: "Manifest", label: { en: ["Child"] }, items: [] },
    [child]: { id: child, type: "Manifest", label: { en: ["Child"] }, items: [] },
  };
  const request: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!documents[url]) throw new Error(`Unexpected fetch ${url}`);
    return new Response(JSON.stringify(documents[url]));
  };
  const config: any = {
    server: { url: "https://published.example/iiif" },
    run: ["extract-runtime-hints"],
    stores: {
      remote: {
        type: "iiif-remote",
        url: root,
        saveManifests: false,
        validation: { strict: true },
        network: { minDelayMs: 0 },
      },
    },
  };
  // Force the supported resource-cache reuse branch after the initial cold build.
  const builtIns = {
    ...defaultBuiltIns,
    storeTypes: { ...defaultBuiltIns.storeTypes, "iiif-remote": { ...IIIFRemoteStore, invalidate: async () => false } },
  };
  const output = join(cwd, ".iiif/build");
  const readMeta = async (slug: string) => JSON.parse(await readFile(join(output, slug, "meta.json"), "utf8"));
  try {
    await build({ cwd, cache: false, networkCache: false, prefetch: false, emit: true, ui: false }, builtIns, {
      customConfig: config,
      fetch: request,
    });
    expect((await readMeta("root"))["hss:runtime"].children).toEqual([child]);
    expect((await readMeta("child"))["hss:runtime"]).toMatchObject({ source: { url: alias }, saveToDisk: false });
    await expect(readFile(join(output, "child/manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await validateBuildOutput(output, { sha256: true });

    documents[page].items = [];
    await build({ cwd, cache: true, networkCache: false, prefetch: false, emit: true, ui: false }, builtIns, {
      customConfig: config,
      fetch: request,
    });
    expect((await readMeta("root"))["hss:runtime"].children).toEqual([]);
    await expect(readMeta("child")).rejects.toMatchObject({ code: "ENOENT" });
    await validateBuildOutput(output, { sha256: true });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
