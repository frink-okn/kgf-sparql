import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionContext, Bus } from '@comunica/core';
import { ActorHttpThrottle, KEY_HTTP_HOST_LIMITS, KEY_HTTP_IN_FLIGHT } from '@kgf/actor-http-throttle';

const RETRY_COUNT = '@comunica/bus-http:http-retry-count';
const RETRY_STATUS_CODES = '@comunica/bus-http:http-retry-status-codes';
const RETRY_DELAY_LIMIT = '@comunica/bus-http:http-retry-delay-limit';
const STOCK_RETRY_WRAPPED = 'urn:comunica:actor-http-retry#wrapped';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A throttle over a fake transport; `answer(url, call)` gives each response, after `hold` ms. */
function throttle(answer = () => new Response('ok'), { hold = 0, ...args } = {}) {
  const calls = [];
  const open = {};
  const peak = {};
  const mediatorHttp = {
    async mediate(action) {
      const url = new URL(typeof action.input === 'string' ? action.input : action.input.url);
      const call = { url: url.href, host: url.host, at: Date.now(), context: action.context, init: action.init };
      calls.push(call);
      open[url.host] = (open[url.host] ?? 0) + 1;
      peak[url.host] = Math.max(peak[url.host] ?? 0, open[url.host]);
      try {
        await sleep(hold);
        return await answer(url, calls.filter(other => other.host === url.host).length - 1);
      } finally {
        open[url.host]--;
      }
    },
  };
  const actor = new ActorHttpThrottle({ name: 'throttle', bus: new Bus({ name: 'test' }), mediatorHttp, ...args });
  const fetch = (input, settings = {}, init = {}) =>
    actor.run({ input, init, context: new ActionContext(settings) });
  return { actor, calls, peak, fetch };
}

const gaps = calls => calls.slice(1).map((call, i) => call.at - calls[i].at);
const refused = (status = 429, headers = {}, cancelled = { count: 0 }) =>
  new Response(new ReadableStream({ cancel() {
    cancelled.count++;
  } }), { status, headers });

test('requests to one host wait for a place, and another host does not wait for them', async() => {
  const { peak, fetch } = throttle(undefined, { hold: 20 });
  const settings = { [KEY_HTTP_IN_FLIGHT.name]: 2 };
  await Promise.all([
    ...Array.from({ length: 6 }, () => fetch('https://a.example/x', settings)),
    ...Array.from({ length: 2 }, () => fetch('https://b.example/x', settings)),
  ]);
  assert.deepEqual(peak, { 'a.example': 2, 'b.example': 2 });
});

test('a host\'s own limit is found by host and port, or by hostname', async() => {
  const { peak, fetch } = throttle(undefined, { hold: 10 });
  const settings = { [KEY_HTTP_HOST_LIMITS.name]: { 'a.example:8080': { inFlight: 1 }, 'b.example': { inFlight: 1 }}};
  await Promise.all([
    ...Array.from({ length: 3 }, () => fetch('http://a.example:8080/x', settings)),
    ...Array.from({ length: 3 }, () => fetch('http://b.example:9000/x', settings)),
    ...Array.from({ length: 3 }, () => fetch('http://c.example/x', settings)),
  ]);
  assert.deepEqual(peak, { 'a.example:8080': 1, 'b.example:9000': 1, 'c.example': 3 });
});

test('a configured rate spaces the starts', async() => {
  const { calls, fetch } = throttle();
  const settings = { [KEY_HTTP_HOST_LIMITS.name]: { 'q.example': { perSecond: 20 }}};
  await Promise.all(Array.from({ length: 4 }, () => fetch('https://q.example/sparql', settings)));
  for (const gap of gaps(calls)) {
    assert.ok(gap >= 45, `${gap} ms between starts at 20 a second`);
  }
});

test('a refusal without Retry-After is retried, and the host is asked less often', async() => {
  // QLever's way: 429 with no hint of when to come back.
  const cancelled = { count: 0 };
  const { calls, fetch } = throttle((_, call) => call < 2 ? refused(429, {}, cancelled) : new Response('ok'));
  const response = await fetch('https://q.example/sparql');
  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
  const [ first, second ] = gaps(calls);
  assert.ok(first >= 245, `first retry after ${first} ms`);
  assert.ok(second >= 495, `second retry after ${second} ms`);
  assert.equal(cancelled.count, 2, 'refused bodies are let go');
});

