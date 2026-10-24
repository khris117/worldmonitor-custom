import { createTransitTracker } from './chokepoint-transit-tracker.js';

const STATE_KEY = 'supply_chain:transit-gates:v1';
const INDEX_KEY = 'supply_chain:transit-gate-times:v1';
const CROSSINGS_KEY = 'supply_chain:chokepoint-crossings:v1';

// Commit the last gate and any resulting crossing together. A retry cannot
// advance the same vessel twice, and overlapping relays cannot replace a
// newer sighting with an older one. Timestamps are observation times.
export const MERGE_TRANSIT_GATES = `
local now = tonumber(ARGV[1])
local gap = tonumber(ARGV[2])
local cooldown = tonumber(ARGV[3])
local rows = cjson.decode(ARGV[4])
for _, row in ipairs(rows) do
  local name, mmsi, side, kind, ts = row[1], row[2], row[3], row[4], tonumber(row[5])
  if ts <= now and ts >= now - gap then
    local id = cjson.encode({name, mmsi})
    local raw = redis.call('HGET', KEYS[1], id)
    local previous = raw and cjson.decode(raw) or nil
    if not previous or ts > previous[2] then
      local lastCrossing = previous and previous[3] or 0
      if previous and previous[1] ~= side and ts - previous[2] <= gap
          and (lastCrossing == 0 or ts - lastCrossing >= cooldown) then
        redis.call('ZADD', KEYS[3], ts, cjson.encode({name, mmsi, kind, ts}))
        lastCrossing = ts
      end
      redis.call('HSET', KEYS[1], id, cjson.encode({side, ts, lastCrossing}))
      redis.call('ZADD', KEYS[2], ts, id)
    end
  end
end
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', '(' .. (now - gap))
for _, id in ipairs(expired) do redis.call('HDEL', KEYS[1], id) end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', '(' .. (now - gap))
redis.call('EXPIRE', KEYS[1], math.ceil(gap / 1000) + 3600)
redis.call('EXPIRE', KEYS[2], math.ceil(gap / 1000) + 3600)
redis.call('EXPIRE', KEYS[3], 25 * 60 * 60)
return 1
`;

export function createDurableTransitTracker({ gates, maxTransitMs, cooldownMs, evaluate }) {
  let pending = [];
  let tails = new Map();
  let inFlight = null;

  function enqueue(mmsi, name, side, type, ts) {
    const key = JSON.stringify([name, mmsi]);
    const tail = tails.get(key);
    // Keep the first observation of each side (the completion clock) and
    // the latest repeat (the clock used for the next gate's gap bound).
    if (tail?.row[2] === side && tail.repeat) {
      tail.row[3] = type;
      tail.row[4] = ts;
    } else {
      const row = [name, mmsi, side, type, ts];
      pending.push(row);
      tails.set(key, { row, repeat: tail?.row[2] === side });
    }
  }

  const tracker = createTransitTracker({ gates, maxTransitMs, cooldownMs,
    crossings: new Map(), onGateObservation: enqueue });

  async function flush(now) {
    if (inFlight) { await inFlight; return flush(now); }
    const batch = pending.filter(row => row[4] <= now);
    const future = pending.filter(row => row[4] > now);
    pending = [];
    tails = new Map();
    for (const [name, mmsi, side, type, ts] of future) enqueue(mmsi, name, side, type, ts);
    batch.sort((a, b) => a[4] - b[4]);
    const operation = (async () => {
      try {
        const result = await evaluate(MERGE_TRANSIT_GATES,
          [STATE_KEY, INDEX_KEY, CROSSINGS_KEY],
          [now, maxTransitMs, cooldownMs, JSON.stringify(batch)]);
        if (result !== 1) throw new Error('Durable transit gate update failed');
      } catch (error) {
        const newer = pending;
        pending = [];
        tails = new Map();
        for (const [name, mmsi, side, type, ts] of [...batch, ...newer]) {
          if (ts >= now - maxTransitMs) enqueue(mmsi, name, side, type, ts);
        }
        throw error;
      }
    })();
    inFlight = operation;
    try { await operation; } finally { if (inFlight === operation) inFlight = null; }
  }

  return { observe: tracker.observe, prune: tracker.prune, flush };
}
