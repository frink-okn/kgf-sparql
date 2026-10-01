"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActorRdfJoinMultiBindBlock = void 0;
const bus_rdf_join_1 = require("@comunica/bus-rdf-join");
const context_entries_1 = require("@comunica/context-entries");
const core_1 = require("@comunica/core");
const utils_algebra_1 = require("@comunica/utils-algebra");
const utils_iterator_1 = require("@comunica/utils-iterator");
const utils_query_operation_1 = require("@comunica/utils-query-operation");
const asynciterator_1 = require("asynciterator");
/**
 * A bind join that sends the smallest entry's rows in blocks through every other entry
 * that can take bindings, one after another, as FedX's bound joins do.
 *
 * Comunica binds in blocks only when every entry but the smallest lives on one source
 * that accepts `joinBindings` (`multi-bind-source`), or when the join has a pattern on a
 * source that accepts `filterBindings` (`multi-smallest-filter-bindings`). A federated
 * join rarely meets either condition, and the fallback is a bind join that sends one
 * request per row, plus a COUNT per row against a SPARQL endpoint.
 *
 * ## The plan
 *
 * Starting from the smallest entry, the actor repeatedly picks the entry that shares the
 * most variables with what is bound so far (then the smallest) among those it can probe:
 *
 * - an operation on one source that accepts `filterBindings` (KGF, brTPF) or
 *   `joinBindings` (a SPARQL endpoint, through `VALUES`);
 * - a union whose branches are each such an operation, as source assignment produces for
 *   a pattern several sources can answer: every branch is probed;
 * - a join no source was given, whose inputs are each of the above, as `group-sources`
 *   leaves behind. Each input is probed and joined in turn, never to each other.
 *
 * Each block of the smallest entry then runs through those entries in that order. Every
 * probe carries the values of the variables it shares with the rows joined so far,
 * projected and deduplicated, so either kind of source returns the entry's own rows that
 * match some row; those are joined locally, and a block that empties stops. Binding all
 * the entries in one pass needs no estimate of an intermediate result: a previous version
 * bound one entry at a time and handed the rest back to the planner, whose compounded
 * estimate of the intermediate (10^21 rows for a few dozen) then chose to scan a label
 * pattern whole. Entries that cannot be probed, or are smaller than the bound entry, are
 * joined afterwards through the join mediator.
 *
 * Up to `blocksInFlight` blocks are probed at once and each is emitted as soon as it is
 * joined. A value an earlier block already sent is answered from a per-join cache.
 *
 * ## Cost
 *
 * The coefficients are the stock bind join's formula over the probed entries, so the two
 * compare on equal terms, except that a probe request is charged per block instead of per
 * row (one request time per entry, paged or not, as the round-trip bind join charges it) and
 * one block of rows is held. Nothing counts as blocking: the join mediator penalises
 * blocking joins below a LIMIT, and this one only ever waits for a block, not its input.
 */
