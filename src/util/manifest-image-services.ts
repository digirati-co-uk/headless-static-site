import type { Vault } from "@iiif/helpers";
import { frameResource, HAS_PART, PART_OF } from "@iiif/parser";

/** Read painting-body image services directly from normalized entities, without reactive wrappers.
 * Preserves canvas/page/body/service order and repeated uses; excludes thumbnail and other services.
 */
export function getManifestImageServices(vault: Pick<Vault, "getStore">, manifestId: string) {
  const entities = vault.getStore().getState().iiif.entities as Record<string, Record<string, any>>;
  const resolve = (type: string, ref: any, parent?: string): any => {
    const id = typeof ref === "string" ? ref : ref?.id || ref?.["@id"];
    const entity = entities[type]?.[id] || (typeof ref === "object" ? ref : undefined);
    const framing = entity?.[HAS_PART]?.find((frame: any) => frame[PART_OF] === (parent || entity.id));
    return frameResource(entity, framing);
  };
  const list = (value: any): any[] => (Array.isArray(value) ? value : value ? [value] : []);
  const found: Array<{ id: string; canvasId: string }> = [];
  const ancestors = new Set<any>();
  const visitBody = (ref: any, canvasId: string, parent?: string) => {
    const body = resolve("ContentResource", ref, parent);
    if (!body || ancestors.has(body.id || body)) return;
    if (body.type === "Choice" || body.type === "SpecificResource") {
      ancestors.add(body.id || body);
      for (const child of list(body.type === "Choice" ? body.items : body.source))
        visitBody(child, canvasId, body.id || parent);
      ancestors.delete(body.id || body);
      return;
    }
    for (const ref of list(body.service)) {
      const service = resolve("Service", ref, body.id);
      const type = service?.type || service?.["@type"];
      const id = service?.id || service?.["@id"];
      if (
        typeof id === "string" &&
        (service.protocol === "http://iiif.io/api/image" || type === "ImageService2" || type === "ImageService3")
      ) {
        found.push({ id, canvasId });
      }
    }
  };
  const manifest = entities.Manifest?.[manifestId];
  for (const canvasRef of list(manifest?.items)) {
    const canvas = resolve("Canvas", canvasRef, manifestId);
    if (!canvas?.id) continue;
    for (const pageRef of list(canvas.items)) {
      const page = resolve("AnnotationPage", pageRef, canvas.id);
      for (const annotationRef of list(page?.items)) {
        const annotation = resolve("Annotation", annotationRef, page.id);
        for (const body of list(annotation?.body)) visitBody(body, canvas.id, annotation.id);
      }
    }
  }
  return found;
}
