import type { CollectionFinalizer, FinalCollection } from "../util/finalize-collection.ts";

function firstThumbnail(value: any): any | undefined {
  const image = Array.isArray(value) ? value[0] : value;
  if (typeof image === "string") return image ? { id: image, type: "Image" } : undefined;
  if (image && typeof image === "object") {
    const id = image.id || image["@id"];
    if (typeof id === "string" && id) return { ...image, id, type: "Image" };
  }
  return undefined;
}

export const collectionThumbnail: CollectionFinalizer<Map<string, any>> = {
  id: "collection-thumbnail",
  name: "Collection thumbnail fallback",
  configure({ collections }) {
    const byId = new Map(Object.values(collections).map((collection) => [collection.id, collection]));
    const resolved = new Map<string, any>();
    type Frame = { collection: FinalCollection; index: number; blocked: boolean };
    for (const root of Object.values(collections)) {
      if (resolved.has(root.id)) continue;
      const active = new Set<string>();
      const stack: Frame[] = [{ collection: root, index: 0, blocked: false }];
      const finish = (image: any, blocked: boolean) => {
        const { collection } = stack.pop()!;
        active.delete(collection.id);
        // A cycle-blocked miss is not evidence that the collection has no image.
        if (image || !blocked) resolved.set(collection.id, image);
        if (stack.length) {
          if (image) {
            // The parent resumes on this member and reads its completed result.
            stack[stack.length - 1].index--;
          } else stack[stack.length - 1].blocked ||= blocked;
        }
      };
      while (stack.length) {
        const frame = stack[stack.length - 1];
        const { collection } = frame;
        active.add(collection.id);
        const explicit = firstThumbnail(collection.thumbnail);
        if (explicit) {
          finish(explicit, false);
          continue;
        }
        const item = collection.items?.[frame.index++];
        if (!item) {
          finish(undefined, frame.blocked);
          continue;
        }
        const child = byId.get(item.id);
        if (!child) {
          const image = firstThumbnail(item.thumbnail);
          if (image) finish(image, false);
        } else if (resolved.has(child.id)) {
          const image = resolved.get(child.id);
          if (image) finish(image, false);
        } else if (active.has(child.id)) frame.blocked = true;
        else stack.push({ collection: child, index: 0, blocked: false });
      }
    }
    return resolved;
  },
  handler(collection, _api, resolved) {
    const explicit = firstThumbnail(collection.thumbnail);
    if (explicit) {
      if (!Array.isArray(collection.thumbnail)) collection.thumbnail = [explicit];
      return;
    }
    const image = resolved.get(collection.id);
    if (image) collection.thumbnail = [image];
  },
};