test('Retry-After pauses the host until then, and teaches no interval', async() => {
  // KGF's admission gate's way: 429 with Retry-After: 1.
  const { calls, fetch } = throttle((_, call) => call === 0 ? refused(429, { 'retry-after': '1' }) : new Response('ok'));
  assert.equal((await fetch('https://kgf.example/fragment')).status, 200);
  assert.ok(gaps(calls)[0] >= 990, `retried after ${gaps(calls)[0]} ms`);
  const before = Date.now();
  await Promise.all(Array.from({ length: 3 }, () => fetch('https://kgf.example/fragment')));
  assert.ok(Date.now() - before < 100, 'the pause is over and nothing was learned');
});

test('when retries run out, the last response is returned as it is', async() => {
  const { calls, fetch } = throttle(() => refused(503));
  const response = await fetch('https://q.example/sparql', { [RETRY_COUNT]: 2 });
  assert.equal(response.status, 503);
  assert.equal(calls.length, 3);
});

test('a timeout or a network failure does not slow the host', async() => {
  // Comunica's rate limiter slowed a whole host after a SPARQL endpoint's service
  // description timed out, and every KGF request on that host with it.
  const { calls, fetch } = throttle((_, call) => {
    if (call === 0) {
      throw new Error('Fetch timed out after 3000 ms');
    }
    return new Response('ok');
  });
  await assert.rejects(fetch('https://apps.example/oard-kg/sparql'), /timed out/u);
  await Promise.all(Array.from({ length: 3 }, () => fetch('https://apps.example/kgf/fragment')));
  assert.ok(calls.at(-1).at - calls[0].at < 100, 'no pause after the failure');
});

test('Comunica\'s retry actor stands aside, and this actor paces a request once', async() => {
  const { actor, calls, fetch } = throttle();
  await fetch('https://a.example/x');
  assert.equal(calls[0].context.get({ name: STOCK_RETRY_WRAPPED }), true);
  const nested = await actor.test({ input: 'https://a.example/x', context: calls[0].context });
  assert.ok(nested.isFailed());
  assert.ok((await actor.test({ input: 'https://a.example/x', context: new ActionContext() })).isPassed());
});

test('a request aborted while it waits leaves the queue', async() => {
  let release;
  const held = new Promise(resolve => {
    release = resolve;
  });
  const { calls, fetch } = throttle(async(_, call) => {
    if (call === 0) {
      await held;
    }
    return new Response('ok');
  });
  const settings = { [KEY_HTTP_IN_FLIGHT.name]: 1 };
  const first = fetch('https://a.example/x', settings);
  const controller = new AbortController();
  const second = fetch('https://a.example/x', settings, { signal: controller.signal });
  const third = fetch('https://a.example/x', settings);
  controller.abort(new Error('stopped'));
  await assert.rejects(second, /stopped/u);
  release();
  await Promise.all([ first, third ]);
  assert.equal(calls.length, 2, 'the aborted request was never sent');
});

test('a 502 is retried only when the context asks for retries, as Comunica\'s retry actor does', async() => {
  const failing = () => throttle((_, call) => call === 0 ? new Response('', { status: 502 }) : new Response('ok'));
  const without = failing();
  assert.equal((await without.fetch('https://a.example/x', { [RETRY_STATUS_CODES]: [ 502 ] })).status, 502);
  assert.equal(without.calls.length, 1);
  const withRetries = failing();
  const settings = { [RETRY_COUNT]: 1, [RETRY_STATUS_CODES]: [ 502 ] };
  assert.equal((await withRetries.fetch('https://a.example/x', settings)).status, 200);
  assert.equal(withRetries.calls.length, 2);
});

test('a request whose body is a stream is not sent twice', async() => {
  const { calls, fetch } = throttle(() => refused(429));
  const body = new ReadableStream({ start(controller) {
    controller.close();
  } });
  const response = await fetch('https://a.example/x', {}, { method: 'POST', body, duplex: 'half' });
  assert.equal(response.status, 429);
  assert.equal(calls.length, 1);
});

