import fs from "node:fs";
import { createHash } from "node:crypto";
import { watch as watchFs } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { cwd, env } from "node:process";
import type { Command } from "commander";
import PQueue from "p-queue";
import packageJson from "../../package.json";
import { canvasThumbnail } from "../enrich/canvas-thumbnail.ts";
import { filesRewrite } from "../enrich/files-rewrite.ts";
import { homepageProperty } from "../enrich/homepage-property";
// import { manifestSqlite } from "../enrich/manifest-sqlite.ts";
import { enrichTopicThumbnails } from "../enrich/topic-thumbnails.ts";
import { translateMetadata } from "../enrich/translate-metadata.ts";
import { enrichTypesense } from "../enrich/typesense-index.ts";
import { typesensePlaintext } from "../enrich/typesense-plaintext.ts";
import { extractCanvasDims } from "../extract/extract-canvas-dims.ts";
import { extractCollectionThumbnail } from "../extract/extract-collection-thumbnail.ts";
import { extractFilesList } from "../extract/extract-files-list.ts";
import { extractFolderCollections } from "../extract/extract-folder-collections.ts";
import { extractLabelString } from "../extract/extract-label-string";
import { extractMetadataAnalysis } from "../extract/extract-metadata-analysis.ts";
import { extractPartOfCollection } from "../extract/extract-part-of-collection.ts";
import { extractPlaintext } from "../extract/extract-plaintext.ts";
import { extractRemoteSource } from "../extract/extract-remote-source.ts";
import { extractRuntimeHints } from "../extract/extract-runtime-hints.ts";
import { extractSearchRecord } from "../extract/extract-search-record.ts";
import { extractSlugSource } from "../extract/extract-slug-source";
import { extractThumbnail } from "../extract/extract-thumbnail.ts";
import { extractTopics } from "../extract/extract-topics.ts";
import { flatManifests } from "../rewrite/flat-manifests.ts";
import { IIIFJSONStore } from "../stores/iiif-json";
import { IIIFRemoteStore } from "../stores/iiif-remote";
import { IIIFMemoryStore } from "../stores/iiif-memory.ts";
import {
  BUILD_STEP_ORDER,
  type BuildProgressCallbacks,
  type BuildStepId,
  type HssBuildEvent,
} from "../util/build-progress.ts";
import type { Enrichment } from "../util/enrich.ts";
import type { Extraction } from "../util/extract.ts";
import { FileHandler } from "../util/file-handler.ts";
import { type BuildBuiltIns, getBuildConfig, getExternalCacheDirectory } from "../util/get-build-config.ts";
import { acquireCacheLock } from "../util/cache-lock.ts";
import type { BuildConcurrencyConfig, IIIFRC, ResolvedConfigSource } from "../util/get-config.ts";
import type { Linker } from "../util/linker.ts";
import type { Rewrite } from "../util/rewrite.ts";
import type { Tracer } from "../util/tracer.ts";
import {
  OUTPUT_CONTRACT_VERSION,
  OUTPUT_FORMAT_VERSION,
  type BuildManifest,
  type OutputFile,
} from "../output-contract.ts";
import { BUILD_RESULT_VERSION, type BuildEntrypoints, type HssBuildResult } from "../output-contract.ts";
import { createResourceOutputDescriptors } from "../util/resource-output-descriptors.ts";
import { warmRemoteStores } from "./build-steps/-1-warm-remote.ts";
import { parseStores } from "./build-steps/0-parse-stores.ts";
import { link } from "./build-steps/1-link.ts";
import { loadStores } from "./build-steps/1-load-stores.ts";
import { extract } from "./build-steps/2-extract.ts";
import { enrich } from "./build-steps/3-enrich.ts";
import { emit } from "./build-steps/4-emit.ts";
import { indices } from "./build-steps/5-indices.ts";
import { generateCommand } from "./generate.ts";
import { validateCommand } from "./validate.ts";

export type BuildOptions = {
  cwd?: string;
  config?: string;
  cache?: boolean;
  /** Programmatic external cache root. HSS owns the versioned layout below this directory. */
  cacheRoot?: string;
  networkCache?: boolean;
  exact?: string;
  watch?: boolean;
  debug?: boolean;
  scripts?: string;
  generate?: boolean;
  stores?: string[];
  dev?: boolean;
  validate?: boolean;
  extract?: boolean;
  enrich?: boolean;
  emit?: boolean;
  skipFirstBuild?: boolean;
  client?: boolean;
  html?: boolean;
  python?: boolean;
  topics?: boolean;
  out?: string;
  ui?: boolean;
  remoteRecords?: boolean;
  prefetch?: boolean;
  concurrency?: BuildConcurrencyConfig;

  // Programmatic only
  onBuild?: () => void | Promise<void>;
};

