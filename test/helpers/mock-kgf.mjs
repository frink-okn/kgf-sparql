// A small, deterministic KGF server model shared by the unit tests. It preserves the
// native per-input-row bag semantics, answers with the headers the real server sends
// (request id, completeness, truncation reason, content length), and can also play a
// SPARQL endpoint at /sparql for tests of explicitly named endpoints.
import assert from 'node:assert/strict';
import { Parser } from 'n3';
import { DataFactory } from 'rdf-data-factory';

export const df = new DataFactory();
export const iri = value => df.namedNode(`urn:${value}`);
export const ORIGIN = 'https://kgf.test';
export const ROOT = `${ORIGIN}/mount/`;
export const EP = `${ORIGIN}/mount/graph/v/1/fragment`;
export const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
export const triples = [
  df.quad(iri('a'), iri('p'), iri('b')),
  df.quad(iri('a'), iri('p'), iri('c')),
  df.quad(iri('b'), iri('p'), iri('c')),
  df.quad(iri('b'), iri('p'), iri('b')),
  df.quad(iri('d'), iri('p'), iri('b')),
  df.quad(iri('a'), iri('label'), df.literal('A\n"quoted" \\ café', 'en')),
  df.quad(iri('b'), iri('label'), df.literal('2', df.namedNode(XSD_INTEGER))),
  df.quad(iri('c'), iri('label'), df.literal('C')),
  df.quad(iri('a'), iri('q'), iri('b')),
];
const positions = ['subject', 'predicate', 'object'];
const wirePositions = ['s', 'p', 'o'];

export const json = (body, status = 200, headers = {}) => {
  const text = JSON.stringify(body);
  return new Response(text, { status, headers: {
    'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers,
  } });
};
export function wire(term) {
  return term.termType === 'NamedNode' ? { type: 'iri', value: term.value } :
    term.termType === 'BlankNode' ? { type: 'bnode', value: term.value } :
      { type: 'literal', value: term.value, ...(term.language ? { lang: term.language } : { datatype: term.datatype.value }) };
}
export function unwire(term) {
  if (term === null || term === undefined || typeof term === 'string' && term.startsWith('?')) return undefined;
  if (typeof term === 'string') return new Parser().parse(`<urn:test:s> <urn:test:p> ${term} .`)[0].object;
  if (term.type === 'iri') return df.namedNode(term.value);
  if (term.type === 'bnode') return df.blankNode(term.value);
  return df.literal(term.value, term.lang ?? (term.datatype ? df.namedNode(term.datatype) : undefined));
}

// A delay that honours the request's abort signal, as a real fetch does.
const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

