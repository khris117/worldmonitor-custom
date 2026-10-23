// Travel-advisory provenance in the CII. Until v15 a failed advisory read
// swapped the live US/Australian levels for an embedded table that disagreed
// with them (CU, LB, RU, IR, IQ) and had no entry for KP, QA, AE or SA. On
// 2026-10-21 between 15:00 and 16:50 UTC production served that table: QA
// 50→8, AE 50→16, KP 60→38, RU 72→54, with no alarm. The rule now: a missing
// or stale advisory read is unknown. The last good live snapshot stands in
// while it is younger than CII_ADVISORY_MAX_AGE_MS; past that the advisory
// terms are absent. Health names the input either way.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadCiiFixtures, trimCiiRawInputs } from '../scripts/lib/cii-fixtures.mts';
import * as riskScores from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import type { CiiRawInputs, CiiScoreTable } from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';
import * as riskConfig from '../server/worldmonitor/intelligence/v1/_risk-config.ts';
import { assessCiiInputs } from '../api/_cii-input-health.js';

// Namespace imports so each case reports on its own against a scorer that
// predates the snapshot path.
const { assessCiiInputAvailability, ciiInputSnapshotTimes, computeCiiScoreTable, withCiiInputQuietClocks } = riskScores;
const { CII_ADVISORY_MAX_AGE_MS } = riskConfig;
const FIXTURES = loadCiiFixtures();
const HOUR_MS = 60 * 60 * 1000;

function table(f: (typeof FIXTURES)[number], inputs: CiiRawInputs): CiiScoreTable {
  return computeCiiScoreTable(inputs, { nowMs: f.nowMs, iranEventsEnabled: f.iranEventsEnabled });
}
const liveLevels = (f: (typeof FIXTURES)[number]) => (f.inputs.advisories as { byCountry: Record<string, string> }).byCountry;
const disclosure = (t: CiiScoreTable) => Object.fromEntries(t.scores.map((s) => [s.region, `${s.advisoryLevel}/${s.advisoryProvenance}`]));
const combined = (t: CiiScoreTable) => Object.fromEntries(t.scores.map((s) => [s.region, s.combinedScore]));
/** The live payload as the build would have kept it, with the producer clock. */
const snapshot = (f: (typeof FIXTURES)[number], ageMs: number) => ({ byCountry: liveLevels(f), fetchedAt: f.nowMs - ageMs });

describe('CII advisory provenance', () => {
  it('fixtures carry live advisory levels to test against', () => {
    assert.ok(FIXTURES.length >= 3);
    for (const f of FIXTURES) assert.ok(Object.keys(liveLevels(f)).length >= 25, f.label);
  });

  it('a failed read with no snapshot scores no advisory level: every term is absent, none comes from a table', () => {
    for (const f of FIXTURES) {
      const t = table(f, { ...f.inputs, advisories: null });
      const used = t.scores.filter((s) => s.advisoryLevel !== '' || s.advisoryProvenance !== 'absent');
      assert.deepEqual(used.map((s) => `${s.region}=${s.advisoryLevel}/${s.advisoryProvenance}`), [], f.label);
      for (const row of t.rows) {
        assert.equal(row.boosts.advisory, 0, `${f.label} ${row.region} advisory boost`);
        assert.equal(row.floors.advisory, 0, `${f.label} ${row.region} advisory floor`);
      }
    }
  });

  it('a live map without a country leaves that country absent instead of filling it from a table', () => {
    for (const f of FIXTURES) {
      const byCountry = { ...liveLevels(f) };
      for (const code of ['UA', 'LB', 'CU']) delete byCountry[code];
      const d = disclosure(table(f, { ...f.inputs, advisories: { byCountry } }));
      for (const code of ['UA', 'LB', 'CU']) assert.equal(d[code], '/absent', `${f.label} ${code}`);
      assert.equal(d.QA, `${liveLevels(f).QA}/live`, `${f.label} QA keeps its live level`);
    }
  });

  it('a failed read with a snapshot inside the maximum age scores exactly the live table, disclosed as fallback', () => {
    for (const f of FIXTURES) {
      const live = table(f, f.inputs);
      const failed = table(f, { ...f.inputs, advisories: null, advisoriesLastGood: snapshot(f, 2 * HOUR_MS) });
      assert.deepEqual(combined(failed), combined(live), `${f.label}: a failed read must not move any country`);
      for (const s of failed.scores) {
        const level = liveLevels(f)[s.region];
        const scored = level === 'do-not-travel' || level === 'reconsider' || level === 'caution';
        assert.equal(`${s.advisoryLevel}/${s.advisoryProvenance}`, scored ? `${level}/fallback` : '/absent', `${f.label} ${s.region}`);
      }
    }
  });

  it('a snapshot past the maximum age is unknown, not used', () => {
    for (const f of FIXTURES) {
      const t = table(f, { ...f.inputs, advisories: null, advisoriesLastGood: snapshot(f, CII_ADVISORY_MAX_AGE_MS + 1) });
      assert.ok(t.scores.every((s) => s.advisoryProvenance === 'absent'), f.label);
      assert.equal(assessCiiInputAvailability([], t.aux, f.nowMs, false).advisories, 'missing');
    }
  });

  it('a snapshot without a producer clock, or with a future one, is not used', () => {
    const f = FIXTURES[0]!;
    for (const lastGood of [{ byCountry: liveLevels(f) }, { byCountry: liveLevels(f), fetchedAt: f.nowMs + HOUR_MS }]) {
      const t = table(f, { ...f.inputs, advisories: null, advisoriesLastGood: lastGood });
      assert.ok(t.scores.every((s) => s.advisoryProvenance === 'absent'), JSON.stringify(lastGood).slice(-40));
    }
  });

  it('a live read past the maximum age is unusable; the snapshot stands in only if it is younger', () => {
    const f = FIXTURES[0]!;
    const staleLive = { byCountry: liveLevels(f), fetchedAt: new Date(f.nowMs - CII_ADVISORY_MAX_AGE_MS - HOUR_MS).toISOString() };
    const alone = table(f, { ...f.inputs, advisories: staleLive });
    assert.ok(alone.scores.every((s) => s.advisoryProvenance === 'absent'));
    assert.equal(assessCiiInputAvailability([], alone.aux, f.nowMs, false).advisories, 'unusable');
    const withSnapshot = table(f, { ...f.inputs, advisories: staleLive, advisoriesLastGood: snapshot(f, HOUR_MS) });
    assert.ok(withSnapshot.scores.some((s) => s.advisoryProvenance === 'fallback'));
  });

  it('a fresh live read wins over any snapshot', () => {
    const f = FIXTURES[0]!;
    const other = { byCountry: { ...liveLevels(f), QA: 'do-not-travel' }, fetchedAt: f.nowMs - HOUR_MS };
    const t = table(f, { ...f.inputs, advisoriesLastGood: other });
    assert.equal(disclosure(t).QA, `${liveLevels(f).QA}/live`);
  });

  it('trimming a fixture keeps the producer clock the age gate reads', () => {
    const f = FIXTURES[0]!;
    const fetchedAt = new Date(f.nowMs - HOUR_MS).toISOString();
    const trimmed = trimCiiRawInputs({ advisories: { byCountry: liveLevels(f), fetchedAt, advisories: [{ title: 'x' }] } });
    assert.deepEqual(Object.keys(trimmed.advisories as object).sort(), ['byCountry', 'fetchedAt']);
    assert.equal((trimmed.advisories as { fetchedAt: string }).fetchedAt, fetchedAt);
  });
});