const defaultCacheDir = ".iiif/cache";
const defaultBuildDir = ".iiif/build";
const devCache = ".iiif/dev/cache";
const devBuild = ".iiif/dev/build";
const topicFolder = "content/topics";

const defaultRun = [
  extractRuntimeHints.id,
  extractRemoteSource.id,
  extractSearchRecord.id,
  extractLabelString.id,
  extractSlugSource.id,
  homepageProperty.id,
  extractMetadataAnalysis.id,
  extractFolderCollections.id,
  extractFilesList.id,
  extractCollectionThumbnail.id,
  filesRewrite.id,
];

const buildInRewrites: Rewrite[] = [
  //
  flatManifests,
];

const builtInExtractions: Extraction[] = [
  extractLabelString,
  extractSlugSource,
  extractCanvasDims,
  extractThumbnail,
  extractCollectionThumbnail,
  extractTopics,
  extractMetadataAnalysis,
  extractRuntimeHints,
  extractRemoteSource,
  extractFolderCollections,
  extractPlaintext,
  extractFilesList,
  // This is really slow, so we don't run it by default.
  extractPartOfCollection,
  extractSearchRecord,
];
const buildInEnrichments: Enrichment[] = [
  homepageProperty,
  canvasThumbnail,
  translateMetadata,
  // manifestSqlite,
  enrichTypesense,
  typesensePlaintext,
  filesRewrite,
  enrichTopicThumbnails,
  // pdiiif
];
const builtInLinkers: Linker[] = [];

const builtInEnrichmentsMap = {
  [homepageProperty.id]: homepageProperty,
  [canvasThumbnail.id]: canvasThumbnail,
  [translateMetadata.id]: translateMetadata,
  [filesRewrite.id]: filesRewrite,
  [enrichTopicThumbnails.id]: enrichTopicThumbnails,
  // [pdiiif.id]: pdiiif,
};

const builtInExtractionsMap = {
  [extractLabelString.id]: extractLabelString,
  [extractSlugSource.id]: extractSlugSource,
  [extractCanvasDims.id]: extractCanvasDims,
};

const storeTypes = {
  "iiif-json": IIIFJSONStore,
  "iiif-remote": IIIFRemoteStore,
  "iiif-memory": IIIFMemoryStore,
};

export const defaultBuiltIns: BuildBuiltIns = {
  defaultRun,
  rewrites: buildInRewrites,
  extractions: builtInExtractions,
  enrichments: buildInEnrichments,
  linkers: builtInLinkers,
  defaultCacheDir,
  defaultBuildDir,
  devCache,
  devBuild,
  topicFolder,
  storeTypes,
  env: {
    DEV_SERVER: env.DEV_SERVER,
    SERVER_URL: env.SERVER_URL,
  },
};

const BUILD_PHASE_LABELS: Record<BuildStepId, string> = {
  "warm-remote": "Warming remote cache",
  "parse-stores": "Parsing stores",
  "load-stores": "Loading resources",
  "link-resources": "Linking resources",
  "extract-resources": "Extracting resources",
  "enrich-resources": "Enriching resources",
  "emit-files": "Emitting files",
  "build-indices": "Building indices",
  "save-files": "Saving files",
};

