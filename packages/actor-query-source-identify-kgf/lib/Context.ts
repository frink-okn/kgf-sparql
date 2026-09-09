import { ActionContextKey } from '@comunica/core';

/** Requested rows per fragment page (default 1,000), capped by the service descriptor. */
export const KEY_KGF_PAGE_SIZE = new ActionContextKey<number>('@kgf:pageSize');
/** Maximum bindings per request; defaults to the advertised service limit (200 if absent), with a byte cap. */
export const KEY_KGF_BINDINGS_SIZE = new ActionContextKey<number>('@kgf:bindingsSize');
/** Use QUERY by default, falling back to POST on HTTP 405/501. POST can be forced. */
export const KEY_KGF_HTTP_METHOD = new ActionContextKey<'QUERY' | 'POST'>('@kgf:httpMethod');
/** Load query-scoped VoID statistics on demand during join planning (default true). */
export const KEY_KGF_VOID_STATISTICS = new ActionContextKey<boolean>('@kgf:voidStatistics');
