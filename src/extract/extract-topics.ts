import { Extraction } from '../util/extract.ts';
import { getValue } from '@iiif/helpers/i18n';
import { getSingleLabel } from '../util/get-single-label.ts';

interface ExtractTopicsConfig {
  language?: string;
  translate?: boolean;
  upperCase?: boolean;
  dateRange?: string[];
  commaSeparated?: string[];
  topicTypes: Record<string, string | string[]>; // e.g. { author: ['Author', 'Written by'] } and it will look in the metadata for these.
}

export const extractTopics: Extraction<ExtractTopicsConfig> = {
  id: 'extract-topics',
  name: 'Extract Topics',
  types: ['Manifest'],

  invalidate: async () => {
    return true;
  },

  handler: async (resource, api, config) => {
    const {
      commaSeparated = [],
      translate = true,
      upperCase = true,
      dateRange = [],
      topicTypes = {},
      language = 'en',
    } = config;

    const topicsToParse = Object.keys(topicTypes);
    const latestResource = resource.vault?.get(api.resource);
    const metadata = latestResource?.metadata || [];
    const metadataLabels: string[] = await Promise.all(
      metadata.map((item: any) => getSingleLabel(item.label, { language, translate }))
    );

    const indices: Record<string, string[]> = {};

    for (const topic of topicsToParse) {
      const topicTypes = config.topicTypes[topic];
      for (const topicType of topicTypes) {
        const index = metadataLabels.indexOf(topicType);
        if (index === -1) {
          continue;
        }

        const arrayRange = ([start, stop]: number[]) =>
          Array.from({ length: stop - start + 1 }, (value, index) => (start + index).toString());

        const makeUpperCase = (string: string) =>
          upperCase ? string.charAt(0).toUpperCase() + string.slice(1) : string;

        const values = metadata[index].value;
        const first = Object.keys(values)[0];
        const value = values[first] as string[];
        if (value) {
          indices[topic] = indices[topic] || [];
          if (dateRange.includes(topic)) {
            value.forEach((v) => {
              if (v.includes('-')) {
                const range = arrayRange(v.split('-').map((d) => +d));
                indices[topic].push(...range);
              } else {
                indices[topic].push(v);
              }
            });
          } else if (commaSeparated.includes(topic)) {
            value.forEach((v) => {
              indices[topic].push(...v.split(',').map((t) => makeUpperCase(t.trim())));
            });
          } else {
            value.forEach((v) => {
              indices[topic].push(makeUpperCase(v.trim()));
            });
          }
        }
      }
    }

    return {
      indices,
    };
  },
};
