"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.USAGE = exports.DEFAULT_MAX_CONNECTIONS = exports.EXIT_ABORTED = exports.EXIT_USAGE = exports.EXIT_ERROR = exports.EXIT_COMPLETE = void 0;
exports.runCli = runCli;
exports.main = main;
const fs = require("node:fs");
const node_util_1 = require("node:util");
const context_entries_1 = require("@comunica/context-entries");
const actor_http_throttle_1 = require("@kgf/actor-http-throttle");
const actor_query_source_identify_hypermedia_sparql_bounded_1 = require("@kgf/actor-query-source-identify-hypermedia-sparql-bounded");
const actor_query_source_identify_kgf_1 = require("@kgf/actor-query-source-identify-kgf");
const QueryEngine_1 = require("../QueryEngine");
const Budget_1 = require("./Budget");
const Output_1 = require("./Output");
const Receipt_1 = require("./Receipt");
const Sources_1 = require("./Sources");
const Transport_1 = require("./Transport");
// eslint-disable-next-line ts/no-require-imports,ts/no-var-requires,import/extensions
const packageJson = require('../../package.json');
// eslint-disable-next-line ts/no-require-imports,ts/no-var-requires,import/extensions
const comunicaJson = require('@comunica/query-sparql/package.json');
/** The run returned exactly the solution set the query denotes. */
exports.EXIT_COMPLETE = 0;
/** The query or a source was wrong, or the process failed. */
exports.EXIT_ERROR = 1;
/** The command line was wrong. */
exports.EXIT_USAGE = 2;
/** A budget ended the run; the receipt says which. */
exports.EXIT_ABORTED = 3;
/** Concurrent connections per origin unless `--max-connections` says otherwise: well under the bursts that fail. */
exports.DEFAULT_MAX_CONNECTIONS = 32;
exports.USAGE = `Usage: kgf-sparql (-q <query> | -f <file>) --source <kind@url>... --out <file> [options]

Runs one SPARQL query to completion, or fails, and accounts for every request it made.

  -q, --query <sparql>      Query text
  -f, --file <path>         Query file; '-' reads standard input
      --source <kind@url>   A source, repeatable: kgf@<fragment-or-dataset-url>, sparql@<endpoint-url>
      --out <path>          Results file (required: results never go to a pipe)
      --format <name>       ${Object.keys(Output_1.FORMATS).join(', ')}, or a media type the engine serializes;
                            srj by default, nt for CONSTRUCT and DESCRIBE
      --receipt <path>      Write the run's receipt here as JSON, on every exit path
      --max-requests <n>    Abort after n requests
      --max-bytes <n>       Abort once n decoded bytes were received; k, M, and G suffixes accepted
      --max-rows <n>        Abort after n result rows were written
      --timeout <seconds>   Abort after this much wall-clock time
      --http-method <m>     QUERY (default) or POST for KGF requests that carry bindings
      --page-size <n>       Rows per KGF fragment page, capped by the server
      --bindings-size <n>   Bindings per KGF request, capped by the server
      --no-void-statistics  Plan without lazy VoID join statistics
      --http-retries <n>    Retry 429, 502, 503, and 504 responses up to n times; without it, 429
                            and 503 are retried up to 5 times and the others not at all
      --max-connections <n> Cap concurrent connections per origin (default ${exports.DEFAULT_MAX_CONNECTIONS})
      --max-in-flight <n>   Cap requests in flight per host (default: the connection cap); repeatable,
                            host=n caps one host and '*.domain=n' a domain's hosts together,
                            e.g. --max-in-flight '*.wikidata.org=5'
      --max-rate <host=n>   Start at most n requests a second to a host (QLever's: 1 by default);
                            repeatable. Hosts that answer 429 without Retry-After are slowed anyway
      --count-cap <n>       Count at most n matches when planning against a SPARQL endpoint
                            (default 1000000); repeatable, and host=n sets one host's cap
  -h, --help

Exit status: 0 complete; 1 query, source, or process error; 2 usage error;
             3 aborted at a budget, receipt written.
`;
const OPTIONS = {
    query: { type: 'string', short: 'q' },
    file: { type: 'string', short: 'f' },
    source: { type: 'string', multiple: true },
    out: { type: 'string' },
    format: { type: 'string' },
    receipt: { type: 'string' },
    'max-requests': { type: 'string' },
    'max-bytes': { type: 'string' },
    'max-rows': { type: 'string' },
    timeout: { type: 'string' },
    'http-method': { type: 'string' },
    'page-size': { type: 'string' },
    'bindings-size': { type: 'string' },
    'no-void-statistics': { type: 'boolean' },
    'http-retries': { type: 'string' },
    'max-connections': { type: 'string' },
    'max-in-flight': { type: 'string', multiple: true },
    'max-rate': { type: 'string', multiple: true },
    'count-cap': { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h' },
};
class UsageError extends Error {
    name = 'UsageError';
}
/** Runs the command line and returns its exit status. Files are closed and the receipt written before it returns. */
async function runCli(argv, options = {}) {
    const stdout = options.stdout ?? ((text) => void process.stdout.write(text));
    const stderr = options.stderr ?? ((text) => void process.stderr.write(text));
    let parsed;
    try {
        const result = parseArguments(argv);
        if (result === 'help') {
            stdout(exports.USAGE);
            return exports.EXIT_COMPLETE;
        }
        parsed = result;
    }
    catch (error) {
        stderr(`${toError(error).message}\n\n${exports.USAGE}`);
        return exports.EXIT_USAGE;
    }
    return run(parsed, options, stderr);
}
/** The process entry point: fatal errors and signals end the run through the receipt, not around it. */
function main() {
    const fatal = new AbortController();
    const fail = (reason) => fatal.abort(toError(reason));
    process.on('unhandledRejection', fail);
    process.on('uncaughtException', fail);
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => fail(new Error(`Interrupted by ${signal}`)));
    }
    runCli(process.argv.slice(2), { fatal: fatal.signal }).then(code => process.exit(code), (error) => {
        process.stderr.write(`${toError(error).message}\n`);
        process.exit(exports.EXIT_ERROR);
    });
}
function parseArguments(argv) {
    let values;
    try {
        ({ values } = (0, node_util_1.parseArgs)({ args: argv, options: OPTIONS, allowPositionals: false, strict: true }));
    }
    catch (error) {
        throw new UsageError(toError(error).message);
    }
    if (values.help) {
        return 'help';
    }
    if ((values.query === undefined) === (values.file === undefined)) {
        throw new UsageError('Give the query as exactly one of -q <query> or -f <file>');
    }
    let query = values.query;
    if (query === undefined) {
        try {
            query = fs.readFileSync(values.file === '-' ? 0 : values.file, 'utf8');
        }
        catch (error) {
            throw new UsageError(`Cannot read query file '${values.file}': ${toError(error).message}`);
        }
    }
    if (!values.source?.length) {
        throw new UsageError('At least one --source <kind@url> is required');
    }
    const sources = values.source.map((argument) => {
        try {
            return (0, Sources_1.parseSource)(argument);
        }
        catch (error) {
            throw new UsageError(toError(error).message);
        }
    });
    if (!values.out) {
        throw new UsageError('--out <file> is required: results go to a file, never to a pipe');
    }
    if (values.format !== undefined && !values.format.trim()) {
        throw new UsageError(`--format must name one of ${Object.keys(Output_1.FORMATS).join(', ')} or a media type`);
    }
    const budget = {
        maxRequests: integer('--max-requests', values['max-requests']),
        maxBytes: byteCount('--max-bytes', values['max-bytes']),
        maxRows: integer('--max-rows', values['max-rows']),
        timeoutSeconds: seconds('--timeout', values.timeout),
    };
    const settings = {};
    if (values['http-method'] !== undefined) {
        const method = values['http-method'].toUpperCase();
        if (method !== 'QUERY' && method !== 'POST') {
            throw new UsageError(`--http-method must be QUERY or POST, not '${values['http-method']}'`);
        }
        settings[actor_query_source_identify_kgf_1.KEY_KGF_HTTP_METHOD.name] = method;
    }
    if (values['page-size'] !== undefined) {
        settings[actor_query_source_identify_kgf_1.KEY_KGF_PAGE_SIZE.name] = integer('--page-size', values['page-size']);
    }
    if (values['bindings-size'] !== undefined) {
        settings[actor_query_source_identify_kgf_1.KEY_KGF_BINDINGS_SIZE.name] = integer('--bindings-size', values['bindings-size']);
    }
    if (values['no-void-statistics']) {
        settings[actor_query_source_identify_kgf_1.KEY_KGF_VOID_STATISTICS.name] = false;
    }
    const retries = integer('--http-retries', values['http-retries'], 0);
    if (retries !== undefined) {
        // The engine's throttle actor retries 429 and 503 itself, paced, honouring Retry-After;
        // given a count it also retries 504 and the statuses listed here.
        settings[context_entries_1.KeysHttp.httpRetryCount.name] = retries;
        settings[context_entries_1.KeysHttp.httpRetryStatusCodes.name] = [502];
        settings[context_entries_1.KeysHttp.httpRetryDelayFallback.name] = 250;
    }
    const maxConnections = integer('--max-connections', values['max-connections']) ?? exports.DEFAULT_MAX_CONNECTIONS;
    const throttle = throttleLimits(values['max-in-flight'], values['max-rate'], maxConnections);
    settings[actor_http_throttle_1.KEY_HTTP_IN_FLIGHT.name] = throttle.inFlight;
    if (Object.keys(throttle.hosts).length > 0) {
        settings[actor_http_throttle_1.KEY_HTTP_HOST_LIMITS.name] = throttle.hosts;
    }
    const countCaps = countCapLimits(values['count-cap']);
    if (countCaps.default !== undefined) {
        settings[actor_query_source_identify_hypermedia_sparql_bounded_1.KEY_SPARQL_COUNT_CAP.name] = countCaps.default;
    }
    if (Object.keys(countCaps.hosts).length > 0) {
        settings[actor_query_source_identify_hypermedia_sparql_bounded_1.KEY_SPARQL_COUNT_CAP_HOSTS.name] = countCaps.hosts;
    }
    return {
        query,
        sources,
        out: values.out,
        format: values.format,
        receipt: values.receipt,
        budget,
        maxConnections,
        throttle,
        countCaps,
        settings,
    };
}
/** `--count-cap` values: a bare number is the cap for every endpoint, `host=n` one host's. */
function countCapLimits(values) {
    const caps = { hosts: {} };
    for (const value of values ?? []) {
        const at = value.lastIndexOf('=');
        if (at < 0) {
            caps.default = integer('--count-cap', value);
        }
        else if (at === 0) {
            throw new UsageError(`--count-cap needs a host before '=', not '${value}'`);
        }
        else {
            caps.hosts[value.slice(0, at)] = integer(`--count-cap ${value.slice(0, at)}`, value.slice(at + 1));
        }
    }
    return caps;
}
/**
 * `--max-in-flight` values: a bare number is the cap for every host, `host=n` caps one host.
 * `--max-rate` values are always `host=n`, in requests started per second.
 */
