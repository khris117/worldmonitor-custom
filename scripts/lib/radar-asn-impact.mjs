// National impact of an ASN-attributed Cloudflare Radar outage.
//
// Radar files some outage annotations against networks (ASNs) and no country.
// The CII counts such an outage for the country Radar places the ASN in only
// when it disrupted more than CII_OUTAGE_ASN_NATIONAL_SHARE of that country's
// Internet (server/worldmonitor/intelligence/v1/_risk-config.ts). This module
// measures that fraction from Radar's own traffic data, never from text:
//
//   impact = sum over the annotation's ASNs in the country of
//            share(ASN of the country's traffic, the 7 days before the outage)
//          x drop(ASN's own traffic during the outage vs the same hours a week earlier)
//
// Limits, kept visible on each record:
//  - The share is NetFlows bytes seen by Cloudflare, not users; Radar lists
//    the top 100 ASes per country, so an ASN outside that list is bounded by
//    the smallest listed share and the impact is an upper bound.
//  - The drop compares with the same hours one week earlier, so a holiday or
//    a recurring outage a week before distorts it.
//  - Hourly buckets dilute an outage much shorter than an hour; outages under
//    six hours are read in 15-minute buckets.
// The country's own traffic drop was rejected as the measure: on the year to
// 2026-10-23 it moved by -30% to +32% around ASN outages that carried 1-3% of
// the country's traffic, so it attributes unrelated swings to the outage.

export const ASN_IMPACT_MEASURE = 'asn-traffic-share-x-drop';

const HOUR_MS = 60 * 60 * 1000;
const QUARTER_MS = 15 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const TOP_ASES_LIMIT = 100;

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The annotation's ASNs grouped by the country Radar places each ASN in; ASNs with no country are left out. */
export function asnCountryGroups(annotation) {
  const groups = new Map();
  for (const detail of annotation?.asnsDetails ?? []) {
    const code = String(detail?.location?.code ?? '').toUpperCase();
    const asn = Number(detail?.asn);
    if (!/^[A-Z]{2}$/.test(code) || !Number.isInteger(asn) || asn <= 0) continue;
    if (!groups.has(code)) groups.set(code, { countryCode: code, countryName: detail.location.name || code, asns: [], asnNames: [] });
    const group = groups.get(code);
    group.asns.push(asn);
    group.asnNames.push(String(detail.name ?? ''));
  }
  return [...groups.values()];
}

/**
 * 1 - traffic during [startMs, endMs) / traffic in the same buckets one week
 * earlier, from one Radar timeseries spanning both; null without a baseline.
 * Clamped to [0, 1]: traffic above the baseline is no disruption.
 */
export function trafficDrop(result, startMs, endMs, stepMs) {
  const timestamps = result?.serie_0?.timestamps ?? [];
  const values = result?.serie_0?.values ?? [];
  const at = new Map(timestamps.map((t, i) => [Date.parse(t), Number(values[i])]));
  let during = 0;
  let before = 0;
  let buckets = 0;
  for (let t = Math.floor(startMs / stepMs) * stepMs; t < endMs; t += stepMs) {
    const now = at.get(t);
    const then = at.get(t - WEEK_MS);
    if (!Number.isFinite(now) || !Number.isFinite(then)) continue;
    during += now;
    before += then;
    buckets++;
  }
  if (buckets === 0 || before <= 0) return null;
  return Math.min(1, Math.max(0, 1 - during / before));
}

/**
 * Measures one country group of an ASN outage. `get(path)` returns a Radar
 * `result` object or throws. Never throws: a failure is an unknown impact.
 */
export async function measureAsnNationalImpact({ get, countryCode, asns, startMs, endMs, nowMs }) {
  const unknown = (reason) => ({ measure: ASN_IMPACT_MEASURE, nationalImpact: null, impactIsUpperBound: false, unknownReason: reason });
  if (!Number.isFinite(startMs) || startMs <= 0) return unknown('no start time');
  const end = Math.min(Number.isFinite(endMs) && endMs > startMs ? endMs : nowMs, nowMs);
  if (!(end > startMs)) return unknown('outage has not started');
  const step = end - startMs < 6 * HOUR_MS ? QUARTER_MS : HOUR_MS;
  const from = Math.floor(startMs / step) * step;
  const to = Math.ceil(end / step) * step;
  try {
    const top = await get(`/radar/netflows/top/ases?location=${countryCode}&dateStart=${iso(from - WEEK_MS)}&dateEnd=${iso(from)}&limit=${TOP_ASES_LIMIT}&format=json`);
    const listed = Array.isArray(top?.top_0) ? top.top_0 : [];
    const shareOf = new Map(listed.map((row) => [Number(row.clientASN), Number(row.value) / 100]));
    const smallest = listed.length ? Math.min(...listed.map((row) => Number(row.value) / 100)) : 0;
    let impact = 0;
    let upperBound = false;
    const parts = [];
    for (const asn of asns) {
      let share = shareOf.get(asn);
      if (!Number.isFinite(share)) {
        // Not among the listed ASes: its share is at most the smallest listed.
        share = listed.length >= TOP_ASES_LIMIT ? smallest : 0;
        upperBound = upperBound || listed.length >= TOP_ASES_LIMIT;
      }
      const agg = step === QUARTER_MS ? '15m' : '1h';
      const series = await get(`/radar/netflows/timeseries?asn=${asn}&dateStart=${iso(from - WEEK_MS)}&dateEnd=${iso(to)}&aggInterval=${agg}&format=json`);
      const drop = trafficDrop(series, startMs, end, step);
      if (drop == null) return unknown(`no baseline week for AS${asn}`);
      impact += share * drop;
      parts.push({ asn, share, drop });
    }
    return { measure: ASN_IMPACT_MEASURE, nationalImpact: Math.min(1, impact), impactIsUpperBound: upperBound, parts };
  } catch (err) {
    return unknown(String(err?.message || err).slice(0, 120));
  }
}
