// The UCDP writers' trailing-window fetch (scripts/shared/ucdp-candidate.cjs):
// the annual GED release by date plus EVERY monthly GED Candidate release,
// against a mock of the UCDP API shaped like the live one (2026-10-23: each
// candidate release 26.0.N holds month N of 2026 plus a few late revisions; the
// annual release's pages are not in date order; StartDate/EndDate filter it).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  annualReleaseEndMs,
  candidateVersionsSince,
  discoverCandidateVersion,
  fetchAnnualWindow,
  fetchCandidateWindow,
  summarizeUcdpWindow,
  ANNUAL_LOOKBACK_MS,
} = require('../scripts/shared/ucdp-candidate.cjs');

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 23);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** 40 events a day; ids encode the release so the dedupe is observable. */
function eventsBetween(startMs, endMs, release, perDay = 40) {
  const out = [];
  for (let ms = startMs; ms <= endMs; ms += DAY_MS) {
    for (let i = 0; i < perDay; i++) out.push({ id: `${release}-${iso(ms)}-${i}`, date_start: iso(ms), country: i % 2 ? 'Ukraine' : 'Mexico', best: 2 });
  }
  return out;
}

function mockApi({ missing = new Set(), failing = new Set() } = {}) {
  const releases = new Map();
  // Annual 26.1: 2024-2025, shuffled so its pages are not in date order.
  const annual = eventsBetween(Date.UTC(2024, 0, 1), Date.UTC(2025, 11, 31), '26.1', 10);
  annual.sort((a, b) => (a.id.length * 7919 + a.id.charCodeAt(a.id.length - 1)) % 13 - (b.id.length * 7919 + b.id.charCodeAt(b.id.length - 1)) % 13);
  releases.set('26.1', annual);
  for (let month = 1; month <= 9; month++) {
    const version = `26.0.${month}`;
    if (missing.has(version)) continue;
    const rows = eventsBetween(Date.UTC(2026, month - 1, 1), Date.UTC(2026, month, 0), version);
    // A late revision of an event the previous release already carried.
    if (month > 1) rows.push({ id: `26.0.${month - 1}-${iso(Date.UTC(2026, month - 2, 1))}-0`, date_start: iso(Date.UTC(2026, month - 2, 1)), country: 'Mexico', best: 9 });
    releases.set(version, rows);
  }
  const calls = [];
  const fetchPage = async (version, page, _timeoutMs, query = {}) => {
    calls.push({ version, page, query });
    if (failing.has(`${version}:${page}`)) throw new Error('HTTP 500');
    let rows = releases.get(version);
    if (!rows) throw new Error(`HTTP 400 ${version}`);
    if (query.StartDate) rows = rows.filter((e) => e.date_start >= query.StartDate && e.date_start <= query.EndDate);
    const totalPages = Math.max(1, Math.ceil(rows.length / 1000));
    return { TotalCount: rows.length, TotalPages: totalPages, Result: rows.slice(page * 1000, page * 1000 + 1000) };
  };
  return { fetchPage, calls };
}

async function fetchWindow(api) {
  const annual = await fetchAnnualWindow(api.fetchPage, '26.1', { nowMs: NOW });
  const newest = await discoverCandidateVersion(api.fetchPage, ['26.0.11', '26.0.10', '26.0.9', '26.0.8']);
  const fromMs = Math.max(annualReleaseEndMs('26.1') + 1, NOW - ANNUAL_LOOKBACK_MS);
  const candidates = await fetchCandidateWindow(api.fetchPage, newest, { fromMs });
  const byId = new Map();
  for (const e of [...annual.events, ...candidates.releases.flatMap((r) => r.events)]) byId.set(e.id, e);
  const events = [...byId.values()].map((e) => ({ id: e.id, country: e.country, dateStart: Date.parse(e.date_start), deathsBest: e.best }));
  const latest = Math.max(...events.map((e) => e.dateStart));
  const inWindow = events.filter((e) => e.dateStart >= latest - 365 * DAY_MS);
  return { annual, candidates, events: inWindow, summary: summarizeUcdpWindow(inWindow, { startMs: latest - 365 * DAY_MS, endMs: latest }) };
}