test('a burst refused together slows the host once, not once per refusal', async() => {
  // Five requests started together and all refused: one doubling, to 250 ms, not five, to 4 s.
  let refusing = true;
  const { calls, fetch } = throttle(() => refusing ? refused(429) : new Response('ok'), { hold: 20 });
  const burst = Array.from({ length: 5 }, () => fetch('https://q.example/sparql'));
  await sleep(30);
  refusing = false;
  await Promise.all(burst);
  const retries = calls.slice(5);
  assert.equal(retries.length, 5);
  assert.ok(retries.at(-1).at - calls[0].at < 2_000, `the retries were done ${retries.at(-1).at - calls[0].at} ms after the burst`);
});

test('an attempt listener hears when each attempt is sent and settled, not while it waits', async() => {
  const { calls, fetch } = throttle((_, call) => call === 0 ? refused(429) : new Response('ok'), { hold: 20 });
  const events = [];
  const listener = { sent: () => events.push([ 'sent', Date.now() ]), settled: () => events.push([ 'settled', Date.now() ]) };
  await fetch('https://q.example/sparql', { '@kgf/actor-http-throttle:attemptListener': listener });
  assert.deepEqual(events.map(([ name ]) => name), [ 'sent', 'settled', 'sent', 'settled' ]);
  const retrying = [];
  const told = { sent: () => retrying.push('sent'), settled: () => retrying.push('settled'), retrying: () => retrying.push('retrying') };
  const again = throttle((_, call) => call === 0 ? refused(429) : new Response('ok'));
  await again.fetch('https://q.example/sparql', { '@kgf/actor-http-throttle:attemptListener': told });
  assert.deepEqual(retrying, [ 'sent', 'settled', 'retrying', 'sent', 'settled' ], 'told when an attempt is let go for another');
  assert.equal(calls.length, 2);
  // The retry waits for the interval learned from the refusal, counted from the first start.
  assert.ok(events[2][1] - events[0][1] >= 245, 'the wait before the retry falls between settled and sent');
});

test('the actor\'s own host limits apply, and the context\'s override them field by field', async() => {
  const { calls, peak, fetch } = throttle(undefined, { hold: 10, hosts: { 'q.example': { inFlight: 1, perSecond: 20 }}});
  await Promise.all(Array.from({ length: 3 }, () => fetch('https://q.example/sparql')));
  assert.equal(peak['q.example'], 1);
  assert.ok(gaps(calls).every(gap => gap >= 45), `${gaps(calls)} ms between starts at 20 a second`);
  calls.length = 0;
  const settings = { [KEY_HTTP_HOST_LIMITS.name]: { 'q.example': { inFlight: 3 }}};
  await Promise.all(Array.from({ length: 3 }, () => fetch('https://q.example/sparql', settings)));
  assert.ok(gaps(calls).every(gap => gap >= 45), 'the rate is still the actor\'s');
});

test('a limit on *.domain is shared by the hosts in it, and a host\'s own limit holds within it', async() => {
  const { peak, fetch } = throttle(undefined, { hold: 20 });
  const settings = { [KEY_HTTP_HOST_LIMITS.name]: {
    '*.wikidata.example': { inFlight: 2 }, 'own.wikidata.example': { inFlight: 3 }, 'one.wikidata.example': { inFlight: 1 },
  }};
  const started = Date.now();
  await Promise.all([
    ...Array.from({ length: 2 }, () => fetch('https://query.wikidata.example/sparql', settings)),
    ...Array.from({ length: 2 }, () => fetch('https://query-scholarly.wikidata.example/sparql', settings)),
  ]);
  assert.ok(Date.now() - started >= 38, 'four requests to the group, two at a time, take two turns');
  await Promise.all(Array.from({ length: 3 }, () => fetch('https://own.wikidata.example/sparql', settings)));
  assert.equal(peak['own.wikidata.example'], 2, 'a host\'s own limit does not take it out of its group');
  await Promise.all(Array.from({ length: 3 }, () => fetch('https://one.wikidata.example/sparql', settings)));
  assert.equal(peak['one.wikidata.example'], 1, 'and a lower one holds within the group\'s');
  await Promise.all(Array.from({ length: 3 }, () => fetch('https://wikidata.example/sparql', settings)));
  assert.equal(peak['wikidata.example'], 3, 'the domain itself is not in the group');
});

