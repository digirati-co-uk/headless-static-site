import { Extraction } from '../util/extract';
import { getValue } from '@iiif/helpers/i18n';

export const extractLabelString: Extraction = {
  id: 'extract-label-string',
  name: 'Extract label as string',
  types: ['Manifest'],
  async invalidate(manifest, api) {
    return true;
  },
  async handler(manifest, api, config) {
    const language = config?.language;
    const resource = api.resource;
    if (!resource.label) {
      return {};
    }

    const label = resource.label || {};
    const keys = Object.keys(resource.label);
    if (keys.length === 0) {
      return {};
    }

    const firstValue = getValue(label, { language });
    return {
      meta: {
        label: firstValue || '',
      },
    };
  },
};
