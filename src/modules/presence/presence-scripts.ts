/** @internal Opens presence, purges stale connections, and advances its revision atomically. */
export const OPEN_PRESENCE_SCRIPT = `
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local stale = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, tonumber(ARGV[4]))
if #stale > 0 then
  redis.call('ZREM', KEYS[1], unpack(stale))
  redis.call('HDEL', KEYS[2], unpack(stale))
end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
local revision = redis.call('INCR', KEYS[3])
local retention = tonumber(ARGV[3]) * 2
redis.call('PEXPIRE', KEYS[1], retention)
redis.call('PEXPIRE', KEYS[2], retention)
redis.call('PEXPIRE', KEYS[3], retention)
return tostring(revision)
`;

/** @internal Refreshes an existing presence connection using the Redis clock. */
export const HEARTBEAT_PRESENCE_SCRIPT = `
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local stale = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, tonumber(ARGV[3]))
local changed = 0
if #stale > 0 then
  redis.call('ZREM', KEYS[1], unpack(stale))
  redis.call('HDEL', KEYS[2], unpack(stale))
  redis.call('INCR', KEYS[3])
  changed = 1
end
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 0 then
  return { redis.call('GET', KEYS[3]) or '0', tostring(changed), '0' }
end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
local revision = redis.call('GET', KEYS[3])
if not revision then
  revision = redis.call('INCR', KEYS[3])
  changed = 1
end
local retention = tonumber(ARGV[2]) * 2
redis.call('PEXPIRE', KEYS[1], retention)
redis.call('PEXPIRE', KEYS[2], retention)
redis.call('PEXPIRE', KEYS[3], retention)
return { tostring(revision), tostring(changed), '1' }
`;

/** @internal Closes one connection idempotently and advances revision only on change. */
export const CLOSE_PRESENCE_SCRIPT = `
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
if removed == 0 then return redis.call('GET', KEYS[3]) or '0' end
local revision = redis.call('INCR', KEYS[3])
redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[2]) * 2)
return tostring(revision)
`;

/** @internal Purges stale entries and returns one compact, bounded repair snapshot. */
export const SNAPSHOT_PRESENCE_SCRIPT = `
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local stale = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, tonumber(ARGV[2]))
local changed = 0
if #stale > 0 then
  redis.call('ZREM', KEYS[1], unpack(stale))
  redis.call('HDEL', KEYS[2], unpack(stale))
  redis.call('INCR', KEYS[3])
  changed = 1
end
local total = redis.call('ZCOUNT', KEYS[1], '(' .. now, '+inf')
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. now, '+inf', 'LIMIT', 0, tonumber(ARGV[1]))
local result = { redis.call('GET', KEYS[3]) or '0', tostring(total), tostring(changed) }
for _, id in ipairs(ids) do
  local details = redis.call('HGET', KEYS[2], id)
  if details then table.insert(result, details) end
end
return result
`;