test('a rate for one host keeps it in its group\'s cap, and the cap holds across the group', async() => {
  // As `--max-in-flight '*.wikidata.org=2' --max-rate query.wikidata.org=50` asks: the rate
  // used to give the host a queue of its own, with the default in flight instead of the group's.
  const open = { count: 0, peak: 0 };
  const { fetch } = throttle(async() => {
    open.peak = Math.max(open.peak, ++open.count);
    await sleep(30);
    open.count--;
    return new Response('ok');
  });
  const settings = { [KEY_HTTP_HOST_LIMITS.name]: { '*.wikidata.example': { inFlight: 2 }, 'query.wikidata.example': { perSecond: 50 }}};
  await Promise.all([
    ...Array.from({ length: 4 }, () => fetch('https://query.wikidata.example/sparql', settings)),
    ...Array.from({ length: 4 }, () => fetch('https://query-scholarly.wikidata.example/sparql', settings)),
  ]);
  assert.equal(open.peak, 2);
});

test('each query\'s limits for a host hold for its requests, whatever another query\'s say', async() => {
  // One engine, two queries: the second's limit used to reconfigure the queue the first's waited in.
  const { calls, fetch } = throttle(undefined, { hold: 20 });
  const strict = { [KEY_HTTP_HOST_LIMITS.name]: { 'a.example': { inFlight: 1 }}, tag: 'strict' };
  const loose = { [KEY_HTTP_IN_FLIGHT.name]: 32, tag: 'loose' };
  await Promise.all([
    ...Array.from({ length: 3 }, () => fetch('https://a.example/x', strict)),
    ...Array.from({ length: 3 }, () => fetch('https://a.example/x', loose)),
  ]);
  const strictCalls = calls.filter(call => call.context.get({ name: 'tag' }) === 'strict');
  assert.ok(gaps(strictCalls).every(gap => gap >= 15), `the strict query's requests one at a time: ${gaps(strictCalls)}`);
});

test('a pause asked by Retry-After lasts no longer than the context\'s httpRetryDelayLimit', async() => {
  // A request whose wait is past the limit gives up; the host's other requests must not wait the whole hour either.
  const { fetch } = throttle((_, call) => call === 0 ? refused(429, { 'retry-after': '3600' }) : new Response('ok'));
  const settings = { [RETRY_DELAY_LIMIT]: 100 };
  assert.equal((await fetch('https://a.example/x', settings)).status, 429, 'the refused request gives up');
  const before = Date.now();
  assert.equal((await fetch('https://a.example/x', settings)).status, 200);
  const waited = Date.now() - before;
  assert.ok(waited >= 90 && waited < 1_000, `the next request waited ${waited} ms`);
});

test('invalidating the HTTP cache forgets a pause and a learned interval', async() => {
  const listeners = [];
  const httpInvalidator = { addInvalidateListener: listener => listeners.push(listener) };
  const { calls, fetch } = throttle((url, call) => url.pathname === '/paused' && call === 0 ?
    refused(429, { 'retry-after': '3600' }) :
    new Response('ok'), { httpInvalidator });
  assert.equal((await fetch('https://a.example/paused', { [RETRY_COUNT]: 0 })).status, 429);
  const waiting = fetch('https://a.example/x');
  await sleep(20);
  assert.equal(calls.length, 1, 'the host is paused');
  for (const listener of listeners) {
    listener({ url: 'https://a.example/paused', context: new ActionContext() });
  }
  assert.equal((await waiting).status, 200, 'and goes on once the cache is invalidated');
  assert.equal(calls.length, 2);
});