export async function buildCommand(options: BuildOptions, command?: Command) {
  if (options.validate) {
    await validateCommand({ config: options.config });
  }

  const startTime = Date.now();
  const initial = await build({
    ui: true,
    ...options,
    watch: false,
  });
  console.log("");
  console.log(`Done in ${Date.now() - startTime}ms`);

  if (!options.watch) {
    return;
  }

  const workingDirectory = options.cwd || cwd();
  const watchTargets = new Map<string, { path: string; recursive: boolean }>();
  const addWatchTarget = (path: string, recursive: boolean) => {
    const absolutePath = isAbsolute(path) ? path : resolve(workingDirectory, path);
    const key = `${absolutePath}:${recursive ? "recursive" : "file"}`;
    watchTargets.set(key, { path: absolutePath, recursive });
  };

  for (const store of Object.values(initial.buildConfig.config.stores || {})) {
    if (store.type === "iiif-json" && store.path) {
      addWatchTarget(store.path, true);
    }
  }
  for (const watchPath of initial.buildConfig.configWatchPaths || []) {
    addWatchTarget(watchPath.path, watchPath.recursive);
  }
  for (const watchedResourcePath of initial.parsed.filesToWatch || []) {
    addWatchTarget(watchedResourcePath, false);
  }

  const ac = new AbortController();
  let watchCount = 0;
  let isBuilding = false;
  let hasPendingBuild = false;
  let isStopping = false;

  const runBuild = async (source: string) => {
    if (isStopping) {
      return;
    }
    if (isBuilding) {
      hasPendingBuild = true;
      return;
    }

    isBuilding = true;
    let reason = source;

    while (true) {
      const rebuildStart = Date.now();
      console.log(`\nRebuilding (${reason})...`);
      try {
        await build({
          ui: true,
          ...options,
          watch: false,
        });
        console.log(`Done in ${Date.now() - rebuildStart}ms`);
      } catch (error) {
        console.error(error);
      }

      if (!hasPendingBuild || isStopping) {
        hasPendingBuild = false;
        break;
      }
      hasPendingBuild = false;
      reason = "queued changes";
    }

    isBuilding = false;
  };

  for (const target of watchTargets.values()) {
    if (!fs.existsSync(target.path)) {
      continue;
    }

    const watcher = watchFs(target.path, {
      signal: ac.signal,
      recursive: target.recursive,
    });
    watchCount++;

    (async () => {
      try {
        for await (const event of watcher) {
          const changed = event.filename ? `${target.path}/${event.filename}` : target.path;
          await runBuild(changed);
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          console.error(`Watch error for ${target.path}:`, error);
        }
      }
    })();
  }

  if (watchCount === 0) {
    console.log("No watchable paths were found.");
    return;
  }

  console.log(`Watching ${watchCount} paths (Ctrl+C to stop).`);

  await new Promise<void>((resolveStop) => {
    const stopWatching = () => {
      if (isStopping) {
        return;
      }
      isStopping = true;
      ac.abort();
      process.off("SIGINT", stopWatching);
      process.off("SIGTERM", stopWatching);
      resolveStop();
    };

    process.on("SIGINT", stopWatching);
    process.on("SIGTERM", stopWatching);
  });
}

export interface BuildContext {
  fileHandler?: FileHandler;
  pathCache?: { allPaths: Record<string, string> };
  storeRequestCaches?: Record<string, any>;
  tracer?: Tracer;
  customConfig?: IIIFRC;
  customConfigSource?: Omit<ResolvedConfigSource, "config">;
  progress?: BuildProgressCallbacks;
  onEvent?: (event: HssBuildEvent) => void | Promise<void>;
  fetch?: typeof globalThis.fetch;
}

export async function build(options: BuildOptions, builtIns = defaultBuiltIns, context: BuildContext = {}) {
  await context.onEvent?.({ type: "build-started", at: new Date().toISOString() });
  try {
    const output = await buildWithExternalCacheFallback(options, builtIns, context);
    await context.onEvent?.({ type: "build-completed", result: output.result, at: new Date().toISOString() });
    return output;
  } catch (error) {
    const buildError = error instanceof Error ? error : new Error(String(error));
    try {
      await context.onEvent?.({
        type: "build-failed",
        error: { name: buildError.name, message: buildError.message },
        at: new Date().toISOString(),
      });
    } catch {
      // Reporting failures must not replace the build failure.
    }
    throw error;
  }
}

async function buildWithExternalCacheFallback(options: BuildOptions, builtIns: BuildBuiltIns, context: BuildContext) {
  if (!options.cacheRoot) {
    return buildInternal(options, builtIns, context);
  }
  const cacheDirectory = resolve(
    options.cwd || cwd(),
    getExternalCacheDirectory(options.cacheRoot, Boolean(options.dev))
  );
  let release: () => Promise<void>;
  try {
    release = await acquireCacheLock(cacheDirectory);
  } catch (error) {
    if (!isExternalCacheIoFailure(error, cacheDirectory)) {
      throw error;
    }
    await reportCacheFallback(context, error);
    return buildInternal({ ...options, cacheRoot: undefined, cache: false, networkCache: false }, builtIns, context);
  }
  try {
    return await buildInternal(options, builtIns, context);
  } catch (error) {
    if (!isExternalCacheIoFailure(error, cacheDirectory)) {
      throw error;
    }
    await reportCacheFallback(context, error);
    return buildInternal({ ...options, cacheRoot: undefined, cache: false, networkCache: false }, builtIns, context);
  } finally {
    try {
      await release();
    } catch (error) {
      await context.onEvent?.({
        type: "diagnostic",
        level: "warning",
        code: "CACHE_LOCK_RELEASE_FAILED",
        message: `External cache lock cleanup failed: ${(error as Error).message}`,
        at: new Date().toISOString(),
      });
    }
  }
}

