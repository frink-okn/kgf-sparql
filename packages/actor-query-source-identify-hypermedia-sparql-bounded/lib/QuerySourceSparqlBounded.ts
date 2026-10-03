import { QuerySourceSparql } from '@comunica/actor-query-source-identify-hypermedia-sparql';
import { ActionContextKey } from '@comunica/core';
import type {
  BindingsStream,
  ComunicaDataFactory,
  IActionContext,
  IQueryBindingsOptions,
  MetadataBindings,
} from '@comunica/types';
import type { AlgebraFactory } from '@comunica/utils-algebra';
import { Algebra, algebraUtils, isKnownOperation } from '@comunica/utils-algebra';
import { MetadataValidationState } from '@comunica/utils-metadata';
import type { IHttpAttemptListener } from '@frink-okn/actor-http-throttle';
import { KEY_HTTP_ATTEMPT_LISTENER } from '@frink-okn/actor-http-throttle';
import type { AsyncIterator } from 'asynciterator';

/** Set on the context of a call that carries bindings, whose cardinality is not counted. */
const KEY_BOUND = new ActionContextKey<boolean>('@frink-okn/actor-query-source-identify-hypermedia-sparql-bounded:bound');

/**
 * Comunica's SPARQL endpoint source, with two changes to the COUNT query it sends for each
 * operation's cardinality.
 *
 * ## The count is bounded
 *
 * `SELECT (COUNT(*) AS ?count) WHERE { SELECT * WHERE { … } LIMIT cap+1 }`, so the endpoint
 * can stop at the cap. A count under it is exact; one that reaches it is reported as an
 * estimate of cap+1, a lower bound. The cap is the one the call's context gives the endpoint:
 * Comunica keeps an identified source for later queries, and a cap fixed when the source was
 * identified held for every query after the first, whatever their contexts said. A planner
 * needs to know which side of a join is small, not how large a large side is: on QLever's Wikidata endpoint,
 * counting every `rdfs:label` took 4.4 s, while counting up to 1,000,000 of them took 28 ms
 * and up to 10,000,000 took 79 ms.
 *
 * ## The count is timed by the server
 *
 * Comunica gives a COUNT `countTimeout` (3 s) from the moment it asks, and then reports the
 * cardinality as unknown (an infinite estimate), which made one query's plan differ from run
 * to run: time spent queued behind a host's other requests, or waiting to retry a refusal,
 * counted against the server. Here the timeout runs only while an attempt is with the server,
 * from when `@frink-okn/actor-http-throttle` sends it until its count arrives, body included, and
 * restarts with each attempt; the time a refused attempt waits to be sent again does not
 * count. `deadline` bounds the whole wait, queue included. (An earlier version stopped the
 * timer when the response headers arrived, and a server that sends them before it has counted
 * then had the whole deadline.)
 *
 * ## The metadata says what a request costs
 *
 * Comunica's SPARQL source reports no `requestTime`, so a join's cost model charges nothing
 * for each request to an endpoint, and a bind join that sends one per row looks as cheap as
 * one that sends a block of rows at a time. With uncapped counts the difference was hidden by
 * accident, since large counts timed out to an unknown size; with every count answered, the
 * two came out equal but for the block held, and the per-row join won. The time the COUNT
 * spent with the server until its count arrived is the metadata's `requestTime`. A count
 * already known, or one that timed out or failed, takes the time of this source's last answered
 * COUNT: a timed-out one took as long as it was let, and once stood for every later request to
 * the endpoint, charging each probe 3 s.
 *
 * ## Bindings are not counted
 *
 * A call that carries bindings, sent as `VALUES`, is a bind join's probe, and Comunica counts
 * it before selecting, so each block of bindings cost the endpoint two requests. Nothing reads
 * that count: the bind joins that send blocks take their cardinality from their own entries,
 * and the COUNT, which carries the block, never matches a cached one. Such a call reports an
 * unknown cardinality, as Comunica's source does with count queries turned off.
 */
export class QuerySourceSparqlBounded extends QuerySourceSparql {
  private readonly capFor: (context: IActionContext) => number;
  private readonly attemptTimeout: number;
  private readonly endpoint: string;
  private readonly countDataFactory: ComunicaDataFactory;
  private readonly countAlgebraFactory: AlgebraFactory;
  /** The cap for a COUNT built with no call's context: the one the source was identified with. */
  private readonly identifiedCap: number;
  /** Each COUNT's cap, by the copy of its operation that `attachMetadata` hands Comunica. */
  private readonly caps = new WeakMap<Algebra.Operation, number>();
  /** Milliseconds this source's last COUNT spent with the server. */
  private lastRequestTime?: number;

  /**
   * @param capFor The cap on a COUNT sent with the given context; `Infinity` for none.
   * @param attemptTimeout Milliseconds a COUNT attempt may spend with the server.
   * @param args Comunica's `QuerySourceSparql` arguments.
   */
  public constructor(
    capFor: (context: IActionContext) => number,
    attemptTimeout: number,
    ...args: ConstructorParameters<typeof QuerySourceSparql>
  ) {
    super(...args);
    this.capFor = capFor;
    this.attemptTimeout = attemptTimeout;
    this.endpoint = args[0];
    this.countDataFactory = args[6];
    this.countAlgebraFactory = args[7];
    this.identifiedCap = capFor(args[2]);
  }

  public override queryBindings(
    operation: Algebra.Operation,
    context: IActionContext,
    options?: IQueryBindingsOptions,
  ): BindingsStream {
    return super.queryBindings(operation, options?.joinBindings ? context.set(KEY_BOUND, true) : context, options);
  }

