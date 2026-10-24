import assert from 'node:assert/strict';
import { createServer } from 'node:net';

// A deliberately small RESP server for real ioredis transport/reconnect tests.
// This proves client behaviour, not compatibility certification of Redis itself.
export async function startRespFixture() {
  const sockets = new Set(), events = [], values = new Map();
  let effects = 0;
  const bulk = value => value == null ? '$-1\r\n' : `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  function parse(buffer) {
    let offset = 0;
    const line = () => {
      const end = buffer.indexOf('\r\n', offset); if (end < 0) return;
      const text = buffer.subarray(offset, end).toString(); offset = end + 2; return text;
    };
    const head = line(); if (head === undefined) return;
    assert(head.startsWith('*'), 'expected RESP command array');
    const count = Number(head.slice(1)); assert(Number.isSafeInteger(count) && count > 0 && count < 1000);
    const args = [];
    for (let index = 0; index < count; index++) {
      const size = line(); if (size === undefined) return;
      assert(size.startsWith('$'), 'expected RESP bulk string');
      const length = Number(size.slice(1)); assert(Number.isSafeInteger(length) && length >= 0 && length < 1024 * 1024);
      if (buffer.length < offset + length + 2) return;
      args.push(buffer.subarray(offset, offset + length).toString()); offset += length + 2;
    }
    return { args, bytes: offset };
  }
  const server = createServer(socket => {
    sockets.add(socket); let buffer = Buffer.alloc(0), database = 0;
    socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    socket.on('data', chunk => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        assert(buffer.length < 2 * 1024 * 1024, 'fixture input exceeded bound');
        for (;;) {
          const command = parse(buffer); if (!command) break;
          buffer = buffer.subarray(command.bytes);
          const [name, ...args] = command.args, method = name.toUpperCase();
          events.push({ method, database, args });
          const key = `${database}:${args[0]}`;
          if (method === 'CLIENT' || method === 'AUTH') socket.write('+OK\r\n');
          else if (method === 'INFO') socket.write(bulk('redis_version:7.2.0\r\nloading:0\r\n'));
          else if (method === 'PING') socket.write('+PONG\r\n');
          else if (method === 'SELECT') {
            const selected = Number(args[0]);
            if (!Number.isInteger(selected) || selected < 0 || selected > 15) socket.write('-ERR DB index is out of range\r\n');
            else { database = selected; socket.write('+OK\r\n'); }
          } else if (method === 'SET') {
            values.set(key, args[1]); effects++;
            if (args[0] === 'lost-ack') socket.destroy(); else socket.write('+OK\r\n');
          } else if (method === 'GET') {
            if (args[0] !== 'stall') socket.write(bulk(values.get(key)));
          } else if (method === 'DEL') {
            const removed = values.delete(key); effects++; socket.write(`:${Number(removed)}\r\n`);
          } else if (method === 'TYPE') socket.write(`+${values.has(key) ? 'string' : 'none'}\r\n`);
          else if (method === 'PTTL' || method === 'TTL') socket.write(`:${values.has(key) ? -1 : -2}\r\n`);
          else if (method === 'QUIT') socket.end('+OK\r\n');
          else socket.write(`-ERR unsupported fixture command ${method}\r\n`);
        }
      } catch (error) { events.push({ failure: String(error) }); socket.destroy(); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    port: server.address().port, events, values,
    effects: () => effects, clients: () => sockets.size,
    async waitFor(predicate) {
      for (let index = 0; index < 200; index++) {
        if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(predicate(), 'RESP fixture timed out');
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
