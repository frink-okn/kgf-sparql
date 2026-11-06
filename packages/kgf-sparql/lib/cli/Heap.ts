import { getHeapStatistics } from 'node:v8';

// Node only, apart from `./Budget` so that `RunAccount` still bundles for a browser.

/** The V8 heap in use, garbage not yet collected included: what the command's heap budget measures. */
export function heapInUse(): number {
  return getHeapStatistics().used_heap_size;
}

/**
 * The process's V8 heap limit, which node's `--max-old-space-size` sets. It includes the young
 * generation, 96 MB by default, so node dies short of it: see `HEAP_RESERVE`.
 */
export function heapLimit(): number {
  return getHeapStatistics().heap_size_limit;
}
