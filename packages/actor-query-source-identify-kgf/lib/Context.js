"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KEY_KGF_VOID_STATISTICS = exports.KEY_KGF_HTTP_METHOD = exports.KEY_KGF_BINDINGS_SIZE = exports.KEY_KGF_PAGE_SIZE = void 0;
const core_1 = require("@comunica/core");
/** Requested rows per fragment page (default 1,000), capped by the service descriptor. */
exports.KEY_KGF_PAGE_SIZE = new core_1.ActionContextKey('@kgf:pageSize');
/** Maximum bindings per request; defaults to the advertised service limit (200 if absent), with a byte cap. */
exports.KEY_KGF_BINDINGS_SIZE = new core_1.ActionContextKey('@kgf:bindingsSize');
/** Use QUERY by default, falling back to POST on HTTP 405/501. POST can be forced. */
exports.KEY_KGF_HTTP_METHOD = new core_1.ActionContextKey('@kgf:httpMethod');
/** Load query-scoped VoID statistics on demand during join planning (default true). */
exports.KEY_KGF_VOID_STATISTICS = new core_1.ActionContextKey('@kgf:voidStatistics');
//# sourceMappingURL=Context.js.map