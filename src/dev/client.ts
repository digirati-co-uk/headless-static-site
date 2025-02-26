import type { IIIFRC } from "../util/get-config.ts";
import { resolveFromSlug } from "../util/resolve-from-slug.ts";

export function create(
  url: string,
  options: {
    ws?: boolean;
    onFullRebuild?: () => void;
    onChangeFile?: () => void;
  } = {}
) {
  const endpoints = {
    slugs: `${url}/config/slugs.json`,
    stores: `${url}/config/stores.json`,
    manifests: `${url}/manifests/collection.json`,
    top: `${url}/collections/collection.json`,
    sitemap: `${url}/meta/sitemap.json`,
    editable: `${url}/meta/editable.json`,
    overrides: `${url}/meta/overrides.json`,
  };

  let cache: Record<string, any> = {};

  if (options.ws) {
    const wsUrl = new URL(url);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = "/ws";
    const ws = new WebSocket(wsUrl.toString());
    ws.onopen = () => ws.send("ping");
    ws.onmessage = (event) => {
      if (event.data === "file-refresh") {
        clearCache();
        if (options.onChangeFile) {
          options.onChangeFile();
        }
      }
      if (event.data === "full-rebuild") {
        clearCache();
        if (options.onFullRebuild) {
          options.onFullRebuild();
        }
      }
    };
  }

  const clearCache = () => {
    cache = {};
  };

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
  const getManifests = () => cachedGet<any>(endpoints.manifests);
  const getTop = () => cachedGet<any>(endpoints.top);
  const getEditable = () => cachedGet<Record<string, string>>(endpoints.editable);

  const getOverrides = () => cachedGet<Record<string, string>>(endpoints.overrides);
  const getSitemap = () =>
    cachedGet<
      Record<
        string,
        {
          type: string;
          source: { type: "disk"; path: string } | { type: "remote"; url: string };
        }
      >
    >(endpoints.sitemap);

  async function getFromSlug(slug: string, type: string) {
    const slugs = await getSlugs();
    return resolveFromSlug(slug, type, slugs || {});
  }

  async function getManifest(url_: string) {
    let url = url_;
    const overrides = await getOverrides();
    const urlWithoutSlash = url.startsWith("/") ? url.slice(1) : url;
    if (overrides?.[urlWithoutSlash]) {
      return `/${overrides[urlWithoutSlash]}`;
    }

    const remote = await getFromSlug(url, "Manifest");
    if (remote) {
      return remote.match;
    }

    if (!url.startsWith("/")) {
      url = `/${url}`;
    }

    return `${url}/manifest.json`;
  }

  async function getCollection(url_: string) {
    let url = url_;
    const overrides = await getOverrides();
    const urlWithoutSlash = url.startsWith("/") ? url.slice(1) : url;
    if (overrides?.[urlWithoutSlash]) {
      return `/${overrides[urlWithoutSlash]}`;
    }

    const remote = await getFromSlug(url, "Collection");
    if (remote) {
      return remote.match;
    }

    if (!url.startsWith("/")) {
      url = `/${url}`;
    }

    return `${url}/collection.json`;
  }

  return {
    endpoints,
    getSlugs,
    getStores,
    getManifests,
    getTop,
    getSitemap,
    resolveFromSlug,
    getEditable,
    getManifest,
    getCollection,
  };
}
