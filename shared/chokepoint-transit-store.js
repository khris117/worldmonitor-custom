import { createTransitTracker } from './chokepoint-transit-tracker.js';

const STATE_KEY = 'supply_chain:transit-gates:v1';
const INDEX_KEY = 'supply_chain:transit-gate-times:v1';
const CROSSINGS_KEY = 'supply_chain:chokepoint-crossings:v1';
const COUNT_RETENTION_MS = 24.5 * 60 * 60 * 1000;
// Bound outage memory, shared storage, and the history replayed by one EVAL.
const MAX_PENDING = 20000;
const MAX_VESSELS = 10000;
const MAX_VESSEL_ROWS = 10000;
const MAX_TOTAL_ROWS = 250000;

// Replay each affected vessel's ordered observations. Late batches can supply
// a missing first gate or an earlier completion report. Replace only this
// journal's derived events, atomically with its observation history.
export const MERGE_TRANSIT_GATES = `
local now = tonumber(ARGV[1])
local gap = tonumber(ARGV[2])
local cooldown = tonumber(ARGV[3])
local countRetention = tonumber(ARGV[4])
local cutoff = now - gap - countRetention
local total = tonumber(redis.call('HGET', KEYS[1], '_rows') or '0')
local incompleteUntil = math.max(tonumber(redis.call('HGET', KEYS[1], '_incompleteUntil') or '0'), tonumber(ARGV[9]))
local function saveMetadata()
  redis.call('HSET', KEYS[1], '_rows', total, '_incompleteUntil', incompleteUntil)
  redis.call('EXPIRE', KEYS[1], math.ceil((gap + countRetention) / 1000) + 3600)
  redis.call('EXPIRE', KEYS[2], math.ceil((gap + countRetention) / 1000) + 3600)
end
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', '(' .. cutoff, 'LIMIT', 0, 4)
for _, id in ipairs(expired) do
  local raw = redis.call('HGET', KEYS[1], id)
  if raw then total = total - #cjson.decode(raw).observations end
  redis.call('HDEL', KEYS[1], id)
  redis.call('ZREM', KEYS[2], id)
end
local vessels = redis.call('ZCARD', KEYS[2])
local groups = {}
local newest = 0
for _, row in ipairs(cjson.decode(ARGV[5])) do
  local ts = tonumber(row[5])
  if ts <= now and ts >= cutoff then
    newest = math.max(newest, ts)
    local id = cjson.encode({row[1], row[2]})
    if not groups[id] then groups[id] = {name=row[1], mmsi=row[2], rows={}} end
    table.insert(groups[id].rows, {row[3], row[4], ts})
  end
end
local updates = {}
local nextTotal = total
for id, group in pairs(groups) do
  local raw = redis.call('HGET', KEYS[1], id)
  local previous = raw and cjson.decode(raw) or {observations={}, crossings={}, anchor={ts=0, crossedAt=0}}
  local observations, unique = {}, {}
  for _, rows in ipairs({previous.observations, group.rows}) do
    for _, row in ipairs(rows) do
      local key = row[1] .. ':' .. row[3]
      if row[3] > previous.anchor.ts and not unique[key] then
        unique[key] = true
        table.insert(observations, row)
      end
    end
  end
  table.sort(observations, function(a,b)
    if a[3] == b[3] then return a[1] < b[1] end
    return a[3] < b[3]
  end)
  local state = previous.anchor
  local anchor = previous.anchor
  local retained, crossings = {}, {}
  for _, row in ipairs(observations) do
    local side, kind, ts = row[1], row[2], row[3]
    if ts > state.ts then
      local crossedAt = state.crossedAt
      if state.side and state.side ~= side and ts - state.ts <= gap
          and (crossedAt == 0 or ts - crossedAt >= cooldown) then
        crossedAt = ts
        if ts > now - countRetention then
          table.insert(crossings, {group.name, group.mmsi, kind, ts})
        end
      end
      state = {side=side, ts=ts, crossedAt=crossedAt}
      if ts < cutoff then anchor = state else table.insert(retained, row) end
    end
  end
  if not raw then vessels = vessels + 1 end
  nextTotal = nextTotal - #previous.observations + #retained
  if vessels > tonumber(ARGV[6]) or #retained > tonumber(ARGV[7]) or nextTotal > tonumber(ARGV[8]) then
    incompleteUntil = math.max(incompleteUntil, newest + gap + countRetention)
    saveMetadata()
    return {0, incompleteUntil}
  end
  table.insert(updates, {id=id, previous=previous.crossings, retained=retained, crossings=crossings, anchor=anchor, ts=state.ts})
end
for _, update in ipairs(updates) do
  for _, event in ipairs(update.previous) do
    redis.call('ZREM', KEYS[3], cjson.encode(event))
  end
  for _, event in ipairs(update.crossings) do
    redis.call('ZADD', KEYS[3], event[4], cjson.encode(event))
  end
  redis.call('HSET', KEYS[1], update.id, cjson.encode({observations=update.retained, crossings=update.crossings, anchor=update.anchor}))
  redis.call('ZADD', KEYS[2], update.ts, update.id)
end
total = nextTotal
saveMetadata()
redis.call('EXPIRE', KEYS[3], 25 * 60 * 60)
return {1, incompleteUntil}
`;

