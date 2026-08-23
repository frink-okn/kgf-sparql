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
exports.KEY_VOID_STATISTICS = void 0;
__exportStar(require("./QueryEngine"), exports);
__exportStar(require("./QueryEngineFactory"), exports);
var actor_rdf_join_selectivity_void_1 = require("@kgf/actor-rdf-join-selectivity-void");
Object.defineProperty(exports, "KEY_VOID_STATISTICS", { enumerable: true, get: function () { return actor_rdf_join_selectivity_void_1.KEY_VOID_STATISTICS; } });
//# sourceMappingURL=index.js.map