import { lookup } from "node:dns";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { BlockList, isIP, type LookupFunction } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["::", 96],
  ["2001::", 32],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["64:ff9b::", 96],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");
export function assertPublicAddress(address: string) {
  const family = isIP(address);
  if (!family || blocked.check(address, family === 4 ? "ipv4" : "ipv6"))
    throw new Error("IIIF URLs must resolve to a public internet address.");
}
export function validatePublicUrl(value: string) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("IIIF URLs must use HTTP(S) without credentials.");
  if (url.port && url.port !== "80" && url.port !== "443")
    throw new Error("IIIF URLs must use a standard HTTP(S) port.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) assertPublicAddress(hostname);
  return url;
}
const publicLookup: LookupFunction = (hostname, options, callback) =>
  lookup(hostname, options, (error, address, family) => {
    if (error) return callback(error, address, family);
    try {
      if (Array.isArray(address)) for (const entry of address) assertPublicAddress(entry.address);
      else assertPublicAddress(address);
      callback(null, address, family);
    } catch (error) {
      callback(error as NodeJS.ErrnoException, address, family);
    }
  });

const MAX_BYTES = 16 * 1024 * 1024;

function byteLimit() {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > MAX_BYTES ? new Error("IIIF response exceeds 16 MiB.") : null, chunk);
    },
  });
}

function withResponseMetadata(response: Response, url: string, redirected: boolean): Response {
  Object.defineProperties(response, {
    url: { value: url },
    redirected: { value: redirected },
    clone: {
      value() {
        return withResponseMetadata(Response.prototype.clone.call(this), url, redirected);
      },
    },
  });
  return response;
}

/**
 * Opt-in public HTTP(S) GET transport. Supports headers, signal and redirect.
 * Buffers at most 16 MiB of transferred and decoded data, within 30 seconds and
 * three redirects. Other RequestInit options are rejected, not silently ignored.
 */
export const fetchPublicResource: typeof fetch = async (input, init = {}) => {
  const requestInput = input instanceof Request ? input : null;
  for (const [key, value] of Object.entries(init)) {
    if (value !== undefined && !["method", "headers", "signal", "redirect"].includes(key)) {
      throw new Error(`Public IIIF fetching does not support RequestInit.${key}.`);
    }
  }
  if ((init.method || requestInput?.method || "GET").toUpperCase() !== "GET" || requestInput?.body) {
    throw new Error("IIIF fetching only supports GET.");
  }
  if (
    requestInput &&
    (requestInput.cache !== "default" ||
      requestInput.credentials !== "same-origin" ||
      requestInput.integrity ||
      requestInput.keepalive ||
      requestInput.mode !== "cors" ||
      requestInput.referrer !== "about:client" ||
      requestInput.referrerPolicy)
  ) {
    throw new Error("Public IIIF fetching only supports default Request policies.");
  }
  const redirect = init.redirect ?? requestInput?.redirect ?? "follow";
  if (!["follow", "error", "manual"].includes(redirect)) throw new Error("Invalid redirect mode.");
  let url = validatePublicUrl(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers = new Headers(
    init.headers ?? requestInput?.headers ?? { Accept: "application/ld+json, application/json" }
  );
  const controller = new AbortController();
  const external = init.signal ?? requestInput?.signal;
  const abort = () => controller.abort(external?.reason);
  const timeout = setTimeout(() => controller.abort(new Error("IIIF request timed out.")), 30_000);
  external?.addEventListener("abort", abort, { once: true });
  if (external?.aborted) abort();
  const signal = controller.signal;
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      const requestHeaders: Record<string, string> = {};
      headers.forEach((value, key) => {
        requestHeaders[key] = value;
      });
      const response = await new Promise<{
        status: number;
        statusText: string;
        headers: Headers;
        body?: Buffer;
        location?: string;
      }>((resolve, reject) => {
        const request = (url.protocol === "https:" ? httpsGet : httpGet)(
          url,
          {
            headers: requestHeaders,
            lookup: publicLookup,
            signal,
          },
          (response) => {
            const status = response.statusCode || 0;
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(response.headers)) {
              if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
            }
            const result = { status, statusText: response.statusMessage || "", headers: responseHeaders };
            if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirect !== "manual") {
              if (redirect === "error") reject(new Error("IIIF redirect disallowed by redirect mode."));
              else resolve({ ...result, location: response.headers.location });
              response.destroy();
              return;
            }
            void (async () => {
              const chunks: Buffer[] = [];
              const decoders: Transform[] = [];
              const encodings = (responseHeaders.get("content-encoding") || "")
                .split(",")
                .map((value) => value.trim().toLowerCase())
                .filter(Boolean);
              if (![204, 205, 304].includes(status)) {
                for (const encoding of encodings.reverse()) {
                  if (encoding === "gzip" || encoding === "x-gzip") decoders.push(createGunzip());
                  else if (encoding === "deflate") decoders.push(createInflate());
                  else if (encoding === "br") decoders.push(createBrotliDecompress());
                  else if (encoding !== "identity") throw new Error(`Unsupported IIIF content encoding: ${encoding}`);
                }
              }
              const sink = new Writable({
                write(chunk, _encoding, callback) {
                  chunks.push(chunk);
                  callback();
                },
              });
              await pipeline([response, byteLimit(), ...decoders, byteLimit(), sink], { signal });
              if (decoders.length) {
                responseHeaders.delete("content-encoding");
                responseHeaders.delete("content-length");
              }
              resolve({ ...result, body: Buffer.concat(chunks) });
            })().catch((error) => {
              response.destroy();
              reject(error);
            });
          }
        );
        request.on("error", reject);
      });
      if (response.location) {
        const next = validatePublicUrl(new URL(response.location, url).href);
        if (next.origin !== url.origin) {
          headers.delete("authorization");
          headers.delete("cookie");
          headers.delete("proxy-authorization");
        }
        url = next;
        continue;
      }
      url.hash = "";
      return withResponseMetadata(
        new Response([204, 205, 304].includes(response.status) ? null : response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
        url.href,
        redirects > 0
      );
    }
    throw new Error("Too many IIIF redirects.");
  } finally {
    clearTimeout(timeout);
    external?.removeEventListener("abort", abort);
  }
};
