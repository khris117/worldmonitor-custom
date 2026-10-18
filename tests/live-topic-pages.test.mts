import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import middleware from '../middleware';
import {
  LIVE_TOPIC_PAGES,
  liveTopicPageForPath,
  liveTopicReading,
  liveTopicRpcPath,
} from '../scripts/live-pages/index.mjs';
import { liveSectionMarkers, replaceLiveSection } from '../scripts/live-pages/common.mjs';
import { debtAt } from '../scripts/live-pages/national-debt.mjs';
import { isPublicSharedRpcRequest, LIVE_TOPIC_RPC_PATHS } from '../src/shared/public-rpc-cache.ts';

const NOW = Date.parse('2026-10-18T09:00:00Z');
const HOUR = 3_600_000;

const page = (slug: string) => {
  const found = LIVE_TOPIC_PAGES.find((candidate) => candidate.slug === slug);
  assert.ok(found, slug);
  return found;
};

function category(score: number, degraded = false) {
  return { score, weight: 0.1, contribution: score / 10, degraded, inputsJson: '{}' };
}

function fearGreedPayload(seededAt = new Date(NOW - 2 * HOUR).toISOString()) {
  return {
    compositeScore: 56.8,
    compositeLabel: 'Neutral',
    previousScore: 55,
    seededAt,
    sentiment: category(34, true),
    volatility: category(60),
    positioning: category(50),
    trend: category(70),
    breadth: category(52),
    momentum: category(61),
    liquidity: category(45),
    credit: category(58),
    macro: category(40),
    crossAsset: category(66),
    vix: 19.99,
    cnnFearGreed: 18,
    cnnLabel: 'Extreme Fear',
    aaiiBull: 39,
    aaiiBear: 42,
  };
}

function debtPayload(seededAt = new Date(NOW - 2 * 24 * HOUR).toISOString()) {
  const baselineTs = Date.parse('2027-01-01T00:00:00Z');
  return {
    seededAt,
    entries: [
      { iso3: 'USA', debtUsd: 44e12, gdpUsd: 34e12, debtToGdp: 128.7, perSecondRate: 84_737, baselineTs, source: 'IMF WEO 2027' },
      { iso3: 'JPN', debtUsd: 9e12, gdpUsd: 4e12, debtToGdp: 230, perSecondRate: 5_000, baselineTs, source: 'IMF WEO 2027' },
      { iso3: 'NOR', debtUsd: 0.2e12, gdpUsd: 0.5e12, debtToGdp: 40, perSecondRate: 0, baselineTs, source: 'IMF WEO 2027' },
    ],
  };
}

function outagesPayload() {
  return {
    outages: [
      { id: 'a', country: 'Namibia', severity: 'OUTAGE_SEVERITY_TOTAL', categories: ['Cloudflare Radar', 'POWER OUTAGE'], detectedAt: NOW - 4 * 24 * HOUR, endedAt: NOW - 3 * 24 * HOUR, description: 'Substation fault.', link: 'https://x.com/CloudflareRadar/status/1' },
      { id: 'b', country: 'Russian Federation', severity: 'OUTAGE_SEVERITY_PARTIAL', categories: ['Cloudflare Radar', 'MILITARY ACTION'], detectedAt: NOW - 11 * 24 * HOUR, endedAt: 0, description: '', link: 'javascript:alert(1)' },
    ],
  };
}

function marketsPayload(fetchedAt = NOW - 30 * 60_000) {
  return {
    fetchedAt,
    dataAvailable: true,
    markets: [
      { id: 'iran', title: 'Will the U.S. invade Iran before 2027?', yesPrice: 0.145, volume: 74_529_597, url: 'https://polymarket.com/event/iran', closesAt: Date.parse('2026-12-31T23:59:00Z'), category: '', source: 'MARKET_SOURCE_POLYMARKET' },
      { id: 'fed', title: 'Fed cut in December </script><script>alert(1)</script>', yesPrice: 0.6, volume: 2_000_000, url: 'https://evil.example/x', closesAt: 0, category: '', source: 'MARKET_SOURCE_KALSHI' },
    ],
  };
}

