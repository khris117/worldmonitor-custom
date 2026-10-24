// /monitor-the-situation/ as the corpus build writes it from the committed
// pulse: every registry crisis filed under a region anchor with its frozen
// HAPI figure, three live sections carrying the pulse's own timestamps, and a
// section with no publishable pulse rendering "No current reading" rather
// than a value.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildChokepointHubRows, buildCorpus, loadCorpusData } from '../scripts/build-crawlable-corpus.mjs';
import { CRISIS_REGIONS, crisisFigure, renderSituationPage } from '../scripts/build-situation-page.mjs';
import { headlinesRecord, situationMarkers, situationSections } from '../scripts/situation-page/sections.mjs';
import { CHOKEPOINT_REGISTRY } from '../src/config/chokepoint-registry.ts';
import { UnpublishableReading } from '../scripts/live-pages/common.mjs';

const SITUATION_SECTIONS = situationSections(CHOKEPOINT_REGISTRY);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = 'https://www.worldmonitor.app';

let outDir;
let data;
let html;

const tpl = {
  escapeHtml: (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  absoluteUrl: (baseUrl, path) => `${baseUrl}${path}`,
  breadcrumbLd: () => ({ '@type': 'BreadcrumbList' }),
  pageDocument: ({ body, jsonLd }) => `<main>${body}</main>${JSON.stringify(jsonLd)}`,
};

function sectionOf(page, section) {
  const { start, end } = situationMarkers(section);
  const from = page.indexOf(start);
  const to = page.indexOf(end, from);
  assert.ok(from !== -1 && to !== -1, `${section.slug} rendered once`);
  assert.equal(page.indexOf(start, from + 1), -1, `${section.slug} rendered once`);
  return page.slice(from, to);
}

before(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'wm-situation-page-'));
  data = await loadCorpusData({ rootDir: repoRoot });
  await buildCorpus({ rootDir: repoRoot, outDir, baseUrl: BASE_URL });
  html = readFileSync(join(outDir, 'monitor-the-situation', 'index.html'), 'utf8');
});

after(() => rmSync(outDir, { recursive: true, force: true }));

describe('/monitor-the-situation/ build', () => {
  it('publishes the page at its canonical URL with one live section per registry entry', () => {
    assert.match(html, /<link rel="canonical" href="https:\/\/www\.worldmonitor\.app\/monitor-the-situation\/">/);
    assert.match(html, /<h1>Monitor the situation<\/h1>/);
    for (const section of SITUATION_SECTIONS) {
      const rendered = sectionOf(html, section);
      assert.match(rendered, /Published reading/, `${section.slug} is labelled as the published pulse`);
      assert.doesNotMatch(rendered, /data-live-at-request/, `${section.slug} is not labelled live at build time`);
      assert.doesNotMatch(rendered, /"@type":"FAQPage"/, `${section.slug} leaves the FAQ to the page`);
    }
    assert.equal(html.split('"@type":"FAQPage"').length, 2, 'exactly one FAQPage on the page');
  });

  it('stamps each live section with its own pulse time, not the build time', () => {
    const pulse = data.livePulse;
    assert.match(sectionOf(html, SITUATION_SECTIONS[0]), new RegExp(`datetime="${new Date(pulse.capturedAtMs).toISOString()}"`));
    const chokepointAsOf = Object.values(pulse.chokepoints).map((row) => row.asOf).sort().at(-1);
    assert.match(sectionOf(html, SITUATION_SECTIONS[1]), new RegExp(`datetime="${chokepointAsOf}"`));
    assert.match(sectionOf(html, SITUATION_SECTIONS[2]), new RegExp(`datetime="${pulse.liveTopics['internet-outages'].asOf}"`));
  });

  it('files every crisis tracker under a region anchor with its tracker and dashboard links', () => {
    for (const region of CRISIS_REGIONS) {
      assert.match(html, new RegExp(`<section class="region" id="${region.id}">`), `#${region.id} anchor`);
    }
    for (const crisis of data.crises) {
      const card = html.match(new RegExp(`<li class="situation" id="${crisis.slug}">([\\s\\S]*?)</li>`));
      assert.ok(card, `${crisis.slug} card`);
      assert.match(card[1], new RegExp(`href="/crises/${crisis.slug}/"`));
      assert.ok(card[1].includes(`href="${tpl.escapeHtml(crisis.dashboardPath)}"`), `${crisis.slug} dashboard link`);
      const regionSection = html.slice(html.indexOf(`id="${crisis.region}"`), html.indexOf(`id="${crisis.slug}"`));
      assert.doesNotMatch(regionSection, /<section class="region"/, `${crisis.slug} sits inside its own region`);
    }
    const figures = data.crises.filter((crisis) => crisisFigure(data.livePulse.crises?.[crisis.slug]));
    assert.ok(figures.length > 0, 'the committed pulse carries at least one combined figure');
    for (const crisis of figures) {
      const pulse = data.livePulse.crises[crisis.slug];
      assert.ok(html.includes(`${pulse.eventsTotal} recorded events and ${pulse.fatalities} fatalities`), `${crisis.slug} figure`);
    }
  });

  it('links to the live map, the chokepoint hub and the outage tracker, and reaches the page from the hubs', () => {
    for (const href of ['/dashboard', '/chokepoints/', '/tools/internet-outages/', '/crises/', '/countries/', '/agent/']) {
      assert.ok(html.includes(`href="${href}"`), `-> ${href}`);
    }
    for (const hub of ['crises/index.html', 'tools/index.html', 'tools/internet-outages/index.html', 'countries/france/index.html']) {
      assert.ok(readFileSync(join(outDir, hub), 'utf8').includes('href="/monitor-the-situation/"'), `${hub} links the board`);
    }
  });
});

