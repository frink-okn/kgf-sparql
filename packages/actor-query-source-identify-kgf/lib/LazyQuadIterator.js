"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LazyQuadIterator = void 0;
const asynciterator_1 = require("asynciterator");
/** Pulls rows only on demand, while allowing metadata to resolve independently. */
class LazyQuadIterator extends asynciterator_1.BufferedIterator {
    generate;
    abortController = new AbortController();
    rows;
    constructor(generate) {
        super({ autoStart: false, maxBufferSize: 1 });
        this.generate = generate;
    }
    _read(count, done) {
        void (async () => {
            this.rows ??= this.generate(this.abortController.signal);
            for (let i = 0; i < count && !this.done; i++) {
                const row = await this.rows.next();
                if (this.done) {
                    break;
                }
                if (row.done) {
                    this.close();
                    break;
                }
                this._push(row.value);
            }
        })().then(done, (error) => { this.destroy(error); done(); });
    }
    _destroy(cause, callback) {
        this.abortController.abort();
        void this.rows?.return(undefined).catch(() => { });
        super._destroy(cause, callback);
    }
}
exports.LazyQuadIterator = LazyQuadIterator;
//# sourceMappingURL=LazyQuadIterator.js.map