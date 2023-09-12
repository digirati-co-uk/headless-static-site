import { IIIFRC } from "../util/get-config.ts";
import { Collection } from "@iiif/presentation-3";
import {
  compileReverseSlugConfig,
  compileSlugConfig,
} from "../util/slug-engine.ts";

export function create(url: string) {
  const endpoints = {
    slugs: `${url}/config/slugs.json`,
    stores: `${url}/config/stores.json`,
    manifests: `${url}/manifests.json`,
    top: `${url}/top.json`,
    sitemap: `${url}/sitemap.json`,
  };

  const cache: Record<string, any> = {};

  const cachedGet = async <T>(url: string): Promise<T> => {
    if (cache[url]) {
      return cache[url];
    }
    const res = await fetch(url);
    const json = await res.json();
    cache[url] = json;
    return json;
  };

  const getSlugs = () => cachedGet<IIIFRC["slugs"]>(endpoints.slugs);
  const getStores = () => cachedGet<IIIFRC["stores"]>(endpoints.stores);
  const getManifests = () => cachedGet<Collection>(endpoints.manifests);
  const getTop = () => cachedGet<Collection>(endpoints.top);
  const getSitemap = () =>
    cachedGet<
      Record<
        string,
        {
          type: string;
          source:
            | { type: "disk"; path: string }
            | { type: "remote"; url: string };
        }
      >
    >(endpoints.sitemap);

  async function resolveFromSlug(slug: string) {
    const slugs = await getSlugs();
    const slugFns = Object.fromEntries(
      Object.entries(slugs || {}).map(([key, value]) => {
        return [key, { info: value, matches: compileReverseSlugConfig(value) }];
      }),
    );

    for (const slugFn of Object.values(slugFns || {})) {
      const [matches] = slugFn.matches(slug);
      if (matches) {
        return matches;
      }
    }
  }

  async function getManifest(url: string) {
    const remote = await resolveFromSlug(url);
    if (remote) {
      return remote;
    }

    if (!url.startsWith("/")) {
      url = `/${url}`;
    }

    return `${url}/manifest.json`;
  }

  return {
    endpoints,
    getSlugs,
    getStores,
    getManifests,
    getTop,
    getSitemap,
    resolveFromSlug,
    getManifest,
  };
}