function throttleLimits(inFlight, rates, fallback) {
    const throttle = { inFlight: fallback, hosts: {} };
    const host = (option, value, at) => {
        if (at === 0) {
            throw new UsageError(`${option} needs a host before '=', not '${value}'`);
        }
        const name = value.slice(0, at);
        throttle.hosts[name] ??= {};
        return name;
    };
    for (const value of inFlight ?? []) {
        const at = value.lastIndexOf('=');
        if (at < 0) {
            throttle.inFlight = integer('--max-in-flight', value);
        }
        else {
            const name = host('--max-in-flight', value, at);
            throttle.hosts[name].inFlight = integer(`--max-in-flight ${name}`, value.slice(at + 1));
        }
    }
    for (const value of rates ?? []) {
        const at = value.lastIndexOf('=');
        if (at < 0) {
            throw new UsageError(`--max-rate takes host=n, not '${value}'`);
        }
        const name = host('--max-rate', value, at);
        const rate = Number(value.slice(at + 1));
        if (!Number.isFinite(rate) || rate <= 0) {
            throw new UsageError(`--max-rate ${name} must be a positive number of requests a second, not '${value.slice(at + 1)}'`);
        }
        throttle.hosts[name].perSecond = rate;
    }
    return throttle;
}
function integer(name, value, minimum = 1) {
    if (value === undefined) {
        return undefined;
    }
    const parsed = Number(value);
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum) {
        throw new UsageError(`${name} must be an integer of at least ${minimum}, not '${value}'`);
    }
    return parsed;
}
function byteCount(name, value) {
    if (value === undefined) {
        return undefined;
    }
    const match = /^(\d+)([kmg])?$/iu.exec(value);
    if (!match || Number(match[1]) < 1) {
        throw new UsageError(`${name} must be a positive byte count, optionally with a k, M, or G suffix, not '${value}'`);
    }
    const scale = { k: 1_024, m: 1_024 ** 2, g: 1_024 ** 3 };
    return Number(match[1]) * (match[2] ? scale[match[2].toLowerCase()] : 1);
}
function seconds(name, value) {
    if (value === undefined) {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new UsageError(`${name} must be a positive number of seconds, not '${value}'`);
    }
    return parsed;
}
async function run(parsed, options, stderr) {
    const started = new Date();
    // A fetch supplied by the caller (tests) is used as is; the real transport is pooled and capped.
    const transport = options.fetch ? undefined : (0, Transport_1.createPooledFetch)(parsed.maxConnections);
    const account = new Budget_1.RunAccount(parsed.budget, options.fetch ?? transport.fetch);
    const onFatal = () => account.fail(toError(options.fatal?.reason));
    options.fatal?.addEventListener('abort', onFatal, { once: true });
    if (options.fatal?.aborted) {
        onFatal();
    }
    const sources = parsed.sources.map(spec => ({ kind: spec.kind, url: spec.url }));
    let outcome = { contract: 'error', rows: 0 };
    let output = null;
    let code = exports.EXIT_ERROR;
    let sink;
    let settled = false;
    // If the engine leaves a promise pending with nothing else to do, the event loop drains and
    // Node exits 0 before the finally below runs. Comunica does that on some failures (a property
    // path over brTPF, at the time of writing). The receipt must still be written, and the
    // status must still say the run did not complete.
    const onDrain = () => {
        if (settled) {
            return;
        }
        const stall = 'The engine stopped without ending the run';
        outcome = account.exceeded ?
            { ...outcome, contract: 'aborted', rows: account.rows, budget: account.exceeded, error: stall } :
            { ...outcome, contract: 'error', rows: account.rows, error: `${stall}${account.failure ? `: ${brief(account.failure)}` : ''}` };
        code = account.exceeded ? exports.EXIT_ABORTED : exports.EXIT_ERROR;
        stderr(`${outcome.error}\n`);
        if (parsed.receipt) {
            (0, Receipt_1.writeReceipt)(parsed.receipt, receipt(parsed, sources, outcome, output, account, started, new Date()));
        }
        process.exitCode = code;
    };
    process.once('beforeExit', onDrain);
    try {
        sink = await Output_1.FileSink.open(parsed.out);
        account.startClock();
        // The receipt names the release the engine reads, resolved through the dataset descriptor
        // with the same counting fetch, so the request appears in the receipt like any other.
        for (const [index, spec] of parsed.sources.entries()) {
            if (spec.kind === 'kgf') {
                sources[index] = await (0, Sources_1.describeKgfSource)(spec.url, account.fetch);
            }
        }
        const context = {
            sources: sources.map(source => ({ type: source.kind, value: source.url })),
            [context_entries_1.KeysHttp.fetch.name]: account.fetch,
            ...parsed.settings,
        };
        const engine = new QueryEngine_1.QueryEngine();
        const result = await engine.query(parsed.query, context);
        outcome.result_type = result.resultType;
        if (result.resultType === 'void') {
            throw new Error('Update requests are not run; SELECT, ASK, CONSTRUCT, and DESCRIBE queries are');
        }
        const mediaType = (0, Output_1.mediaTypeFor)(parsed.format, result.resultType);
        output = { path: parsed.out, format: mediaType };
        const counted = await countRows(result, account);
        if (counted.resultType === 'bindings') {
            output.variables = (await counted.metadata()).variables.map(variable => variable.value);
        }
        // The engine's own serializers write every format; only the rows pass through the budget.
        let data;
        try {
            ({ data } = await engine.resultToString(counted, mediaType, resultContext(result) ?? context));
        }
        catch (error) {
            const cause = toError(error);
            if (!/none of the configured actors were able to serialize/u.test(cause.message)) {
                throw cause;
            }
            throw new UsageError(`Cannot write a ${result.resultType} result as ${mediaType}; ` +
                `use one of ${Object.keys(Output_1.FORMATS).join(', ')} or a media type the engine serializes for it`);
        }
        await (0, Output_1.pump)(data, sink, account);
        if (account.exceeded === 'max_rows') {
            // The document above is complete as written; stop whatever the plan still has in flight.
            account.abort('max_rows', `${account.rows} rows written`);
        }
        if (account.exceeded) {
            code = exports.EXIT_ABORTED;
        }
        else if (account.failure) {
            throw account.failure;
        }
        else {
            outcome = { ...outcome, contract: 'complete', rows: account.rows };
            code = exports.EXIT_COMPLETE;
        }
    }
    catch (error) {
        if (account.exceeded) {
            code = exports.EXIT_ABORTED;
        }
        else {
            const cause = account.failure ?? toError(error);
            outcome = { ...outcome, contract: 'error', rows: account.rows, error: brief(cause) };
            code = cause instanceof UsageError ? exports.EXIT_USAGE : exports.EXIT_ERROR;
            stderr(`${cause.message}\n`);
        }
    }
    finally {
        settled = true;
        process.removeListener('beforeExit', onDrain);
        account.stopClock();
        options.fatal?.removeEventListener('abort', onFatal);
        if (account.exceeded) {
            outcome = { ...outcome, contract: 'aborted', rows: account.rows, budget: account.exceeded };
            stderr(`${account.signal.aborted ? toError(account.signal.reason).message : `Aborted at ${account.exceeded}`}\n`);
        }
        try {
            await sink?.close();
        }
        catch (error) {
            if (code === exports.EXIT_COMPLETE) {
                outcome = { ...outcome, contract: 'error', error: `Output was not flushed: ${toError(error).message}` };
                code = exports.EXIT_ERROR;
                stderr(`${outcome.error}\n`);
            }
        }
        if (parsed.receipt) {
            (0, Receipt_1.writeReceipt)(parsed.receipt, receipt(parsed, sources, outcome, output, account, started, new Date()));
        }
        await transport?.close();
    }
    return code;
}
/**
 * The result as the serializer will see it, with every row passing through the account first.
 * Bindings metadata is read once: the engine's own `metadata()` rewrites its variable list in
 * place on every call, so a second reading would hand the serializer nothing usable.
 */
