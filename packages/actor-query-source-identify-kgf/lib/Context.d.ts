import { ActionContextKey } from '@comunica/core';
/** Requested rows per fragment page (default 1,000), capped by the service descriptor. */
export declare const KEY_KGF_PAGE_SIZE: ActionContextKey<number>;
/** Maximum bindings per request; defaults to the advertised service limit (200 if absent), with a byte cap. */
export declare const KEY_KGF_BINDINGS_SIZE: ActionContextKey<number>;
/** Use QUERY by default, falling back to POST on HTTP 405/501. POST can be forced. */
export declare const KEY_KGF_HTTP_METHOD: ActionContextKey<"QUERY" | "POST">;
/** Load query-scoped VoID statistics on demand during join planning (default true). */
export declare const KEY_KGF_VOID_STATISTICS: ActionContextKey<boolean>;
//# sourceMappingURL=Context.d.ts.map