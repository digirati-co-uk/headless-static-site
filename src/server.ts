import fs, { existsSync } from "node:fs";
import { readFile, watch } from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { timeout } from "hono/timeout";
import { z } from "zod";
import { type BuildOptions, build, defaultBuiltIns } from "./commands/build";
import { cloverHtml } from "./server/clover.html";
import { editorHtml } from "./server/editor.html";
import { explorerHtml } from "./server/explorer.html";
import { indexHtml } from "./server/index.html";
import { FileHandler } from "./util/file-handler";
import { getConfig } from "./util/get-config";

const app = new Hono();

app.use(cors());

// New Hono server.
//
// TODO Endpoints:
// - POST /api/page-blocks
// - POST /api/save-manifest
//
let ac = new AbortController();
const pathCache = { allPaths: {} as Record<string, string> };

let isWatching = false;
const fileHandler = new FileHandler(fs, cwd());
const storeRequestCaches = {};

const cachedBuild = async (options: BuildOptions) => {
  return build(options, defaultBuiltIns, {
    storeRequestCaches,
    fileHandler,
    pathCache,
  });
};

app.get("/", async (ctx) => {
  return ctx.html(indexHtml());
});

app.get("/explorer/*", async (ctx) => {
  return ctx.html(explorerHtml());
});

app.get("/editor/*", async (ctx) => {
  return ctx.html(editorHtml());
});

app.get("/config", async (ctx) => {
  const config = await getConfig();
  return ctx.json({
    isWatching: isWatching,
    pendingFiles: Array.from(fileHandler.openJsonChanged.keys()).filter(Boolean),
    ...config,
  });
});

app.get("/client.js", async (ctx) => {
  const local = existsSync(join(cwd(), "build", "client.js"));
  if (local) {
    const file = await readFile(join(cwd(), "build", "client.js"), "utf-8");
    ctx.header("Content-Type", "application/javascript");
    return ctx.body(file);
  }

  try {
    const fromModule = require.resolve("iiif-hss/client");
    const file = await readFile(fromModule, "utf-8");
    ctx.header("Content-Type", "application/javascript");
    return ctx.body(file);
  } catch (e) {
    console.log(e);
  }
});

app.get("/watch", async (ctx) => {
  if (isWatching) return ctx.json({ watching: true });

  const config = await getConfig();

  const stores = Object.values(config.stores).filter((store) => {
    return store.type === "iiif-json";
  });

  for (const store of stores) {
    (async () => {
      const watcher = watch(store.path, {
        signal: ac.signal,
        recursive: true,
      });

      for await (const event of watcher) {
        if (event.filename) {
          const name = join(store.path, event.filename);
          const realPath = pathCache.allPaths[name];
          await cachedBuild({
            exact: realPath,
            emit: true,
            cache: true,
          });
        }
      }
    })().catch((err) => {
      // ignore.
    });
  }

  console.log(`Watching ${stores.length} stores`);

  isWatching = true;

  return ctx.json({ watching: true });
});

app.get("/unwatch", async (ctx) => {
  ac.abort();
  ac = new AbortController();
  isWatching = false;
  return ctx.json({ watching: false });
});

app.get("/build/save", async (ctx) => {
  const total = Array.from(fileHandler.openJsonChanged.keys()).filter(Boolean).length;
  if (total) {
    await fileHandler.saveAll();
  }
  return ctx.json({ saved: true, total });
});

app.get("/clover/*", async (ctx) => {
  return ctx.html(cloverHtml());
});

app.get(
  "/build",
  timeout(120_000),
  zValidator(
    "query",
    z.object({
      cache: z.string().optional(),
      generate: z.string().optional(),
      exact: z.string().optional(),
      save: z.string().optional(),
      emit: z.string().optional(),
      debug: z.string().optional(),
      enrich: z.string().optional(),
      extract: z.string().optional(),
    })
  ),
  async (ctx) => {
    const { buildConfig, emitted, enrichments, extractions, parsed, stores } = await cachedBuild({
      cache: ctx.req.query("cache") !== "false",
      generate: ctx.req.query("generate") !== "false",
      exact: ctx.req.query("exact"),
      emit: ctx.req.query("emit") !== "false",
      debug: ctx.req.query("debug") === "true",
      enrich: ctx.req.query("enrich") !== "false",
      extract: ctx.req.query("extract") !== "false",
    });

    const { files, log, fileTypeCache, ...config } = buildConfig;

    return ctx.json({
      emitted: {
        stats: emitted.stats,
        siteMap: emitted.siteMap,
      },
      enrichments,
      extractions,
      stores,
      parsed,
      config,
    });
  }
);

app.post(
  "/build",
  timeout(120_000),
  zValidator(
    "json",
    z.object({
      cache: z.string().optional(),
      generate: z.string().optional(),
      exact: z.string().optional(),
      save: z.string().optional(),
      emit: z.string().optional(),
      debug: z.string().optional(),
      enrich: z.string().optional(),
      extract: z.string().optional(),
    })
  ),
  async (ctx) => {
    const body = await ctx.req.json();

    const { buildConfig, emitted, enrichments, extractions, parsed, stores } = await cachedBuild(body);

    return ctx.json({
      emitted: {
        stats: emitted.stats,
        siteMap: emitted.siteMap,
      },
      enrichments,
      extractions,
      stores,
      parsed,
      buildConfig,
    });
  }
);

app.get("/*", async (ctx) => {
  let realPath = join(cwd(), ".iiif/build", ctx.req.path);
  if (realPath.endsWith("meta.json")) {
    realPath = join(cwd(), ".iiif/cache", ctx.req.path);
  }

  if (fileHandler.openJsonMap.has(fileHandler.resolve(realPath))) {
    const file = await fileHandler.loadJson(realPath);
    return ctx.json(file);
  }

  if (fileHandler.existsBinary(fileHandler.resolve(realPath))) {
    const file = await fileHandler.readFile(realPath);
    return ctx.body(file as any);
  }

  return ctx.notFound();
});

if (import.meta.main) {
  await app.request("/build?cache=true&emit=true");
}

export default {
  request: app.request,
  fetch: app.fetch,
  port: 7111,
};
