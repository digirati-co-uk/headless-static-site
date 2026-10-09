export interface RemoteChildReference {
  id: string;
  type?: string;
}

function getType(input: any): string | undefined {
  if (!input) {
    return undefined;
  }
  const raw = input.type || input["@type"];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  if (typeof raw === "string") {
    return raw;
  }
  return undefined;
}

function getId(input: any): string | undefined {
  if (!input) {
    return undefined;
  }
  if (typeof input === "string") {
    return input;
  }
  const id = input.id || input["@id"];
  return typeof id === "string" ? id : undefined;
}

function normalizeType(type?: string) {
  if (!type) {
    return undefined;
  }
  if (type.endsWith("CollectionPage")) {
    return "CollectionPage";
  }
  if (type.endsWith("Collection")) {
    return "Collection";
  }
  if (type.endsWith("Manifest")) {
    return "Manifest";
  }
  return type;
}

function toReference(input: any, fallbackType?: string): RemoteChildReference | null {
  const id = getId(input);
  if (!id) {
    return null;
  }
  const type = normalizeType(getType(input) || fallbackType);
  return { id, type };
}

function asArray<T = any>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function isCollectionLike(resource: any) {
  const type = normalizeType(getType(resource));
  return type === "Collection" || type === "CollectionPage";
}

function getDirectChildren(resource: any): RemoteChildReference[] {
  const children: RemoteChildReference[] = [];

  for (const item of asArray(resource?.items)) {
    const ref = toReference(item);
    if (ref) children.push(ref);
  }
  for (const item of asArray(resource?.manifests)) {
    const ref = toReference(item, "Manifest");
    if (ref) children.push(ref);
  }
  for (const item of asArray(resource?.collections)) {
    const ref = toReference(item, "Collection");
    if (ref) children.push(ref);
  }

  return children;
}

function getPaginationLinks(resource: any): string[] {
  const links: string[] = [];
  for (const candidate of [...asArray(resource?.first), ...asArray(resource?.next)]) {
    const ref = toReference(candidate, "CollectionPage");
    if (ref?.id) {
      links.push(ref.id);
    }
  }
  return links;
}

export interface RemoteDiscoveryLimits {
  /** Distinct attempted root/child URLs per store, including aliases. */
  maxResources?: number;
  /** Distinct linked page URLs per store; root collections are resources, not pages. */
  maxCollectionPages?: number;
  /** Distinct direct child reference URLs per collection, across its pages. */
  maxChildren?: number;
}

export class DiscoveryLimitError extends Error {}

export function checkDiscoveryLimit(size: number, limit: number | undefined, name: string) {
  if (limit !== undefined && size > limit) throw new DiscoveryLimitError(`IIIF discovery exceeds ${limit} ${name}.`);
}

export function createDiscoveryBudget(limits: RemoteDiscoveryLimits = {}) {
  for (const [name, value] of ["maxResources", "maxCollectionPages", "maxChildren"].map(
    (name) => [name, limits[name as keyof RemoteDiscoveryLimits]] as const
  )) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Invalid IIIF discovery limit ${name}: expected a non-negative integer.`);
    }
  }
  const resources = new Set<string>();
  const pages = new Set<string>();
  return {
    resource(url: string) {
      if (resources.has(url)) return false;
      checkDiscoveryLimit(resources.size + 1, limits.maxResources, "resource URLs");
      resources.add(url);
      return true;
    },
    page(url: string) {
      if (pages.has(url)) return;
      checkDiscoveryLimit(pages.size + 1, limits.maxCollectionPages, "collection pages");
      pages.add(url);
    },
  };
}

export interface CollectionDiscoveryOptions extends RemoteDiscoveryLimits {
  strict?: boolean;
  /** Share page accounting when walking multiple collections in one store. */
  budget?: ReturnType<typeof createDiscoveryBudget>;
}

export async function discoverCollectionChildren(
  startUrl: string,
  startResource: any,
  fetchJson: (url: string) => Promise<any>,
  onError?: (url: string, error: unknown) => void,
  options: CollectionDiscoveryOptions = {}
): Promise<RemoteChildReference[]> {
  const budget = options.budget || createDiscoveryBudget(options);
  const discovered = new Map<string, RemoteChildReference>();
  const queuedPages = new Set<string>([startUrl]);
  const pendingPages: Array<{ url: string; resource: any }> = [{ url: startUrl, resource: startResource }];

  const enqueuePage = async (url: string) => {
    if (queuedPages.has(url)) return;
    budget.page(url);
    queuedPages.add(url);
    try {
      pendingPages.push({ url, resource: await fetchJson(url) });
    } catch (error) {
      onError?.(url, error);
      if (options.strict) throw new Error(`Failed to load IIIF collection page ${url}`, { cause: error });
    }
  };

  for (let index = 0; index < pendingPages.length; index++) {
    const current = pendingPages[index];
    if (options.strict && (!isCollectionLike(current.resource) || !getId(current.resource))) {
      throw new Error(`Invalid IIIF Collection or CollectionPage at ${current.url}`);
    }
    for (const child of getDirectChildren(current.resource)) {
      if (child.type === "CollectionPage") {
        await enqueuePage(child.id);
      } else if (!discovered.has(child.id)) {
        checkDiscoveryLimit(discovered.size + 1, options.maxChildren, "children");
        discovered.set(child.id, child);
      }
    }
    for (const url of getPaginationLinks(current.resource)) await enqueuePage(url);
  }
  return Array.from(discovered.values());
}
