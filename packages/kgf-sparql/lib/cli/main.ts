import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import { KeysHttp } from '@comunica/context-entries';
import type { IActionContext, QueryType } from '@comunica/types';
import {
  KEY_KGF_BINDINGS_SIZE,
  KEY_KGF_HTTP_METHOD,
  KEY_KGF_PAGE_SIZE,
  KEY_KGF_VOID_STATISTICS,
} from '@kgf/actor-query-source-identify-kgf';
import { QueryEngine } from '../QueryEngine';
import type { IBudget } from './Budget';
import { RunAccount } from './Budget';
import { BudgetIterator, FORMATS, FileSink, mediaTypeFor, pump } from './Output';
import type { IReceipt, IReceiptOutcome, IReceiptOutput, IReceiptSource } from './Receipt';
import { RECEIPT_SCHEMA, writeReceipt } from './Receipt';
import type { ISourceSpec } from './Sources';
import { describeKgfSource, parseSource } from './Sources';
import { createPooledFetch } from './Transport';

// eslint-disable-next-line ts/no-require-imports,ts/no-var-requires,import/extensions
const packageJson: { version: string } = require('../../package.json');
// eslint-disable-next-line ts/no-require-imports,ts/no-var-requires,import/extensions
const comunicaJson: { version: string } = require('@comunica/query-sparql/package.json');

/** The run returned exactly the solution set the query denotes. */
export const EXIT_COMPLETE = 0;
/** The query or a source was wrong, or the process failed. */
export const EXIT_ERROR = 1;
/** The command line was wrong. */
export const EXIT_USAGE = 2;
/** A budget ended the run; the receipt says which. */
export const EXIT_ABORTED = 3;

/** Concurrent connections per origin unless `--max-connections` says otherwise: well under the bursts that fail. */
export const DEFAULT_MAX_CONNECTIONS = 32;

export const USAGE = `Usage: kgf-sparql (-q <query> | -f <file>) --source <kind@url>... --out <file> [options]

Runs one SPARQL query to completion, or fails, and accounts for every request it made.

  -q, --query <sparql>      Query text
  -f, --file <path>         Query file; '-' reads standard input
      --source <kind@url>   A source, repeatable: kgf@<fragment-or-dataset-url>, sparql@<endpoint-url>
      --out <path>          Results file (required: results never go to a pipe)
      --format <name>       ${Object.keys(FORMATS).join(', ')}, or a media type the engine serializes;
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
      --http-retries <n>    Retry 429, 502, 503, and 504 responses up to n times (default 0)
      --max-connections <n> Cap concurrent connections per origin (default ${DEFAULT_MAX_CONNECTIONS})
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
  help: { type: 'boolean', short: 'h' },
} as const;

class UsageError extends Error {
  public override readonly name = 'UsageError';
}

interface IParsedArguments {
  query: string;
  sources: ISourceSpec[];
  out: string;
  format?: string;
  receipt?: string;
  budget: IBudget;
  /** Cap on concurrent connections per origin. Not an abort budget; it bounds the run's load. */
  maxConnections: number;
  settings: Record<string, unknown>;
}

export interface IRunOptions {
  /** The fetch to count, the global one by default. Tests pass a fake. */
  fetch?: typeof fetch;
  /** Aborting this signal fails the run with its reason; the process entry point wires fatal errors and signals to it. */
  fatal?: AbortSignal;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** Runs the command line and returns its exit status. Files are closed and the receipt written before it returns. */
export async function runCli(argv: string[], options: IRunOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string): void => void process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string): void => void process.stderr.write(text));
  let parsed: IParsedArguments;
  try {
    const result = parseArguments(argv);
    if (result === 'help') {
      stdout(USAGE);
      return EXIT_COMPLETE;
    }
    parsed = result;
  } catch (error: unknown) {
    stderr(`${toError(error).message}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  return run(parsed, options, stderr);
}