describe('live topic readings', () => {
  it('reads the Fear & Greed composite with CNN and AAII beside it, and refuses a stale seed', () => {
    const record = liveTopicReading(page('fear-and-greed-index'), fearGreedPayload(), NOW);
    assert.equal(record.score, 56.8);
    assert.deepEqual(record.cnn, { score: 18, label: 'Extreme Fear' });
    assert.deepEqual(record.aaii, { bull: 39, bear: 42 });
    assert.equal(record.categories.length, 10);
    assert.equal(record.categories[0].partial, true, 'a degraded category is shown as partial, not dropped');
    assert.equal(liveTopicReading(page('fear-and-greed-index'), fearGreedPayload(new Date(NOW - 25 * HOUR).toISOString()), NOW), null);
    assert.equal(liveTopicReading(page('fear-and-greed-index'), { compositeScore: 140, compositeLabel: 'x', seededAt: new Date(NOW).toISOString() }, NOW), null);
  });

  it('extrapolates debt the way the dashboard panel does and refuses data older than 60 days', () => {
    const payload = debtPayload();
    const record = liveTopicReading(page('national-debt-clock'), payload, NOW);
    const expectedUs = 44e12 + 84_737 * ((NOW - payload.entries[0].baselineTs) / 1000);
    assert.equal(record.us.debtUsd, expectedUs);
    assert.equal(debtAt(payload.entries[2], NOW), 0.2e12, 'a surplus country does not tick');
    assert.deepEqual(record.top.map((country: { name: string }) => country.name), ['United States', 'Japan', 'Norway']);
    assert.equal(record.countryCount, 3);
    assert.equal(liveTopicReading(page('national-debt-clock'), debtPayload(new Date(NOW - 61 * 24 * HOUR).toISOString()), NOW), null);
  });

  it('lists outages newest first, marks ongoing ones and drops unsafe links', () => {
    const record = liveTopicReading(page('internet-outages'), outagesPayload(), NOW);
    assert.deepEqual(record.outages.map((outage: { country: string }) => outage.country), ['Namibia', 'Russian Federation']);
    assert.equal(record.ongoing, 1);
    assert.equal(record.outages[0].severity, 'Nationwide');
    assert.equal(record.outages[1].link, null);
    const empty = liveTopicReading(page('internet-outages'), { outages: [] }, NOW);
    assert.equal(empty.total, 0, 'an empty seeded list is a real "no disruptions" reading');
  });

  it('ranks markets by volume, keeps venue links on the venue host and refuses a stale capture', () => {
    const record = liveTopicReading(page('prediction-markets'), marketsPayload(), NOW);
    assert.equal(record.markets[0].yesPct, 14.5);
    assert.equal(record.markets[1].url, null, 'a link off the venue host is dropped');
    assert.equal(liveTopicReading(page('prediction-markets'), marketsPayload(NOW - 7 * HOUR), NOW), null);
    assert.equal(liveTopicReading(page('prediction-markets'), { dataAvailable: false, markets: [] }, NOW), null);
  });

  it('lets a programming error propagate instead of publishing "no reading"', () => {
    const broken = { ...page('internet-outages'), record: () => { throw new TypeError('bug'); } };
    assert.throws(() => liveTopicReading(broken, {}, NOW), TypeError);
  });
});

describe('live topic sections', () => {
  it('states the reading with its date and carries matching FAQ markup that cannot close its script tag', () => {
    const topic = page('prediction-markets');
    const section = topic.renderSection(liveTopicReading(topic, marketsPayload(), NOW), { live: true });
    const answer = section.match(/<p data-live-answer>([^<]*)<\/p>/)?.[1] ?? '';
    assert.match(answer, /^As of Oct 18, 2026/);
    const ld = section.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? '';
    assert.ok(!ld.includes('</script'), 'market titles cannot end the JSON-LD script');
    const faq = JSON.parse(ld);
    assert.equal(faq.mainEntity[0].name, topic.question);
    assert.ok(section.includes('data-live-at-request'));
  });

  it('renders "no current reading" without a dated claim when the record is null', () => {
    for (const topic of LIVE_TOPIC_PAGES) {
      const section = topic.renderSection(null, { live: false });
      assert.ok(!section.includes('<time'), `${topic.slug} makes no dated claim without a reading`);
      assert.match(section, /No current reading/);
    }
  });

  it('replaces exactly one marked section', () => {
    const { start, end } = liveSectionMarkers('x');
    assert.equal(replaceLiveSection(`a${start}old${end}b`, 'x', 'new'), 'anewb');
    assert.equal(replaceLiveSection('no markers', 'x', 'new'), null);
    assert.equal(replaceLiveSection(`${start}1${end}${start}2${end}`, 'x', 'new'), null);
  });
});