class ActorRdfJoinMultiBindBlock extends bus_rdf_join_1.ActorRdfJoin {
    blockSize;
    blocksInFlight;
    requestsInFlight;
    probeCacheRows;
    selectivityModifier;
    mediatorJoinEntriesSort;
    mediatorJoin;
    constructor(args) {
        super(args, {
            logicalType: 'inner',
            physicalName: 'multi-bind-block',
            limitEntries: 2,
            limitEntriesMin: true,
            canHandleUndefs: false,
            isLeaf: false,
        });
        this.blockSize = args.blockSize ?? 256;
        this.blocksInFlight = args.blocksInFlight ?? 4;
        this.requestsInFlight = args.requestsInFlight ?? 8;
        this.probeCacheRows = args.probeCacheRows ?? 100_000;
        this.selectivityModifier = args.selectivityModifier ?? 0.0001;
        this.mediatorJoinEntriesSort = args.mediatorJoinEntriesSort;
        this.mediatorJoin = args.mediatorJoin;
    }
    async getJoinCoefficients(action, sideData) {
        if (action.context.get(context_entries_1.KeysRdfJoin.lastPhysicalJoin) === this.physicalName) {
            return (0, core_1.failTest)(`${this.name} can not be called recursively`);
        }
        const planned = await this.plan(action, sideData.metadatas);
        if (planned.isFailed()) {
            return planned;
        }
        const plan = planned.get();
        const { first, steps } = plan;
        const rows = first.metadata.cardinality.value;
        const blocks = Math.ceil(rows / this.blockSize);
        const metadatas = [first.metadata, ...steps.map(step => step.entry.metadata)];
        const initial = bus_rdf_join_1.ActorRdfJoin.getRequestInitialTimes(metadatas);
        const item = bus_rdf_join_1.ActorRdfJoin.getRequestItemTimes(metadatas);
        // The stock bind join's formula over the probed entries, with its selectivity modifier...
        let probed = 0;
        let probeRequest = 0;
        let receive = 0;
        for (const [i, step] of steps.entries()) {
            const { selectivity } = await this.mediatorJoinSelectivity.mediate({
                entries: [first, step.entry],
                context: action.context,
            });
            const stepRows = step.entry.metadata.cardinality.value;
            // An unknown entry size says nothing about what its probes return; one row per bound row is the guess.
            probed += Number.isFinite(stepRows) ? stepRows * selectivity * this.selectivityModifier : 1;
            // A probe is a new request whether or not the entry is paged, as the round-trip bind join charges it.
            probeRequest += step.entry.metadata.requestTime ?? initial[i + 1];
            receive += item[i + 1];
        }
        // ...except that a probe request is sent per block instead of per row, and a block is held to join it.
        // Only a block is held, never the whole input, so nothing counts as blocking for a LIMIT above.
        return (0, core_1.passTestWithSideData)({
            iterations: rows * probed,
            persistedItems: Math.min(rows, this.blockSize),
            blockingItems: 0,
            requestTime: initial[0] + rows * item[0] + blocks * probeRequest + rows * probed * receive,
        }, { ...sideData, plan });
    }
    async getOutput(action, sideData) {
        const { first, steps, remaining } = sideData.plan;
        const dataFactory = action.context.getSafe(context_entries_1.KeysInitQuery.dataFactory);
        const algebraFactory = new utils_algebra_1.AlgebraFactory(dataFactory);
        // The bound entries are only probed; their own streams are never read.
        for (const step of steps) {
            step.entry.output.bindingsStream.destroy();
        }
        const probes = { cache: new ProbeCache(this.probeCacheRows), slots: new Slots(this.requestsInFlight) };
        const bindingsStream = new BlockJoinIterator(new utils_iterator_1.ChunkedIterator(first.output.bindingsStream, this.blockSize, { autoStart: false }), async (rows, emit) => await this.joinBlock(rows, steps, first.metadata, dataFactory, action.context, probes, emit), this.blocksInFlight, this.blocksInFlight * this.blockSize);
        const bound = [first, ...steps.map(step => step.entry)];
        const joined = {
            output: {
                type: 'bindings',
                bindingsStream,
                metadata: async () => await this.constructResultMetadata(bound, bound.map(entry => entry.metadata), action.context),
            },
            operation: algebraFactory.createJoin(bound.map(entry => entry.operation), false),
            operationModified: true,
        };
        const physicalPlanMetadata = {
            firstIndex: sideData.plan.firstIndex,
            stepIndexes: sideData.plan.stepIndexes,
            probes: steps.reduce((sum, step) => sum + step.parts.reduce((parts, part) => parts + part.leaves.length, 0), 0),
            blockSize: this.blockSize,
            blocksInFlight: this.blocksInFlight,
        };
        if (remaining.length === 0) {
            return { result: joined.output, physicalPlanMetadata };
        }
        return {
            result: await this.mediatorJoin.mediate({
                type: action.type,
                entries: [joined, ...remaining],
                context: action.context,
            }),
            physicalPlanMetadata,
        };
    }
    /**
     * Choose the entry to bind (the smallest) and, in order, the entries to probe with it.
     */
    async plan(action, metadatas) {
        const entriesUnsorted = action.entries
            .map((entry, i) => ({ ...entry, metadata: metadatas[i] }));
        const sortedTest = await bus_rdf_join_1.ActorRdfJoin.sortJoinEntries(this.mediatorJoinEntriesSort, entriesUnsorted, action.context);
        if (sortedTest.isFailed()) {
            return sortedTest;
        }
        // An entry already computed locally cannot be probed, so it is the one to bind if there is one.
        const sorted = [...sortedTest.get()]
            .sort((left, right) => Number(Boolean(right.operationModified)) - Number(Boolean(left.operationModified)));
        const first = sorted[0];
        const rows = first.metadata.cardinality.value;
        if (!Number.isFinite(rows) || rows <= 0) {
            return (0, core_1.failTest)(`${this.name} needs a smallest entry of known, non-zero size`);
        }
        const known = new Set(first.metadata.variables.map(variable => variable.variable.value));
        const pool = sorted.slice(1).filter(entry => !entry.operationModified &&
            // An entry smaller than the bound one is cheaper to fetch whole and join afterwards.
            !(Number.isFinite(entry.metadata.cardinality.value) && entry.metadata.cardinality.value < rows));
        const steps = [];
        for (;;) {
            let best;
            for (const entry of pool) {
                if (steps.some(step => step.entry === entry)) {
                    continue;
                }
                const parts = await this.probeParts(entry.operation, known, action.context);
                if (!parts) {
                    continue;
                }
                const shared = new Set(parts.flatMap(part => part.shared)).size;
                if (!best || shared > best.shared ||
                    (shared === best.shared && entry.metadata.cardinality.value < best.step.entry.metadata.cardinality.value)) {
                    best = { step: { entry, parts }, shared };
                }
            }
            if (!best) {
                break;
            }
            steps.push(best.step);
            for (const variable of best.step.entry.metadata.variables) {
                known.add(variable.variable.value);
            }
        }
        if (steps.length === 0) {
            return (0, core_1.failTest)(`${this.name} found no entry that accepts bindings and shares a variable with the smallest`);
        }
        return (0, core_1.passTest)({
            first,
            steps,
            remaining: sorted.slice(1).filter(entry => !steps.some(step => step.entry === entry)),
            firstIndex: entriesUnsorted.indexOf(first),
            stepIndexes: steps.map(step => entriesUnsorted.indexOf(step.entry)),
        });
    }
    /**
     * How to probe an operation with rows binding the `known` variables, as separately
     * probed parts, or `undefined` when it cannot be probed.
     */
    async probeParts(operation, known, context) {
        const leaves = await this.probeLeaves(operation, known, context);
        if (leaves) {
            const variables = ActorRdfJoinMultiBindBlock.variablesOf(operation);
            const shared = variables.filter(name => known.has(name));
            return shared.length > 0 ? [{ operation, shared, leaves }] : undefined;
        }
        if (operation.type === utils_algebra_1.Algebra.Types.JOIN && !(0, utils_query_operation_1.getOperationSource)(operation)) {
            const parts = [];
            for (const input of operation.input) {
                const inner = await this.probeParts(input, known, context);
                if (!inner) {
                    return undefined;
                }
                parts.push(...inner);
            }
            return parts;
        }
        return undefined;
    }
    /**
     * The source requests one probe of an operation sends, or `undefined` when one of
     * them cannot take bindings or would not be restricted by them.
     */
    async probeLeaves(operation, known, context) {
        const source = (0, utils_query_operation_1.getOperationSource)(operation);
        if (source) {
            const shared = ActorRdfJoinMultiBindBlock.variablesOf(operation).filter(name => known.has(name));
            if (shared.length === 0) {
                return undefined;
            }
            const shape = await source.source.getSelectorShape(context);
            const wildcardAcceptAllExtensionFunctions = context.get(context_entries_1.KeysInitQuery.extensionFunctionsAlwaysPushdown);
            for (const mode of ['filterBindings', 'joinBindings']) {
                if ((0, utils_query_operation_1.doesShapeAcceptOperation)(shape, operation, { [mode]: true, wildcardAcceptAllExtensionFunctions })) {
                    return [{ operation, source, mode, shared }];
                }
            }
            return undefined;
        }
        if (operation.type === utils_algebra_1.Algebra.Types.UNION) {
            const leaves = [];
            for (const input of operation.input) {
                const inner = await this.probeLeaves(input, known, context);
                if (!inner) {
                    return undefined;
                }
                leaves.push(...inner);
            }
            return leaves.length > 0 ? leaves : undefined;
        }
        return undefined;
    }
    /**
     * Run one block through every step. Rows move on in chunks as soon as they are joined,
     * so neither a probe's results nor a step's joined rows are ever held whole: a value that
     * matches millions of rows streams through rather than filling memory, and the event loop
     * gets a turn between chunks, so a budget, a LIMIT, or a signal can stop the work. An
     * earlier version materialized both and joined them in one synchronous pass; on a probe of
     * a handful of experiments with millions of statements each it held the event loop for
     * minutes, past the run's own timeout and its SIGTERM handler, at 9.4 GB.
     */
    async joinBlock(rows, steps, metadata, dataFactory, context, probes, emit) {
        const run = { metadata, dataFactory, context, probes, emit };
        const parts = steps.flatMap(step => step.parts);
        // Each part collects the rows reaching it until they carry `blockSize` distinct values
        // (or `BATCH_ROWS` rows), so its requests stay full however finely the part before it
        // hands rows on; what is left is sent when the block's rows are all in.
        let batches = parts.map(() => new Batch());
        // Batches sent and not yet joined, per part; a part sends a few at once, not one after another.
        const sent = parts.map(() => new Set());
        // A batch leaves `sent` once it settles, so one that failed before anything waited on it
        // took its error with it, and the block ended with the rows the other batches made: in a
        // browser, where every batch failed, a query "completed" with none. The first failure
        // is kept here and thrown at the next chance.
        let failure;
        const check = () => {
            if (failure) {
                throw failure.error;
            }
        };
        const feed = async (level, incoming) => {
            check();
            if (incoming.length === 0) {
                return;
            }
            if (level === parts.length) {
                await run.emit(incoming);
                return;
            }
            for (const row of incoming) {
                const key = ActorRdfJoinMultiBindBlock.keyOf(row, parts[level].shared) ?? '';
                if (batches[level].isFull(key, this.blockSize)) {
                    await send(level);
                }
                batches[level].add(key, row);
            }
        };
        const send = async (level) => {
            const batch = batches[level];
            if (batch.rows.length === 0) {
                return;
            }
            // Swapped out before any await, so rows arriving meanwhile start the next batch.
            batches = batches.map((current, i) => i === level ? new Batch() : current);
            const joining = this.probeBatch(batch.rows, parts[level], run, async (joined) => await feed(level + 1, joined))
                .catch((error) => {
                failure ??= { error };
            });
            sent[level].add(joining);
            void joining.finally(() => sent[level].delete(joining));
            if (sent[level].size >= BATCHES_IN_FLIGHT) {
                await Promise.race(sent[level]);
            }
            check();
        };
        await feed(0, rows);
        for (let level = 0; level < parts.length; level++) {
            // A part's last batch can go once every batch of the part before it has been joined.
            await send(level);
            await Promise.all(sent[level]);
            check();
        }
    }
    /** Join one batch to a part: index the batch, and stream each probe's rows past it. */
    async probeBatch(batch, part, run, onJoined) {
        const index = ActorRdfJoinMultiBindBlock.index(batch, part.shared);
        let joined = [];
        const pass = async () => {
            const chunk = joined;
            joined = [];
            await onJoined(chunk);
        };
        await Promise.all(part.leaves.map(async (leaf) => await this.probe(leaf, batch, run, async (probed) => {
            for (const row of probed) {
                for (const match of ActorRdfJoinMultiBindBlock.matches(index, row, part.shared)) {
                    const merged = bus_rdf_join_1.ActorRdfJoin.joinBindings(match, row);
                    if (merged) {
                        joined.push(merged);
                        if (joined.length >= CHUNK_ROWS) {
                            await pass();
                        }
                    }
                }
            }
            await yieldToEventLoop();
        })));
        if (joined.length > 0) {
            await pass();
        }
    }
    /**
     * Hand `onRows` the leaf's rows that match some of the given rows, a chunk at a time.
     * Values an earlier block already sent are answered from the cache, or from the request
     * still carrying them, and not sent again; an answer too large to keep is sent for again.
     * New values go out in requests of at most `blockSize` values, at most `requestsInFlight`
     * of them at once across the join: a step whose rows fan out to many values would
     * otherwise send all its requests together.
     */
    async probe(leaf, rows, run, onRows) {
        const { cache } = run.probes;
        const keep = new Set(leaf.shared);
        const seen = new Set();
        const elsewhere = [];
        const send = [];
        for (const row of rows) {
            const key = ActorRdfJoinMultiBindBlock.keyOf(row, leaf.shared);
            // Each value's rows are handed on once; the local join pairs them with every row that carries it.
            if (key === undefined || seen.has(key)) {
                continue;
            }
            seen.add(key);
            const bindings = row.filter((_, variable) => keep.has(variable.value));
            const known = cache.get(leaf, key);
            if (known) {
                elsewhere.push({ key, bindings, answer: known });
                continue;
            }
            const answer = deferred();
            cache.set(leaf, key, answer.promise);
            send.push({ key, bindings, answer });
        }
        const metadata = {
            ...run.metadata,
            variables: leaf.shared.map(name => ({ variable: run.dataFactory.variable(name), canBeUndef: false })),
        };
        const requests = [];
        const track = (request) => {
            // Awaited at the end, after the values other blocks are fetching; a failure meanwhile
            // must not also surface as an unhandled rejection.
            request.catch(() => undefined);
            requests.push(request);
        };
        for (let start = 0; start < send.length; start += this.blockSize) {
            track(this.request(leaf, send.slice(start, start + this.blockSize), metadata, run, onRows, true));
        }
        const answered = await Promise.all(elsewhere.map(async (value) => ({ value, rows: await value.answer })));
        const kept = answered.flatMap(({ rows: answer }) => answer ?? []);
        if (kept.length > 0) {
            await onRows(kept);
        }
        // Answers that turned out too large to keep: ask for those values here too, uncached.
        const resend = answered.filter(({ rows: answer }) => !answer)
            .map(({ value }) => ({ key: value.key, bindings: value.bindings, answer: deferred() }));
        for (let start = 0; start < resend.length; start += this.blockSize) {
            track(this.request(leaf, resend.slice(start, start + this.blockSize), metadata, run, onRows, false));
        }
        await Promise.all(requests);
    }
    /**
     * One request carrying the given values. Its rows go to `onRows` a chunk at a time as
     * they arrive. While they stay few they are also kept per value, and settle each value's
     * answer for other blocks; once they pass `blockSize` times 64 rows the values' answers
     * are settled as too large to keep, so blocks waiting on them send for them themselves.
     */
    async request(leaf, values, metadata, run, onRows, cacheable) {
        const { cache, slots } = run.probes;
        let keeping = cacheable;
        let kept = 0;
        const byKey = new Map();
        const tooLarge = () => {
            keeping = false;
            byKey.clear();
            for (const { key, answer } of values) {
                cache.forget(leaf, key);
                answer.resolve(undefined);
            }
        };
        let stream;
        // A slot is held while waiting on the source, never while rows move on: the next step's
        // probes need slots too, and holding one across `onRows` let every slot end up held by a
        // request waiting for a slot. That deadlock left a corpus query idle past its budget, with
        // nothing in flight for the abort to cancel.
        let holding = false;
        try {
            await slots.enter();
            holding = true;
            stream = leaf.source.source.queryBindings(leaf.operation, leaf.source.context ? run.context.merge(leaf.source.context) : run.context, { [leaf.mode]: {
                    bindings: new asynciterator_1.ArrayIterator(values.map(value => value.bindings), { autoStart: false }),
                    metadata: { ...metadata, cardinality: { type: 'exact', value: values.length } },
                } });
            const reader = new ChunkReader(stream);
            for (;;) {
                if (!holding) {
                    await slots.enter();
                    holding = true;
                }
                const chunk = await reader.next(CHUNK_ROWS);
                slots.leave();
                holding = false;
                if (!chunk) {
                    break;
                }
                if (keeping) {
                    for (const row of chunk) {
                        const key = ActorRdfJoinMultiBindBlock.keyOf(row, leaf.shared);
                        if (key !== undefined) {
                            const bucket = byKey.get(key);
                            if (bucket) {
                                bucket.push(row);
                            }
                            else {
                                byKey.set(key, [row]);
                            }
                        }
                    }
                    kept += chunk.length;
                    if (kept > this.blockSize * 64) {
                        tooLarge();
                    }
                }
                await onRows(chunk);
            }
            if (keeping) {
                for (const { key, answer } of values) {
                    const matched = byKey.get(key) ?? [];
                    cache.retain(leaf, key, matched.length);
                    answer.resolve(matched);
                }
            }
            else if (!cacheable) {
                for (const { answer } of values) {
                    answer.resolve(undefined);
                }
            }
        }
        catch (error) {
            stream?.destroy();
            if (keeping) {
                for (const { key, answer } of values) {
                    cache.forget(leaf, key);
                    answer.reject(error);
                }
            }
            throw error;
        }
        finally {
            if (holding) {
                slots.leave();
            }
        }
    }
    /** The rows indexed by the values of `variables`, for streaming another side past them. */
    static index(rows, variables) {
        const byKey = new Map();
        const loose = [];
        for (const row of rows) {
            const key = ActorRdfJoinMultiBindBlock.keyOf(row, variables);
            if (key === undefined) {
                loose.push(row);
            }
            else {
                const bucket = byKey.get(key);
                if (bucket) {
                    bucket.push(row);
                }
                else {
                    byKey.set(key, [row]);
                }
            }
        }
        return { byKey, loose, all: rows };
    }
    /** The indexed rows that may join with `row`; `joinBindings` makes the final check. */
    static matches(index, row, variables) {
        const key = ActorRdfJoinMultiBindBlock.keyOf(row, variables);
        if (key === undefined) {
            return index.all;
        }
        const bucket = index.byKey.get(key) ?? NO_ROWS;
        return index.loose.length === 0 ? bucket : [...bucket, ...index.loose];
    }
    /** Join two lists of solutions on the given variables, which every row is expected to bind. */
    static hashJoin(left, right, variables) {
        const keyOf = (bindings) => ActorRdfJoinMultiBindBlock.keyOf(bindings, variables);
        const index = new Map();
        const loose = [];
        for (const row of right) {
            const key = keyOf(row);
            if (key === undefined) {
                loose.push(row);
            }
            else {
                const bucket = index.get(key);
                if (bucket) {
                    bucket.push(row);
                }
                else {
                    index.set(key, [row]);
                }
            }
        }
        const out = [];
        for (const row of left) {
            const key = keyOf(row);
            const candidates = key === undefined ? right : [...index.get(key) ?? [], ...loose];
            for (const candidate of candidates) {
                const merged = bus_rdf_join_1.ActorRdfJoin.joinBindings(row, candidate);
                if (merged) {
                    out.push(merged);
                }
            }
        }
        return out;
    }
    /** A string identifying the values of the given variables, or `undefined` when one is unbound. */
    static keyOf(bindings, variables) {
        const values = [];
        for (const name of variables) {
            const term = bindings.get(name);
            if (!term) {
                return undefined;
            }
            values.push(term);
        }
        return JSON.stringify(values.map(term => [term.termType, term.value,
            term.termType === 'Literal' ? `${term.language}^${term.datatype.value}` : '']));
    }
    static variablesOf(operation) {
        return utils_algebra_1.algebraUtils.inScopeVariables(operation).map(variable => variable.value);
    }
}
exports.ActorRdfJoinMultiBindBlock = ActorRdfJoinMultiBindBlock;
/** Rows waiting to be sent to one part, and the distinct values they carry. */
class Batch {
    rows = [];
    keys = new Set();
    /** Whether `key` would take the batch past `limit` distinct values, or it already holds `BATCH_ROWS` rows. */
    isFull(key, limit) {
        return this.rows.length >= BATCH_ROWS || (!this.keys.has(key) && this.keys.size >= limit);
    }
    add(key, row) {
        this.keys.add(key);
        this.rows.push(row);
    }
}
/** Rows joined, read, or emitted at a time between turns of the event loop. */
const CHUNK_ROWS = 1024;
/** Rows a part collects before sending, however few distinct values they carry. */
const BATCH_ROWS = 4 * CHUNK_ROWS;
/** Batches one part of one block may have sent and not yet joined. */
const BATCHES_IN_FLIGHT = 4;
const NO_ROWS = [];
/** Thrown into a block's work once the joined stream is closed, as a LIMIT above it does. */
const STOPPED = new Error('The joined stream was closed');
/**
 * Lets timers, I/O, and signal handlers run before continuing. Browsers have no
 * `setImmediate`, and a `setTimeout` chain is held to 4 ms a step there, so they get a
 * message to themselves instead, which runs as soon as pending input and network events have.
 */
