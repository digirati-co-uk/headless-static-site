import { Enrichment } from '../util/enrich';

export const homepageProperty: Enrichment = {
  name: 'Homepage property',
  types: ['Manifest'],
  async invalidate(resource, api) {
    if (resource.id && resource.type === 'Manifest') {
      const homepage = api.config.server?.url + '/' + resource.slug;
      const existingHomepage = api.resource.homepage.find(h => h.id === homepage);
      if (!existingHomepage) {
        return true;
      }
    }

    return false;
  },
  async handler(resource, api) {
    if (resource.id) {

      api.builder.editManifest(resource.id, (m) => {
        m.setHomepage({
          id: api.config.server?.url + '/' + resource.slug,
        });
      });

      return { didChange: true };
    }

    return {};
  }
}
