"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RECEIPT_SCHEMA = void 0;
exports.writeReceipt = writeReceipt;
const fs = require("node:fs");
exports.RECEIPT_SCHEMA = 'kgf-sparql.receipt/1';
function writeReceipt(path, receipt) {
    fs.writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
}
//# sourceMappingURL=Receipt.js.map