const yieldToEventLoop = typeof setImmediate === 'function' ?
    async () => await new Promise(resolve => setImmediate(resolve)) :
    messageYield();
function messageYield() {
    const channel = new MessageChannel();
    const waiting = [];
    // The browser's port, which Node's types (the only ones this package compiles with) lack.
    channel.port1.onmessage = () => waiting.shift()?.();
    return async () => await new Promise((resolve) => {
        waiting.push(resolve);
        channel.port2.postMessage(undefined);
    });
}
/**
 * Reads a stream a chunk at a time: whatever is ready now, or the first items to arrive.
 * Its listeners stay attached for the stream's life, and it waits for an event only when the
 * stream says it is not readable: a wrapping iterator that reports readable with nothing to
 * read never announces `readable` again, and a read that waited for it stalled a query.
 */
class ChunkReader {
    stream;
    wake;
    failure;
    ended = false;
    constructor(stream) {
        this.stream = stream;
        stream.on('readable', () => this.notify());
        stream.on('end', () => {
            this.ended = true;
            this.notify();
        });
        stream.on('error', (error) => {
            this.failure = error;
            this.notify();
        });
    }
    /** Up to `size` items, or `undefined` once the stream has ended. */
    async next(size) {
        for (;;) {
            if (this.failure) {
                throw this.failure;
            }
            const chunk = [];
            let item;
            while (chunk.length < size && (item = this.stream.read()) !== null) {
                chunk.push(item);
            }
            if (chunk.length > 0) {
                return chunk;
            }
            if (this.ended || this.stream.done) {
                return undefined;
            }
            if (this.stream.readable) {
                // Readable yet nothing to read: an iterator wrapping another one can stay in this
                // state, and it announces `readable` only on becoming readable, so waiting for the
                // event would wait forever. Let its source make progress, then look again.
                await yieldToEventLoop();
                continue;
            }
            await new Promise((resolve) => {
                this.wake = resolve;
            });
        }
    }
    notify() {
        const wake = this.wake;
        this.wake = undefined;
        wake?.();
    }
}
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    // A failure is reported by whichever block awaits it; one no block awaits must not crash the process.
    promise.catch(() => undefined);
    return { promise, resolve, reject };
}
/**
 * Probe answers for one join, per source request and bound values. A value in flight is
 * shared by every block that needs it; answered values are kept until `limit` rows are held.
 */
