import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { acquireCacheLock } from "../../src/util/cache-lock.ts";

describe("external cache lock", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test("serializes callers sharing a cache directory", async () => {
    directory = await mkdtemp(join(tmpdir(), "iiif-hss-cache-lock-"));
    const releaseFirst = await acquireCacheLock(directory);
    let acquiredSecond = false;
    const second = acquireCacheLock(directory).then(async (release) => {
      acquiredSecond = true;
      await release();
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(acquiredSecond).toBe(false);
    await releaseFirst();
    await second;
    expect(acquiredSecond).toBe(true);
  });
});
