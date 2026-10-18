// Contract for /reference/coverage/: every panel, map layer and MCP tool by
// name, generated from the registries the product reads.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { buildCorpus } from '../scripts/build-crawlable-corpus.mjs';
import {
  assertCatalogComplete,
  assertWrittenDescriptionsTargetPanels,
  buildPanelGroups,
  feedNamesByCategory,
  feedPanelDescription,
  firstSentence,
  PANEL_DESCRIPTIONS_PATH,
  tooltipText,
} from '../scripts/build-coverage-catalog.mjs';
import { ALL_PANELS } from '../src/config/panels.ts';
import { getCompleteLayerCatalogKeys } from '../src/config/map-layer-definitions.ts';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('coverage catalog text', () => {
  it('turns a tooltip into plain prose without its title or interaction hints', () => {
    const html = '<strong>Supply Chain Monitor</strong> Global logistics:<ul><li><strong>Chokepoints</strong>: transit status &amp; scores</li><li><strong>U</strong>nrest: protests</li></ul>Click a chokepoint card to expand transit history chart.';
    assert.equal(tooltipText(html), 'Global logistics: Chokepoints: transit status & scores; Unrest: protests.');
  });

  it('keeps sentences that are not interaction hints', () => {
    assert.equal(
      tooltipText('<strong>Methodology</strong> Composite score.<br>Auto-refreshes every 5 minutes.'),
      'Composite score. Auto-refreshes every 5 minutes.',
    );
    assert.equal(tooltipText(undefined), '');
  });

  it('keeps the first sentence of a tool description and cuts long ones on a word', () => {
    assert.equal(firstSentence('Return rows. Seeded-cache read.'), 'Return rows.');
    const long = `${'word '.repeat(80)}end.`;
    const cut = firstSentence(long, 40);
    assert.ok(cut.endsWith('…') && cut.length <= 41, cut);
  });

  it('describes a news panel by its feeds', () => {
    assert.equal(feedPanelDescription(['A']), 'Headlines from A.');
    assert.equal(
      feedPanelDescription(['A', 'B', 'C', 'D', 'E']),
      'Headlines from 5 news feeds, including A, B, C and D.',
    );
    assert.equal(feedPanelDescription(undefined), '');
    const merged = feedNamesByCategory({
      full: { europe: [{ name: 'A' }, { name: 'B' }] },
      tech: { europe: [{ name: 'B' }, { name: 'C' }] },
    });
    assert.deepEqual(merged.get('europe'), ['A', 'B', 'C']);
  });
});

describe('coverage catalog panel groups', () => {
  const allPanels = {
    'fear-greed': { name: 'Fear & Greed' },
    europe: { name: 'Europe' },
    markets: { name: 'Markets', premium: 'locked' },
  };
  const categoryMap = {
    core: { labelKey: 'header.panelCatCore', panelKeys: ['fear-greed', 'europe'] },
    tech: { labelKey: 'header.panelCatMarkets', panelKeys: ['markets'], variants: ['tech'] },
    fin: { labelKey: 'header.panelCatMarkets', panelKeys: ['markets'], variants: ['finance'] },
  };
  const locale = {
    header: { panelCatCore: 'Core', panelCatMarkets: 'Markets' },
    components: { fearGreed: { infoTooltip: '<strong>Fear</strong> CNN index.' } },
  };

  it('prefers the tooltip, then a written description, then the feed list', () => {
    const groups = buildPanelGroups({
      allPanels,
      categoryMap,
      locale,
      writtenDescriptions: { 'fear-greed': 'Ignored.', markets: 'Shows markets.' },
      feedNames: new Map([['europe', ['France 24']]]),
    });
    const byId = Object.fromEntries(groups.flatMap((group) => group.panels).map((panel) => [panel.id, panel]));
    assert.equal(byId['fear-greed'].description, 'CNN index.');
    assert.equal(byId.markets.description, 'Shows markets.');
    assert.equal(byId.europe.description, 'Headlines from France 24.');
  });

  it('lists a panel once, under one group per label, with every dashboard it appears on', () => {
    const groups = buildPanelGroups({ allPanels, categoryMap, locale });
    assert.deepEqual(groups.map((group) => group.label), ['Core', 'Markets']);
    const markets = groups[1].panels;
    assert.equal(markets.length, 1);
    assert.deepEqual(markets[0].variants, ['tech', 'finance']);
    assert.equal(markets[0].pro, true);
    assert.equal(groups[0].panels[0].variants.length, 6, 'a category with no variants is on every dashboard');
  });

  it('fails when a panel is in no picker category or a written description names no panel', () => {
    const groups = buildPanelGroups({ allPanels, categoryMap, locale });
    assert.throws(
      () => assertCatalogComplete({ panelGroups: groups, tools: [], layers: [{}] }, { panelCount: 4, toolCount: 0 }),
      /lists 3 panels but the panel registry has 4/,
    );
    assert.throws(() => assertWrittenDescriptionsTargetPanels({ gone: 'x' }, allPanels), /unknown panels: gone/);
  });
});