class ProbeCache {
    limit;
    answers = new Map();
    rows = 0;
    constructor(limit) {
        this.limit = limit;
    }
    get(leaf, key) {
        return this.answers.get(leaf)?.get(key);
    }
    set(leaf, key, answer) {
        let forLeaf = this.answers.get(leaf);
        if (!forLeaf) {
            forLeaf = new Map();
            this.answers.set(leaf, forLeaf);
        }
        forLeaf.set(key, answer);
    }
    /** Keep an answered value if there is room for its rows, else drop it. */
    retain(leaf, key, rows) {
        if (this.rows + rows > this.limit) {
            this.forget(leaf, key);
        }
        else {
            this.rows += rows;
        }
    }
    forget(leaf, key) {
        this.answers.get(leaf)?.delete(key);
    }
}
/** At most `limit` holders at once; the rest wait in arrival order. */
class Slots {
    limit;
    active = 0;
    waiting = [];
    constructor(limit) {
        this.limit = limit;
    }
    async enter() {
        if (this.active < this.limit) {
            this.active++;
            return;
        }
        await new Promise(resolve => this.waiting.push(resolve));
    }
    /** Hands the place to the next waiter, if any, rather than freeing it. */
    leave() {
        const next = this.waiting.shift();
        if (next) {
            next();
        }
        else {
            this.active--;
        }
    }
}
/**
 * Joins blocks of the bound entry with up to `maxActive` in progress at once. Each block
 * hands its joined rows out through `deliver` as it produces them, whatever the order the
 * blocks came in; `deliver` waits while `maxReady` rows are unread, so a slow reader holds
 * the probes back. Destroying the stream (a LIMIT above it was reached) starts no further
 * block, and wakes the waiting blocks with `STOPPED` so their requests end.
 */
