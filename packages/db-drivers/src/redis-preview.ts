/** A fixed read-only script bounds the RESP reply before ioredis decodes it.
 * SCAN COUNT is only a hint, so the reply has independent element/byte caps.
 * This bounds the client preview, not Redis's own command buffers or script time.
 * No fallback to HGETALL/SMEMBERS/full LRANGE when scripting is unavailable. */
export const REDIS_PREVIEW_BYTES = 64 * 1024;
export const REDIS_PREVIEW_ITEMS = 200;
export const REDIS_PREVIEW_SCRIPT = `
local key = KEYS[1]
local kind = redis.call('TYPE', key).ok
local ttl = redis.call('TTL', key)
local limit = tonumber(ARGV[1])
local budget = tonumber(ARGV[2])
local partial = 0
local used = 0
local function bounded(value)
  if #value > budget - used then
    partial = 1
    value = string.sub(value, 1, math.max(0, budget - used))
  end
  used = used + #value
  return value
end
if kind == 'none' then return {kind, ttl, 0, false} end
if kind == 'string' then
  if redis.call('STRLEN', key) > budget then partial = 1 end
  return {kind, ttl, partial, redis.call('GETRANGE', key, 0, budget - 1)}
end
local values = {}
local pairs = false
if kind == 'list' then
  if redis.call('LLEN', key) > limit then partial = 1 end
  values = redis.call('LRANGE', key, 0, limit - 1)
elseif kind == 'zset' then
  if redis.call('ZCARD', key) > limit then partial = 1 end
  values = redis.call('ZRANGE', key, 0, limit - 1, 'WITHSCORES')
  pairs = true
elseif kind == 'hash' or kind == 'set' then
  local scan = redis.call(kind == 'hash' and 'HSCAN' or 'SSCAN', key, '0', 'COUNT', limit)
  if scan[1] ~= '0' then partial = 1 end
  values = scan[2]
  pairs = kind == 'hash'
else
  return redis.error_reply('Unsupported key type for bounded preview: ' .. kind)
end
local result = {}
local stride = pairs and 2 or 1
local taken = 0
for i = 1, #values, stride do
  if taken >= limit or used >= budget then partial = 1; break end
  result[#result + 1] = bounded(values[i])
  if pairs then result[#result + 1] = bounded(values[i + 1]) end
  taken = taken + 1
end
return {kind, ttl, partial, result}
`;

export function decodeRedisPreview(reply: unknown) {
  if (!Array.isArray(reply) || reply.length !== 4) throw new Error('Invalid Redis preview reply');
  const [type, ttl, partial, raw] = reply;
  if (typeof type !== 'string' || typeof ttl !== 'number' || (partial !== 0 && partial !== 1)) {
    throw new Error('Invalid Redis preview metadata');
  }
  let value = raw;
  if (type === 'hash') {
    if (!Array.isArray(raw) || raw.length % 2) throw new Error('Invalid Redis hash preview');
    value = Object.fromEntries(Array.from({ length: raw.length / 2 }, (_, index) => [String(raw[index * 2]), raw[index * 2 + 1]]));
  }
  return { type, ttl, value, truncated: partial === 1 };
}
