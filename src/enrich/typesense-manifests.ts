import { mkdirp } from 'fs-extra';
import { Enrichment } from '../util/enrich';
import { getValue } from '@iiif/helpers';
import { InternationalString } from '@iiif/presentation-3';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

// Schema:
// - label
// - summary
// - thumbnail, index: false
// - .*_topic, facet: true, type: string[], optional: true
// - collections, type: string[], facet: true
// - plaintext content

const schema = {
  name: 'manifests',
  fields: [
    { name: 'id', type: 'string' },
    { name: 'label', type: 'string' },
    { name: 'all_labels', type: 'string[]' },
    { name: 'summary', type: 'string' },
    { name: 'collections', type: 'string[]', facet: true, optional: true },
    { name: 'plaintext', type: 'string', optional: true },
    // { name: 'topic_.*', type: 'string[]', facet: true, optional: true },

    // other fields
    { name: 'slug', type: 'string' },
    { name: 'thumbnail', type: 'string', index: false, optional: true },
  ],
};

type SingleRecord = {
  id: string;
  slug: string;
  label: string;
  all_labels: string[];
  summary: string;
  collections: string[];
  plaintext?: string;
  thumbnail?: string;
} & TopicRecord;

type TopicRecord = Record<`topic_${string}`, string[]>;

export const enrichTypesense: Enrichment<{}, { record: SingleRecord; foundTopics: string[] }> = {
  id: 'typesense-manifests',
  name: 'Typesense manifest collection',
  types: ['Manifest'],
  invalidate: async () => {
    return true;
  },

  async handler(resource, api) {
    const id = resource.slug.replace('manifests/', '');
    const meta = await api.meta.value;
    const indices = await api.indices.value;

    const extraTopics: TopicRecord = {};

    for (const [k, v] of Object.entries(indices)) {
      extraTopics[`topic_${k}`] = v;
    }

    return {
      temp: {
        record: {
          id: btoa(id),
          slug: resource.slug,
          label: getValue(api.resource.label),
          all_labels: Object.entries(api.resource.label as InternationalString).map(([_, v]) => (v || []).join(' ')),
          summary: getValue(api.resource.summary),
          thumbnail: meta.thumbnail?.id,
          collections: [],
          plaintext: '',
          ...extraTopics,
        },
        foundTopics: Object.keys(extraTopics),
      },
    };
  },

  async collect(temp, api, config) {
    // Write the schema + the jsonl file with all the data.
    const typeSenseDir = join(api.build.filesDir, 'meta', 'typesense');
    const schemaFile = join(typeSenseDir, 'manifests.schema.json');
    const dataFile = join(typeSenseDir, 'manifests.jsonl');

    const foundTopics: string[] = [];
    const topicSchema: any[] = [];
    for (const record of Object.values(temp)) {
      for (const topic of record.foundTopics) {
        if (!foundTopics.includes(topic)) {
          foundTopics.push(topic);
          topicSchema.push({ name: topic, type: 'string[]', facet: true, optional: true });
        }
      }
    }

    await mkdirp(typeSenseDir);

    // Write the schema
    await writeFile(schemaFile, JSON.stringify({ ...schema, fields: [...schema.fields, ...topicSchema] }, null, 2));

    const jsonList = Object.values(temp)
      .map((record) => {
        return JSON.stringify(record.record);
      })
      .join('\n');

    await writeFile(dataFile, jsonList);
  },
};
