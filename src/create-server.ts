import fs from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import mitt from "mitt";
import PQueue from "p-queue";
import { z } from "zod";
import { type BuildOptions, build, defaultBuiltIns } from "./commands/build";
import { createBuildStatusTracker } from "./server/build-status.ts";
import { findDebugUiDir, mimeTypeFor, registerDebugUiRoutes } from "./server/debug-ui-routes.ts";
import { editorHtml } from "./server/editor.html";
import { explorerHtml } from "./server/explorer.html";
import type { BuildStatus } from "./util/build-progress.ts";
import { FileHandler, type SavedFile } from "./util/file-handler";
import { resolveConfigSource, type IIIFRC, type ResolvedConfigSource } from "./util/get-config";
import { isSafeOutputPath } from "./output-validation.ts";
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
  const baseServerUrl = () => resolveHostUrl(config.server?.url || "http://localhost:7111").replace(/\/+$/, "");
  let configSource = serverOptions.configSource;

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
  const pathCache = { allPaths: {} as Record<string, string> };

  let isWatching = false;
  const fileHandler = new FileHandler(fs, projectRoot);
  let savedFiles = new Map<string, SavedFile>();
  let outputSnapshot: Map<string, Buffer> | undefined;
  let editableSources: Record<string, { type: string; source: any }> | undefined;
  const tracer = new Tracer();
  const storeRequestCaches = {};
  const buildStatusTracker = createBuildStatusTracker((status) => {
    emitter.emit("build-progress", status);
  });

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
    const buildFiles = new FileHandler(fs, projectRoot);
    if (options.dev) {
      buildFiles.savedFiles = new Map(savedFiles);
      buildFiles.captureRoot = toProjectPath(defaultBuiltIns.devBuild);
    }
    try {
      if (options.dev && serverOptions.reloadConfig) config = await serverOptions.reloadConfig();
      else if (options.dev && configSource && configSource.mode !== "custom") {
        const refreshed = await resolveConfigSource(
          configSource.mode === "explicit" ? configSource.configPath : undefined,
          projectRoot
        );
        const { config: nextConfig, ...source } = refreshed;
        config = nextConfig;
        configSource = source;
      }
      result = await build({ ...options, cwd: projectRoot }, defaultBuiltIns, {
        storeRequestCaches,
        // Failed builds must not leave queued writes/copies in the next build.
        fileHandler: buildFiles,
        pathCache,
        tracer,
        customConfig: config,
        customConfigSource: configSource,
        progress: buildStatusTracker.callbacks,
      });
      if (result.result?.status === "complete") {
        const snapshot = new Map<string, Buffer>();
        const queue = new PQueue({ concurrency: 16 });
        await Promise.all(
          [...result.result.manifest.files.map((file) => file.path), "meta/build.json"].map((path) =>
            queue.add(async () => {
              const absolute = buildFiles.resolve(join(result.buildConfig.buildDir, path));
              snapshot.set(absolute, buildFiles.capturedFiles.get(absolute) || (await readFile(absolute)));
            })
          )
        );
        // Publish only after the entire build and snapshot succeed. Requests keep the previous generation meanwhile.
        outputSnapshot = snapshot;
        editableSources = {
          ...(result.result.manifest.mode === "partial" ? editableSources : {}),
          ...Object.fromEntries(
            result.stores.allResources
              .filter((resource) => !resource.virtual)
              .map(({ slug, type, source }) => [slug, { type, source }])
          ),
        };
        fileHandler.readSnapshot = { root: buildFiles.resolve(result.buildConfig.buildDir), files: snapshot };
        savedFiles = buildFiles.savedFiles || new Map();
        activePaths.buildDir = result.buildConfig.buildDir;
        activePaths.cacheDir = result.buildConfig.cacheDir;
        for (const [values, changed] of [
          [fileHandler.openJsonMap, fileHandler.openJsonChanged],
          [fileHandler.openBinaryMap, fileHandler.openBinaryChanged],
        ] as const) {
          for (const key of values.keys())
            if (!changed.get(key)) {
              values.delete(key);
              changed.delete(key);
            }
        }
      }
      if (isWatching) refreshWatchers();
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
    return {
      ...result,
      dev: {
        writes: buildFiles.writeStats,
        snapshotBytes: [...(outputSnapshot?.values() || [])].reduce((total, bytes) => total + bytes.length, 0),
      },
    };
  };

  const cachedBuild = (options: BuildOptions) => {
    const queued = buildQueue.then(() => executeBuild(options));
    // Keep a completion barrier, not the last build result and all of its Vaults.
    buildQueue = queued.then(
      () => undefined,
      () => undefined
    );
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
      pendingFiles: Array.from(fileHandler.openJsonChanged)
        .filter(([, changed]) => changed)
        .map(([path]) => path),
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

  const watchers = new Map<string, fs.FSWatcher>();
  let watchTimer: ReturnType<typeof setTimeout> | undefined;
  let watchDirty = false;
  let watchBuild: Promise<void> | undefined;

  function scheduleWatchBuild() {
    if (!isWatching) return;
    watchDirty = true;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      if (watchBuild || !isWatching) return;
      watchDirty = false;
      watchBuild = cachedBuild({ emit: true, cache: true, dev: true })
        .then(() => {
          emitter.emit("full-rebuild", { source: "watch" });
        })
        .catch(() => undefined) // The build status reports failure; keep watching for the next edit.
        .finally(() => {
          watchBuild = undefined;
          if (watchDirty && isWatching) scheduleWatchBuild();
        });
    }, 75);
    watchTimer.unref?.();
  }

  function refreshWatchers() {
    const requested: Array<{ path: string; recursive: boolean; rootConfig?: boolean }> = [];
    for (const store of Object.values(config.stores)) {
      if (store.type === "iiif-json") requested.push({ path: toProjectPath(store.path), recursive: true });
      if (store.type === "iiif-remote" && store.overrides)
        requested.push({ path: toProjectPath(store.overrides), recursive: true });
    }
    requested.push(...(configSource?.watchPaths || []).map((entry) => ({ ...entry, path: toProjectPath(entry.path) })));
    requested.push({ path: toProjectPath(configSource?.defaultScriptsPath || "./scripts"), recursive: true });
    // A JS config can read sidecar YAML/JSON (as Delft does). Watch root config files without watching generated output.
    requested.push({ path: projectRoot, recursive: false, rootConfig: true });
    const next = new Set<string>();
    for (const entry of requested) {
      let location = entry.path;
      // Watch the parent for files (atomic editor replacements), and for folders not created yet.
      if (!existsSync(location) || !fs.statSync(location).isDirectory()) location = dirname(location);
      while (!existsSync(location) && location !== dirname(location)) location = dirname(location);
      const key = JSON.stringify([location, entry]);
      next.add(key);
      if (watchers.has(key)) continue;
      try {
        const watcher = fs.watch(location, { recursive: entry.recursive, persistent: false }, (_event, filename) => {
          const changed = filename ? resolve(location, filename.toString()) : entry.path;
          if (
            relative(projectRoot, changed)
              .split(/[\\/]/)
              .some((part) => [".iiif", "node_modules", ".git"].includes(part))
          )
            return;
          if (changed.startsWith(`${toProjectPath(activePaths.buildDir)}/`)) return;
          if (entry.rootConfig) {
            if (dirname(changed) !== projectRoot || !/\.(ya?ml|json|[cm]?[jt]s)$/.test(changed)) return;
          } else if (changed !== entry.path && !changed.startsWith(`${entry.path}/`)) return;
          const resourcePath = pathCache.allPaths[changed];
          if (resourcePath) emitter.emit("file-change", { path: resourcePath });
          scheduleWatchBuild();
        });
        watcher.on("error", (error) => console.warn(`IIIF watcher failed for ${entry.path}:`, error));
        watchers.set(key, watcher);
      } catch (error) {
        console.warn(`Unable to watch ${entry.path}:`, error);
      }
    }
    for (const [key, watcher] of watchers)
      if (!next.has(key)) {
        watcher.close();
        watchers.delete(key);
      }
  }

  function stopWatching() {
    isWatching = false;
    watchDirty = false;
    clearTimeout(watchTimer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  }

  app.get("/watch", (ctx) => {
    if (!isWatching) {
      isWatching = true;
      refreshWatchers();
      console.log(`Watching ${watchers.size} paths`);
    }
    return ctx.json({ watching: true });
  });

  app.get("/unwatch", (ctx) => {
    stopWatching();
    return ctx.json({ watching: false });
  });

  app.get("/build/save", async (ctx) => {
    const total = Array.from(fileHandler.openJsonChanged.values()).filter(Boolean).length;
    if (total) {
      const { failedToWrite } = await fileHandler.saveAll();
      if (failedToWrite.length) return ctx.json({ saved: false, total, failed: failedToWrite.length }, 500);
    }
    return ctx.json({ saved: true, total });
  });

  const booleanOption = z.preprocess(
    (value) => (value === "true" ? true : value === "false" ? false : value),
    z.boolean().optional()
  );
  const buildRequest = z.object({
    cache: booleanOption,
    networkCache: booleanOption,
    generate: booleanOption,
    exact: z.string().optional(),
    emit: booleanOption,
    debug: booleanOption,
    enrich: booleanOption,
    extract: booleanOption,
  });
  async function buildResponse(ctx: Context, options: z.infer<typeof buildRequest>) {
    const result = await cachedBuild({ cache: true, generate: true, ...options, dev: true });
    const { files, log, fileTypeCache, ...buildConfig } = result.buildConfig;
    const report = {
      emitted: { stats: result.emitted.stats, siteMap: result.emitted.siteMap },
      extractions: result.extractions,
      enrichments: result.enrichments,
      timings: result.timings,
      dev: result.dev,
      config: buildConfig,
      buildConfig,
      stores: result.stores && {
        ...result.stores,
        allResources: result.stores.allResources.map(({ vault, ...resource }) => resource),
      },
      parsed: result.parsed,
    };
    emitter.emit("full-rebuild", report);
    return ctx.json(report);
  }
  app.get("/build", zValidator("query", buildRequest), (ctx) => buildResponse(ctx, ctx.req.valid("query")));
  app.post("/build", zValidator("json", buildRequest), (ctx) => buildResponse(ctx, ctx.req.valid("json")));

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
      const isJson = ctx.req.query("json") === "true";

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

      if (!isSafeOutputPath(name)) return ctx.text("Invalid slug", 400);

      const existing = join(toProjectPath(chosenStore.path), `${name}.json`);
      if (existsSync(existing)) {
        return ctx.text(`Manifest ${name} already exists`, 400);
      }

      const manifest = {
        "@context": "http://iiif.io/api/presentation/3/context.json",
        id: `${baseServerUrl()}/${name}/manifest.json`,
        type: "Manifest",
        label: {
          en: ["Blank Manifest"],
        },
        items: [],
      };

      await mkdir(dirname(existing), { recursive: true });
      await writeFile(existing, JSON.stringify(manifest, null, 2));

      const created = await cachedBuild({
        emit: true,
        cache: false,
        dev: true,
      });

      const resource = created.stores.allResources.find(
        (resource) => resource.source.type === "disk" && toProjectPath(resource.source.filePath) === existing
      );
      if (!resource) return ctx.text("Created file was not included by the store configuration", 422);
      const manifestId = `${resource.slug}/manifest.json`;
      const manifestUrl = `${baseServerUrl()}/${manifestId.replace(/^\/+/, "")}`;

      if (isJson) {
        return ctx.json({ manifestUrl, editUrl: `${meUrl}/editor/external?manifest=${manifestUrl}` });
      }

      return ctx.redirect(`${meUrl}/editor/external?manifest=${manifestUrl}`);
    }
  );

  app.get("/*", async (ctx, next) => {
    ctx.header("Cache-Control", "no-store");
    if (ctx.req.path.startsWith("/ws")) {
      await next();
      return;
    }
    let requestedPath: string;
    try {
      requestedPath = decodeURIComponent(ctx.req.path).replace(/^\/+/, "");
    } catch {
      return ctx.notFound();
    }
    if (!isSafeOutputPath(requestedPath)) return ctx.notFound();
    let realPath = join(toProjectPath(activePaths.buildDir), requestedPath);
    if (realPath.endsWith("meta.json")) {
      realPath = join(toProjectPath(activePaths.cacheDir), requestedPath);
    }

    const headers: Record<string, string> = {
      //
    };

    const isManifest = ctx.req.path.endsWith("manifest.json");
    if (isManifest) {
      const manifestUrl = `${baseServerUrl()}${ctx.req.path}`;
      headers["X-IIIF-Post-Url"] = manifestUrl;
    }

    const isEdit = ctx.req.path.endsWith("/edit");
    if (isEdit) {
      const slug = ctx.req.path.replace("/edit", "").slice(1);
      const realPath = await resolveEditablePathForSlug(fileHandler, activePaths.buildDir, slug, editableSources);
      if (!realPath) {
        return ctx.notFound();
      }

      const manifestId = ctx.req.path.replace("/edit", "/manifest.json");
      const manifestUrl = `${baseServerUrl()}${manifestId}`;

      return ctx.redirect(`${meUrl}/editor/external?manifest=${manifestUrl}`);
    }

    headers["Cache-Control"] = "no-store";
    headers["Content-Type"] = mimeTypeFor(realPath);
    const outputRoot = toProjectPath(activePaths.buildDir);
    if (outputSnapshot && realPath.startsWith(`${outputRoot}/`)) {
      const file = outputSnapshot.get(realPath);
      return file ? ctx.body(file as any, { headers }) : ctx.notFound();
    }
    try {
      // Before the first build, and for private metadata, read fresh bytes rather than caching filesystem reads forever.
      return ctx.body((await readFile(realPath)) as any, { headers });
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EISDIR"].includes((error as NodeJS.ErrnoException).code || "")) return ctx.notFound();
      throw error;
    }
  });

  const saveManifest = async (ctx: Context) => {
    const isManifest = ctx.req.path.endsWith("manifest.json");
    if (!isManifest) {
      return ctx.notFound();
    }

    // WIthout `/manifest.json`
    const slug = ctx.req.path.replace("/manifest.json", "").slice(1);
    const realPath = await resolveEditablePathForSlug(fileHandler, activePaths.buildDir, slug, editableSources);
    if (!realPath) {
      return ctx.notFound();
    }

    const file = await ctx.req.json();
    await fileHandler.saveJson(realPath, file, true);
    await cachedBuild({
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
      close: stopWatching,
      getBuildStatus: () => buildStatusTracker.getBuildStatus(),
    },
  };
}