function sparqlResponse(url, init, respond) {
  const query = url.searchParams.get('query') ?? new URLSearchParams(String(init.body ?? '')).get('query') ?? '';
  const headers = { 'content-type': 'application/sparql-results+json' };
  if (/COUNT\(/iu.test(query)) {
    return respond({ head: { vars: ['count'] }, results: { bindings: [{ count: { type: 'literal', datatype: XSD_INTEGER, value: '1' } }] } }, 200, headers);
  }
  return respond({ head: { vars: ['s', 'o'] }, results: { bindings: [{ s: { type: 'uri', value: 'urn:a' }, o: { type: 'uri', value: 'urn:b' } }] } }, 200, headers);
}

/**
 * Options: caps, maxRequestBytes, queryUnsupported, queryFailure, schemaFailure, countFailure,
 * countEstimateZero, badCursor ('missing' | 'repeat'), datasetStatsOnly, delayMs, origin, and
 * data, the quads to serve in place of `triples`.
 */
export function server(options = {}) {
  const requests = [];
  const data = options.data ?? triples;
  const origin = options.origin ?? ORIGIN;
  const root = `${origin}/mount/`;
  const caps = { max_limit: 2, max_bindings: 2, ...options.caps };
  const fetch = async(input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method ?? 'GET';
    const isJson = typeof init.body === 'string' && init.body.startsWith('{');
    const body = isJson ? JSON.parse(init.body) : undefined;
    const call = { url, method, body, init };
    requests.push(call);
    const respond = (payload, status = 200, headers = {}) =>
      json(payload, status, { 'kgf-request-id': `mock-${String(requests.length).padStart(7, '0')}`, ...headers });
    if (options.delayMs) await delay(options.delayMs, init.signal);
    if (url.pathname === '/sparql') return sparqlResponse(url, init, respond);
    if (options.queryUnsupported && method === 'QUERY') return respond({}, 405);
    if (options.queryFailure && method === 'QUERY') return respond({}, 400);
    if (url.href === root) return respond({ caps, budgets: { max_request_bytes: options.maxRequestBytes ?? 100000 } });
    if (url.pathname === '/mount/graph') {
      return respond({ id: 'graph', current: '1', releases: [
        { version: '1', content_digest: 'sha256:mock', url: '/mount/graph/v/1/', links: { fragment: '/mount/graph/v/1/fragment' } },
      ] });
    }
    if (url.pathname.endsWith('/schema')) {
      if (options.schemaFailure) return respond({}, 503);
      assert.equal(url.searchParams.get('view'), 'queryable');
      assert.equal(url.searchParams.has('children'), false);
      const predicate = unwire(url.searchParams.get('predicate'));
      const selected = data.filter(quad => !predicate || quad.predicate.equals(predicate));
      const counts = { triples: selected.length };
      if (!options.datasetStatsOnly || !predicate) {
        counts.distinct_subjects = new Set(selected.map(quad => quad.subject.value)).size;
        counts.distinct_objects = new Set(selected.map(quad => quad.object.value)).size;
      }
      return respond({ complete: true, node: selected.length ? { counts } : null });
    }
    const pattern = body?.pattern ?? Object.fromEntries(wirePositions.map(key => [key, url.searchParams.get(key)]));
    const inputRows = body?.bindings.rows ?? [undefined];
    if (body) {
      assert.ok(inputRows.length <= caps.max_bindings, 'binding row cap');
      assert.ok(Buffer.byteLength(init.body) <= (options.maxRequestBytes ?? 100000), 'request byte cap');
    }
    const counts = [];
    const rows = [];
    for (const [binding, values] of inputRows.entries()) {
      let matches = 0;
      for (const quad of data) {
        const assignment = new Map();
        const match = positions.every((position, i) => {
          const selector = pattern[wirePositions[i]];
          let term = unwire(selector);
          if (typeof selector === 'string' && selector.startsWith('?')) {
            const index = body.bindings.vars.indexOf(selector);
            if (index >= 0) term = unwire(values[index]);
            if (assignment.has(selector) && !assignment.get(selector).equals(quad[position])) return false;
            assignment.set(selector, quad[position]);
          }
          return !term || term.termType !== 'BlankNode' && term.equals(quad[position]);
        });
        if (!match) continue;
        matches++;
        const row = body ? { binding } : {};
        positions.forEach((position, i) => {
          if (!unwire(pattern[wirePositions[i]])) row[wirePositions[i]] = wire(quad[position]);
        });
        rows.push(row);
      }
      counts.push({ binding, count: { value: matches, exact: true } });
    }
    if (url.pathname.endsWith('/count')) {
      if (options.countFailure) return respond({}, 500);
      if (options.countEstimateZero) return respond({ count: { value: 0, exact: false }, complete: false, next: 'count-more' });
      return respond(body ? { counts, complete: true, next: null } : { count: counts[0].count, complete: true, next: null });
    }
    assert.ok(url.pathname.endsWith('/fragment'), `unexpected endpoint ${url}`);
    const limit = body?.limit ?? Number(url.searchParams.get('limit'));
    assert.ok(limit <= caps.max_limit && limit > 0, 'fragment page cap');
    const cursor = body?.cursor ?? url.searchParams.get('cursor');
    const offset = cursor ? Number(cursor.split(':')[1]) : 0;
    const page = rows.slice(offset, offset + limit);
    const next = offset + page.length < rows.length ? `opaque:${offset + page.length}` : null;
    if (options.badCursor) return respond({ rows: page, complete: false, next: options.badCursor === 'missing' ? null : 'opaque:0' });
    const complete = next === null;
    return respond({ rows: page, complete, next }, 200, {
      'kgf-complete': String(complete), ...(complete ? {} : { 'kgf-truncation-reason': 'page_limit' }),
    });
  };
  return { requests, fetch, http: { mediate: ({ input, init }) => fetch(input, init) } };
}
