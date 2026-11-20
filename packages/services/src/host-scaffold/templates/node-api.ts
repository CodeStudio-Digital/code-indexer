import type { HostTemplate } from './types.js';

export function nodeApiFiles(name: string, pathPrefix = ''): Record<string, string> {
  const manifest = {
    name,
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'node --watch server.mjs',
      build: 'node --check server.mjs',
      start: 'node server.mjs',
    },
  };

  return {
    'package.json': JSON.stringify(manifest, null, 2) + '\n',
    '.gitignore': 'node_modules\ndist\n',
    'server.mjs': [
      "import { createServer } from 'node:http';",
      "import { parseArgs } from 'node:util';",
      '',
      'const { values } = parseArgs({ options: {',
      "  host: { type: 'string', default: process.env.HOST ?? '127.0.0.1' },",
      "  port: { type: 'string', default: process.env.PORT ?? '3000' },",
      '} });',
      `const prefix = ${JSON.stringify(pathPrefix.replace(/\/$/, ''))};`,
      '',
      "const json = (res, value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));",
      'const server = createServer(async (req, res) => {',
      '  try {',
      "    const { pathname } = new URL(req.url, 'http://localhost');",
      "    const path = prefix && (pathname === prefix || pathname.startsWith(prefix + '/'))",
      "      ? pathname.slice(prefix.length) || '/' : pathname;",
      "    if (req.method === 'GET' && path === '/') return json(res, { service: 'vite-api', ok: true });",
      "    if (req.method === 'GET' && path === '/health') return res.end('ok');",
      "    if (req.method === 'POST' && path === '/api/echo') {",
      '      const chunks = [];',
      '      let size = 0;',
      '      for await (const chunk of req.iterator({ destroyOnReturn: false })) {',
      '        size += chunk.length;',
      '        if (size > 1024 * 1024) return res.writeHead(413).end();',
      '        chunks.push(chunk);',
      '      }',
      '      let received = {};',
      "      try { received = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* empty or invalid JSON */ }",
      '      return json(res, { received, at: new Date().toISOString() });',
      '    }',
      "    res.writeHead(404).end('Not Found');",
      '  } catch {',
      "    if (!res.destroyed) res.writeHead(400).end('Bad Request');",
      '  }',
      '});',
      'server.listen(Number(values.port), values.host, () => {',
      '  console.log(`Local: http://${values.host}:${server.address().port}`);',
      '});',
      '',
    ].join('\n'),
  };
}

export const nodeApiTemplate: HostTemplate = {
  id: 'vite-api',
  needsNetwork: false,
  createsTargetDir: true,
  files: ({ slug }) => nodeApiFiles(slug),
  build: () => [],
};
