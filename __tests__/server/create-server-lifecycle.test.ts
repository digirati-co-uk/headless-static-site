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
          }),
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
      },
    );

    const first = server._extra.cachedBuild({ dev: true });
    const firstRejection = expect(first).rejects.toThrow("first failed");
    const second = server._extra.cachedBuild({ dev: true });
    await vi.waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
    rejectFirst(new Error("first failed"));
    await firstRejection;
    await expect(second).resolves.toEqual(result);

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
      },
    );

    await expect(server._extra.cachedBuild({})).rejects.toBe(original);
  });
});
