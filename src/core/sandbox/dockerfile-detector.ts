import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface DockerfileInfo {
  path: string;
  exposedPorts: number[];
}

const CANDIDATES = ['Dockerfile', 'Containerfile'] as const;
const EXPOSE_RE = /^\s*EXPOSE\s+(\d+(?:\s+\d+)*)/i;

export function detectDockerfile(root: string): DockerfileInfo | null {
  for (const name of CANDIDATES) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      if (!statSync(path).isFile()) continue;
      const content = readFileSync(path, 'utf8');
      return { path, exposedPorts: parseExposedPorts(content) };
    } catch {
      return { path, exposedPorts: [] };
    }
  }
  return null;
}

function parseExposedPorts(content: string): number[] {
  const ports: number[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(EXPOSE_RE);
    if (!match) continue;
    for (const raw of match[1].split(/\s+/)) {
      const port = Number(raw);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) {
        ports.push(port);
      }
    }
  }
  return ports;
}