async function countRows(result, account) {
    switch (result.resultType) {
        case 'bindings': {
            const metadata = await result.metadata();
            return {
                ...result,
                execute: async () => new Output_1.BudgetIterator(await result.execute(), account),
                metadata: async () => Object.assign({}, metadata),
            };
        }
        case 'quads':
            return { ...result, execute: async () => new Output_1.BudgetIterator(await result.execute(), account) };
        case 'boolean':
            return {
                ...result,
                execute: async () => {
                    const value = await result.execute();
                    account.countRow();
                    return value;
                },
            };
        default:
            return result;
    }
}
/** The preprocessed context the engine attached to its result, which its serializers expect. */
function resultContext(result) {
    return result.context;
}
function receipt(parsed, sources, outcome, output, account, started, finished) {
    return {
        schema: Receipt_1.RECEIPT_SCHEMA,
        query: parsed.query,
        sources,
        outcome,
        output,
        requests: account.requests,
        totals: {
            requests: account.requests.length,
            bindings_requests: account.requests.filter(request => request.bindings).length,
            bytes: account.bytes,
            elapsed_ms: finished.getTime() - started.getTime(),
        },
        statistics: {
            void: parsed.settings[actor_query_source_identify_kgf_1.KEY_KGF_VOID_STATISTICS.name] !== false,
            schema_requests: account.requests.filter(request => pathOf(request.url).endsWith('/schema')).length,
        },
        budget: {
            max_requests: parsed.budget.maxRequests ?? null,
            max_bytes: parsed.budget.maxBytes ?? null,
            max_rows: parsed.budget.maxRows ?? null,
            timeout_s: parsed.budget.timeoutSeconds ?? null,
            max_connections: parsed.maxConnections,
            max_in_flight: parsed.throttle.inFlight,
            max_in_flight_hosts: Object.fromEntries(Object.entries(parsed.throttle.hosts)
                .filter(([, limits]) => limits.inFlight !== undefined).map(([name, limits]) => [name, limits.inFlight])),
            max_rate_hosts: Object.fromEntries(Object.entries(parsed.throttle.hosts)
                .filter(([, limits]) => limits.perSecond !== undefined).map(([name, limits]) => [name, limits.perSecond])),
            sparql_count_cap: parsed.countCaps.default ?? null,
            sparql_count_cap_hosts: parsed.countCaps.hosts,
        },
        engine: { kgf_sparql: packageJson.version, comunica: comunicaJson.version, node: process.version },
        started: started.toISOString(),
        finished: finished.toISOString(),
    };
}
function pathOf(url) {
    try {
        return new URL(url).pathname;
    }
    catch {
        return url;
    }
}
function toError(value) {
    return value instanceof Error ? value : new Error(String(value));
}
/** An error's message, cut where a server's whole error page would otherwise follow. */
function brief(error) {
    const message = error.message.trim();
    return message.length > 1_000 ? `${message.slice(0, 1_000)}…` : message;
}
//# sourceMappingURL=main.js.map