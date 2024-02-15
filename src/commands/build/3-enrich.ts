import { BuildConfig } from '../build.ts';
import { lazyLoadJson, lazyLoadOptionalJson } from '../../util/load-json.ts';
import { join } from 'node:path';
import { IIIFBuilder } from '@iiif/builder';
import { mergeIndices } from '../../util/merge-indices.ts';
import { ActiveResourceJson } from '../../util/store.ts';
import { Enrichment } from '../../util/enrich.ts';
import { mkdirp } from 'mkdirp';
import { makeProgressBar } from '../../util/make-progress-bar.ts';
import { createStoreRequestCache } from '../../util/store-request-cache.ts';

export async function enrich({ allResources }: { allResources: Array<ActiveResourceJson> }, buildConfig: BuildConfig) {
  const {
    options,
    config,
    log,
    cacheDir,
    canvasEnrichment,
    manifestEnrichment,
    collectionEnrichment,
    allEnrichments,
    requestCacheDir,
  } = buildConfig;

  if (!options.enrich) {
    return {};
  }

  const enrichmentConfigs: Record<string, any> = {};
  const temp: Record<string, Record<string, any>> = {};
  for (const enrichment of allEnrichments) {
    if (enrichment.configure) {
      const enrichmentConfig = (config.config || {})[enrichment.id];
      enrichmentConfigs[enrichment.id] = await enrichment.configure({ config, build: buildConfig }, enrichmentConfig);
    } else {
      enrichmentConfigs[enrichment.id] = (config.config || {})[enrichment.id];
    }
  }

  let savingFiles: Promise<any>[] = [];
  const saveJson = (file: string, contents: any) => {
    savingFiles.push(Bun.write(file, JSON.stringify(contents, null, 2)));
  };

  let totalResources = allResources.length;
  for (const resource of allResources) {
    totalResources += resource.subResources || 0;
  }

  const progress = makeProgressBar('Enrichment', totalResources);
  const requestCache = createStoreRequestCache('_enrich', requestCacheDir);

  const processManifest = async (manifest: ActiveResourceJson) => {
    if (!manifest.vault) {
      progress.increment(1 + (manifest.subResources || 0));
      return;
    }
    const skipSteps = config.stores[manifest.storeId]?.skip || [];
    const runSteps = config.stores[manifest.storeId]?.run;

    // Lazy files.
    const caches = lazyLoadJson(cacheDir, manifest.slug, 'caches.json');
    const meta = lazyLoadJson(cacheDir, manifest.slug, 'meta.json');
    const indices = lazyLoadJson(cacheDir, manifest.slug, 'indices.json');

    // Output files.
    const files = {
      'meta.json': join(cacheDir, manifest.slug, 'meta.json'),
      'indices.json': join(cacheDir, manifest.slug, 'indices.json'),
      'caches.json': join(cacheDir, manifest.slug, 'caches.json'),
      'vault.json': join(cacheDir, manifest.slug, 'vault.json'),
    };

    const builder = new IIIFBuilder(manifest.vault as any);
    const resource = manifest.vault.getObject(manifest.id);

    const newMeta = {};
    const newCaches = {};
    const newindices = {};
    let didChange = false;

    let enrichmentList = manifest.type === 'Manifest' ? manifestEnrichment : collectionEnrichment;

    // Add extra steps that might not be in already.
    if (runSteps) {
      // Need to make a copy in this case.
      enrichmentList = [...enrichmentList];
      for (const step of runSteps) {
        const found = allEnrichments.find((e) => e.id === step);
        if (found && found.types.includes(manifest.type) && !enrichmentList.includes(found)) {
          enrichmentList.push(found);
        }
      }

      // order by enrichment list.
      enrichmentList = enrichmentList.sort((a: any, b: any) => {
        const aIndex = runSteps.indexOf(a.id);
        const bIndex = runSteps.indexOf(b.id);
        if (aIndex === -1 && bIndex === -1) {
          return 0;
        }
        if (aIndex === -1) {
          return 1;
        }
        if (bIndex === -1) {
          return -1;
        }
        return aIndex - bIndex;
      });
    }

    const runEnrichment = async (enrichment: Enrichment) => {
      const filesDir = join(cacheDir, manifest.slug, 'files');
      const storeConfig = enrichmentConfigs[enrichment.id] || {};
      const enrichmentConfig = Object.assign(
        {},
        storeConfig,
        (config.stores[manifest.storeId].config || {})[enrichment.id] || {}
      );

      const valid =
        !options.cache ||
        (await enrichment.invalidate(
          manifest,
          {
            caches,
            resource,
            config,
            files: filesDir,
          },
          enrichmentConfig
        ));
      if (!valid) {
        // console.log('Skipping "' + enrichment.name + '" for "' + manifest.slug + '" because it is not modified');
        return;
      }

      const result = await enrichment.handler(
        manifest,
        {
          meta,
          indices,
          caches,
          config,
          builder,
          resource,
          files: filesDir,
          requestCache,
        },
        enrichmentConfig
      );
      if (result.temp) {
        temp[enrichment.id] = temp[enrichment.id] || {};
        temp[enrichment.id][manifest.slug] = result.temp;
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
      didChange = didChange || result.didChange || false;
    };

    const processedEnrichments = [];
    for (const enrichment of enrichmentList) {
      if (skipSteps.includes(enrichment.id)) {
        continue;
      }
      processedEnrichments.push(runEnrichment(enrichment));
    }

    const results = await Promise.allSettled(processedEnrichments);
    const errors = results.filter((r) => r.status === 'rejected');
    if (errors.length > 0) {
      throw new Error(
        'Enrichment failed for ' +
          errors.length +
          ' manifest(s): \n \n' +
          errors.map((e, n) => `  ${n + 1}) ` + (e as any)?.reason?.message).join(', ')
      );
    }

    if (Object.keys(newMeta).length > 0) {
      const metaValue = await meta.value;
      saveJson(files['meta.json'], Object.assign({}, metaValue, newMeta));
    }

    if (Object.keys(newindices).length > 0) {
      saveJson(files['indices.json'], mergeIndices(await indices.value, newindices));
    }

    if (Object.keys(newCaches).length > 0) {
      saveJson(files['caches.json'], Object.assign(await caches.value, newCaches));
    }

    progress.increment();

    let canvasEnrichmentSteps = canvasEnrichment;
    if (manifest.type === 'Manifest' && runSteps) {
      // Need to make a copy in this case.
      canvasEnrichmentSteps = [...canvasEnrichmentSteps];
      for (const step of runSteps) {
        const found = allEnrichments.find((e) => e.id === step);
        if (found && found.types.includes('Canvas') && !canvasEnrichmentSteps.includes(found)) {
          canvasEnrichmentSteps.push(found);
        }
      }
    }

    // Canvases.
    if (manifest.type === 'Manifest' && canvasEnrichmentSteps.length) {
      const canvases = resource.items || [];
      for (let canvasIndex = 0; canvasIndex < canvases.length; canvasIndex++) {
        const canvas = canvases[canvasIndex];
        const canvasDir = join(cacheDir, manifest.slug, 'canvases', canvasIndex.toString());
        const filesDir = join(canvasDir, 'files');
        const files = {
          'meta.json': join(canvasDir, 'meta.json'),
          'indices.json': join(canvasDir, 'indices.json'),
          'caches.json': join(canvasDir, 'caches.json'),
        };
        const caches = lazyLoadOptionalJson(files['caches.json']);
        const meta = lazyLoadOptionalJson(files['meta.json']);
        const indices = lazyLoadOptionalJson(files['indices.json']);
        const newMeta = {};
        const newCaches = {};
        const newindices = {};

        const runEnrichment = async (enrichment: Enrichment) => {
          const storeConfig = enrichmentConfigs[enrichment.id] || {};
          const enrichmentConfig = Object.assign(
            {},
            storeConfig,
            (config.stores[manifest.storeId].config || {})[enrichment.id] || {}
          );
          const valid =
            !options.cache ||
            (await enrichment.invalidate(
              manifest,
              {
                caches,
                resource: canvas,
                config,
                files: filesDir,
              },
              enrichmentConfig
            ));
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
          if (!valid) {
            // console.log('Skipping "' + enrichment.name + '" for "' + manifest.slug + '" because it is not modified');
            return;
          }
          const result = await enrichment.handler(
            canvasResource,
            {
              meta,
              indices,
              caches,
              config,
              builder,
              resource: canvas,
              files: filesDir,
              requestCache,
            },
            enrichmentConfig
          );

          if (result.meta) {
            Object.assign(newMeta, result.meta);
          }
          if (result.caches) {
            Object.assign(newCaches, result.caches);
          }
          if (result.indices) {
            mergeIndices(newindices, result.indices);
          }
          didChange = didChange || result.didChange || false;
        };

        const processedEnrichments = [];
        for (const enrichment of canvasEnrichmentSteps) {
          if (skipSteps.includes(enrichment.id)) {
            continue;
          }
          processedEnrichments.push(runEnrichment(enrichment));
        }

        const results = await Promise.allSettled(processedEnrichments);
        const errors = results.filter((r) => r.status === 'rejected');
        if (errors.length > 0) {
          throw new Error(
            'Enrichment failed for ' +
              errors.length +
              ' manifest(s): \n \n' +
              errors.map((e, n) => `  ${n + 1}) ` + (e as any)?.reason?.message).join(', ')
          );
        }

        if (
          Object.keys(newMeta).length > 0 ||
          Object.keys(newindices).length > 0 ||
          Object.keys(newCaches).length > 0
        ) {
          await mkdirp(canvasDir);
        }

        if (Object.keys(newMeta).length > 0) {
          const metaValue = await meta.value;
          saveJson(files['meta.json'], Object.assign({}, metaValue, newMeta));
        }

        if (Object.keys(newindices).length > 0) {
          saveJson(files['indices.json'], mergeIndices(await indices.value, newindices));
        }

        if (Object.keys(newCaches).length > 0) {
          saveJson(files['caches.json'], Object.assign(await caches.value, newCaches));
        }

        progress.increment();
      }
    } else {
      progress.increment(manifest.subResources || 0);
    }

    // Finally save the vault.
    if (didChange && manifest.vault) {
      saveJson(files['vault.json'], manifest.vault.getStore().getState());
    }
  };

  const allManifestProcesses = [];
  for (const manifest of allResources) {
    allManifestProcesses.push(processManifest(manifest));
  }
  await Promise.all(allManifestProcesses);

  for (const extraction of allEnrichments) {
    if (extraction.close) {
      const extractionConfig = enrichmentConfigs[extraction.id] || {};
      await extraction.close(extractionConfig);
    }
    if (extraction.collect) {
      const extractionConfig = enrichmentConfigs[extraction.id] || {};
      await extraction.collect(temp[extraction.id], { config, build: buildConfig }, extractionConfig);
    }
  }

  progress.stop();

  log('Saving ' + savingFiles.length + ' files');
  await Promise.all(savingFiles);
  savingFiles = [];
}