export function createDurableTransitTracker({ gates, maxTransitMs, cooldownMs, evaluate }) {
  let pending = [];
  let inFlight = null;
  let buffered = 0;
  let incompleteUntil = 0;
  const tracker = createTransitTracker({ gates, maxTransitMs, cooldownMs,
    crossings: new Map(),
    onGateObservation: (mmsi, name, side, type, ts) => {
      if (buffered >= MAX_PENDING) {
        // A lost input can affect a later journey for gap + count retention.
        // Keep that fixed source deadline visible, including across restarts.
        incompleteUntil = Math.max(incompleteUntil, ts + maxTransitMs + COUNT_RETENTION_MS);
        return;
      }
      pending.push([name, mmsi, side, type, ts]);
      buffered++;
    },
  });

  function prune(now) {
    const before = pending.length;
    pending = pending.filter(row => row[4] >= now - maxTransitMs - COUNT_RETENTION_MS);
    buffered -= before - pending.length;
  }

  async function flush(now) {
    if (inFlight) { await inFlight; return flush(now); }
    prune(now);
    const batch = pending.filter(row => row[4] <= now);
    batch.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[4] - b[4]);
    pending = pending.filter(row => row[4] > now);
    const operation = (async () => {
      let committed = 0;
      try {
        do {
          let end = committed;
          const vessels = new Set();
          while (end < batch.length && end - committed < 1000) {
            const id = JSON.stringify(batch[end].slice(0, 2));
            if (!vessels.has(id) && vessels.size === 4) break;
            vessels.add(id);
            end++;
          }
          const chunk = batch.slice(committed, end);
          const result = await evaluate(MERGE_TRANSIT_GATES,
            [STATE_KEY, INDEX_KEY, CROSSINGS_KEY],
            [now, maxTransitMs, cooldownMs, COUNT_RETENTION_MS, JSON.stringify(chunk),
              MAX_VESSELS, MAX_VESSEL_ROWS, MAX_TOTAL_ROWS, incompleteUntil]);
          if (!Array.isArray(result) || result.length !== 2 || !Number.isFinite(result[1])) {
            throw new Error('Durable transit gate update failed');
          }
          incompleteUntil = Math.max(incompleteUntil, result[1]);
          if (result[0] !== 1) throw new Error('Durable transit gate capacity exceeded');
          buffered -= chunk.length;
          committed += chunk.length;
        } while (committed < batch.length);
      } catch (error) {
        pending = [...batch.slice(committed), ...pending];
        prune(now);
        throw error;
      }
    })();
    inFlight = operation;
    try {
      await operation;
      if (incompleteUntil > now) throw new Error('Durable transit gate capacity exceeded; incomplete input window');
    } finally { if (inFlight === operation) inFlight = null; }
  }

  return { observe: tracker.observe, prune, flush };
}
