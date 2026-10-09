import { join, relative } from "node:path";

export function rewritePath(config: { base?: string; destination?: string }) {
  return (inputPath: string) => {
    let currentPath = inputPath;
    if (config.base) {
      currentPath = relative(config.base, currentPath);
    }

    if (config.destination) {
      currentPath = join(config.destination, currentPath);
    }

    if (/(^|\/)_?collection\.(json|ya?ml)$/.test(currentPath)) {
      return currentPath.replace(/(^|\/)_?collection\.(json|ya?ml)$/, "");
    }

    // Remove extension.
    return currentPath.replace(/\.[A-Za-z0-9]+$/, "");
  };
}