describe('coverage catalog page', () => {
  let outDir;
  let manifest;
  let html;
  let dataset;

  before(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'wm-coverage-corpus-'));
    manifest = await buildCorpus({ rootDir: repoRoot, outDir, baseUrl: 'https://www.worldmonitor.app' });
    html = readFileSync(join(outDir, 'reference', 'coverage', 'index.html'), 'utf8');
    dataset = JSON.parse(readFileSync(join(outDir, 'reference', 'coverage', 'coverage.json'), 'utf8'));
  });

  after(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('lists every panel, catalog layer and MCP tool in the registries', () => {
    const panelIds = dataset.panelGroups.flatMap((group) => group.panels.map((panel) => panel.id));
    assert.deepEqual([...panelIds].sort(), Object.keys(ALL_PANELS).sort());
    assert.deepEqual(dataset.layers.map((layer) => layer.id), getCompleteLayerCatalogKeys('full'));
    assert.deepEqual(dataset.tools.map((tool) => tool.name).sort(), TOOL_REGISTRY.map((tool) => tool.name).sort());
    for (const tool of TOOL_REGISTRY) assert.ok(html.includes(`<code>${tool.name}</code>`), `page lists ${tool.name}`);
  });

  it('publishes plain-text descriptions and states counts that match the lists', () => {
    for (const panel of dataset.panelGroups.flatMap((group) => group.panels)) {
      assert.ok(!/<\/?[a-z]/i.test(panel.description), `${panel.id} description has markup`);
    }
    assert.equal(dataset.counts.panels, Object.keys(ALL_PANELS).length);
    assert.equal(dataset.counts.tools, TOOL_REGISTRY.length);
    assert.match(html, new RegExp(`${dataset.counts.panels} dashboard panels in ${dataset.counts.panelGroups} groups, ${dataset.counts.layers} map layers and ${dataset.counts.tools} MCP tools`));
  });

  it('answers "What does World Monitor cover?" in FAQ markup and is linked from every corpus page', () => {
    const faq = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map(([, raw]) => JSON.parse(raw))
      .find((entry) => entry['@type'] === 'FAQPage');
    assert.equal(faq?.mainEntity?.[0]?.name, 'What does World Monitor cover?');
    assert.match(html, /<link rel="canonical" href="https:\/\/www\.worldmonitor\.app\/reference\/coverage\/">/);
    assert.equal(manifest.sections.coverage.index, '/reference/coverage/');
    const chokepoints = readFileSync(join(outDir, 'chokepoints', 'index.html'), 'utf8');
    assert.ok(chokepoints.includes('<a href="/reference/coverage/">Coverage</a>'));
  });

  it('keeps written descriptions for panels that exist', () => {
    const written = JSON.parse(readFileSync(join(repoRoot, PANEL_DESCRIPTIONS_PATH), 'utf8'));
    assert.doesNotThrow(() => assertWrittenDescriptionsTargetPanels(written, ALL_PANELS));
  });
});
