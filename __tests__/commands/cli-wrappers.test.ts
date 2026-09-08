import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

test("CLI wrappers report missing builds and forward arguments to built entrypoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "iiif-hss-cli-"));
  try {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    for (const [name, target] of [["iiif-hss", "build/index.js"], ["iiif-hss-dev", "build/server/entrypoint.js"]]) {
      const wrapper = join(root, "bin", `${name}.js`);
      await copyFile(new URL(`../../bin/${name}.js`, import.meta.url), wrapper);
      const missing = spawnSync(process.execPath, [wrapper], { cwd: tmpdir(), encoding: "utf8" });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain(`${name} has not been built yet`);
      await mkdir(dirname(join(root, target)), { recursive: true });
      await writeFile(join(root, target), "console.log(JSON.stringify(process.argv.slice(2)));");
      const built = spawnSync(process.execPath, [wrapper, "--help"], { cwd: tmpdir(), encoding: "utf8" });
      expect(built.status).toBe(0);
      expect(JSON.parse(built.stdout)).toEqual(["--help"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