  /**
   * The COUNT for an operation, bounded at its call's cap. A pattern's variables are renamed,
   * as Comunica renames them, so that its count is cached whatever its variables are called;
   * its graph is kept, which Comunica's drops, counting a `GRAPH` pattern in the default graph.
   */
  public override async operationToNormalizedCountQuery(operation: Algebra.Operation): Promise<string> {
    const cap = this.caps.get(operation) ?? this.identifiedCap;
    const df = this.countDataFactory;
    const af = this.countAlgebraFactory;
    const normalized = isKnownOperation(operation, Algebra.Types.PATTERN) ? this.normalize(operation) : operation;
    if (!Number.isFinite(cap)) {
      return await this.operationToCountQuery(df, af, normalized);
    }
    const bounded = af.createSlice(af.createProject(normalized, algebraUtils.inScopeVariables(normalized)), 0, cap + 1);
    return await this.operationToCountQuery(df, af, bounded);
  }

  /**
   * A pattern with each variable renamed for the first position it fills (`s`, `p`, `o`, `g`),
   * so that a repeated variable stays repeated: `?x <p> ?x` is counted as `?s <p> ?s`. Comunica
   * renames each position apart, and counted every `<p>` statement as that pattern's exact
   * size. A pattern with a quoted triple is kept as it is: the variables inside it are not
   * renamed, and the new names could meet them.
   */
  private normalize(pattern: Algebra.Pattern): Algebra.Pattern {
    const terms = [ pattern.subject, pattern.predicate, pattern.object, pattern.graph ];
    if (terms.some(term => term.termType === 'Quad')) {
      return pattern;
    }
    const renamed = new Map<string, ReturnType<ComunicaDataFactory['variable']>>();
    const [ subject, predicate, object, graph ] = terms.map((term, position) => {
      if (term.termType !== 'Variable') {
        return term;
      }
      let variable = renamed.get(term.value);
      if (!variable) {
        variable = this.countDataFactory.variable('spog'[position]);
        renamed.set(term.value, variable);
      }
      return variable;
    });
    return this.countAlgebraFactory.createPattern(subject, predicate, object, graph);
  }

  protected override attachMetadata(
    target: AsyncIterator<any>,
    context: IActionContext,
    operationPromise: Promise<Algebra.Operation>,
  ): void {
    const cap = this.capFor(context);
    let written = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** When the attempt with the server now was sent, if one is. */
    let sentAt: number | undefined;
    /**
     * Writes the metadata once. Only a count the server answered times a request: one that
     * timed out or failed took as long as it was let, and the time of a refused attempt is the
     * refusal's, so the source's last answered COUNT's time stands for them.
     */
    const write = (metadata: MetadataBindings): void => {
      if (!written) {
        written = true;
        clearTimeout(timer);
        if (sentAt !== undefined && Number.isFinite(metadata.cardinality.value)) {
          this.lastRequestTime = Date.now() - sentAt;
        }
        const time = this.lastRequestTime;
        target.setProperty('metadata', QuerySourceSparqlBounded.bound(
          time === undefined ? metadata : { ...metadata, requestTime: time },
          cap,
        ));
      }
    };
    // The cardinality is unknown, as Comunica reports a COUNT that timed out. It is written
    // even when the operation cannot be built, without variables, as Comunica writes it then:
    // whatever waits on the metadata would otherwise wait for good.
    const unknown = async(): Promise<void> => {
      let variables: MetadataBindings['variables'] = [];
      try {
        const operation = await operationPromise;
        const undefs = QuerySourceSparql.getOperationUndefs(operation);
        variables = algebraUtils.inScopeVariables(operation).map(variable => ({
          variable,
          canBeUndef: undefs.some(undef => undef.equals(variable)),
        }));
      } catch {
        // The stream reports the error itself.
      }
      write({
        state: new MetadataValidationState(),
        cardinality: { type: 'estimate', value: Number.POSITIVE_INFINITY, dataset: this.endpoint },
        variables,
      });
    };
    if (context.get(KEY_BOUND)) {
      void unknown();
      return;
    }
    const listener: IHttpAttemptListener = {
      sent: () => {
        clearTimeout(timer);
        sentAt = Date.now();
        // Past this the server took too long on this attempt. The COUNT itself carries on,
        // and its answer is cached.
        timer = setTimeout(() => void unknown(), this.attemptTimeout);
      },
      // The headers are not the count: a server may send them before it has counted, so the
      // timer runs on until the count arrives.
      settled: () => undefined,
      // A refused attempt is over; the wait for the next one is not the server's time.
      retrying: () => {
        clearTimeout(timer);
        timer = undefined;
        sentAt = undefined;
      },
    };
    const metadataOnly = <AsyncIterator<any>> <unknown> {
      setProperty: (name: string, value: unknown): void => {
        if (name === 'metadata') {
          write(<MetadataBindings> value);
        } else {
          target.setProperty(name, value);
        }
      },
    };
    // Comunica builds the COUNT from the operation alone, so a copy of it, for this call only,
    // carries the call's cap there. The copy keeps the prototype: a pattern is an RDF/JS quad.
    const counted = operationPromise.then((operation) => {
      const copy: Algebra.Operation = Object.assign(Object.create(Object.getPrototypeOf(operation)), operation);
      this.caps.set(copy, cap);
      return copy;
    });
    super.attachMetadata(metadataOnly, context.set(KEY_HTTP_ATTEMPT_LISTENER, listener), counted);
  }

  /** A count that reached the cap is an estimate, a lower bound, not an exact count. */
  private static bound(metadata: MetadataBindings, cap: number): MetadataBindings {
    const { cardinality } = metadata;
    if (cardinality.type !== 'exact' || cardinality.value <= cap) {
      return metadata;
    }
    return { ...metadata, cardinality: { ...cardinality, type: 'estimate' }};
  }
}
