import { BuildConfig } from '../build.ts';
import { loadJson } from '../../util/load-json.ts';
import { join } from 'node:path';
import { lazyValue } from '../../util/lazy-value.ts';
import { Vault } from '@iiif/helpers';
import { mergeIndices } from '../../util/merge-indices.ts';
import { ActiveResourceJson } from '../../util/store.ts';
import { mkdirp } from 'mkdirp';
import { makeProgressBar } from '../../util/make-progress-bar.ts';
import { createStoreRequestCache } from '../../util/store-request-cache.ts';

export async function extract(
  {
    allResources,
  }: {
    allResources: Array<ActiveResourceJson>;
  },
  buildConfig: BuildConfig
) {
  const {
    options,
    config,
    cacheDir,
    log,
    extractions,
    manifestExtractions,
    collectionExtractions,
    canvasExtractions,
    allExtractions,
    requestCacheDir,
  } = buildConfig;
  if (!options.extract) {
    // This is to remind us that we _cant_ export a site map without extracting.
    return {};
  }

  const requestCache = createStoreRequestCache('_extract', requestCacheDir);

  const extractionConfigs: Record<string, any> = {};
  for (const extraction of allExtractions) {
    if (extraction.configure) {
      const extractionConfig = (config.config || {})[extraction.id];
      extractionConfigs[extraction.id] = await extraction.configure({ config, build: buildConfig }, extractionConfig);
    } else {
      extractionConfigs[extraction.id] = (config.config || {})[extraction.id];
    }
  }

  // Caches.
  let savingFiles = [];
  const temp: Record<string, Record<string, any>> = {};

  let totalResources = allResources.length;
  for (const resource of allResources) {
    totalResources += resource.subResources || 0;
  }

  // Found Collections
  const collections: Record<string, string[]> = {};

  const progress = makeProgressBar('Extraction', totalResources);

  for (const manifest of allResources) {
    const skipSteps = config.stores[manifest.storeId]?.skip || [];
    const runSteps = config.stores[manifest.storeId]?.run;

    const vaultData = loadJson(join(cacheDir, manifest.slug, 'vault.json'));
    const caches = lazyValue(() => loadJson(join(cacheDir, manifest.slug, 'caches.json')));
    const meta = lazyValue(() => loadJson(join(cacheDir, manifest.slug, 'meta.json')));
    const indices = lazyValue(() => loadJson(join(cacheDir, manifest.slug, 'indices.json')));
    const newMeta = {};
    const newCaches = {};
    const newindices = {};

    manifest.vault = new Vault();
    manifest.vault.getStore().setState(await vaultData);
    const resource = manifest.vault.getObject(manifest.id);

    let extractions = manifest.type === 'Manifest' ? manifestExtractions : collectionExtractions;

    // Add extra steps that might not be in already.
    if (runSteps) {
      // Need to make a copy in this case.
      extractions = [...extractions];
      for (const step of runSteps) {
        const found = allExtractions.find((e) => e.id === step);
        if (found && found.types.includes(manifest.type) && !extractions.includes(found)) {
          extractions.push(found);
        }
      }
    }

    for (const extraction of extractions) {
      if (skipSteps.includes(extraction.id)) {
        // log("Skipping " + extraction.id + " for " + manifest.slug);
        continue;
      }
      const storeConfig = extractionConfigs[extraction.id] || {};
      const extractConfig = Object.assign(
        {},
        storeConfig,
        (config.stores[manifest.storeId].config || {})[extraction.id] || {}
      );
      const valid =
        !options.cache ||
        (await extraction.invalidate(
          manifest,
          {
            caches,
            resource,
            build: buildConfig,
          },
          extractConfig
        ));
      if (valid) {
        log('Running extract: ' + extraction.name + ' for ' + manifest.slug);
        const result = await extraction.handler(
          manifest,
          {
            resource,
            meta,
            indices,
            caches,
            config,
            build: buildConfig,
            requestCache,
          },
          extractConfig
        );
        if (result.temp) {
          temp[extraction.id] = temp[extraction.id] || {};
          temp[extraction.id][manifest.slug] = result.temp;
        }
        if (result.meta) {
          Object.assign(newMeta, result.meta);
        }
        if (result.caches) {
          Object.assign(newCaches, result.caches);
        }
        if (result.indices) {
          mergeIndices(newindices, result.indices);
        }
        if (result.collections) {
          result.collections.forEach((collectionSlug) => {
            collections[collectionSlug] = collections[collectionSlug] || [];
            collections[collectionSlug].push(manifest.slug);
          });
        }
      }

      if (Object.keys(newMeta).length > 0) {
        savingFiles.push(
          Bun.write(
            join(cacheDir, manifest.slug, 'meta.json'),
            JSON.stringify(Object.assign(await meta.value, newMeta), null, 2)
          )
        );
      }
      if (Object.keys(newindices).length > 0) {
        savingFiles.push(
          Bun.write(
            join(cacheDir, manifest.slug, 'indices.json'),
            JSON.stringify(mergeIndices(await indices.value, newindices), null, 2)
          )
        );
      }
      if (Object.keys(newCaches).length > 0) {
        savingFiles.push(
          Bun.write(
            join(cacheDir, manifest.slug, 'caches.json'),
            JSON.stringify(Object.assign(await caches.value, newCaches), null, 2)
          )
        );
      }
    }

    progress.increment();

    // Canvas extractions.
    if (manifest.type === 'Manifest' && canvasExtractions.length) {
      // Canvas extractions
      // These will have to be saved alongside the manifest in the same folder. We could do:
      //  - manifest.json
      //  - canvases/0/meta.json
      //  - canvases/0/caches.json
      //  - canvases/0/indices.json
      //  - canvases/0/files/thumbnail.jpg
      //
      // Which would be translated to:
      // - manifest.json
      // - canvases/0/meta.json
      // - canvases/0/thumbnail.jpg
      const canvases = resource.items || [];
      let canvasIndex = 0;
      for (const canvas of canvases) {
        const canvasDir = join(cacheDir, manifest.slug, 'canvases', canvasIndex.toString());
        const caches = lazyValue(() => loadJson(join(canvasDir, 'caches.json'), true));
        const meta = lazyValue(() => loadJson(join(canvasDir, 'meta.json'), true));
        const indices = lazyValue(() => loadJson(join(canvasDir, 'indices.json'), true));
        const newMeta = {};
        const newCaches = {};
        const newindices = {};
        const canvasResource: ActiveResourceJson = {
          id: canvas.id,
          type: 'Canvas',
          path: manifest.path + '/canvases/' + canvasIndex,
          slug: manifest.slug + '/canvases/' + canvasIndex,
          storeId: manifest.storeId,
          slugSource: manifest.slugSource,
          saveToDisk: false, // ?
          source: manifest.source,
          vault: manifest.vault,
        };
        for (const canvasExtraction of canvasExtractions) {
          const storeConfig = extractionConfigs[canvasExtraction.id] || {};
          const extractConfig = Object.assign(
            {},
            storeConfig,
            (config.stores[manifest.storeId].config || {})[canvasExtraction.id] || {}
          );
          const valid =
            !options.cache ||
            (await canvasExtraction.invalidate(
              canvasResource,
              {
                caches,
                resource: canvas,
                build: buildConfig,
              },
              extractConfig
            ));
          if (!valid) {
            continue;
          }
          const result = await canvasExtraction.handler(
            canvasResource,
            {
              resource: canvas,
              meta,
              indices,
              caches,
              config,
              build: buildConfig,
              requestCache,
            },
            extractConfig
          );
          if (result.temp) {
            temp[canvasExtraction.id] = temp[canvasExtraction.id] || {};
            temp[canvasExtraction.id][manifest.slug] = temp[canvasExtraction.id][manifest.slug] || {};
            temp[canvasExtraction.id][manifest.slug].canvases = temp[canvasExtraction.id][manifest.slug].canvases || {};
            temp[canvasExtraction.id][manifest.slug].canvases[canvasIndex.toString()] = result.temp;
          }
          if (result.meta) {
            Object.assign(newMeta, result.meta);
          }
          if (result.caches) {
            Object.assign(newCaches, result.caches);
          }
          if (result.indices) {
            mergeIndices(newindices, result.indices);
          }
        }

        if (
          Object.keys(newMeta).length > 0 ||
          Object.keys(newindices).length > 0 ||
          Object.keys(newCaches).length > 0
        ) {
          await mkdirp(canvasDir);
        }

        if (Object.keys(newMeta).length > 0) {
          savingFiles.push(
            Bun.write(join(canvasDir, 'meta.json'), JSON.stringify(Object.assign(await meta.value, newMeta), null, 2))
          );
        }
        if (Object.keys(newindices).length > 0) {
          savingFiles.push(
            Bun.write(
              join(canvasDir, 'indices.json'),
              JSON.stringify(mergeIndices(await indices.value, newindices), null, 2)
            )
          );
        }
        if (Object.keys(newCaches).length > 0) {
          savingFiles.push(
            Bun.write(
              join(canvasDir, 'caches.json'),
              JSON.stringify(Object.assign(await caches.value, newCaches), null, 2)
            )
          );
        }

        progress.increment();
        canvasIndex++;
      }

      for (const canvasExtraction of canvasExtractions) {
        if (canvasExtraction.collectManifest && temp[canvasExtraction.id] && temp[canvasExtraction.id][manifest.slug]) {
          const extractionConfig = extractionConfigs[canvasExtraction.id] || {};
          await canvasExtraction.collectManifest(
            manifest,
            temp[canvasExtraction.id][manifest.slug],
            { config, build: buildConfig },
            extractionConfig
          );
        }
      }
    } else {
      progress.increment(manifest.subResources || 0);
    }
  }

  log('Saving ' + savingFiles.length + ' files');
  await Promise.all(savingFiles);

  for (const extraction of allExtractions) {
    if (extraction.close) {
      const extractionConfig = extractionConfigs[extraction.id] || {};
      await extraction.close(extractionConfig);
    }
    if (extraction.collect && temp[extraction.id]) {
      const extractionConfig = extractionConfigs[extraction.id] || {};
      await extraction.collect(temp[extraction.id], { config, build: buildConfig }, extractionConfig);
    }
  }

  progress.stop();

  return { collections };
}
