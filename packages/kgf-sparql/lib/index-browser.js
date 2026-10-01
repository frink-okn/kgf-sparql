"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KEY_HTTP_IN_FLIGHT = exports.KEY_HTTP_HOST_LIMITS = exports.KEY_VOID_STATISTICS = exports.KEY_KGF_VOID_STATISTICS = exports.KEY_KGF_HTTP_METHOD = exports.KEY_KGF_BINDINGS_SIZE = exports.KEY_KGF_PAGE_SIZE = void 0;
// The library without the command line, which needs Node's file system and undici, and
// without the factory, which reads a config from disk. Bundlers pick this file through the
// `browser` field, as they do for @comunica/query-sparql.
__exportStar(require("./QueryEngine"), exports);
var actor_query_source_identify_kgf_1 = require("@kgf/actor-query-source-identify-kgf");
Object.defineProperty(exports, "KEY_KGF_PAGE_SIZE", { enumerable: true, get: function () { return actor_query_source_identify_kgf_1.KEY_KGF_PAGE_SIZE; } });
Object.defineProperty(exports, "KEY_KGF_BINDINGS_SIZE", { enumerable: true, get: function () { return actor_query_source_identify_kgf_1.KEY_KGF_BINDINGS_SIZE; } });
Object.defineProperty(exports, "KEY_KGF_HTTP_METHOD", { enumerable: true, get: function () { return actor_query_source_identify_kgf_1.KEY_KGF_HTTP_METHOD; } });
Object.defineProperty(exports, "KEY_KGF_VOID_STATISTICS", { enumerable: true, get: function () { return actor_query_source_identify_kgf_1.KEY_KGF_VOID_STATISTICS; } });
var actor_rdf_join_selectivity_void_1 = require("@kgf/actor-rdf-join-selectivity-void");
Object.defineProperty(exports, "KEY_VOID_STATISTICS", { enumerable: true, get: function () { return actor_rdf_join_selectivity_void_1.KEY_VOID_STATISTICS; } });
var actor_http_throttle_1 = require("@kgf/actor-http-throttle");
Object.defineProperty(exports, "KEY_HTTP_HOST_LIMITS", { enumerable: true, get: function () { return actor_http_throttle_1.KEY_HTTP_HOST_LIMITS; } });
Object.defineProperty(exports, "KEY_HTTP_IN_FLIGHT", { enumerable: true, get: function () { return actor_http_throttle_1.KEY_HTTP_IN_FLIGHT; } });
//# sourceMappingURL=index-browser.js.map