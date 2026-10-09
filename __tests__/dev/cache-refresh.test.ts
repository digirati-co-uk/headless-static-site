import { expect, test, vi } from "vitest";
import { create } from "../../src/dev/client";
import { createIiifViteClient } from "../../src/vite/client";

test("a response started before cache invalidation cannot repopulate either HTTP client cache", async () => {
  for (const legacy of [true, false]) {
    let finish!: (response: Response) => void;
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          })
      )
      .mockResolvedValue(new Response(JSON.stringify({ items: [{ label: "New" }] })));
    vi.stubGlobal("fetch", fetchFn);
    try {
      const client = legacy
        ? create("http://localhost:7111")
        : createIiifViteClient({ baseUrl: "http://localhost:7111", fetchFn });
      const read = () => ("getManifests" in client ? client.getManifests() : client.getAllManifests());
      const pending = read();
      client.clearCache();
      finish(new Response(JSON.stringify({ items: [{ label: "Old" }] })));
      await pending;
      expect((await read())?.items[0].label).toBe("New");
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

test("WebSocket refresh uses the client's mounted base path", () => {
  const urls: string[] = [];
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor(url: string) {
        urls.push(url);
      }
    }
  );
  try {
    create("http://localhost:7111/iiif/", { ws: true });
    expect(urls).toEqual(["ws://localhost:7111/iiif/ws"]);
  } finally {
    vi.unstubAllGlobals();
  }
});
