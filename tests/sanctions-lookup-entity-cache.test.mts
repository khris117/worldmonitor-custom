import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupSanctionEntity } from '../server/worldmonitor/sanctions/v1/lookup-entity.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
};
const INDEX = [
  { id: 'SDN:1', name: 'Test Person', et: 'individual', cc: ['RU'], pr: ['SDN'] },
  { id: 'CONSOLIDATED:2', name: 'Test Company', et: 'entity', cc: ['IR'], pr: ['SSI'] },
  { id: 'sema-ca:russia:1-1:3', name: 'Test Vessel', et: 'vessel', cc: [], pr: ['SEMA'] },
];
const ALL_SOURCES = 'OFAC SDN, OFAC Consolidated, Canada SEMA';

function installIndex(t: test.TestContext, index: unknown = INDEX, status = 200) {
  t.after(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    for (const [key, value] of [
      ['UPSTASH_REDIS_REST_URL', ORIGINAL_ENV.url],
      ['UPSTASH_REDIS_REST_TOKEN', ORIGINAL_ENV.token],
    ] as const) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url === 'https://redis.example.test/get/sanctions%3Aentities%3Av1') {
      return new Response(JSON.stringify({ result: index == null ? null : JSON.stringify(index) }), { status });
    }
    if (url.startsWith('https://api.opensanctions.org/')) {
      return new Response('No API key provided.', { status: 401 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return requests;
}

test('local lookup makes no OpenSanctions or query-cache requests without a licence key', async (t) => {
  const requests = installIndex(t);
  const result = await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 });
  assert.deepEqual(requests, ['https://redis.example.test/get/sanctions%3Aentities%3Av1']);
  assert.equal(result.source, ALL_SOURCES);
  assert.deepEqual(result.results, [{
    id: 'SDN:1', name: 'Test Person', entityType: 'individual', countryCodes: ['RU'], programs: ['SDN'],
  }, {
    id: 'CONSOLIDATED:2', name: 'Test Company', entityType: 'entity', countryCodes: ['IR'], programs: ['SSI'],
  }, {
    id: 'sema-ca:russia:1-1:3', name: 'Test Vessel', entityType: 'vessel', countryCodes: [], programs: ['SEMA'],
  }]);
  assert.equal(result.total, 3);
});

test('Canada-only lookup reports only Canada and preserves its match', async (t) => {
  installIndex(t, [INDEX[2]]);
  const result = await lookupSanctionEntity({} as never, { q: 'Test Vessel', maxResults: 10 });
  assert.equal(result.source, 'Canada SEMA');
  assert.equal(result.results[0]?.id, INDEX[2]!.id);
});

test('a no-match answer still identifies the full searched index', async (t) => {
  installIndex(t);
  const result = await lookupSanctionEntity({} as never, { q: 'Unlisted', maxResults: 10 });
  assert.deepEqual(result, { results: [], total: 0, source: ALL_SOURCES });
});

test('case, whitespace, ranking, and maxResults keep the local matcher contract', async (t) => {
  installIndex(t, Array.from({ length: 60 }, (_, i) => ({ ...INDEX[0], id: `SDN:${i}`, name: i === 0 ? 'Test Person' : `Test Person ${i}` })));
  for (const [maxResults, expectedLength] of [[1, 1], [5.9, 5], [50, 50], [100, 50], [0, 10], [-1, 10], [NaN, 10]] as const) {
    const result = await lookupSanctionEntity({} as never, { q: '  TEST   person  ', maxResults });
    assert.equal(result.results.length, expectedLength);
    assert.equal(result.total, 60);
    assert.equal(result.results[0]?.name, 'Test Person');
    assert.equal(result.source, 'OFAC SDN');
  }
});

test('invalid query lengths perform no search and claim no source lists', async (t) => {
  const requests = installIndex(t);
  for (const q of ['', 'x', ' '.repeat(10), 'x'.repeat(201)]) {
    const result = await lookupSanctionEntity({} as never, { q, maxResults: 10 });
    assert.deepEqual(result, { results: [], total: 0, source: 'Not searched' });
  }
  assert.deepEqual(requests, []);
});

for (const [label, index, status, source] of [
  ['empty', [], 200, 'Local sanctions index (empty)'],
  ['missing', null, 200, 'Local sanctions index unavailable'],
  ['invalid', {}, 200, 'Local sanctions index unavailable'],
  ['failed', null, 503, 'Local sanctions index unavailable'],
] as const) {
  test(`${label} index does not claim regulator coverage`, async (t) => {
    const requests = installIndex(t, index, status);
    const result = await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 });
    assert.deepEqual(result, { results: [], total: 0, source });
    assert.ok(requests.every(url => url.startsWith('https://redis.example.test/')));
  });
}

test('an unrecognized record source uses a generic local label', async (t) => {
  installIndex(t, [{ ...INDEX[0], id: 'legacy:1' }]);
  const result = await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 });
  assert.equal(result.source, 'Local sanctions index');
  assert.equal(result.results[0]?.id, 'legacy:1');
});

test('repeat lookups see the current seed instead of a cached query answer', async (t) => {
  const index = [INDEX[0]!];
  const requests = installIndex(t, index);
  const first = await lookupSanctionEntity({} as never, { q: 'Test', maxResults: 10 });
  assert.equal(first.source, 'OFAC SDN');
  assert.equal(first.total, 1);
  index.push(INDEX[2]!);
  const second = await lookupSanctionEntity({} as never, { q: 'Test', maxResults: 10 });
  assert.equal(second.source, 'OFAC SDN, Canada SEMA');
  assert.equal(second.total, 2);
  assert.ok(requests.every(url => url === 'https://redis.example.test/get/sanctions%3Aentities%3Av1'));
});
