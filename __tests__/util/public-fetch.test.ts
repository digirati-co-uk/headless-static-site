import { PassThrough } from "node:stream";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { EventEmitter } from "node:events";
import { beforeEach, expect, test, vi } from "vitest";
const { get, lookup } = vi.hoisted(() => ({ get: vi.fn(), lookup: vi.fn() }));
vi.mock("node:https", () => ({ get }));
vi.mock("node:dns", () => ({ lookup }));
import { fetchPublicResource, validatePublicUrl } from "../../src/util/public-fetch.ts";
beforeEach(() => {
  get.mockReset();
  lookup.mockReset();
});
function respond(statusCode: number, headers: Record<string, string>, body?: Buffer) {
  get.mockImplementationOnce((_url, _options, callback) => {
    const request = new EventEmitter();
    queueMicrotask(() => {
      const response = new PassThrough();
      Object.assign(response, { statusCode, headers });
      callback(response);
      response.end(body);
    });
    return request;
  });
}
test.each([
  "http://127.0.0.1/",
  "http://10.0.0.1/",
  "http://169.254.169.254/",
  "http://[::1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://public.example:3000/",
  "https://user:password@public.example/",
])("rejects private or unsupported URLs: %s", (url) => {
  expect(() => validatePublicUrl(url)).toThrow();
});
test("checks the actual DNS result used by the socket", async () => {
  lookup.mockImplementation((_host, _options, callback) => callback(null, "127.0.0.1", 4));
  get.mockImplementation((url, options) => {
    const request = new EventEmitter();
    queueMicrotask(() => options.lookup(url.hostname, {}, (error: Error) => request.emit("error", error)));
    return request;
  });
  await expect(fetchPublicResource("https://public.example/resource")).rejects.toThrow("public internet address");
});
test("validates redirects before opening a second socket", async () => {
  respond(302, { location: "http://169.254.169.254/latest/meta-data" });
  await expect(fetchPublicResource("https://public.example/resource")).rejects.toThrow("public internet address");
  expect(get).toHaveBeenCalledTimes(1);
});
test("does not forward credentials across origins", async () => {
  respond(302, { location: "https://other.example/resource" });
  respond(200, {}, Buffer.from("{}"));
  await fetchPublicResource("https://public.example/resource", { headers: { Authorization: "test", Cookie: "test" } });
  expect(get.mock.calls[1][1].headers).not.toHaveProperty("authorization");
  expect(get.mock.calls[1][1].headers).not.toHaveProperty("cookie");
});
test("caps redirect chains and response bytes", async () => {
  for (let index = 0; index < 4; index++) respond(302, { location: "/next" });
  await expect(fetchPublicResource("https://public.example/resource")).rejects.toThrow("Too many IIIF redirects");
  respond(200, {}, Buffer.alloc(16 * 1024 * 1024 + 1));
  await expect(fetchPublicResource("https://public.example/resource")).rejects.toThrow("exceeds 16 MiB");
});
test("returns a bounded JSON response and honors an external signal", async () => {
  respond(200, { "content-type": "application/json" }, Buffer.from('{"type":"Manifest"}'));
  const response = await fetchPublicResource("https://public.example/resource", { signal: AbortSignal.timeout(1000) });
  expect(await response.json()).toEqual({ type: "Manifest" });
  expect(get.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});

test.each([
  ["gzip", gzipSync],
  ["deflate", deflateSync],
  ["br", brotliCompressSync],
] as const)("decodes %s JSON", async (encoding, compress) => {
  respond(200, { "content-encoding": encoding }, compress(Buffer.from('{"id":"decoded"}')));
  expect(await (await fetchPublicResource("https://public.example/resource")).json()).toEqual({ id: "decoded" });
});

test("bounds decoded bytes, not only compressed transfer size", async () => {
  respond(200, { "content-encoding": "gzip" }, gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1)));
  await expect(fetchPublicResource("https://public.example/resource")).rejects.toThrow("exceeds 16 MiB");
});

test("honors redirect modes and preserves response metadata when cloned", async () => {
  respond(302, { location: "/next" });
  await expect(fetchPublicResource("https://public.example/resource", { redirect: "error" })).rejects.toThrow(
    "redirect disallowed"
  );
  respond(302, { location: "/next" }, Buffer.from("redirect"));
  const manual = await fetchPublicResource("https://public.example/resource", { redirect: "manual" });
  expect(manual.status).toBe(302);
  expect(manual.headers.get("location")).toBe("/next");
  expect(manual.redirected).toBe(false);
  respond(302, { location: "/next#fragment" });
  respond(200, {}, Buffer.from("{}"));
  const followed = await fetchPublicResource("https://public.example/resource");
  expect(followed.url).toBe("https://public.example/next");
  expect(followed.clone().redirected).toBe(true);
  expect(await followed.json()).toEqual({});
});

test("aborts an active body stream and rejects prematurely closed streams", async () => {
  let stream: PassThrough;
  get.mockImplementationOnce((_url, _options, callback) => {
    const request = new EventEmitter();
    stream = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
    queueMicrotask(() => {
      callback(stream);
      stream.write("partial");
    });
    return request;
  });
  const controller = new AbortController();
  const pending = fetchPublicResource("https://public.example/resource", { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(stream!.destroyed).toBe(true);

  get.mockImplementationOnce((_url, _options, callback) => {
    const request = new EventEmitter();
    queueMicrotask(() => {
      const body = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
      callback(body);
      body.write("partial");
      body.destroy();
    });
    return request;
  });
  await expect(fetchPublicResource("https://public.example/resource")).rejects.toThrow();
});

test("rejects unsupported options and an already cancelled request before connecting", async () => {
  await expect(fetchPublicResource("https://public.example/resource", { method: "POST" })).rejects.toThrow(
    "only supports GET"
  );
  await expect(fetchPublicResource("https://public.example/resource", { cache: "force-cache" })).rejects.toThrow(
    "RequestInit.cache"
  );
  await expect(
    fetchPublicResource("https://public.example/resource", { signal: AbortSignal.abort() })
  ).rejects.toThrow();
  expect(get).not.toHaveBeenCalled();
});

test("handles real HTTP response streams, cancellation and a broken connection", async () => {
  const http = await vi.importActual<typeof import("node:http")>("node:http");
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const server = http.createServer((request, response) => {
    if (request.url === "/gzip") {
      response.writeHead(200, { "content-encoding": "gzip" });
      response.end(gzipSync('{"real":true}'));
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write("partial");
      if (request.url === "/slow") began();
      else setTimeout(() => response.destroy(), 10);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  // Test-only socket routing. Production DNS validation is covered separately.
  get.mockImplementation((url, options, callback) =>
    http.get(
      `http://127.0.0.1:${address.port}${url.pathname}`,
      { headers: options.headers, signal: options.signal },
      callback
    )
  );
  try {
    expect(await (await fetchPublicResource("https://public.example/gzip")).json()).toEqual({ real: true });
    const controller = new AbortController();
    const slow = fetchPublicResource("https://public.example/slow", { signal: controller.signal });
    const rejection = expect(slow).rejects.toThrow();
    await started;
    controller.abort();
    await rejection;
    await expect(fetchPublicResource("https://public.example/broken")).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
