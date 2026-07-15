import fs from "node:fs";
import { createHash } from "node:crypto";
import { watch as watchFs } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { cwd, env } from "node:process";
import type { Command } from "commander";
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
import { BUILD_STEP_ORDER, type BuildProgressCallbacks, type BuildStepId } from "../util/build-progress.ts";
import type { Enrichment } from "../util/enrich.ts";
import type { Extraction } from "../util/extract.ts";
import { FileHandler } from "../util/file-handler.ts";
import { type BuildBuiltIns, getBuildConfig } from "../util/get-build-config.ts";
import type { BuildConcurrencyConfig, IIIFRC, ResolvedConfigSource } from "../util/get-config.ts";
import type { Linker } from "../util/linker.ts";
import type { Rewrite } from "../util/rewrite.ts";
import type { Tracer } from "../util/tracer.ts";
import { OUTPUT_FORMAT_VERSION, type BuildManifest, type OutputFile } from "../output-contract.ts";
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

export async function build(
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
    fetch,
  }: {
    fileHandler?: FileHandler;
    pathCache?: { allPaths: Record<string, string> };
    storeRequestCaches?: Record<string, any>;
    tracer?: Tracer;
    customConfig?: IIIFRC;
    customConfigSource?: Omit<ResolvedConfigSource, "config">;
    progress?: BuildProgressCallbacks;
    fetch?: typeof globalThis.fetch;
  } = {}
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

  if (buildConfig.options.generate) {
    await generateCommand({ ...buildConfig.options, fetch: buildConfig.fetch });
  }

  const { time } = buildConfig;

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

  const enterPhase = (id: BuildStepId) => {
    progress?.onPhase?.({
      id,
      label: BUILD_PHASE_LABELS[id],
      index: BUILD_STEP_ORDER.indexOf(id) + 1,
      total: BUILD_STEP_ORDER.length,
    });
  };

  const useNetworkCache = buildConfig.options.networkCache ?? true;
  if (buildConfig.network.prefetch && useNetworkCache) {
    enterPhase("warm-remote");
    await time("Warmed remote request cache", warmRemoteStores(buildConfig, parseState, progress));
  } else {
    progress?.onMessage?.("Skipping remote cache warmup");
  }

  // Parse stores.
  enterPhase("parse-stores");
  const parsed = await time("Parsed stores", parseStores(buildConfig, parseState, undefined, progress));

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
  progress?.onResourcesDiscovered?.({ total: loadTargetTotal });

  // Load stores.
  enterPhase("load-stores");
  const stores = await time("Loaded stores", loadStores(parsed, buildConfig, undefined, progress));

  pathCache.allPaths = { ...stores.allPaths };

  enterPhase("link-resources");
  const linked = await time("Linking resources", link(stores, buildConfig));

  // Extract.
  enterPhase("extract-resources");
  const extractions = await time("Extracting resources", extract(stores, buildConfig, progress));

  enterPhase("enrich-resources");
  const enrichments = await time("Enriching resources", enrich(stores, buildConfig, progress));

  enterPhase("emit-files");
  const emitted = await time(
    "Emitting files",
    emit(stores, buildConfig, { canvasSearchIndex: enrichments.canvasSearchIndex })
  );

  enterPhase("build-indices");
  await time(
    "Building indices",
    indices(
      {
        allResources: stores.allResources,
        editable: stores.editable,
        overrides: stores.overrides,
        collections: extractions.collections,
        manifestCollection: emitted.manifestCollection,
        storeCollections: emitted.storeCollections,
        indexCollection: emitted.indexCollection,
        searchIndexes: enrichments.searchIndexes,
        allIndices: enrichments.allIndices,
        siteMap: emitted.siteMap,
      },
      buildConfig
    )
  );

  await buildConfig.fileTypeCache.save();

  if (options.emit) {
    enterPhase("save-files");
    const { failedToWrite } = await fileHandler.saveAll(false, buildConfig.concurrency.write);
    if (failedToWrite.length) {
      const details = failedToWrite
        .slice(0, 5)
        .map(({ filePath, err }) => `${filePath}: ${err instanceof Error ? err.message : String(err)}`)
        .join("\n");
      throw new Error(`Failed to write ${failedToWrite.length} output file(s):\n${details}`);
    }

    const outputRoot = buildConfig.files.resolve(buildConfig.buildDir);
    const inventory: OutputFile[] = [];
    const visit = async (directory: string) => {
      const entries = await buildConfig.files.fs.promises.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const filePath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(filePath);
          continue;
        }
        if (relative(outputRoot, filePath) === "meta/build.json") {
          continue;
        }
        const data = await buildConfig.files.fs.promises.readFile(filePath);
        inventory.push({
          path: relative(outputRoot, filePath).split("\\").join("/"),
          bytes: data.byteLength,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
      }
    };
    await visit(outputRoot);
    inventory.sort((a, b) => a.path.localeCompare(b.path));
    const features = [
      inventory.some(({ path }) => path.startsWith("meta/search/")) && "search",
      inventory.some(({ path }) => path.includes("/canvases/index.json")) && "canvas-discovery",
      inventory.some(({ path }) => path === "topics/collection.json") && "topics",
      buildConfig.options.debug && "debug",
    ].filter(Boolean) as string[];
    const manifest: BuildManifest = {
      formatVersion: OUTPUT_FORMAT_VERSION,
      hssVersion: packageJson.version,
      mode: isPartialBuild ? "partial" : "full",
      canonicalBaseUrl: buildConfig.configUrl as string,
      completedAt: new Date().toISOString(),
      stores: [...buildConfig.stores].sort(),
      features,
      search: inventory.filter(({ path }) => path.endsWith(".mapping.json")).map(({ path }) => path),
      analysis: inventory.filter(({ path }) => /(^|\/)analysis[^/]*\.json$/i.test(path)).map(({ path }) => path),
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
  }

  return {
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
