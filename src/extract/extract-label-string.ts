import { sha1 } from 'object-hash';
import { Extraction } from '../util/extract';

export const extractLabelString: Extraction = {
  name: "Extract label as string",
  types: ['Manifest'],
  async invalidate(manifest, api) {
    const resource = api.resource;
    if (!resource.label) {
      return false;
    }
    const hash = sha1(resource.label);
    const caches = await api.caches.value;
    return hash !== caches.extractLabelString;
  },
  async handler(manifest, api) {
    const resource = api.resource;
    if (!resource.label) {
      return {};
    }

    const label = resource.label || {};
    const keys = Object.keys(resource.label);
    if (keys.length === 0) {
      return {};
    }

    const firstValue = (label[keys[0]] || [])[0] || '';
    return {
      caches: {
        extractLabelString: sha1(resource.label),
      },
      meta: {
        label: firstValue,
      }
    }
  }
}


export const extractLabelStringNoCache: Extraction = {
  name: "Extract label as string",
  types: ['Manifest'],
  async invalidate() {
    return true;
  },
  async handler(manifest, { resource }) {
    const label = resource?.label || {};
    const keys = Object.keys(resource.label);
    if (keys.length === 0) {
      return {};
    }
    const firstValue = (label[keys[0]] || [])[0] || '';
    return {
      meta: {
        label: firstValue,
      }
    }
  }
}
