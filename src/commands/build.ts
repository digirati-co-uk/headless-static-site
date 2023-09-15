import { Command } from "commander";
import { getConfig } from "../util/get-config";
import { IIIFJSONStore } from "../stores/iiif-json";
import { mkdirp } from "mkdirp";
import { join, relative } from "node:path";
import { existsSync } from "fs";
import { extractLabelString } from "../extract/extract-label-string";
import { homepageProperty } from "../enrich/homepage-property";
import { watch } from "fs/promises";
import { cwd } from "process";
import { readAllFiles } from "../util/read-all-files";
import { IIIFRemoteStore } from "../stores/iiif-remote";
import { getNodeGlobals } from "../util/get-node-globals";
import { compileSlugConfig } from "../util/slug-engine";
import { extractSlugSource } from "../extract/extract-slug-source";
import { validate } from "./validate.ts";
import { parseStores } from "./build/0-parse-stores.ts";
import { loadStores } from "./build/1-load-stores.ts";
import { extract } from "./build/2-extract.ts";
import { enrich } from "./build/3-enrich.ts";
import { emit } from "./build/4-emit.ts";
import { indices } from "./build/5-indices.ts";
import { createStoreRequestCache } from "../util/store-request-cache.ts";
// @ts-ignore
import { ImageServiceLoader } from "@atlas-viewer/iiif-image-api";
import chalk from "chalk";

export type BuildOptions = {
  config?: string;
  cache?: boolean;
  exact?: string;
  watch?: boolean;
  debug?: boolean;
  scripts?: string;
  stores?: string[];
  dev?: boolean;
  validate?: boolean;
  extract?: boolean;
  enrich?: boolean;
  emit?: boolean;
  skipFirstBuild?: boolean;
  client?: boolean;
  html?: boolean;

  // Programmatic only
  onBuild?: () => void | Promise<void>;
};

const defaultCacheDir = ".iiif/cache";
const defaultBuildDir = ".iiif/build";
const devCache = ".iiif/dev/cache";
const devBuild = ".iiif/dev/build";

const builtInExtractions = [extractLabelString, extractSlugSource];
const buildInEnrichments = [homepageProperty /*, translateMetadata , pdiiif*/];

const storeTypes = {
  "iiif-json": IIIFJSONStore,
  "iiif-remote": IIIFRemoteStore,
};

export async function build(options: BuildOptions, command: Command) {
  const buildConfig = await getBuildConfig(options);
  const config = await getConfig();
  const { log, time } = buildConfig;
  const startTime = Date.now();

  if (options.validate) {
    await validate({}, command);
  }

  await mkdirp(buildConfig.cacheDir);
  await mkdirp(buildConfig.buildDir);
  await mkdirp(buildConfig.requestCacheDir);

  const {
    //
    allPaths,
    storeResources,
    overrides,
  } = await time("Parsed stores", parseStores(buildConfig));

  if (!options.skipFirstBuild) {
    const { allResources, editable } = await time(
      "Loaded stores",
      loadStores({ storeResources }, buildConfig),
    );

    await time("Extracting resources", extract({ allResources }, buildConfig));

    await time("Enriching resources", enrich({ allResources }, buildConfig));

    const { storeCollections, manifestCollection, indexCollection, siteMap } =
      await time(
        "Emitting files",
        emit({ allResources, allPaths }, buildConfig),
      );

    await time(
      "Building indicies",
      indices(
        {
          storeCollections,
          manifestCollection,
          indexCollection,
          editable,
          overrides,
          siteMap,
        },
        buildConfig,
      ),
    );

    log("");
    console.log("Done in " + (Date.now() - startTime) + "ms");
  }

  if (options.watch) {
    const watcher = watch(join(cwd(), "content"), { recursive: true });
    const { watch: _watch, scripts, cache, ...nonWatchOptions } = options;
    for await (const event of watcher) {
      if (event.eventType === "change" && event.filename) {
        const file = join("content", event.filename);
        console.log(
          `Detected ${event.eventType} in ${event.filename} (${allPaths[file]})`,
        );
        await build({ ...nonWatchOptions, exact: allPaths[file] }, command);
        if (options.onBuild) {
          await options.onBuild();
        }
      }
    }
  }
}

export async function getBuildConfig(options: BuildOptions) {
  const config = await getConfig();

  const extractions = [...builtInExtractions];
  const enrichments = [...buildInEnrichments];

  const cacheDir = options.dev ? devCache : defaultCacheDir;
  const buildDir = options.dev ? devBuild : defaultBuildDir;

  const slugs = Object.fromEntries(
    Object.entries(config.slugs || {}).map(([key, value]) => {
      return [key, { info: value, compile: compileSlugConfig(value) }];
    }),
  );

  const stores = Object.keys(config.stores).filter((s) => {
    if (!options.stores || options.stores.length === 0) return true;
    return options.stores.includes(s);
  });

  if (stores.length === 0) {
    if (options.stores && options.stores.length > 0) {
      throw new Error("No stores found matching: " + options.stores.join(", "));
    }
    throw new Error("No stores defined in config");
  }

  const log = (...args: any[]) => {
    options.debug && console.log(...args);
  };

  // Load external configs / scripts.
  if (options.scripts) {
    const scriptsPath = join(cwd(), options.scripts);
    if (existsSync(scriptsPath)) {
      const allFiles = Array.from(readAllFiles(scriptsPath));
      log(`Loading ${allFiles.length} script(s)`);
      for (const file of allFiles) {
        console.log(" => ", relative(cwd(), file));
        try {
          await import(file);
        } catch (e) {
          console.log(chalk.red(e));
          process.exit(1);
        }
      }
    }
  }

  const globals = getNodeGlobals();

  extractions.push(...globals.extractions);
  enrichments.push(...globals.enrichments);

  const manifestExtractions = extractions.filter((e) =>
    e.types.includes("Manifest"),
  );
  const collectionExtractions = extractions.filter((e) =>
    e.types.includes("Collection"),
  );

  const manifestEnrichment = enrichments.filter((e) =>
    e.types.includes("Manifest"),
  );
  const collectionEnrichment = enrichments.filter((e) =>
    e.types.includes("Collection"),
  );
  const requestCacheDir = join(cacheDir, "_requests");

  const server = options.dev ? { url: "http://localhost:7111" } : config.server;

  const time = async <T>(label: string, promise: Promise<T>): Promise<T> => {
    const startTime = Date.now();
    const resp = await promise.catch((e) => {
      console.log(chalk.red(e));
      process.exit(1);
    });
    log(chalk.blue(label) + chalk.grey(` (${Date.now() - startTime}ms)`));
    return resp;
  };

  const requestCache = createStoreRequestCache("_thumbs", requestCacheDir);
  const imageServiceLoader = new (class extends ImageServiceLoader {
    fetchService(serviceId: string): Promise<any & { real: boolean }> {
      return requestCache.fetch(serviceId);
    }
  })();

  return {
    options,
    server,
    config,
    extractions,
    manifestExtractions,
    collectionExtractions,
    enrichments,
    manifestEnrichment,
    collectionEnrichment,
    requestCacheDir,
    cacheDir,
    buildDir,
    stores,
    // Helpers based on config.
    time,
    log,
    slugs,
    imageServiceLoader,
    // Currently hard-coded.
    storeTypes,
  };
}

export type BuildConfig = Awaited<ReturnType<typeof getBuildConfig>>;
