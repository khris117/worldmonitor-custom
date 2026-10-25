import type { NotamAirspaceKind, NotamAirspaceRestriction } from '@/services/notam-airspace';

// Red for closures and no-go areas, warm tones for restrictions, cool tones
// for activity notices that do not by themselves bar entry.
export const NOTAM_AIRSPACE_COLORS: Record<NotamAirspaceKind, [number, number, number]> = {
  closure: [220, 38, 38],
  tfr: [239, 68, 68],
  prohibited: [190, 18, 60],
  restricted: [249, 115, 22],
  danger: [234, 179, 8],
  military: [168, 85, 247],
  reserved: [59, 130, 246],
  overflight: [14, 165, 233],
};

export const NOTAM_AIRSPACE_KIND_LABELS: Record<NotamAirspaceKind, string> = {
  closure: 'Airspace closed',
  tfr: 'Temporary flight restriction',
  prohibited: 'Prohibited area',
  restricted: 'Restricted area',
  danger: 'Danger area',
  military: 'Military operating area',
  reserved: 'Airspace reservation',
  overflight: 'Overflight restriction',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GROUND = /^(SFC|GND)$/;
const UNLIMITED = /^UNL$/;

/**
 * Feet for one altitude limit as the feed spells it (SFC, FL250, 5000FT AMSL,
 * 3000M AGL, UNL), 0 for the ground, Infinity for no ceiling, null when unreadable.
 */
function limitFeet(value: string | undefined): number | null {
  if (!value) return null;
  const raw = value.split(/[\r\n]/)[0]!.trim().replace(/[).]+$/, '').toUpperCase();
  if (GROUND.test(raw)) return 0;
  if (UNLIMITED.test(raw)) return Infinity;
  const fl = /^FL\s*(\d{1,3})$/.exec(raw);
  if (fl) return Number(fl[1]) * 100;
  const m = /^(\d+)\s*(FT|M)?\b/.exec(raw);
  if (!m) return null;
  if (m[2] !== 'M') return Number(m[1]);
  const feet = Number(m[1]) * 3.28084;
  return Math.round(feet / (feet >= 1000 ? 100 : 10)) * (feet >= 1000 ? 100 : 10);
}

function altitudeBand(lower: string | undefined, upper: string | undefined): string {
  const lo = limitFeet(lower);
  const hi = limitFeet(upper);
  const ft = (n: number) => n.toLocaleString('en-US');
  if (lo === null || hi === null || lo === Infinity || hi < lo) return '';
  if (hi === lo) return lo === 0 ? '' : `At ${ft(lo)} ft`;
  if (hi === Infinity) return lo === 0 ? 'Any altitude' : `${ft(lo)} ft and above`;
  return lo === 0 ? `Ground to ${ft(hi)} ft` : `${ft(lo)} to ${ft(hi)} ft`;
}

function clock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

function day(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const year = d.getUTCFullYear() === new Date(nowMs).getUTCFullYear() ? '' : ` ${d.getUTCFullYear()}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}`;
}

function sameUtcDay(a: number, b: number): boolean {
  return new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
}

function timing(row: NotamAirspaceRestriction, nowMs: number): string {
  if (row.upcoming && row.startsAt !== null) {
    return sameUtcDay(row.startsAt, nowMs) ? `Starts ${clock(row.startsAt)} today` : `Starts ${day(row.startsAt, nowMs)}, ${clock(row.startsAt)}`;
  }
  if (row.endsAt === null) return 'Permanent';
  const until = sameUtcDay(row.endsAt, nowMs) ? `${clock(row.endsAt)} today` : day(row.endsAt, nowMs);
  return row.schedule ? `At set times until ${until}` : `Until ${until}`;
}

/**
 * Tooltip HTML: what the area is, how high it reaches and until when. The
 * area itself is drawn on the map, so codes, coordinates and the raw NOTAM
 * text stay out. `text` must HTML-escape: every NOTAM field is upstream data.
 */
export function notamAirspaceTooltip(row: NotamAirspaceRestriction, text: (value: unknown) => string, nowMs = Date.now()): string {
  const [r, g, b] = NOTAM_AIRSPACE_COLORS[row.kind] ?? [239, 68, 68];
  const band = altitudeBand(row.lower, row.upper);
  return `<div class="deckgl-tooltip"><strong style="color:rgb(${r},${g},${b});">&#9888; ${text(NOTAM_AIRSPACE_KIND_LABELS[row.kind] ?? 'NOTAM')}</strong>`
    + (band ? `<br/>${text(band)}` : '')
    + `<br/>${text(timing(row, nowMs))}`
    + `<br/><span style="opacity:.6">FAA NOTAM ${text(row.number)}</span></div>`;
}