describe('UCDP trailing-window fetch', () => {
  it('names every monthly candidate release since the annual year, oldest first, across a year boundary', () => {
    assert.deepEqual(candidateVersionsSince(Date.UTC(2026, 0, 1), '26.0.9'), ['26.0.1', '26.0.2', '26.0.3', '26.0.4', '26.0.5', '26.0.6', '26.0.7', '26.0.8', '26.0.9']);
    assert.deepEqual(candidateVersionsSince(Date.UTC(2026, 10, 15), '27.0.2'), ['26.0.11', '26.0.12', '27.0.1', '27.0.2']);
    assert.equal(annualReleaseEndMs('26.1'), Date.UTC(2026, 0, 1) - 1);
  });

  it('covers every month of the window, not only the newest release (the 2026-10 truncation)', async () => {
    const api = mockApi();
    const { summary, candidates } = await fetchWindow(api);
    assert.deepEqual(candidates.releases.map((r) => r.version), ['26.0.1', '26.0.2', '26.0.3', '26.0.4', '26.0.5', '26.0.6', '26.0.7', '26.0.8', '26.0.9']);
    assert.equal(candidates.complete, true);
    assert.deepEqual(summary.gapMonths, []);
    const empty = Object.entries(summary.months).filter(([month, n]) => n === 0 && month !== '2025-09');
    assert.deepEqual(empty, [], `months with no rows: ${JSON.stringify(summary.months)}`);
  });

  it('fetches the annual release by date, so its unordered pages cannot leave the window short', async () => {
    const api = mockApi();
    const { annual } = await fetchWindow(api);
    const annualCalls = api.calls.filter((c) => c.version === '26.1');
    assert.ok(annualCalls.every((c) => c.query.StartDate === iso(NOW - ANNUAL_LOOKBACK_MS) && c.query.EndDate === '2025-12-31'), 'every annual page is date-filtered');
    assert.equal(annual.failedPages, 0);
    assert.ok(annual.events.every((e) => e.date_start >= iso(NOW - ANNUAL_LOOKBACK_MS)));
    const lastAnnualMonth = annual.events.reduce((m, e) => (e.date_start > m ? e.date_start : m), '');
    assert.equal(lastAnnualMonth, '2025-12-31');
  });

  it('dedupes by event id across releases, the later release winning', async () => {
    const { events } = await fetchWindow(mockApi());
    const revised = events.filter((e) => e.id === '26.0.7-2026-07-01-0');
    assert.equal(revised.length, 1);
    assert.equal(revised[0].deathsBest, 9, 'the 26.0.8 revision of a 26.0.7 event wins');
  });

  it('reports a missing release and the month it leaves empty (the gap check fails)', async () => {
    const { candidates, summary } = await fetchWindow(mockApi({ missing: new Set(['26.0.4']) }));
    assert.equal(candidates.complete, false);
    assert.deepEqual(candidates.missingReleases, ['26.0.4']);
    assert.deepEqual(summary.gapMonths, ['2026-04']);
  });

  it('reports a failed candidate page as incomplete rather than silently thin', async () => {
    const { candidates } = await fetchWindow(mockApi({ failing: new Set(['26.0.6:1']) }));
    assert.equal(candidates.complete, false);
    assert.deepEqual(candidates.missingReleases, []);
  });

  it('a failed first annual page counts as the annual base failing, for the preserve-last-good guard', async () => {
    const api = mockApi({ failing: new Set(['26.1:0']) });
    const annual = await fetchAnnualWindow(api.fetchPage, '26.1', { nowMs: NOW });
    assert.equal(annual.events.length, 0);
    assert.ok(annual.failedPages > 0);
  });
});

