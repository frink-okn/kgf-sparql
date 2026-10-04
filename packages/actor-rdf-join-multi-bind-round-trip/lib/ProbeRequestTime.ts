import type { Algebra } from '@comunica/utils-algebra';
import { algebraUtils } from '@comunica/utils-algebra';

/** A join entry as the bind joins price it: its operation, and the metadata its output reported. */
export interface IProbedEntry {
  operation: Algebra.Operation;
  metadata: { pageSize?: number; requestTime?: number };
}

/**
 * The triple patterns and property paths an operation evaluates. A probe into an entry the engine
 * computes re-plans and re-runs each of them, at least one request apiece.
 */
export function countPatterns(operation: Algebra.Operation): number {
  let patterns = 0;
  algebraUtils.visitOperation(operation, {
    pattern: { visitor: () => {
      patterns++;
    } },
    path: { visitor: () => {
      patterns++;
    } },
  });
  return patterns;
}

/**
 * The request time of one bound probe into each entry that Comunica's bind-join formulas leave
 * out. A paged source's probe is one request, which the formulas price at zero, since an entry's
 * first page is fetched by the time its metadata is known. An entry the engine computes, as the
 * result of a join or an `OPTIONAL` is, reports neither a page size nor a request time, so the
 * formulas price its probes at zero too, though each re-plans and re-runs every pattern in it:
 * one query's nested `OPTIONAL` group, probed per row at a cost of nothing, read the same four
 * predicates whole 780 times each before the query ran out of time. Such a probe is charged a
 * request per pattern, each at the time the join's other entries took per pattern, or at
 * `fallback` when no entry reports a request time. A non-paged source's probe, and a paged source
 * that reports no request time, are left as the formulas price them.
 */
export function probeRequestTimes(entries: IProbedEntry[], fallback: number): number[] {
  const patterns = entries.map(entry => countPatterns(entry.operation));
  let timed = 0;
  let timedPatterns = 0;
  for (const [ index, entry ] of entries.entries()) {
    if (entry.metadata.requestTime !== undefined) {
      timed += entry.metadata.requestTime;
      timedPatterns += Math.max(1, patterns[index]);
    }
  }
  const perPattern = timedPatterns > 0 ? timed / timedPatterns : fallback;
  return entries.map(({ metadata }, index) => {
    if (metadata.pageSize) {
      return metadata.requestTime ?? 0;
    }
    return metadata.requestTime === undefined ? patterns[index] * perPattern : 0;
  });
}
