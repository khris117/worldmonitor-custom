import { createTransitTracker } from './chokepoint-transit-tracker.js';

const STATE_KEY = 'supply_chain:transit-gates:v1';
const INDEX_KEY = 'supply_chain:transit-gate-times:v1';
const CROSSINGS_KEY = 'supply_chain:chokepoint-crossings:v1';
const COUNT_RETENTION_MS = 24.5 * 60 * 60 * 1000;

// Replay each affected vessel's ordered observations. Late batches can supply
// a missing first gate or an earlier completion report. Replace only this
// journal's derived events, atomically with its observation history.
export const MERGE_TRANSIT_GATES = `
local now = tonumber(ARGV[1])
local gap = tonumber(ARGV[2])
local cooldown = tonumber(ARGV[3])
local countRetention = tonumber(ARGV[4])
local cutoff = now - gap - countRetention
local groups = {}
for _, row in ipairs(cjson.decode(ARGV[5])) do
  local ts = tonumber(row[5])
  if ts <= now and ts >= cutoff then
    local id = cjson.encode({row[1], row[2]})
    if not groups[id] then groups[id] = {name=row[1], mmsi=row[2], rows={}} end
    table.insert(groups[id].rows, {row[3], row[4], ts})
  end
end
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
  for _, event in ipairs(previous.crossings) do
    redis.call('ZREM', KEYS[3], cjson.encode(event))
  end
  for _, event in ipairs(crossings) do
    redis.call('ZADD', KEYS[3], event[4], cjson.encode(event))
  end
  redis.call('HSET', KEYS[1], id, cjson.encode({observations=retained, crossings=crossings, anchor=anchor}))
  redis.call('ZADD', KEYS[2], state.ts, id)
end
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', '(' .. cutoff)
for _, id in ipairs(expired) do redis.call('HDEL', KEYS[1], id) end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', '(' .. cutoff)
redis.call('EXPIRE', KEYS[1], math.ceil((gap + countRetention) / 1000) + 3600)
redis.call('EXPIRE', KEYS[2], math.ceil((gap + countRetention) / 1000) + 3600)
redis.call('EXPIRE', KEYS[3], 25 * 60 * 60)
return 1
`;

export function createDurableTransitTracker({ gates, maxTransitMs, cooldownMs, evaluate }) {
  let pending = [];
  let inFlight = null;
  const tracker = createTransitTracker({ gates, maxTransitMs, cooldownMs,
    crossings: new Map(),
    onGateObservation: (mmsi, name, side, type, ts) => pending.push([name, mmsi, side, type, ts]),
  });

  function prune(now) {
    pending = pending.filter(row => row[4] >= now - maxTransitMs - COUNT_RETENTION_MS);
  }

  async function flush(now) {
    if (inFlight) { await inFlight; return flush(now); }
    const batch = pending.filter(row => row[4] <= now);
    pending = pending.filter(row => row[4] > now);
    const operation = (async () => {
      try {
        const result = await evaluate(MERGE_TRANSIT_GATES,
          [STATE_KEY, INDEX_KEY, CROSSINGS_KEY],
          [now, maxTransitMs, cooldownMs, COUNT_RETENTION_MS, JSON.stringify(batch)]);
        if (result !== 1) throw new Error('Durable transit gate update failed');
      } catch (error) {
        pending = [...batch, ...pending];
        prune(now);
        throw error;
      }
    })();
    inFlight = operation;
    try { await operation; } finally { if (inFlight === operation) inFlight = null; }
  }

  return { observe: tracker.observe, prune, flush };
}