describe('UCDP window aggregates for the CII', () => {
  it('aggregates per country and day, counting each event as at least one death', () => {
    const day = Date.UTC(2026, 8, 1);
    const rows = [
      { country: 'Mexico', dateStart: day, deathsBest: 3 },
      { country: 'Mexico', dateStart: day + 3_600_000, deathsBest: 0 },
      { country: 'Ukraine', dateStart: day, deathsBest: 10 },
    ];
    const s = summarizeUcdpWindow(rows, { startMs: day - 30 * DAY_MS, endMs: day + DAY_MS });
    assert.deepEqual(s.countryDays.Mexico, [[day / DAY_MS, 2, 4]]);
    assert.deepEqual(s.countryDays.Ukraine, [[day / DAY_MS, 1, 10]]);
    assert.deepEqual(s.dailyTotals, [[day / DAY_MS, 3]]);
  });

  it('flags a month with no rows while a later month has rows, and only then', () => {
    const rows = [
      { country: 'Mexico', dateStart: Date.UTC(2026, 0, 10), deathsBest: 1 },
      { country: 'Mexico', dateStart: Date.UTC(2026, 2, 10), deathsBest: 1 },
    ];
    const s = summarizeUcdpWindow(rows, { startMs: Date.UTC(2026, 0, 1), endMs: Date.UTC(2026, 3, 30) });
    assert.deepEqual(s.gapMonths, ['2026-02'], 'February is empty while March has rows; April (empty, nothing later) is the frontier');
  });

  it('does not flag a first month that barely overlaps the window', () => {
    const rows = [{ country: 'Mexico', dateStart: Date.UTC(2025, 9, 5), deathsBest: 1 }];
    const s = summarizeUcdpWindow(rows, { startMs: Date.UTC(2025, 8, 30), endMs: Date.UTC(2025, 9, 31) });
    assert.deepEqual(s.gapMonths, []);
  });
});

describe('consumers of the canonical key that do not read the CII aggregates', () => {
  const aggregates = { countryDays: { Ukraine: [[20_700, 3, 9]] }, dailyTotals: [[20_700, 3]], window: { complete: true } };

  it('the dashboard bootstrap projection drops countryDays and dailyTotals', async () => {
    const { compactUcdpDashboardPayload } = await import('../scripts/_ucdp-dashboard.mjs');
    const compact = compactUcdpDashboardPayload({ events: [{ id: '1', country: 'Ukraine', dateStart: NOW, deathsBest: 1 }], ...aggregates }, NOW);
    assert.equal('countryDays' in compact, false);
    assert.equal('dailyTotals' in compact, false);
    assert.equal(compact.events.length, 1);
  });

  it('MCP get_conflict_events drops them, so they cannot crowd events out of the output budget', async (t) => {
    const { executeTool } = await import('../api/mcp/dispatch.ts');
    const { CACHE_TOOLS } = await import('../api/mcp/registry/cache-tools.ts');
    const tool = CACHE_TOOLS.find((x) => x.name === 'get_conflict_events');
    const originalEnv = process.env;
    process.env = { ...originalEnv, UPSTASH_REDIS_REST_URL: 'https://conflict-redis.test', UPSTASH_REDIS_REST_TOKEN: 'test-token' };
    t.after(() => { process.env = originalEnv; });
    const fresh = { fetchedAt: NOW - 60_000, recordCount: 1, status: 'ok' };
    const values = new Map([
      ['conflict:ucdp-events:v1', { candidateVersion: '26.0.9', events: [{ id: 'event', country: 'Ukraine', deathsBest: 1 }], ...aggregates }],
      ['unrest:events:v1', { events: [] }],
      ['conflict:iran-events:v1', { events: [] }],
      ...tool._cacheKeys.filter((key) => key.includes('risk:')).map((key) => [key, { ciiScores: [] }]),
      ['seed-meta:conflict:ucdp-events', fresh], ['seed-meta:unrest:events', fresh],
    ]);
    t.mock.method(globalThis, 'fetch', async (url) => {
      const key = decodeURIComponent(String(url).split('/get/')[1] ?? '');
      return Response.json({ result: values.get(key) == null ? null : JSON.stringify(values.get(key)) });
    });
    const result = await executeTool(tool, { limit: 3 }, NOW);
    const ucdp = result.data['ucdp-events'];
    assert.deepEqual(ucdp.events.map((e) => e.id), ['event']);
    assert.equal('countryDays' in ucdp, false);
    assert.equal('dailyTotals' in ucdp, false);
  });
});