class BlockJoinIterator extends asynciterator_1.BufferedIterator {
    blocks;
    join;
    maxActive;
    maxReady;
    active = 0;
    ready = [];
    readyRows = 0;
    head = 0;
    pending;
    drained = [];
    constructor(blocks, join, maxActive, maxReady) {
        super({ autoStart: false });
        this.blocks = blocks;
        this.join = join;
        this.maxActive = maxActive;
        this.maxReady = maxReady;
        blocks.on('readable', () => this.startBlocks());
        blocks.on('end', () => this.settle());
        blocks.on('error', (error) => this.destroy(error));
    }
    _read(count, done) {
        this.pending = { count, done };
        this.startBlocks();
        this.settle();
    }
    _destroy(cause, callback) {
        // Without the cause: destroyed with one, the blocks emit it as an error, and when the
        // error came from them in the first place that destroys this iterator again, without end.
        this.blocks.destroy();
        this.wake();
        super._destroy(cause, callback);
    }
    async deliver(rows) {
        if (this.done) {
            throw STOPPED;
        }
        if (rows.length > 0) {
            this.ready.push(rows);
            this.readyRows += rows.length;
            this.settle();
        }
        while (!this.done && this.readyRows >= this.maxReady) {
            await new Promise(resolve => this.drained.push(resolve));
        }
        if (this.done) {
            throw STOPPED;
        }
    }
    wake() {
        for (const resolve of this.drained.splice(0)) {
            resolve();
        }
    }
    startBlocks() {
        while (!this.done && this.active < this.maxActive && this.readyRows < this.maxReady) {
            const block = this.blocks.read();
            if (block === null) {
                break;
            }
            this.active++;
            block.toArray()
                .then(async (rows) => await this.join(rows, async (joined) => await this.deliver(joined)))
                .then(() => {
                this.active--;
                this.settle();
                this.startBlocks();
            }, (error) => {
                this.active--;
                if (error !== STOPPED) {
                    this.destroy(error);
                }
            });
        }
    }
    settle() {
        if (!this.pending || this.done) {
            return;
        }
        const { count, done } = this.pending;
        if (this.readyRows > 0) {
            this.pending = undefined;
            for (let pushed = 0; pushed < count && this.ready.length > 0; pushed++) {
                const rows = this.ready[0];
                this._push(rows[this.head++]);
                this.readyRows--;
                if (this.head === rows.length) {
                    this.ready.shift();
                    this.head = 0;
                }
            }
            if (this.readyRows < this.maxReady) {
                this.wake();
            }
            done();
            this.startBlocks();
        }
        else if (this.blocks.done && this.active === 0) {
            this.pending = undefined;
            this.close();
            done();
        }
    }
}
//# sourceMappingURL=ActorRdfJoinMultiBindBlock.js.map