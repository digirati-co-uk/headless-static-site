import { createHash } from "crypto";
import { join } from "node:path";
import { pathExists, readJson } from "fs-extra/esm";
import { writeFile } from "fs/promises";
import { mkdirp } from "mkdirp";
import objectHash from "object-hash";

export function createStoreRequestCache(storeKey: string, cacheDir: string) {
  const cache = new Map<string, string>();
  const didChangeCache = new Map<string, string>();

  return {
    async getKey(url: string) {
      if (cache.has(url) || didChangeCache.has(url)) {
        return url;
      }
      return null;
    },
    async didChange(url: string) {
      let data = null;

      if (cache.has(url)) {
        data = cache.get(url);
      }

      if (didChangeCache.has(url)) {
        return true;
      }

      if (!data && (await pathExists(url))) {
        data = await readJson(url);
      }

      if (!data) {
        return true;
      }

      const freshData = await fetch(url).then((r) => r.json());

      const didChange = objectHash(data) !== objectHash(freshData as any);

      if (didChange) {
        didChangeCache.set(url, freshData as any);
      }

      return didChange;
    },
    async fetch(url: string) {
      const hash = createHash("sha256").update(url).digest("hex");
      const dir = join(cacheDir, storeKey);
      const cachePath = join(cacheDir, `${storeKey}/${hash}.json`);

      if (didChangeCache.has(url)) {
        const data = didChangeCache.get(url);
        didChangeCache.delete(url);

        // Also populate the cache.
        await mkdirp(dir);
        await writeFile(cachePath, JSON.stringify(data));
        cache.set(cachePath, data as any);

        return data;
      }

      if (cache.has(cachePath)) {
        return cache.get(cachePath);
      }

      if (await pathExists(cachePath)) {
        const data = await readJson(cachePath);
        cache.set(url, data);
        return data;
      }

      const resp = await fetch(url);
      const data = await resp.json();
      const cachedData = { ...data, _cached: true };
      cache.set(url, cachedData as any);
      await mkdirp(dir);
      await writeFile(cachePath, JSON.stringify(cachedData));

      return data;
    },
  };
}