const CACHE_IO_ERROR_CODES = new Set(["EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT", "EIO", "EMFILE", "ENFILE", "ELOCKED"]);

function isExternalCacheIoFailure(error: unknown, cacheDirectory: string) {
  let current: any = error;
  while (current) {
    if (CACHE_IO_ERROR_CODES.has(String(current.code || ""))) {
      const errorPath = current.path ? resolve(String(current.path)) : null;
      return !errorPath || errorPath === cacheDirectory || errorPath.startsWith(`${cacheDirectory}${sep}`);
    }
    current = current.cause;
  }
  return false;
}

async function reportCacheFallback(context: BuildContext, error: unknown) {
  await context.onEvent?.({
    type: "diagnostic",
    level: "warning",
    code: "CACHE_FALLBACK",
    message: `External cache unavailable; retrying without cache: ${(error as Error).message}`,
    at: new Date().toISOString(),
  });
}

async function buildInternal(
  options: BuildOptions,
  builtIns: BuildBuiltIns = defaultBuiltIns,
  {
    fileHandler = new FileHandler(fs, options.cwd || cwd(), true),
    pathCache = { allPaths: {} },
    storeRequestCaches,
    tracer,
    customConfig,
    customConfigSource,
    progress,
    onEvent,
    fetch,
  }: BuildContext = {}
) {
  const buildConfig = await getBuildConfig(
    {
      extract: true,
      enrich: true,
      dev: false,
      emit: true,
      remoteRecords: false,
      prefetch: true,
      networkCache: true,
      ...options,
    },
    {
      ...builtIns,
      fileHandler,
      tracer,
      customConfig,
      customConfigSource,
      fetch,
    }
  );

  let discoveredResources = 0;
  let processedResources = 0;
  const progressCallbacks: BuildProgressCallbacks = {
    onPhase: (details) => progress?.onPhase?.(details),
    async onResourcesDiscovered(details) {
      discoveredResources = Math.max(discoveredResources, details.total);
      await progress?.onResourcesDiscovered?.(details);
      await onEvent?.({ type: "resources-discovered", ...details, at: new Date().toISOString() });
    },
    async onResourceProcessed(details) {
      processedResources += 1;
      await progress?.onResourceProcessed?.(details);
      await onEvent?.({
        type: "resource-progress",
        processed: processedResources,
        total: discoveredResources,
        ...details,
        at: new Date().toISOString(),
      });
    },
    onFetch: (event) => progress?.onFetch?.(event),
    async onMessage(message) {
      await progress?.onMessage?.(message);
      await onEvent?.({ type: "diagnostic", level: "info", message, at: new Date().toISOString() });
    },
  };

  if (buildConfig.options.generate) {
    await generateCommand({ ...buildConfig.options, fetch: buildConfig.fetch });
  }

  const { time } = buildConfig;
  buildConfig.files.clearProducerClaims();

  await buildConfig.files.mkdir(buildConfig.cacheDir);
  const isPartialBuild = Boolean(buildConfig.options.exact || buildConfig.options.stores?.length);
  if (buildConfig.options.emit && !buildConfig.options.dev && !isPartialBuild) {
    await buildConfig.files.remove(buildConfig.buildDir);
  }
  await buildConfig.files.mkdir(buildConfig.buildDir);
  if (isPartialBuild) {
    await buildConfig.files.remove(join(buildConfig.buildDir, "meta", "build.json"));
  }
  await buildConfig.files.mkdir(buildConfig.requestCacheDir);

  const parseState = { storeRequestCaches: storeRequestCaches || {} };

  const enterPhase = async (id: BuildStepId) => {
    const details = {
      id,
      label: BUILD_PHASE_LABELS[id],
      index: BUILD_STEP_ORDER.indexOf(id) + 1,
      total: BUILD_STEP_ORDER.length,
    };
    await progressCallbacks.onPhase?.(details);
    await onEvent?.({
      type: "phase-started",
      phase: id,
      label: details.label,
      index: details.index,
      total: details.total,
      at: new Date().toISOString(),
    });
    return Date.now();
  };
  const runPhase = async <T>(id: BuildStepId, label: string, task: () => Promise<T>) => {
    const startedAt = await enterPhase(id);
    const result = await time(label, task());
    await onEvent?.({
      type: "phase-completed",
      phase: id,
      durationMs: Date.now() - startedAt,
      at: new Date().toISOString(),
    });
    return result;
  };

  const useNetworkCache = buildConfig.options.networkCache ?? true;
  if (buildConfig.network.prefetch && useNetworkCache) {
    await runPhase("warm-remote", "Warmed remote request cache", () =>
      warmRemoteStores(buildConfig, parseState, progressCallbacks)
    );
  } else {
    await progressCallbacks.onMessage?.("Skipping remote cache warmup");
  }

  // Parse stores.
  const parsed = await runPhase("parse-stores", "Parsed stores", () =>
    parseStores(buildConfig, parseState, undefined, progressCallbacks)
  );

  const loadTargetTotal = Object.values(parsed.storeResources).reduce((total, resources) => {
    if (!buildConfig.options.exact) {
      return total + resources.length;
    }
    return (
      total +
      resources.filter(
        (resource) => resource.slug === buildConfig.options.exact || resource.path === buildConfig.options.exact
      ).length
    );
  }, 0);
  await progressCallbacks.onResourcesDiscovered?.({ total: loadTargetTotal });

  // Load stores.
  const stores = await runPhase("load-stores", "Loaded stores", () =>
    loadStores(parsed, buildConfig, undefined, progressCallbacks)
  );

  pathCache.allPaths = { ...stores.allPaths };

  const linked = await runPhase("link-resources", "Linking resources", () => link(stores, buildConfig));

  // Extract.
  const extractions = await runPhase("extract-resources", "Extracting resources", () =>
    extract(stores, buildConfig, progressCallbacks)
  );

  const enrichments = await runPhase("enrich-resources", "Enriching resources", () =>
    enrich(stores, buildConfig, progressCallbacks)
  );

  const emitted = await runPhase("emit-files", "Emitting files", () =>
    emit(stores, buildConfig, { canvasSearchIndex: enrichments.canvasSearchIndex })
  );

  await runPhase("build-indices", "Building indices", () =>
    indices(
      {
        allResources: stores.allResources,
        editable: stores.editable,
        overrides: stores.overrides,
        collections: extractions.collections,
        manifestCollection: emitted.manifestCollection,
        storeCollections: emitted.storeCollections,
        indexCollection: emitted.indexCollection,
        collectionItems: emitted.collectionItems,
        searchIndexes: enrichments.searchIndexes,
        allIndices: enrichments.allIndices,
        siteMap: emitted.siteMap,
      },
      buildConfig
    )
  );

  await buildConfig.fileTypeCache.save();

  let manifest: BuildManifest | undefined;
  let outputRoot: string | undefined;
  if (buildConfig.options.emit) {
    const saveStartedAt = await enterPhase("save-files");
    const { failedToWrite } = await fileHandler.saveAll(false, buildConfig.concurrency.write);
    if (failedToWrite.length) {
      const details = failedToWrite
        .slice(0, 5)
        .map(({ filePath, err }) => `${filePath}: ${err instanceof Error ? err.message : String(err)}`)
        .join("\n");
      const cause = failedToWrite[0].err;
      throw Object.assign(new Error(`Failed to write ${failedToWrite.length} output file(s):\n${details}`, { cause }), {
        code: (cause as NodeJS.ErrnoException)?.code,
        path: failedToWrite[0].filePath,
      });
    }

    const resolvedOutputRoot = buildConfig.files.resolve(buildConfig.buildDir);
    outputRoot = resolvedOutputRoot;
    const inventory: OutputFile[] = [];
    const inventoryQueue = new PQueue({ concurrency: buildConfig.concurrency.write });
    const visit = async (directory: string) => {
      const entries = await buildConfig.files.fs.promises.readdir(directory, { withFileTypes: true });
      await Promise.all(entries.map(async (entry) => {
        const filePath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(filePath);
          return;
        }
        const outputPath = relative(resolvedOutputRoot, filePath).split("\\").join("/");
        if (outputPath === "meta/build.json" || outputPath === "meta/resource-descriptors.json") {
          return;
        }
        await inventoryQueue.add(async () => {
          const data = await buildConfig.files.fs.promises.readFile(filePath);
          inventory.push({
            path: outputPath,
            bytes: data.byteLength,
            sha256: createHash("sha256").update(data).digest("hex"),
          });
        });
      }));
    };
    await visit(resolvedOutputRoot);
    const resourceDescriptors = await createResourceOutputDescriptors(
      resolvedOutputRoot,
      stores.allResources,
      inventory,
      emitted.indexCollection
    );
    const descriptorJson = JSON.stringify(resourceDescriptors, null, 2);
    await buildConfig.files.writeFile(
      join(buildConfig.buildDir, "meta", "resource-descriptors.json"),
      descriptorJson
    );
    inventory.push({
      path: "meta/resource-descriptors.json",
      bytes: Buffer.byteLength(descriptorJson),
      sha256: createHash("sha256").update(descriptorJson).digest("hex"),
    });
    inventory.sort((a, b) => a.path.localeCompare(b.path));
    const features = [
      inventory.some(({ path }) => path.startsWith("meta/search/")) && "search",
      inventory.some(({ path }) => path.includes("/canvases/index.json")) && "canvas-discovery",
      inventory.some(({ path }) => path === "topics/collection.json") && "topics",
      buildConfig.options.debug && "debug",
    ].filter(Boolean) as string[];
    const entrypointCandidates: Record<keyof BuildEntrypoints, string> = {
      rootCollection: "collection.json",
      manifestsCollection: "manifests/collection.json",
      collectionsCollection: "collections/collection.json",
      featuredCollection: "featured/collection.json",
      resources: "meta/resources.json",
      resourceDescriptors: "meta/resource-descriptors.json",
      sitemap: "meta/sitemap.json",
      indices: "meta/indices.json",
      facets: "meta/facets.json",
      canvasSearch: "meta/canvas-search-index.json",
    };
    const inventoryPaths = new Set(inventory.map(({ path }) => path));
    const entrypoints = Object.fromEntries(
      Object.entries(entrypointCandidates).filter(([, path]) => inventoryPaths.has(path))
    ) as BuildEntrypoints;
    manifest = {
      formatVersion: OUTPUT_FORMAT_VERSION,
      contractVersion: OUTPUT_CONTRACT_VERSION,
      hssVersion: packageJson.version,
      mode: isPartialBuild ? "partial" : "full",
      canonicalBaseUrl: buildConfig.configUrl as string,
      completedAt: new Date().toISOString(),
      stores: [...buildConfig.stores].sort(),
      features,
      search: inventory.filter(({ path }) => path.endsWith(".mapping.json")).map(({ path }) => path),
      analysis: inventory.filter(({ path }) => /(^|\/)[^/]*analysis[^/]*\.json$/i.test(path)).map(({ path }) => path),
      entrypoints,
      resources: {
        manifests: emitted.indexCollection
          ? Object.values(emitted.indexCollection).filter((item: any) => item.type === "Manifest").length
          : 0,
        collections: emitted.indexCollection
          ? Object.values(emitted.indexCollection).filter((item: any) => item.type === "Collection").length
          : 0,
        canvases: Object.values(emitted.siteMap || {}).reduce(
          (total: number, entry: any) => total + (entry.canvases || 0),
          0
        ),
      },
      files: inventory,
    };
    await buildConfig.files.writeFile(
      join(buildConfig.buildDir, "meta", "build.json"),
      JSON.stringify(manifest, null, 2)
    );
    await onEvent?.({
      type: "phase-completed",
      phase: "save-files",
      durationMs: Date.now() - saveStartedAt,
      at: new Date().toISOString(),
    });
  }

  const result: HssBuildResult = manifest
    ? {
        resultVersion: BUILD_RESULT_VERSION,
        status: "complete",
        directory: outputRoot as string,
        manifestPath: "meta/build.json",
        manifest,
        diagnostics: { cache: buildConfig.options.cacheRoot || buildConfig.options.cache ? "enabled" : "disabled" },
      }
    : { resultVersion: BUILD_RESULT_VERSION, status: "not-emitted" };

  return {
    result,
    emitted,
    enrichments,
    linked,
    extractions,
    stores,
    parsed,
    buildConfig,
  };
}

export type BuildConfig = Awaited<ReturnType<typeof getBuildConfig>>;