describe('CII advisory provenance alarm', () => {
  function verdict(f: (typeof FIXTURES)[number], inputs: CiiRawInputs) {
    const t = table(f, inputs);
    const states = assessCiiInputAvailability([], t.aux, f.nowMs, false);
    const reports = withCiiInputQuietClocks(states, null, f.nowMs, ciiInputSnapshotTimes(t.aux));
    return { states, reports, health: assessCiiInputs({ inputs: reports }, f.nowMs + 10 * 60_000) };
  }
  const advisoryAlarm = (v: ReturnType<typeof verdict>) => v.health.dead.find((d: { id: string }) => d.id === 'advisories');

  it('a live read raises no advisory alarm', () => {
    for (const f of FIXTURES) assert.equal(advisoryAlarm(verdict(f, f.inputs)), undefined, f.label);
  });

  it('a flip to the snapshot is an alarm that carries the snapshot age', () => {
    for (const f of FIXTURES) {
      const v = verdict(f, { ...f.inputs, advisories: null, advisoriesLastGood: snapshot(f, 2 * HOUR_MS) });
      assert.equal(v.states.advisories, 'fallback', f.label);
      assert.equal(v.reports.advisories.snapshotAt, f.nowMs - 2 * HOUR_MS, f.label);
      assert.deepEqual(advisoryAlarm(v), { id: 'advisories', state: 'fallback', ageMin: 130 }, f.label);
    }
  });

  it('a flip to unknown is an alarm', () => {
    for (const f of FIXTURES) {
      assert.deepEqual(advisoryAlarm(verdict(f, { ...f.inputs, advisories: null })), { id: 'advisories', state: 'missing' }, f.label);
    }
  });

  it('no score is ever disclosed as fallback without the alarm', () => {
    for (const f of FIXTURES) {
      const cases: CiiRawInputs[] = [
        f.inputs,
        { ...f.inputs, advisories: { byCountry: { QA: 'reconsider' } } },
        { ...f.inputs, advisories: null },
        { ...f.inputs, advisories: null, advisoriesLastGood: snapshot(f, HOUR_MS) },
      ];
      for (const inputs of cases) {
        const t = table(f, inputs);
        const v = verdict(f, inputs);
        if (t.scores.some((s) => s.advisoryProvenance === 'fallback')) assert.ok(advisoryAlarm(v), `${f.label}: fallback without an alarm`);
      }
    }
  });
});