test('under Node a request is sent with the actor\'s user agent, unless it names its own', async() => {
  const { calls, fetch } = throttle(undefined, { userAgent: 'kgf-sparql/test (+https://example.org/kgf-sparql)' });
  await fetch('https://a.example/x');
  await fetch('https://a.example/x', {}, { headers: { 'User-Agent': 'kgfq/1' }});
  await fetch('https://a.example/x', {}, { headers: [[ 'accept', 'text/plain' ]]});
  const agent = call => new Headers(call.init.headers).get('user-agent');
  assert.deepEqual(calls.map(agent), [
    'kgf-sparql/test (+https://example.org/kgf-sparql)',
    'kgfq/1',
    'kgf-sparql/test (+https://example.org/kgf-sparql)',
  ]);
  assert.equal(new Headers(calls[2].init.headers).get('accept'), 'text/plain', 'other headers are kept');
  const { calls: plain, fetch: fetchPlain } = throttle();
  await fetchPlain('https://a.example/x');
  assert.equal(plain[0].init.headers, undefined, 'without a userAgent the request is left alone');
});

test('a host\'s rate holds when its group holds its requests back, and they start when the group has room', async() => {
  // Each request used to take its host's turn, stamping the host's last start, and then wait
  // for its group's; when the group had room it let them all start at once, past the host's rate.
  const { calls, fetch } = throttle(async url => {
    if (url.host === 'other.wikidata.example') {
      await sleep(250);
    }
    return new Response('ok');
  });
  const settings = { [KEY_HTTP_HOST_LIMITS.name]: {
    '*.wikidata.example': { inFlight: 1 }, 'query.wikidata.example': { perSecond: 10 },
  }};
  const busy = fetch('https://other.wikidata.example/sparql', settings);
  await sleep(10);
  await Promise.all([ busy, ...Array.from({ length: 3 }, () => fetch('https://query.wikidata.example/sparql', settings)) ]);
  const query = calls.filter(call => call.host === 'query.wikidata.example');
  assert.equal(query.length, 3);
  assert.ok(query[0].at - calls[0].at >= 245, 'the group held the first back');
  assert.ok(gaps(query).every(gap => gap >= 95), `${gaps(query)} ms between starts at 10 a second`);
});

test('a refusal teaches before the refused request gives up its place', async() => {
  // The place used to go first, and the request waiting for it started at the old pace.
  const { calls, fetch } = throttle((_, call) => call === 0 ? refused(429) : new Response('ok'), { hold: 10 });
  const settings = { [KEY_HTTP_IN_FLIGHT.name]: 1, [RETRY_COUNT]: 0 };
  const [ first, second ] = await Promise.all([ fetch('https://q.example/sparql', settings), fetch('https://q.example/sparql', settings) ]);
  assert.deepEqual([ first.status, second.status ], [ 429, 200 ]);
  assert.ok(gaps(calls)[0] >= 245, `the next request started ${gaps(calls)[0]} ms after the refused one`);
});

test('a Request keeps its own headers when the user agent is added, and its own user agent', async() => {
  // fetch sends a Request's headers only when the init gives none: an init with just a user
  // agent dropped the rest.
  const { calls, fetch } = throttle(undefined, { userAgent: 'kgf-sparql/test' });
  await fetch(new Request('https://a.example/x', { headers: { accept: 'text/turtle' }}));
  await fetch(new Request('https://a.example/x', { headers: { 'user-agent': 'kgfq/1' }}));
  const sent = new Headers(calls[0].init.headers);
  assert.equal(sent.get('accept'), 'text/turtle');
  assert.equal(sent.get('user-agent'), 'kgf-sparql/test');
  assert.equal(calls[1].init.headers, undefined, 'a Request that names itself is left alone');
});

test('a queue no request holds is let go, and the host\'s rate outlives it', async() => {
  // Each set of limits a query gave a host made a queue that was kept for good.
  const { actor, calls, fetch } = throttle();
  for (let i = 0; i < 3; i++) {
    await fetch('https://q.example/sparql', { [KEY_HTTP_HOST_LIMITS.name]: { 'q.example': { inFlight: i + 1, perSecond: 20 }}});
  }
  assert.equal(actor.queues.size, 0);
  assert.ok(gaps(calls).every(gap => gap >= 45), `${gaps(calls)} ms between starts at 20 a second, across queues`);
});