/** The process entry point: fatal errors and signals end the run through the receipt, not around it. */
export function main(): void {
  const fatal = new AbortController();
  const fail = (reason: unknown): void => fatal.abort(toError(reason));
  process.on('unhandledRejection', fail);
  process.on('uncaughtException', fail);
  for (const signal of [ 'SIGINT', 'SIGTERM' ] as const) {
    process.once(signal, () => fail(new Error(`Interrupted by ${signal}`)));
  }
  runCli(process.argv.slice(2), { fatal: fatal.signal }).then(
    code => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${toError(error).message}\n`);
      process.exit(EXIT_ERROR);
    },
  );
}

function parseArguments(argv: string[]): IParsedArguments | 'help' {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true }));
  } catch (error: unknown) {
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
      query = fs.readFileSync(values.file === '-' ? 0 : values.file!, 'utf8');
    } catch (error: unknown) {
      throw new UsageError(`Cannot read query file '${values.file}': ${toError(error).message}`);
    }
  }
  if (!values.source?.length) {
    throw new UsageError('At least one --source <kind@url> is required');
  }
  const sources = values.source.map((argument) => {
    try {
      return parseSource(argument);
    } catch (error: unknown) {
      throw new UsageError(toError(error).message);
    }
  });
  if (!values.out) {
    throw new UsageError('--out <file> is required: results go to a file, never to a pipe');
  }
  if (values.format !== undefined && !values.format.trim()) {
    throw new UsageError(`--format must name one of ${Object.keys(FORMATS).join(', ')} or a media type`);
  }
  const budget: IBudget = {
    maxRequests: integer('--max-requests', values['max-requests']),
    maxBytes: byteCount('--max-bytes', values['max-bytes']),
    maxRows: integer('--max-rows', values['max-rows']),
    timeoutSeconds: seconds('--timeout', values.timeout),
  };
  const settings: Record<string, unknown> = {};
  if (values['http-method'] !== undefined) {
    const method = values['http-method'].toUpperCase();
    if (method !== 'QUERY' && method !== 'POST') {
      throw new UsageError(`--http-method must be QUERY or POST, not '${values['http-method']}'`);
    }
    settings[KEY_KGF_HTTP_METHOD.name] = method;
  }
  if (values['page-size'] !== undefined) {
    settings[KEY_KGF_PAGE_SIZE.name] = integer('--page-size', values['page-size']);
  }
  if (values['bindings-size'] !== undefined) {
    settings[KEY_KGF_BINDINGS_SIZE.name] = integer('--bindings-size', values['bindings-size']);
  }
  if (values['no-void-statistics']) {
    settings[KEY_KGF_VOID_STATISTICS.name] = false;
  }
  const retries = integer('--http-retries', values['http-retries'], 0);
  if (retries) {
    settings[KeysHttp.httpRetryCount.name] = retries;
    // Comunica retries 429, 503, and 504 on its own, honouring Retry-After; 502 needs forcing.
    settings[KeysHttp.httpRetryStatusCodes.name] = [ 502 ];
    settings[KeysHttp.httpRetryDelayFallback.name] = 250;
  }
  const maxConnections = integer('--max-connections', values['max-connections']) ?? DEFAULT_MAX_CONNECTIONS;
  return { query, sources, out: values.out, format: values.format, receipt: values.receipt, budget, maxConnections, settings };
}

function integer(name: string, value: string | undefined, minimum = 1): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new UsageError(`${name} must be an integer of at least ${minimum}, not '${value}'`);
  }
  return parsed;
}

function byteCount(name: string, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(\d+)([kmg])?$/iu.exec(value);
  if (!match || Number(match[1]) < 1) {
    throw new UsageError(`${name} must be a positive byte count, optionally with a k, M, or G suffix, not '${value}'`);
  }
  const scale: Record<string, number> = { k: 1_024, m: 1_024 ** 2, g: 1_024 ** 3 };
  return Number(match[1]) * (match[2] ? scale[match[2].toLowerCase()] : 1);
}

function seconds(name: string, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`${name} must be a positive number of seconds, not '${value}'`);
  }
  return parsed;
}

async function run(parsed: IParsedArguments, options: IRunOptions, stderr: (text: string) => void): Promise<number> {
  const started = new Date();
  // A fetch supplied by the caller (tests) is used as is; the real transport is pooled and capped.
  const transport = options.fetch ? undefined : createPooledFetch(parsed.maxConnections);
  const account = new RunAccount(parsed.budget, options.fetch ?? transport!.fetch);
  const onFatal = (): void => account.fail(toError(options.fatal?.reason));
  options.fatal?.addEventListener('abort', onFatal, { once: true });
  if (options.fatal?.aborted) {
    onFatal();
  }
  const sources: IReceiptSource[] = parsed.sources.map(spec => ({ kind: spec.kind, url: spec.url }));
  let outcome: IReceiptOutcome = { contract: 'error', rows: 0 };
  let output: IReceiptOutput | null = null;
  let code = EXIT_ERROR;
  let sink: FileSink | undefined;
  let settled = false;
  // If the engine leaves a promise pending with nothing else to do, the event loop drains and
  // Node exits 0 before the finally below runs. Comunica does that on some failures (a property
  // path over brTPF, at the time of writing). The receipt must still be written, and the
  // status must still say the run did not complete.
  const onDrain = (): void => {
    if (settled) {
      return;
    }
    const stall = 'The engine stopped without ending the run';
    outcome = account.exceeded ?
      { ...outcome, contract: 'aborted', rows: account.rows, budget: account.exceeded, error: stall } :
      { ...outcome, contract: 'error', rows: account.rows, error: `${stall}${account.failure ? `: ${brief(account.failure)}` : ''}` };
    code = account.exceeded ? EXIT_ABORTED : EXIT_ERROR;
    stderr(`${outcome.error}\n`);
    if (parsed.receipt) {
      writeReceipt(parsed.receipt, receipt(parsed, sources, outcome, output, account, started, new Date()));
    }
    process.exitCode = code;
  };
  process.once('beforeExit', onDrain);
  try {
    sink = await FileSink.open(parsed.out);
    account.startClock();
    // The receipt names the release the engine reads, resolved through the dataset descriptor
    // with the same counting fetch, so the request appears in the receipt like any other.
    for (const [ index, spec ] of parsed.sources.entries()) {
      if (spec.kind === 'kgf') {
        sources[index] = await describeKgfSource(spec.url, account.fetch);
      }
    }
    const context = {
      sources: sources.map(source => ({ type: source.kind, value: source.url })),
      [KeysHttp.fetch.name]: account.fetch,
      ...parsed.settings,
    };
    const engine = new QueryEngine();
    const result = await engine.query(parsed.query, context);
    outcome.result_type = result.resultType;
    if (result.resultType === 'void') {
      throw new Error('Update requests are not run; SELECT, ASK, CONSTRUCT, and DESCRIBE queries are');
    }
    const mediaType = mediaTypeFor(parsed.format, result.resultType);
    output = { path: parsed.out, format: mediaType };
    const counted = await countRows(result, account);
    if (counted.resultType === 'bindings') {
      output.variables = (await counted.metadata()).variables.map(variable => variable.value);
    }
    // The engine's own serializers write every format; only the rows pass through the budget.
    let data: NodeJS.ReadableStream;
    try {
      ({ data } = await engine.resultToString(counted, mediaType, resultContext(result) ?? context));
    } catch (error: unknown) {
      const cause = toError(error);
      if (!/none of the configured actors were able to serialize/u.test(cause.message)) {
        throw cause;
      }
      throw new UsageError(`Cannot write a ${result.resultType} result as ${mediaType}; ` +
        `use one of ${Object.keys(FORMATS).join(', ')} or a media type the engine serializes for it`);
    }
    await pump(data, sink, account);
    if (account.exceeded === 'max_rows') {
      // The document above is complete as written; stop whatever the plan still has in flight.
      account.abort('max_rows', `${account.rows} rows written`);
    }
    if (account.exceeded) {
      code = EXIT_ABORTED;
    } else if (account.failure) {
      throw account.failure;
    } else {
      outcome = { ...outcome, contract: 'complete', rows: account.rows };
      code = EXIT_COMPLETE;
    }
  } catch (error: unknown) {
    if (account.exceeded) {
      code = EXIT_ABORTED;
    } else {
      const cause = account.failure ?? toError(error);
      outcome = { ...outcome, contract: 'error', rows: account.rows, error: brief(cause) };
      code = cause instanceof UsageError ? EXIT_USAGE : EXIT_ERROR;
      stderr(`${cause.message}\n`);
    }
  } finally {
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
    } catch (error: unknown) {
      if (code === EXIT_COMPLETE) {
        outcome = { ...outcome, contract: 'error', error: `Output was not flushed: ${toError(error).message}` };
        code = EXIT_ERROR;
        stderr(`${outcome.error}\n`);
      }
    }
    if (parsed.receipt) {
      writeReceipt(parsed.receipt, receipt(parsed, sources, outcome, output, account, started, new Date()));
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
async function countRows(result: QueryType, account: RunAccount): Promise<QueryType> {
  switch (result.resultType) {
    case 'bindings': {
      const metadata = await result.metadata();
      return <QueryType> <unknown> {
        ...result,
        execute: async() => new BudgetIterator(await result.execute(), account),
        metadata: async() => Object.assign({}, metadata),
      };
    }
    case 'quads':
      return { ...result, execute: async() => new BudgetIterator(await result.execute(), account) };
    case 'boolean':
      return {
        ...result,
        execute: async() => {
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
function resultContext(result: QueryType): IActionContext | undefined {
  return (<{ context?: IActionContext }> result).context;
}

function receipt(
  parsed: IParsedArguments,
  sources: IReceiptSource[],
  outcome: IReceiptOutcome,
  output: IReceiptOutput | null,
  account: RunAccount,
  started: Date,
  finished: Date,
): IReceipt {
  return {
    schema: RECEIPT_SCHEMA,
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
      void: parsed.settings[KEY_KGF_VOID_STATISTICS.name] !== false,
      schema_requests: account.requests.filter(request => pathOf(request.url).endsWith('/schema')).length,
    },
    budget: {
      max_requests: parsed.budget.maxRequests ?? null,
      max_bytes: parsed.budget.maxBytes ?? null,
      max_rows: parsed.budget.maxRows ?? null,
      timeout_s: parsed.budget.timeoutSeconds ?? null,
      max_connections: parsed.maxConnections,
    },
    engine: { kgf_sparql: packageJson.version, comunica: comunicaJson.version, node: process.version },
    started: started.toISOString(),
    finished: finished.toISOString(),
  };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** An error's message, cut where a server's whole error page would otherwise follow. */
function brief(error: Error): string {
  const message = error.message.trim();
  return message.length > 1_000 ? `${message.slice(0, 1_000)}…` : message;
}
