import { describe, expect, test, vi } from "vitest";

const { buildMock } = vi.hoisted(() => ({ buildMock: vi.fn() }));

vi.mock("../../src/commands/build", () => ({
  build: buildMock,
  defaultBuiltIns: {
    defaultRun: [],
    devBuild: ".iiif/dev/build",
    devCache: ".iiif/dev/cache",
    defaultBuildDir: ".iiif/build",
    defaultCacheDir: ".iiif/cache",
  },
}));

import { createServer } from "../../src/create-server";

const result = {
  buildConfig: { buildDir: ".iiif/build", cacheDir: ".iiif/cache" },
};

describe("createServer build lifecycle", () => {
  test("serializes builds, continues after failure, and emits lifecycle events", async () => {
    let rejectFirst!: (error: Error) => void;
    let active = 0;
    let maxActive = 0;
    buildMock
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            active++;
            maxActive = Math.max(maxActive, active);
            rejectFirst = (error) => {
              active--;
              reject(error);
            };
          })
      )
      .mockImplementationOnce(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        active--;
        return result;
      });

    const events: string[] = [];
    const server = await createServer(
      { stores: {} },
      {
        onBuild(event) {
          events.push(event.type);
        },
      }
    );

    const first = server._extra.cachedBuild({ dev: true });
    const firstRejection = expect(first).rejects.toThrow("first failed");
    const second = server._extra.cachedBuild({ dev: true });
    await vi.waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
    rejectFirst(new Error("first failed"));
    await firstRejection;
    await expect(second).resolves.toMatchObject(result);

    expect(maxActive).toBe(1);
    expect(events).toEqual(["start", "error", "start", "success"]);
  });

  test("preserves the build failure when the error callback also fails", async () => {
    const original = new Error("build failed");
    buildMock.mockRejectedValueOnce(original);
    const server = await createServer(
      { stores: {} },
      {
        onBuild(event) {
          if (event.type === "error") throw new Error("reporting failed");
        },
      }
    );

    await expect(server._extra.cachedBuild({})).rejects.toBe(original);
  });
});

test.each([false, "false"])("POST build accepts and normalizes cache=%s", async (cache) => {
  buildMock.mockReset();
  buildMock.mockResolvedValue({ ...result, emitted: { stats: {}, siteMap: {} }, extractions: {}, enrichments: {} });
  const server = await createServer({ stores: {} });
  const response = await server.request("/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cache }),
  });
  expect(response.status).toBe(200);
  expect(buildMock.mock.calls[0][0]).toMatchObject({ cache: false, dev: true });
});

test("coalesces watch bursts and schedules only one follow-up for edits during a build", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "hss-watch-"));
  await mkdir(join(root, "content"));
  const config = { stores: { local: { type: "iiif-json" as const, path: "./content" } } };
  let finish!: (value: typeof result) => void;
  buildMock.mockReset();
  buildMock
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    )
    .mockResolvedValue(result);
  const server = await createServer(config, { projectRoot: root });
  try {
    await server.request("/watch");
    for (let i = 0; i < 10; i++) await writeFile(join(root, "content/object.json"), `${i}`);
    await vi.waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 10; i++) await writeFile(join(root, "content/object.json"), `${i}`);
    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(buildMock).toHaveBeenCalledTimes(1);
    finish(result);
    await vi.waitFor(() => expect(buildMock).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(buildMock).toHaveBeenCalledTimes(2);
    await server.request("/unwatch");
    await writeFile(join(root, "content/object.json"), "stopped");
    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(buildMock).toHaveBeenCalledTimes(2);
  } finally {
    server._extra.close();
    finish?.(result);
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed watcher can be recreated on the next build", async () => {
  const fs = (await import("node:fs")).default;
  const { EventEmitter } = await import("node:events");
  const watchers: Array<InstanceType<typeof EventEmitter> & { close: ReturnType<typeof vi.fn> }> = [];
  const watch = vi.spyOn(fs, "watch").mockImplementation(() => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    watchers.push(watcher);
    return watcher as any;
  });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  buildMock.mockReset();
  buildMock.mockResolvedValue(result);
  const server = await createServer({ stores: {} });
  try {
    await server.request("/watch");
    const initial = watchers.length;
    watchers[0].emit("error", new Error("watch failed"));
    expect(watchers[0].close).toHaveBeenCalledOnce();
    await server._extra.cachedBuild({ dev: true });
    expect(watchers).toHaveLength(initial + 1);
    server._extra.close();
    expect((await server.request("/watch")).status).toBe(503);
    await expect(server._extra.cachedBuild({ dev: true })).rejects.toThrow("server is closed");
  } finally {
    server._extra.close();
    watch.mockRestore();
    warning.mockRestore();
  }
});
