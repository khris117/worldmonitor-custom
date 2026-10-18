/**
 * ISO 3166-1 alpha-2 codes for a natural hazard, for the strict country scope
 * of natural.hazard webhook subscriptions (scripts/shipping-webhook-worker.mjs).
 *
 * The agencies name the place in their own text (USGS and NRCan `place`,
 * GDACS and EONET titles), so the text decides first. Bounding boxes
 * (scripts/shared/country-bboxes.json) overlap at every border (Canada's box
 * covers Seattle), so they only place a point the text does not name: the
 * smallest box containing it wins, the ordering seed-climate-disasters.mjs
 * uses. Railway runs the worker with rootDirectory=scripts, so everything here
 * reads the scripts/shared copies.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { countryNameToIso2 } = require('../shared/country-name-to-iso2.cjs');

const COUNTRY_BBOXES = JSON.parse(readFileSync(new URL('../shared/country-bboxes.json', import.meta.url), 'utf8'));
const COUNTRY_NAMES = JSON.parse(readFileSync(new URL('../shared/country-names.json', import.meta.url), 'utf8'));

const KNOWN_CODES = new Set(Object.values(COUNTRY_NAMES));

function longitudeSpan([, west, , east]) {
  return west > east ? 360 - west + east : east - west;
}

const BBOXES_SMALLEST_FIRST = Object.entries(COUNTRY_BBOXES)
  .filter(([, bbox]) => Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite))
  .sort(([, a], [, b]) => (a[2] - a[0]) * longitudeSpan(a) - (b[2] - b[0]) * longitudeSpan(b));

function inBox(lat, lon, [south, west, north, east]) {
  if (lat < south || lat > north) return false;
  return west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
}

function validPoint(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** The smallest country bounding box containing the point, or null. */
export function pointToIso2(lat, lon) {
  if (!validPoint(lat, lon)) return null;
  for (const [code, bbox] of BBOXES_SMALLEST_FIRST) {
    if (inBox(lat, lon, bbox)) return code;
  }
  return null;
}

// Same normalization as country-name-to-iso2.cjs, so scans hit its key space.
function normalize(raw) {
  return String(raw || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[''‘’`.(),/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const US_STATES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
  'florida', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
  'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana',
  'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina',
  'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia',
  'wisconsin', 'wyoming',
]);
const US_BBOX = COUNTRY_BBOXES.US;

// Longest first, so "papua new guinea" wins over "guinea".
const NAMES_LONGEST_FIRST = Object.keys(COUNTRY_NAMES)
  .filter((name) => name.length >= 3)
  .sort((a, b) => b.length - a.length);

function scanForCountry(normalized) {
  const padded = ` ${normalized} `;
  for (const name of NAMES_LONGEST_FIRST) {
    if (padded.includes(` ${name} `)) return COUNTRY_NAMES[name];
  }
  return null;
}

/**
 * The country an agency's text names, or null. The last comma segment is the
 * country (or a US state) in USGS, NRCan and EONET IRWIN places; USGS writes
 * California as `CA`, which would otherwise read as Canada. "Georgia" is the
 * one name both lists carry: the point decides (inside the US box: the state).
 * Otherwise any country named in the text, longest name first.
 */
export function textToIso2(text, { lat = Number.NaN, lon = Number.NaN } = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const segments = text.split(',').map((segment) => segment.trim()).filter(Boolean);
  const last = segments.length > 1 ? segments[segments.length - 1] : '';
  if (last) {
    if (last === 'CA') return 'US';
    const token = normalize(last).replace(/ region$/, '');
    if (token === 'georgia') {
      return validPoint(lat, lon) && US_BBOX && inBox(lat, lon, US_BBOX) ? 'US' : 'GE';
    }
    if (US_STATES.has(token)) return 'US';
    const code = countryNameToIso2(last.replace(/\s+region$/i, ''));
    if (code && KNOWN_CODES.has(code)) return code;
  }
  return scanForCountry(normalize(text));
}

/**
 * 0 or 1 ISO2 codes for a hazard: the text's country, else the smallest box
 * containing the point, else none (open ocean, a mid-ocean ridge).
 */
export function hazardCountryCodes({ lat, lon, text }) {
  const code = textToIso2(text, { lat, lon }) ?? pointToIso2(lat, lon);
  return code ? [code] : [];
}
