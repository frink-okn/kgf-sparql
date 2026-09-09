"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BudgetIterator = exports.FileSink = exports.FORMATS = void 0;
exports.mediaTypeFor = mediaTypeFor;
exports.pump = pump;
const node_events_1 = require("node:events");
const fs = require("node:fs");
const promises_1 = require("node:stream/promises");
const asynciterator_1 = require("asynciterator");
/**
 * Short names for the media types of Comunica's result serializers. Any media type the
 * engine knows may also be given verbatim; the engine's own serializers write every format.
 */
exports.FORMATS = {
    srj: 'application/sparql-results+json',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    xml: 'application/sparql-results+xml',
    nt: 'application/n-triples',
    nq: 'application/n-quads',
    ttl: 'text/turtle',
    jsonld: 'application/ld+json',
};
/** SPARQL Results JSON by default, because `kgfq` and the corpus scripts read it; N-Triples for quads. */
function mediaTypeFor(format, resultType) {
    if (format === undefined) {
        return resultType === 'quads' ? exports.FORMATS.nt : exports.FORMATS.srj;
    }
    return exports.FORMATS[format] ?? format;
}
/**
 * Results go to a file, never to a pipe: Node truncates unflushed writes at exit and pipes
 * cap at 64 KB. `close` returns once the descriptor is closed, so nothing written is lost.
 */
class FileSink {
    stream;
    failure;
    constructor(stream) {
        this.stream = stream;
        stream.on('error', (error) => {
            this.failure = error;
        });
    }
    /** Opens the file before the query runs, so an unwritable path fails before the work, not after it. */
    static async open(path) {
        const stream = fs.createWriteStream(path);
        await (0, node_events_1.once)(stream, 'open');
        return new FileSink(stream);
    }
    async close() {
        if (!this.stream.writableEnded) {
            this.stream.end();
        }
        if (!this.stream.closed) {
            await (0, node_events_1.once)(this.stream, 'close');
        }
        if (this.failure) {
            throw this.failure;
        }
    }
}
exports.FileSink = FileSink;
/**
 * Counts rows on their way to the serializer and ends the stream cleanly at the row budget,
 * so the serializer closes its document and the rows before the budget are a well-formed file.
 */
class BudgetIterator extends asynciterator_1.TransformIterator {
    account;
    constructor(source, account) {
        super(source, { autoStart: false });
        this.account = account;
    }
    _transform(item, done, push) {
        if (this.account.countRow()) {
            push(item);
        }
        else {
            this.close();
        }
        done();
    }
}
exports.BudgetIterator = BudgetIterator;
/**
 * Pipes serialized output to the file with backpressure. A budget abort fails or destroys the
 * source, never the file, so what was written before the abort is flushed and kept.
 */
async function pump(data, sink, account) {
    const readable = data;
    readable.pipe(sink.stream, { end: false });
    const stop = () => {
        readable.destroy();
    };
    account.signal.addEventListener('abort', stop, { once: true });
    try {
        await (0, promises_1.finished)(readable);
    }
    catch (error) {
        // A run the account ended surfaces here as the stream's error; the account says why.
        if (!account.exceeded && !account.signal.aborted) {
            throw error;
        }
    }
    finally {
        account.signal.removeEventListener('abort', stop);
    }
}
//# sourceMappingURL=Output.js.map