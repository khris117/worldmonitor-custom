import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';

const tool = CACHE_TOOLS.find(entry => entry.name === 'get_news_intelligence');
const serverCard = JSON.parse(
  readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'),
);

describe('get_news_intelligence credibility discovery (#6597)', () => {
  it('advertises credibilityScore in the canonical tool description', () => {
    assert.ok(tool, 'get_news_intelligence must stay registered');
    assert.match(tool.description, /credibilityScore/);
    assert.match(tool.description, /source reliability/i);
  });

  it('keeps the public server card equal to the canonical description', () => {
    const cardTool = serverCard.tools.find(entry => entry.name === 'get_news_intelligence');
    assert.ok(cardTool, 'get_news_intelligence must stay published in the server card');
    assert.equal(cardTool.description, tool.description);
  });

  it('states that story filters narrow the seeder\'s global top-story selection', async () => {
    // A country call returned 2 stories because the filter runs over the
    // 8 the seeder selected worldwide; an agent reading the old description
    // took that as all the coverage there was.
    const seeder = readFileSync(new URL('../scripts/seed-insights.mjs', import.meta.url), 'utf8');
    const selected = Number(seeder.match(/selectTopStories\(clusters, (\d+), selectionStats\)/)?.[1]);
    assert.ok(Number.isInteger(selected), 'seed-insights must still pass a literal top-story count');
    assert.match(tool.description, new RegExp(`the ${selected} AI-classified top stories the dashboard selects worldwide`));
    assert.match(tool.description, new RegExp(`narrow those ${selected} and never search the wider feed`));
    const { SERVER_INSTRUCTIONS } = await import('../api/mcp/constants.ts');
    assert.match(SERVER_INSTRUCTIONS, new RegExp(`get_news_intelligence's country filter only narrows its ${selected} global top stories`));
    assert.match(tool.inputSchema.properties.country.description, new RegExp(`the ${selected} top stories`));
  });

  it('honors GDELT observation age as well as its seeder clock', () => {
    const gdeltCheck = tool._freshnessChecks.find(
      ({ key }) => key === 'seed-meta:intelligence:gdelt-intel',
    );
    assert.equal(gdeltCheck?.honorContentAge, true);
  });
});
