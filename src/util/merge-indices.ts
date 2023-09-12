export function mergeIndices(newIndicies: Record<string, string[]>, indicies: Record<string, string[]>) {
  const keys = Object.keys(indicies);
  for (const key of keys) {
    if (!newIndicies[key]) {
      newIndicies[key] = [];
    }
    for (const item of indicies[key]) {
      if (!newIndicies[key].includes(item)) {
        newIndicies[key].push(item);
      }
    }
  }

  return newIndicies;
}
