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
 * Starting from the smallest entry whose size is known exactly (an estimate may be a lower
 * bound, as a COUNT that reached its cap reports), the actor repeatedly picks the entry that
 * shares the most variables with what is bound so far (then the smallest) among those it can probe:
 *
 * - an operation on one source that accepts `filterBindings` (KGF, brTPF) or
 *   `joinBindings` (a SPARQL endpoint, through `VALUES`);
 * - a union whose branches are each such an operation, as source assignment produces for
 *   a pattern several sources can answer: every branch is probed;
 * - a join no source was given, whose inputs are each of the above, as `group-sources`
 *   leaves behind. Each input is probed and joined in turn, never to each other, in an
 *   order where each shares a variable with the rows bound by then.
 *
 * Each block of the smallest entry then runs through those entries in that order. Every
 * probe carries the values of the variables it shares with the rows joined so far,
 * projected and deduplicated, so either kind of source returns the entry's own rows that
 * match some row; those are joined locally, and a block that empties stops. Binding all
 * the entries in one pass needs no estimate of an intermediate result: a previous version
 * bound one entry at a time and handed the rest back to the planner, whose compounded
 * estimate of the intermediate (10^21 rows for a few dozen) then chose to scan a label
 * pattern whole. Entries that cannot be probed, or are known to be smaller than the bound
 * entry, are joined afterwards through the join mediator.
 *
 * Up to `blocksInFlight` blocks are probed at once and each is emitted as soon as it is
 * joined, with up to `requestsInFlight` requests to each source. A value an earlier block
 * already sent is answered from a per-join cache.
 *
 * ## Cost
 *
 * The coefficients are the stock bind join's formula over the probed entries, so the two
 * compare on equal terms, except that probe requests are charged per block instead of per
 * row (one request time per source request a block sends to the entry, paged or not, as the
 * round-trip bind join charges it: one for each branch of a union, and each input of a join)
 * and one block of rows is held. Nothing counts as blocking: the join mediator penalises
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
    /**
     * The outputs of this actor's joins, which it does not take into a join again: it would bind
     * the computed result into the entries it just left out. A context key, as Comunica's
     * filter-bindings join marks its own, reached every join nested under the leftover one, and
     * left a join of two leftover entries that this actor could bind to a per-row bind join.
     */
    outputs = new WeakSet();
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
        if (action.entries.some(entry => entry.output.type === 'bindings' && this.outputs.has(entry.output))) {
            return (0, core_1.failTest)(`${this.name} does not bind its own result again`);
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
        const selectivities = await Promise.all(steps.map(async (step) => (await this.mediatorJoinSelectivity.mediate({
            entries: [first, step.entry],
            context: action.context,
        })).selectivity));
        let probed = 0;
        let probeRequest = 0;
        let receive = 0;
        for (const [i, step] of steps.entries()) {
            const stepRows = step.entry.metadata.cardinality.value;
            // An unknown entry size says nothing about what its probes return; one row per bound row is the guess.
            probed += Number.isFinite(stepRows) ? stepRows * selectivities[i] * this.selectivityModifier : 1;
            // A probe is a new request whether or not the entry is paged, as the round-trip bind join
            // charges it, and a block sends one to each source request of the entry: every branch of a
            // union, and every input of a join.
            const requests = step.parts.reduce((sum, part) => sum + part.leaves.length, 0);
            probeRequest += requests * (step.entry.metadata.requestTime ?? initial[i + 1]);
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
        const probes = {
            cache: new ProbeCache(this.probeCacheRows),
            slots: new Map(),
            readers: new Set(),
            stopped: false,
        };
        const bindingsStream = new BlockJoinIterator(new utils_iterator_1.ChunkedIterator(first.output.bindingsStream, this.blockSize, { autoStart: false }), async (rows, emit) => await this.joinBlock(rows, steps, first.metadata, dataFactory, action.context, probes, emit), () => ActorRdfJoinMultiBindBlock.stop(probes), this.blocksInFlight, this.blocksInFlight * this.blockSize);
        const bound = [first, ...steps.map(step => step.entry)];
        const output = {
            type: 'bindings',
            bindingsStream,
            metadata: async () => await this.constructResultMetadata(bound, bound.map(entry => entry.metadata), action.context),
        };
        this.outputs.add(output);
        const joined = {
            output,
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
            // This actor does not take a join with `joined` in it (see `outputs`), and may take
            // any other join nested under this one.
            result: await this.mediatorJoin.mediate({ type: action.type, entries: [joined, ...remaining], context: action.context }),
            physicalPlanMetadata,
        };
    }
    /**
     * Stops a join's probes once its output is closed: a request waiting for a slot sends
     * nothing, and one waiting on its source stops reading it. Without this, the requests queued
     * behind the slots all went out after a LIMIT above the join was met, and the rows they
     * returned sent the next step's.
     */
    static stop(probes) {
        probes.stopped = true;
        for (const reader of probes.readers) {
            reader.cancel();
        }
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
        const sorted = sortedTest.get();
        // Of known size: an entry whose count failed or timed out, reported as an infinite
        // estimate, cannot be bound in blocks, but it can still be probed. Refusing whenever
        // such an entry came first let a slow COUNT hand the join to a per-row bind join.
        const finite = sorted.filter(entry => Number.isFinite(entry.metadata.cardinality.value));
        // An entry already computed locally cannot be probed, so it is the one to bind if there is
        // one. Otherwise the smallest exact size: an estimate may be a lower bound, as a COUNT that
        // reached its cap reports cap+1 however many more there are, and of several entries at the
        // cap the sort may put any first.
        const first = finite.find(entry => entry.operationModified) ??
            finite.find(entry => entry.metadata.cardinality.type === 'exact') ??
            finite[0];
        const rows = first?.metadata.cardinality.value ?? Number.NaN;
        if (!first || rows <= 0) {
            return (0, core_1.failTest)(`${this.name} needs an entry of known, non-zero size`);
        }
        const others = sorted.filter(entry => entry !== first);
        const known = new Set(first.metadata.variables.map(variable => variable.variable.value));
        const pool = others.filter(entry => !entry.operationModified &&
            // An entry known to be smaller than the bound one is cheaper to fetch whole and join
            // afterwards. One estimated smaller may be far larger, and is probed.
            !(entry.metadata.cardinality.type === 'exact' && entry.metadata.cardinality.value < rows));
        const steps = [];
        // Each source's shape is asked for once, and an entry's parts are worked out again only
        // once a step binds one of its variables: nothing else changes how it can be probed.
        const shapes = new Map();
        const candidates = new Map();
        for (;;) {
            let best;
            for (const entry of pool) {
                if (steps.some(step => step.entry === entry)) {
                    continue;
                }
                let candidate = candidates.get(entry);
                if (!candidate) {
                    const parts = await this.probeParts(entry.operation, known, action.context, shapes);
                    candidate = { parts, shared: parts ? new Set(parts.flatMap(part => part.shared)).size : 0 };
                    candidates.set(entry, candidate);
                }
                const { parts, shared } = candidate;
                if (!parts) {
                    continue;
                }
                if (!best || shared > best.shared ||
                    (shared === best.shared && entry.metadata.cardinality.value < best.step.entry.metadata.cardinality.value)) {
                    best = { step: { entry, parts }, shared };
                }
            }
            if (!best) {
                break;
            }
            steps.push(best.step);
            const added = best.step.entry.metadata.variables
                .map(variable => variable.variable.value)
                .filter(name => !known.has(name));
            for (const name of added) {
                known.add(name);
            }
            for (const entry of candidates.keys()) {
                if (ActorRdfJoinMultiBindBlock.variablesOf(entry.operation).some(name => added.includes(name))) {
                    candidates.delete(entry);
                }
            }
        }
        if (steps.length === 0) {
            return (0, core_1.failTest)(`${this.name} found no entry that accepts bindings and shares a variable with the smallest`);
        }
        return (0, core_1.passTest)({
            first,
            steps,
            remaining: others.filter(entry => !steps.some(step => step.entry === entry)),
            firstIndex: entriesUnsorted.indexOf(first),
            stepIndexes: steps.map(step => entriesUnsorted.indexOf(step.entry)),
        });
    }
    /**
     * How to probe an operation with rows binding the `known` variables, as separately
     * probed parts, or `undefined` when it cannot be probed.
     */
    async probeParts(operation, known, context, shapes) {
        const leaves = await this.probeLeaves(operation, known, context, shapes);
        if (leaves) {
            const variables = ActorRdfJoinMultiBindBlock.variablesOf(operation);
            const shared = variables.filter(name => known.has(name));
            return shared.length > 0 ? [{ operation, shared, leaves }] : undefined;
        }
        if (operation.type === utils_algebra_1.Algebra.Types.JOIN && !(0, utils_query_operation_1.getOperationSource)(operation)) {
            // Inputs are probed in turn, each with the rows the ones before it joined, so an input
            // may share a variable only with an earlier one: a label pattern on ?article after the
            // pattern that binds ?article from the block's ?wikicell. Each next input is the one
            // sharing the most variables with what is bound by then; an input that never shares
            // one leaves the join to another actor. Checking every input against the block's own
            // variables alone refused such a join, and the per-row bind join that took it sent a
            // COUNT per row to every source of every pattern.
            const pending = [...operation.input];
            const bound = new Set(known);
            const parts = [];
            while (pending.length > 0) {
                let best;
                for (const input of pending) {
                    const inner = await this.probeParts(input, bound, context, shapes);
                    const shared = inner ? new Set(inner.flatMap(part => part.shared)).size : 0;
                    if (inner && (!best || shared > best.shared)) {
                        best = { input, parts: inner, shared };
                    }
                }
                if (!best) {
                    return undefined;
                }
                parts.push(...best.parts);
                pending.splice(pending.indexOf(best.input), 1);
                for (const name of ActorRdfJoinMultiBindBlock.variablesOf(best.input)) {
                    bound.add(name);
                }
            }
            return parts;
        }
        return undefined;
    }
    /**
     * The source requests one probe of an operation sends, or `undefined` when one of
     * them cannot take bindings or would not be restricted by them.
     */
    async probeLeaves(operation, known, context, shapes) {
        const source = (0, utils_query_operation_1.getOperationSource)(operation);
        if (source) {
            const shared = ActorRdfJoinMultiBindBlock.variablesOf(operation).filter(name => known.has(name));
            if (shared.length === 0) {
                return undefined;
            }
            let shapePromise = shapes.get(source.source);
            if (!shapePromise) {
                shapePromise = source.source.getSelectorShape(context);
                shapes.set(source.source, shapePromise);
            }
            const shape = await shapePromise;
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
                const inner = await this.probeLeaves(input, known, context, shapes);
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
            if (probes.stopped) {
                throw STOPPED;
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
            const { shared } = parts[level];
            for (const row of incoming) {
                const key = ActorRdfJoinMultiBindBlock.keyOf(row, shared);
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
            const joining = this.probeBatch(batch, parts[level], run, async (joined) => await feed(level + 1, joined))
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
    /**
     * Join one batch to a part: index the batch, and stream each probe's rows past it. Rows that
     * leave one of the part's variables unbound match its rows whatever their value there, so
     * they are probed apart from the others, each set of values they do bind on its own, and
     * joined only with what their own requests return. (They used to be indexed with the rest
     * and joined only with what the other rows' values brought back, and a batch of nothing but
     * such rows sent no request and joined nothing.)
     */
    async probeBatch(batch, part, run, onJoined) {
        const rows = [];
        const keys = [];
        const loose = [];
        for (const [i, row] of batch.rows.entries()) {
            const key = batch.keys[i];
            if (key === undefined) {
                loose.push(row);
            }
            else {
                rows.push(row);
                keys.push(key);
            }
        }
        // The batch's rows are keyed on the part's variables already; a leaf on the same ones reuses the keys.
        const index = ActorRdfJoinMultiBindBlock.index(rows, keys);
        let joined = [];
        const pass = async () => {
            const chunk = joined;
            joined = [];
            await onJoined(chunk);
        };
        const add = async (merged) => {
            joined.push(merged);
            if (joined.length >= CHUNK_ROWS) {
                await pass();
            }
        };
        const onRows = async (probed) => {
            for (const row of probed) {
                for (const match of ActorRdfJoinMultiBindBlock.matches(index, row, part.shared)) {
                    const merged = bus_rdf_join_1.ActorRdfJoin.joinBindings(match, row);
                    if (merged) {
                        await add(merged);
                    }
                }
            }
            await yieldToEventLoop();
        };
        await Promise.all(part.leaves.map(async (leaf) => {
            const leafKeys = ActorRdfJoinMultiBindBlock.sameVariables(leaf.shared, part.shared) ? keys : undefined;
            await Promise.all([
                this.probe(leaf, rows, leafKeys, run, onRows),
                this.probeLoose(leaf, loose, run, add),
            ]);
        }));
        if (joined.length > 0) {
            await pass();
        }
    }
    /**
     * Probe a leaf for rows that leave one of their part's variables unbound: one uncached
     * request per set of values they bind, the unbound ones left out of its bindings (`UNDEF` in
     * a `VALUES`, a wildcard to KGF), whose rows are joined with the rows that sent it alone.
     */
    async probeLoose(leaf, rows, run, add) {
        if (rows.length === 0) {
            return;
        }
        const groups = new Map();
        for (const row of rows) {
            const key = ActorRdfJoinMultiBindBlock.partialKeyOf(row, leaf.shared);
            const group = groups.get(key);
            if (group) {
                group.push(row);
            }
            else {
                groups.set(key, [row]);
            }
        }
        const keep = new Set(leaf.shared);
        const metadata = {
            ...run.metadata,
            variables: leaf.shared.map(name => ({ variable: run.dataFactory.variable(name), canBeUndef: true })),
        };
        await Promise.all([...groups].map(async ([key, members]) => {
            const value = { key, bindings: members[0].filter((_, variable) => keep.has(variable.value)), answer: deferred() };
            await this.request(leaf, [value], metadata, run, async (probed) => {
                for (const row of probed) {
                    for (const member of members) {
                        const merged = bus_rdf_join_1.ActorRdfJoin.joinBindings(member, row);
                        if (merged) {
                            await add(merged);
                        }
                    }
                }
                await yieldToEventLoop();
            }, false);
        }));
    }
    /**
     * Hand `onRows` the leaf's rows that match some of the given rows, a chunk at a time.
     * Values an earlier block already sent are answered from the cache, or from the request
     * still carrying them, and not sent again; an answer too large to keep is sent for again.
     * New values go out in requests of at most `blockSize` values, at most `requestsInFlight`
     * of them at once to the leaf's source across the join: a step whose rows fan out to many
     * values would otherwise send all its requests together. `keys`, when given, are the rows'
     * keys on the leaf's variables.
     */
    async probe(leaf, rows, keys, run, onRows) {
        const { cache } = run.probes;
        const keep = new Set(leaf.shared);
        const seen = new Set();
        const elsewhere = [];
        const send = [];
        for (const [i, row] of rows.entries()) {
            const key = keys ? keys[i] : ActorRdfJoinMultiBindBlock.keyOf(row, leaf.shared);
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
        const { cache } = run.probes;
        const slots = this.slotsOf(run.probes, leaf);
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
        let reader;
        // A slot is held while waiting on the source, never while rows move on: the next step's
        // probes need slots too, and holding one across `onRows` let every slot end up held by a
        // request waiting for a slot. That deadlock left a corpus query idle past its budget, with
        // nothing in flight for the abort to cancel. The slots are the source's: shared across
        // sources, requests queued behind a host paced at one a second could hold them all, and
        // the probes to every other source wait with them.
        let holding = false;
        // Once the join's output is closed, a request that gets its slot sends nothing, and one
        // that was reading ends there.
        const running = () => {
            if (run.probes.stopped) {
                throw STOPPED;
            }
        };
        try {
            await slots.enter();
            holding = true;
            running();
            stream = leaf.source.source.queryBindings(leaf.operation, leaf.source.context ? run.context.merge(leaf.source.context) : run.context, { [leaf.mode]: {
                    bindings: new asynciterator_1.ArrayIterator(values.map(value => value.bindings), { autoStart: false }),
                    metadata: { ...metadata, cardinality: { type: 'exact', value: values.length } },
                } });
            reader = new ChunkReader(stream);
            run.probes.readers.add(reader);
            for (;;) {
                if (!holding) {
                    await slots.enter();
                    holding = true;
                    running();
                }
                const chunk = await reader.next(CHUNK_ROWS);
                slots.leave();
                holding = false;
                running();
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
            if (reader) {
                run.probes.readers.delete(reader);
            }
            if (holding) {
                slots.leave();
            }
        }
    }
    /** The probe slots of the leaf's source in this join, made on first use. */
    slotsOf(probes, leaf) {
        let slots = probes.slots.get(leaf.source.source);
        if (!slots) {
            slots = new Slots(this.requestsInFlight);
            probes.slots.set(leaf.source.source, slots);
        }
        return slots;
    }
    /** The rows, each bound on all of the variables `keys` were made on, indexed by their keys. */
    static index(rows, keys) {
        const byKey = new Map();
        for (const [i, row] of rows.entries()) {
            const bucket = byKey.get(keys[i]);
            if (bucket) {
                bucket.push(row);
            }
            else {
                byKey.set(keys[i], [row]);
            }
        }
        return { byKey, all: rows };
    }
    /**
     * The indexed rows that may join with `row`: those with its key, or all of them when `row`
     * leaves one of the variables unbound, as a union branch without it does. `joinBindings`
     * makes the final check.
     */
    static matches(index, row, variables) {
        const key = ActorRdfJoinMultiBindBlock.keyOf(row, variables);
        return key === undefined ? index.all : index.byKey.get(key) ?? NO_ROWS;
    }
    /**
     * A string identifying the values of the given variables, or `undefined` when one is unbound.
     * Equal terms give equal keys and different ones different keys, so a key stands for its
     * values: a probe sends each key once.
     */
    static keyOf(bindings, variables) {
        let key = '';
        for (const name of variables) {
            const term = bindings.get(name);
            if (!term) {
                return undefined;
            }
            key += termKey(term);
        }
        return key;
    }
    /** As `keyOf`, with a mark of its own for each variable that is unbound. */
    static partialKeyOf(bindings, variables) {
        let key = '';
        for (const name of variables) {
            const term = bindings.get(name);
            key += term ? termKey(term) : '-';
        }
        return key;
    }
    static sameVariables(left, right) {
        return left.length === right.length && left.every((name, i) => name === right[i]);
    }
    static variablesOf(operation) {
        return utils_algebra_1.algebraUtils.inScopeVariables(operation).map(variable => variable.value);
    }
}
exports.ActorRdfJoinMultiBindBlock = ActorRdfJoinMultiBindBlock;
/**
 * One term's part of a key. Each value is prefixed with its length, so that no two lists of
 * terms run together into the same key, and a quoted triple is keyed by its own terms.
 */
function termKey(term) {
    switch (term.termType) {
        case 'Literal':
            return `L${term.value.length}:${term.value}@${term.language}@${term.direction ?? ''}` +
                `${term.datatype.value.length}:${term.datatype.value}`;
        case 'Quad':
            return `Q${termKey(term.subject)}${termKey(term.predicate)}${termKey(term.object)}${termKey(term.graph)}`;
        default:
            return `${term.termType.charAt(0)}${term.value.length}:${term.value}`;
    }
}
/** Rows waiting to be sent to one part, their keys on its variables, and the distinct values they carry. */
class Batch {
    rows = [];
    /** Each row's key, `undefined` where the row leaves one of the part's variables unbound. */
    keys = [];
    distinct = new Set();
    /** Whether `key` would take the batch past `limit` distinct values, or it already holds `BATCH_ROWS` rows. */
    isFull(key, limit) {
        return this.rows.length >= BATCH_ROWS || (!this.distinct.has(key) && this.distinct.size >= limit);
    }
    add(key, row) {
        this.distinct.add(key);
        this.keys.push(key);
        this.rows.push(row);
    }
}
/** Rows joined, read, or emitted at a time between turns of the event loop. */
const CHUNK_ROWS = 1024;
/** Rows a part collects before sending, however few distinct values they carry. */
const BATCH_ROWS = 4 * CHUNK_ROWS;
/** Batches one part of one block may have sent and not yet joined. */
const BATCHES_IN_FLIGHT = 4;
/** Turns of the event loop a read waits on a stream readable with nothing to read, before it waits on a timer. */
const IDLE_YIELDS = 8;
/** The longest a read waits on that timer before looking again. */
const IDLE_WAIT_MS = 16;
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
    cancelled = false;
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
    /**
     * Stops reading: destroys the stream, and ends a read waiting on it. A stream destroyed
     * without an error never announces its end, so such a read would wait for good.
     */
    cancel() {
        this.cancelled = true;
        this.stream.destroy();
        this.notify();
    }
    /** Up to `size` items, or `undefined` once the stream has ended or the reader was cancelled. */
    async next(size) {
        for (let idle = 0;; idle++) {
            if (this.failure) {
                throw this.failure;
            }
            if (this.cancelled) {
                return undefined;
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
                // event alone would wait forever. Let its source make progress, then look again: at
                // once for a few turns, then after a timer or an event, whichever comes first, so a
                // response that takes seconds does not keep a core busy looking.
                if (idle < IDLE_YIELDS) {
                    await yieldToEventLoop();
                }
                else {
                    await this.event(Math.min(2 ** (idle - IDLE_YIELDS), IDLE_WAIT_MS));
                }
                continue;
            }
            await this.event();
        }
    }
    /** Waits for the stream's next event, or at most `milliseconds` when given. */
    async event(milliseconds) {
        await new Promise((resolve) => {
            const timer = milliseconds === undefined ? undefined : setTimeout(() => this.notify(), milliseconds);
            this.wake = () => {
                clearTimeout(timer);
                resolve();
            };
        });
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
 * shared by every block that needs it; answered values are kept until `limit` is held, each
 * counting its rows and one more for itself.
 */
class ProbeCache {
    limit;
    answers = new Map();
    held = 0;
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
    /**
     * Keep an answered value if there is room for it, else drop it. The value itself counts
     * one: counting rows alone kept every value with no rows, without limit.
     */
    retain(leaf, key, rows) {
        if (this.held + rows + 1 > this.limit) {
            this.forget(leaf, key);
        }
        else {
            this.held += rows + 1;
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
 * block, wakes the waiting blocks with `STOPPED`, and calls `stop` so that their requests end.
 */
class BlockJoinIterator extends asynciterator_1.BufferedIterator {
    blocks;
    join;
    stop;
    maxActive;
    maxReady;
    /**
     * Whether this iterator has been read. Until then no block starts, however readable the
     * blocks say they are, as asynciterator's own iterators wait for a read before reading their
     * source: a lazy iterator says it is readable as soon as it exists. A join the planner built
     * and never read, inside an entry another join only probed, otherwise read its first entry:
     * every `wdt:P921` statement on two of Wikidata's query services, until the heap gave out.
     */
    started = false;
    active = 0;
    ready = [];
    readyRows = 0;
    head = 0;
    pending;
    drained = [];
    constructor(blocks, join, stop, maxActive, maxReady) {
        super({ autoStart: false });
        this.blocks = blocks;
        this.join = join;
        this.stop = stop;
        this.maxActive = maxActive;
        this.maxReady = maxReady;
        blocks.on('readable', () => {
            if (this.started) {
                this.startBlocks();
            }
        });
        blocks.on('end', () => this.settle());
        blocks.on('error', (error) => this.destroy(error));
    }
    _read(count, done) {
        this.started = true;
        this.pending = { count, done };
        this.startBlocks();
        this.settle();
    }
    _destroy(cause, callback) {
        // Without the cause: destroyed with one, the blocks emit it as an error, and when the
        // error came from them in the first place that destroys this iterator again, without end.
        this.blocks.destroy();
        this.stop();
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