describe('live topic public shapes', () => {
  it('opens exactly the registry routes to anonymous reads, and only as the bare public=1 shape', () => {
    assert.deepEqual([...LIVE_TOPIC_RPC_PATHS].sort(), LIVE_TOPIC_PAGES.map(liveTopicRpcPath).sort());
    for (const topic of LIVE_TOPIC_PAGES) {
      assert.ok(isPublicSharedRpcRequest(`https://www.worldmonitor.app${topic.statusPath}`), topic.statusPath);
      assert.ok(!isPublicSharedRpcRequest(`https://www.worldmonitor.app${liveTopicRpcPath(topic)}`));
      assert.ok(!isPublicSharedRpcRequest(`https://www.worldmonitor.app${topic.statusPath}&country=US`));
      assert.equal(liveTopicPageForPath(topic.path), topic);
    }
  });
});

describe('live topic pages through the middleware', () => {
  const topic = page('fear-and-greed-index');
  const pageUrl = `https://www.worldmonitor.app${topic.path}`;
  const builtUrl = `${pageUrl}?wm-built=1`;
  const builtHtml = `<!doctype html><html><body><main><h1>${topic.h1}</h1>
${topic.renderSection(null, { live: false })}
</main></body></html>`;

  afterEach(() => mock.restoreAll());

  function stubFetch(statusResponse: () => Response) {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url === builtUrl) {
        return new Response(builtHtml, { status: 200, headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=3600', etag: 'W/"b"' } });
      }
      if (url.includes(liveTopicRpcPath(topic))) return statusResponse();
      throw new Error(`unexpected fetch ${url}`);
    });
    return calls;
  }

  function request(method = 'GET') {
    return new Request(pageUrl, { method, headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; OAI-SearchBot/1.0)' } });
  }

  it('serves the current reading with the short cache policy', async () => {
    const calls = stubFetch(() => Response.json(fearGreedPayload(new Date(Date.now() - HOUR).toISOString())));
    const response = await middleware(request());
    assert.ok(response instanceof Response);
    const html = await response.text();
    assert.equal(response.headers.get('x-wm-live-page'), topic.slug);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300, must-revalidate');
    assert.equal(response.headers.get('etag'), null);
    assert.match(html, /World Monitor Fear &amp; Greed Index reads 56\.8 out of 100/);
    const statusCall = calls.find((url) => url.includes(liveTopicRpcPath(topic)));
    assert.equal(new URL(statusCall!).search, '?public=1');
  });

  it('keeps the built page when the reading is stale or the read fails', async () => {
    stubFetch(() => Response.json(fearGreedPayload(new Date(Date.now() - 30 * HOUR).toISOString())));
    let response = await middleware(request());
    assert.equal(await response!.text(), builtHtml);
    assert.equal(response!.headers.get('x-wm-live-page'), null);
    mock.restoreAll();
    stubFetch(() => new Response('nope', { status: 503 }));
    response = await middleware(request());
    assert.equal(await response!.text(), builtHtml);
    assert.equal(response!.headers.get('cache-control'), 'public, max-age=300, must-revalidate');
  });

  it('leaves HEAD and the built-page fetch alone', async () => {
    stubFetch(() => Response.json(fearGreedPayload()));
    assert.equal(await middleware(request('HEAD')), undefined);
    assert.equal(await middleware(new Request(builtUrl, { headers: { accept: 'text/html' } })), undefined);
  });
});
