import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';

// The isolated desktop only receives a disposable loopback credential. In live
// mode an existing access token is used in memory exclusively at the fixed
// ChatGPT endpoint. No refresh token, account payload or transcript is logged.
async function liveHeaders(providerId) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(homedir(), '.mcp-code-indexer', 'index.db'), { readOnly: true });
  try {
    const config = db.prepare("SELECT kind, enabled FROM provider_configs WHERE id = ?").get(providerId);
    assert.ok(config?.enabled && config.kind === 'chatgpt', 'Enabled ChatGPT provider required');
    const row = db.prepare('SELECT access_token, expires_at, extra FROM oauth_tokens WHERE provider_id = ?').get(providerId);
    assert.ok(row?.access_token && Number(row.expires_at) > Date.now() + 60_000, 'An active ChatGPT login is required');
    const idToken = JSON.parse(row.extra || '{}').id_token;
    const claims = JSON.parse(Buffer.from((idToken || row.access_token).split('.')[1], 'base64url').toString('utf8'));
    const account = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    return { authorization: 'Bearer ' + row.access_token, ...(account && { 'chatgpt-account-id': account }) };
  } finally { db.close(); }
}

function syntheticResponse(answer, staged) {
  const id = 'resp_' + randomUUID();
  const events = [
    { type: 'response.created', response: { id, status: 'in_progress' } },
    ...(staged ? [
      { type: 'response.reasoning_summary_text.delta', delta: 'probe-private-reasoning' },
      { type: 'response.output_text.delta', delta: 'Trecho parcial. ', item_id: 'msg1', output_index: 0 },
    ] : []),
    { type: 'response.output_text.delta', delta: answer, item_id: 'msg1', output_index: 0 },
    { type: 'response.completed', response: { id, status: 'completed', usage: { input_tokens: 30, output_tokens: 8 } } },
  ];
  return new Response(events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''));
}

export async function startSideChatProbe({ live, providerId, model, sideModel, primaryKey, sideKey, finalWord }) {
  const secret = randomUUID();
  const credentials = live ? await liveHeaders(providerId) : null;
  const main = Promise.withResolvers(), cancel = Promise.withResolvers();
  const reasoning = Promise.withResolvers(), firstText = Promise.withResolvers();
  const reached = new Set();
  const records = [];
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    try {
      if (req.method !== 'POST' || req.url !== '/codex/responses' || req.headers.authorization !== 'Bearer ' + secret) {
        res.writeHead(401); res.end('{}'); return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      const input = JSON.stringify(payload.input);
      const side = payload.instructions?.includes('Only questions from this side chat are active');
      const last = JSON.stringify(payload.input.at(-1));
      const scenario = side ? (last.includes('CANCELAR_AMOSTRA') ? 'cancel' : last.includes('SEGUNDA_AMOSTRA') ? 'followup' : 'first')
        : input.includes(primaryKey) && (payload.tools?.length ?? 0) > 0 ? 'main' : 'auxiliary';
      assert.equal(payload.model, ['followup', 'cancel'].includes(scenario) ? sideModel : model);
      const record = { scenario, model: payload.model, effort: payload.reasoning?.effort ?? null,
        toolCount: payload.tools?.length ?? 0, session: req.headers.session_id, status: 0, publicText: false };
      records.push(record);
      if (side) {
        assert.equal(record.toolCount, 0);
        assert.ok(input.includes(primaryKey), 'Side request is missing the parent reference');
        if (scenario === 'followup') assert.ok(input.includes(sideKey), 'Follow-up is missing its private history');
      }
      const liveCall = live && scenario !== 'auxiliary';
      const headers = { 'content-type': 'application/json', accept: 'text/event-stream', ...credentials };
      for (const key of ['originator','user-agent','session_id','conversation_id','openai-beta','version']) {
        if (typeof req.headers[key] === 'string') headers[key] = req.headers[key];
      }
      const answer = { main: finalWord, first: primaryKey, followup: sideKey, cancel: 'Cancelamento', auxiliary: '{}' }[scenario];
      const upstream = liveCall ? await fetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST', headers, body, signal: controller.signal, redirect: 'error',
      }) : syntheticResponse(answer, scenario === 'first');
      record.status = upstream.status;
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel(); res.writeHead(upstream.status); res.end('Provider returned HTTP ' + upstream.status); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const decoder = new TextDecoder();
      let pending = '';
      for await (const chunk of upstream.body) {
        pending += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(pending))) {
          const frame = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          res.write(frame + '\n\n');
          if (!live && scenario === 'first' && frame.includes('response.reasoning_summary_text.delta')) {
            await reasoning.promise;
          }
          if (!record.publicText && frame.includes('response.output_text.delta')) {
            record.publicText = true;
            if (scenario === 'main' || scenario === 'cancel' || (!live && scenario === 'first')) {
              reached.add(scenario);
              const heartbeat = setInterval(() => res.write(': probe waiting\n\n'), 3_000);
              try {
                const gate = scenario === 'main' ? main : scenario === 'cancel' ? cancel : firstText;
                await Promise.race([gate.promise, once(res, 'close', { signal: AbortSignal.timeout(120_000) }).catch(() => {})]);
              } finally { clearInterval(heartbeat); }
            }
          }
          if (controller.signal.aborted) return;
        }
      }
      res.end(pending + decoder.decode());
    } catch (error) {
      if (!controller.signal.aborted) console.error('Probe transport:', error.message);
      res.destroy();
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: 'http://127.0.0.1:' + server.address().port, secret, records, reached,
    releaseReasoning: () => reasoning.resolve(), releaseFirstText: () => firstText.resolve(), releaseMain: () => main.resolve(),
    close() { reasoning.resolve(); firstText.resolve(); main.resolve(); cancel.resolve(); server.closeAllConnections(); server.close(); } };
}
