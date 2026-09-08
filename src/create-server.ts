import fs from "node:fs";
import { existsSync } from "node:fs";
import { readFile, watch, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { timeout } from "hono/timeout";
import mitt from "mitt";
import { z } from "zod";
import { type BuildOptions, build, defaultBuiltIns } from "./commands/build";
import { createBuildStatusTracker } from "./server/build-status.ts";
import { findDebugUiDir, registerDebugUiRoutes } from "./server/debug-ui-routes.ts";
import { editorHtml } from "./server/editor.html";
import { explorerHtml } from "./server/explorer.html";
import type { BuildStatus } from "./util/build-progress.ts";
import { FileHandler } from "./util/file-handler";
import type { IIIFRC, ResolvedConfigSource } from "./util/get-config";
import { resolveEditablePathForSlug } from "./util/resolve-editable-path";
import { resolveHostUrl } from "./util/resolve-host-url";
import { Tracer } from "./util/tracer";

const require = createRequire(import.meta.url);

export type IiifServerBuildEvent =
  | { type: "start"; context: "development" | "production"; buildNumber: number }
  | {
      type: "success";
      context: "development" | "production";
      buildNumber: number;
      buildDir: string | null;
      durationMs: number;
    }
  | {
      type: "error";
      context: "development" | "production";
      buildNumber: number;
      error: Error;
      durationMs: number;
    };

interface IIIFServerOptions {
  customManifestEditor?: string;
  configSource?: Omit<ResolvedConfigSource, "config">;
  reloadConfig?: () => Promise<IIIFRC>;
  projectRoot?: string;
  onBuild?: (event: IiifServerBuildEvent) => void | Promise<void>;
  onboarding?: {
    enabled?: boolean;
    configMode?: string;
    contentFolder?: string | null;
    shorthand?: {
      enabled: boolean;
      urls: string[];
      saveManifests: boolean;
      overrides: string;
    } | null;
    hints?: {
      addContent?: string;
      astro?: string;
      vite?: string;
    };
  };
}

function redirectToDebugPath(basePathHeader?: string) {
  const normalizedBase = (basePathHeader || "").replace(/^\/+/, "").replace(/\/+$/, "");
  return normalizedBase.length > 0 ? `/${normalizedBase}/_debug/` : "/_debug/";
}

export async function createServer(config: IIIFRC, serverOptions: IIIFServerOptions = {}) {
  const app = new Hono();
  const projectRoot = resolve(serverOptions.projectRoot || process.cwd());
  const meUrl = serverOptions.customManifestEditor || "https://manifest-editor.digirati.services";
  const baseServerUrl = resolveHostUrl(config.server?.url || "http://localhost:7111").replace(/\/+$/, "");
  const configSource = serverOptions.configSource;

  app.use(async (c, next) => {
    if (c.req.method === "OPTIONS") {
      function set(key: string, value: string) {
        c.res.headers.set(key, value);
      }
      const didRequestPrivateNetwork = c.req.header("access-control-request-private-network");
      if (didRequestPrivateNetwork) {
        set("Access-Control-Allow-Private-Network", "true");
      }
    }
    await next();
  });

  app.use(
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
      exposeHeaders: ["Content-Type", "X-IIIF-Post-Url", "Access-Control-Allow-Private-Network"],
      allowHeaders: ["Content-Type", "Access-Control-Request-Private-Network"],
    })
  );

  app.use("/_debug/api/*", async (ctx, next) => {
    if (ctx.req.method === "GET") {
      return next();
    }
    const origin = ctx.req.header("origin");
    if (origin && origin !== new URL(ctx.req.url).origin) {
      return ctx.json({ error: "Cross-origin debug mutations are forbidden" }, 403);
    }
    return next();
  });

  const emitter = mitt<{
    "file-change": { path: string };
    "file-refresh": { path: string };
    "full-rebuild": unknown;
    "build-progress": BuildStatus;
  }>();

  // New Hono server.
  //
  // TODO Endpoints:
  // - POST /api/page-blocks
  // - POST /api/save-manifest
  //
  let ac = new AbortController();
  const pathCache = { allPaths: {} as Record<string, string> };

  let isWatching = false;
  const fileHandler = new FileHandler(fs, projectRoot);
  const tracer = new Tracer();
  const storeRequestCaches = {};
  const buildStatusTracker = createBuildStatusTracker((status) => {
    emitter.emit("build-progress", status);
  });

  const state = {
    shouldRebuild: false,
  };

  function toProjectPath(path: string) {
    return isAbsolute(path) ? path : resolve(projectRoot, path);
  }

  function selectInitialPath(devPath: string, defaultPath: string) {
    return existsSync(toProjectPath(devPath)) ? devPath : defaultPath;
  }

  const activePaths = {
    buildDir: selectInitialPath(defaultBuiltIns.devBuild, defaultBuiltIns.defaultBuildDir),
    cacheDir: selectInitialPath(defaultBuiltIns.devCache, defaultBuiltIns.defaultCacheDir),
  };

  let buildNumber = 0;
  let buildQueue: Promise<unknown> = Promise.resolve();

  const executeBuild = async (options: BuildOptions) => {
    const context = options.dev ? "development" : "production";
    const currentBuildNumber = ++buildNumber;
    const startedAt = Date.now();
    await serverOptions.onBuild?.({ type: "start", context, buildNumber: currentBuildNumber });
    buildStatusTracker.startBuild();

    let result: Awaited<ReturnType<typeof build>>;
    try {
      if (options.dev && serverOptions.reloadConfig) config = await serverOptions.reloadConfig();
      result = await build({ ...options, cwd: projectRoot }, defaultBuiltIns, {
        storeRequestCaches,
        // Failed builds must not leave queued writes/copies in the next build.
        fileHandler: new FileHandler(fs, projectRoot),
        pathCache,
        tracer,
        customConfig: config,
        customConfigSource: configSource,
        progress: buildStatusTracker.callbacks,
      });
      activePaths.buildDir = result.buildConfig.buildDir;
      activePaths.cacheDir = result.buildConfig.cacheDir;
      buildStatusTracker.completeBuild();
    } catch (error) {
      buildStatusTracker.failBuild(error);
      const originalError = error instanceof Error ? error : new Error(String(error));
      try {
        await serverOptions.onBuild?.({
          type: "error",
          context,
          buildNumber: currentBuildNumber,
          error: originalError,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // The build error is the useful failure; a reporting failure must not replace it.
      }
      throw error;
    }
    await serverOptions.onBuild?.({
      type: "success",
      context,
      buildNumber: currentBuildNumber,
      buildDir: result.buildConfig.buildDir ? toProjectPath(result.buildConfig.buildDir) : null,
      durationMs: Date.now() - startedAt,
    });
    return result;
  };

  const cachedBuild = (options: BuildOptions) => {
    const queued = buildQueue.then(() => executeBuild(options));
    buildQueue = queued.catch(() => undefined);
    return queued;
  };

  app.get("/", async (ctx) => {
    return ctx.redirect(redirectToDebugPath(ctx.req.header("x-hss-base-path")));
  });

  app.get("/explorer/*", async (ctx) => ctx.html(explorerHtml()));
  app.get("/editor/*", async (ctx) => ctx.html(editorHtml()));

  app.get("/client.js", async (ctx) => {
    const localPath = join(projectRoot, "build", "client.js");
    try {
      const file = await readFile(existsSync(localPath) ? localPath : require.resolve("iiif-hss/client"), "utf-8");
      ctx.header("Content-Type", "application/javascript");
      return ctx.body(file);
    } catch (error) {
      console.warn(error);
      return ctx.notFound();
    }
  });

  app.get("/config", async (ctx) => {
    return ctx.json({
      isWatching: isWatching,
      pendingFiles: Array.from(fileHandler.openJsonChanged.keys()).filter(Boolean),
      configMode: configSource?.mode || "custom",
      ...config,
      run: config.run || defaultBuiltIns.defaultRun,
    });
  });

  app.get("/trace.json", async (ctx) => {
    return ctx.json(tracer.toJSON());
  });

  registerDebugUiRoutes({
    app,
    fileHandler,
    getActivePaths: () => ({ ...activePaths }),
    getConfig: () => config,
    getConfigMode: () => (configSource?.mode as any) || "custom",
    getTraceJson: () => tracer.toJSON(),
    getDebugUiDir: () => findDebugUiDir(projectRoot, require.resolve.bind(require)),
    projectRoot,
    manifestEditorUrl: meUrl,
    getBuildStatus: () => buildStatusTracker.getBuildStatus(),
    subscribeBuildProgress: (listener) => {
      emitter.on("build-progress", listener);
      return () => emitter.off("build-progress", listener);
    },
    onboarding: serverOptions.onboarding,
    defaultRun: defaultBuiltIns.defaultRun,
    rebuild: async () => {
      await cachedBuild({
        cache: true,
        emit: true,
        dev: true,
      });
    },
  });

  app.get("/watch", async (ctx) => {
    if (isWatching) return ctx.json({ watching: true });

    const jsonStores = Object.values(config.stores).filter((store) => {
      return store.type === "iiif-json";
    });
    const remoteOverrideStores = Object.values(config.stores).filter((store) => {
      return store.type === "iiif-remote" && typeof store.overrides === "string" && Boolean(store.overrides.trim());
    });
    // Cached full builds refresh aggregate collections and resource inventories after edits.
    const extraWatchPaths = configSource?.watchPaths || [];
    let watchCount = 0;

    for (const store of jsonStores) {
      const storePath = toProjectPath(store.path);
      if (!existsSync(storePath)) {
        continue;
      }
      (async () => {
        const watcher = watch(storePath, {
          signal: ac.signal,
          recursive: true,
        });
        watchCount++;

        for await (const event of watcher) {
          if (event.filename) {
            const name = join(storePath, event.filename);
            const realPath = pathCache.allPaths[name];
            emitter.emit("file-change", { path: realPath });
            await cachedBuild({
              emit: true,
              cache: true,
              dev: true,
            }).catch(() => undefined); // Build status reports the error; keep watching for the next edit.
            emitter.emit("file-refresh", { path: realPath });
          }
        }
      })().catch((err) => {
        // ignore.
      });
    }

    for (const store of remoteOverrideStores) {
      if (store.type !== "iiif-remote" || typeof store.overrides !== "string") {
        continue;
      }
      const overridesPath = toProjectPath(store.overrides.trim());
      if (!existsSync(overridesPath)) {
        continue;
      }
      (async () => {
        const watcher = watch(overridesPath, {
          signal: ac.signal,
          recursive: true,
        });
        watchCount++;

        for await (const event of watcher) {
          const changedPath = event.filename ? join(overridesPath, event.filename) : null;
          const realPath = changedPath ? pathCache.allPaths[changedPath] : undefined;
          if (realPath) {
            emitter.emit("file-change", { path: realPath });
          }
          await cachedBuild({
            emit: true,
            cache: true,
            dev: true,
          }).catch(() => undefined); // Keep watching after errors reported through build status.
          if (realPath) {
            emitter.emit("file-refresh", { path: realPath });
          } else {
            emitter.emit("full-rebuild", {
              source: "overrides-watch",
              path: overridesPath,
              filename: event.filename || null,
            });
          }
        }
      })().catch((err) => {
        // ignore.
      });
    }

    for (const watchPath of extraWatchPaths) {
      const resolvedWatchPath = toProjectPath(watchPath.path);
      if (!existsSync(resolvedWatchPath)) {
        continue;
      }
      (async () => {
        const watcher = watch(resolvedWatchPath, {
          signal: ac.signal,
          recursive: watchPath.recursive,
        });
        watchCount++;
        for await (const event of watcher) {
          await cachedBuild({
            emit: true,
            cache: true,
            dev: true,
          }).catch(() => undefined); // A failed build must not terminate the watcher.
          emitter.emit("full-rebuild", {
            source: "config-watch",
            path: resolvedWatchPath,
            filename: event.filename || null,
          });
        }
      })().catch((err) => {
        // ignore.
      });
    }

    console.log(`Watching ${watchCount} paths`);

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

  app.get(
    "/build",
    timeout(120_000),
    zValidator(
      "query",
      z.object({
        cache: z.string().optional(),
        networkCache: z.string().optional(),
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
        networkCache: ctx.req.query("networkCache") !== "false",
        generate: ctx.req.query("generate") !== "false",
        exact: ctx.req.query("exact"),
        emit: ctx.req.query("emit") !== "false",
        debug: ctx.req.query("debug") === "true",
        enrich: ctx.req.query("enrich") !== "false",
        extract: ctx.req.query("extract") !== "false",
        dev: true,
      });

      const { files, log, fileTypeCache, ...config } = buildConfig;

      const report = {
        emitted: {
          stats: emitted.stats,
          siteMap: emitted.siteMap,
        },
        enrichments,
        extractions,
        stores,
        parsed,
        config,
      };

      emitter.emit("full-rebuild", report);

      return ctx.json(report);
    }
  );

  app.post(
    "/build",
    timeout(120_000),
    zValidator(
      "json",
      z.object({
        cache: z.string().optional(),
        networkCache: z.string().optional(),
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

      if (!body.exact) {
        state.shouldRebuild = false;
      }

      const { buildConfig, emitted, enrichments, extractions, parsed, stores } = await cachedBuild({
        ...body,
        dev: true,
      });

      const report = {
        emitted: {
          stats: emitted.stats,
          siteMap: emitted.siteMap,
        },
        enrichments,
        extractions,
        stores,
        parsed,
        buildConfig,
      };

      emitter.emit("full-rebuild", report);

      return ctx.json(report);
    }
  );

  app.get("/create", async (ctx) => {
    return ctx.html(`
      <form method="post">
        <label for="slug">Slug:</label>
        <input type="text" id="slug" name="slug" required>
        <label for="store">Store:</label>
        <select id="store" name="store">
          ${Object.entries(config.stores)
            .map(([key, value]) => `<option value="${key}">${key}</option>`)
            .join("")}
        </select>
        <button type="submit">Create</button>
      </form>
    `);
  });

  app.post(
    "/create",
    zValidator(
      "form",
      z.object({
        slug: z.string().min(1),
        store: z.string().optional(),
      })
    ),
    async (ctx, next) => {
      const defaultStore =
        Object.entries(config.stores).find(([key, value]) => value.type === "iiif-json")?.[0] || "default";
      const { store = defaultStore, slug: name } = ctx.req.valid("form");
      const isJson = await ctx.req.query("json");

      if (!name) {
        return ctx.text("Slug is required", 400);
      }

      const chosenStore = config.stores[store];
      if (!chosenStore) {
        return ctx.text(`Store ${store} not found`, 400);
      }
      if (chosenStore.type !== "iiif-json") {
        return ctx.text(`Store ${store} is not of type iiif-json`, 400);
      }

      // Check for existing?
      const existing = join(toProjectPath(chosenStore.path), `${name}.json`);
      if (existsSync(existing)) {
        return ctx.text(`Manifest ${name} already exists`, 400);
      }

      const manifest = {
        "@context": "http://iiif.io/api/presentation/3/context.json",
        id: `${join(chosenStore.destination || chosenStore.path, name)}`,
        type: "Manifest",
        label: {
          en: ["Blank Manifest"],
        },
        items: [],
      };

      await writeFile(existing, JSON.stringify(manifest, null, 2));

      const exactPath = join(chosenStore.destination || chosenStore.path, name);

      await cachedBuild({
        emit: true,
        cache: false,
        dev: true,
      });

      const manifestId = `${exactPath}/manifest.json`;
      const manifestUrl = `${baseServerUrl}/${manifestId.replace(/^\/+/, "")}`;

      if (isJson) {
        return ctx.json({ manifestUrl, editUrl: `${meUrl}/editor/external?manifest=${manifestUrl}` });
      }

      return ctx.redirect(`${meUrl}/editor/external?manifest=${manifestUrl}`);
    }
  );

  app.get("/*", async (ctx, next) => {
    if (ctx.req.path.startsWith("/ws")) {
      await next();
      return;
    }
    let realPath = join(projectRoot, activePaths.buildDir, ctx.req.path);
    if (realPath.endsWith("meta.json")) {
      realPath = join(projectRoot, activePaths.cacheDir, ctx.req.path);
    }

    const headers: Record<string, string> = {
      //
    };

    const isManifest = ctx.req.path.endsWith("manifest.json");
    if (isManifest) {
      const manifestUrl = `${baseServerUrl}${ctx.req.path}`;
      headers["X-IIIF-Post-Url"] = manifestUrl;
    }

    const isEdit = ctx.req.path.endsWith("/edit");
    if (isEdit) {
      const slug = ctx.req.path.replace("/edit", "").slice(1);
      const realPath = await resolveEditablePathForSlug(fileHandler, activePaths.buildDir, slug);
      if (!realPath) {
        return ctx.notFound();
      }

      const manifestId = ctx.req.path.replace("/edit", "/manifest.json");
      const manifestUrl = `${baseServerUrl}${manifestId}`;

      return ctx.redirect(`${meUrl}/editor/external?manifest=${manifestUrl}`);
    }

    if (fileHandler.openJsonMap.has(fileHandler.resolve(realPath))) {
      const file = await fileHandler.loadJson(realPath);
      return ctx.json(file, { headers });
    }

    if (fileHandler.existsBinary(fileHandler.resolve(realPath))) {
      const file = await fileHandler.readFile(realPath);
      return ctx.body(file as any, { headers });
    }

    return ctx.notFound();
  });

  const saveManifest = async (ctx: Context) => {
    const isManifest = ctx.req.path.endsWith("manifest.json");
    if (!isManifest) {
      return ctx.notFound();
    }

    // WIthout `/manifest.json`
    const slug = ctx.req.path.replace("/manifest.json", "").slice(1);
    const realPath = await resolveEditablePathForSlug(fileHandler, activePaths.buildDir, slug);
    if (!realPath) {
      return ctx.notFound();
    }

    const file = await ctx.req.json();
    await fileHandler.saveJson(realPath, file, true);
    await cachedBuild({
      exact: slug,
      emit: true,
      cache: true,
      dev: true,
    });
    emitter.emit("file-refresh", { path: realPath });

    return ctx.json({ saved: true });
  };

  app.post("/*", saveManifest);
  app.put("/*", saveManifest);
  app.patch("/*", saveManifest);

  return {
    request: app.request,
    fetch: app.fetch,
    port: 7111,
    _extra: {
      emitter,
      app,
      cachedBuild,
      getBuildStatus: () => buildStatusTracker.getBuildStatus(),
    },
  };
}