describe('/monitor-the-situation/ readings', () => {
  it('withholds the combined figure when the pulse holds none', () => {
    assert.equal(crisisFigure(null), null);
    assert.equal(crisisFigure({ state: 'missing' }), null);
    assert.equal(crisisFigure({ state: 'partial', eventsTotal: null, fatalities: null, referencePeriod: 'Mixed reference periods' }), null);
    assert.equal(crisisFigure({ state: 'ready', eventsTotal: '1,111', fatalities: '12', referencePeriod: '2026-10-01' }), '1,111 recorded events and 12 fatalities in the October 2026 HAPI summary');
  });

  it('renders "No current reading" and no value for a section without a publishable pulse', () => {
    const hubRows = buildChokepointHubRows(data.chokepoints, data.livePulse);
    const bare = { ...data.livePulse, headlines: [], liveTopics: {} };
    const page = renderSituationPage({ baseUrl: BASE_URL, lastmod: '2026-10-24', tpl, crises: data.crises, livePulse: bare, hubRows, snapshotPath: 'x.json' });
    for (const section of [SITUATION_SECTIONS[0], SITUATION_SECTIONS[2]]) {
      const rendered = sectionOf(page, section);
      assert.match(rendered, /No current reading/);
      assert.doesNotMatch(rendered, /<time /, `${section.slug} prints no timestamp without a reading`);
      assert.doesNotMatch(rendered, /As of /, `${section.slug} states no dated value`);
    }
    assert.match(sectionOf(page, SITUATION_SECTIONS[1]), /Published reading/, 'the chokepoint board still renders from the hub rows');
  });

  it('rejects a digest it cannot publish as current', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    const fresh = { generatedAt: '2026-10-24T11:50:00Z', coverage: { state: 'complete' }, categories: { world: { items: [
      { title: 'A', source: 'Reuters', link: 'https://www.reuters.com/a', publishedAt: now - 60_000, importanceScore: 5 },
    ] } } };
    assert.equal(headlinesRecord(fresh, now).rows.length, 1);
    assert.throws(() => headlinesRecord({ ...fresh, generatedAt: '2026-10-24T05:00:00Z' }, now), UnpublishableReading);
    assert.throws(() => headlinesRecord({ ...fresh, coverage: { state: 'unavailable' } }, now), UnpublishableReading);
    assert.throws(() => headlinesRecord({ ...fresh, categories: { world: { items: [{ title: 'No source', link: 'https://x.y/z', publishedAt: now }] } } }, now), UnpublishableReading);
    assert.throws(() => headlinesRecord({ ...fresh, categories: null }, now), UnpublishableReading);
  });
});
