import { join, relative } from "node:path";

export function rewritePath(config: { base?: string; destination?: string }) {
  return (currentPath: string) => {
    if (config.base) {
      currentPath = relative(config.base, currentPath);
    }

    if (config.destination) {
      currentPath = join(config.destination, currentPath);
    }

    // Remove extension.
    return currentPath.replace(/\.[A-Za-z0-9]+$/, "");
  };
}
