import { join } from 'node:path';
import { Extraction } from '../util/extract';
import { mkdirp } from 'mkdirp';

export const extractPlaintext: Extraction = {
  id: 'extract-plaintext',
  name: 'Extract plaintext',
  types: ['Canvas'],
  invalidate: async () => {
    return true;
  },
  async collectManifest(manifest, temp, api, config) {
    if (temp.canvases) {
      const filesDir = join(api.build.cacheDir, manifest.slug, 'files', 'plaintext');
      await mkdirp(filesDir);

      for (const [canvasIdx, canvas] of Object.entries(temp.canvases)) {
        if ((canvas as any).plaintext) {
          const canvasFile = join(filesDir, `${canvasIdx}.txt`);
          await mkdirp(filesDir);
          await Bun.write(canvasFile, (canvas as any).plaintext);
        }
      }
    }
  },
  async handler(resource, api) {
    if (!api.resource.annotations.length) {
      return {};
    }

    const first = api.resource.annotations[0];

    const result = await api.requestCache.fetch(first.id);
    const plaintextLines = [];
    if (result && result.items?.length) {
      for (const item of result.items) {
        if (item.body) {
          const body = Array.isArray(item.body) ? item.body[0] : item.body;
          if (body.type === 'TextualBody' && typeof body.value === 'string') {
            plaintextLines.push(body.value);
          }
        }
      }

      return {
        temp: {
          plaintext: plaintextLines.join('\n'),
        },
      };
    }

    return {};
  },
};
