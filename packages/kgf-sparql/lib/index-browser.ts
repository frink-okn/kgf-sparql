// The library without the command line, which needs Node's file system and undici, and
// without the factory, which reads a config from disk. Bundlers pick this file through the
// `browser` field, as they do for @comunica/query-sparql.
export * from './QueryEngine';
export {
  KEY_KGF_PAGE_SIZE,
  KEY_KGF_BINDINGS_SIZE,
  KEY_KGF_HTTP_METHOD,
  KEY_KGF_VOID_STATISTICS,
} from '@kgf/actor-query-source-identify-kgf';
export { KEY_VOID_STATISTICS } from '@kgf/actor-rdf-join-selectivity-void';
export { KEY_HTTP_HOST_LIMITS, KEY_HTTP_IN_FLIGHT } from '@kgf/actor-http-throttle';
export type { IHostLimits } from '@kgf/actor-http-throttle';
export type {
  IVoidClassPartition,
  IVoidDatasetStatistics,
  IVoidPropertyPartition,
  VoidStatisticsRegistry,
} from '@kgf/actor-rdf-join-selectivity-void';
