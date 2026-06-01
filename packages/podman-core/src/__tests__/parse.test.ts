import { describe, it, expect } from 'vitest';
import {
  parseContainers,
  parseImages,
  parseVolumes,
  parseNetworks,
  parsePods,
  decodeJsonList,
} from '../parse.js';

describe('decodeJsonList', () => {
  it('handles a JSON array', () => {
    expect(decodeJsonList('[{"a":1},{"a":2}]')).toHaveLength(2);
  });
  it('handles JSON-lines (Docker style)', () => {
    expect(decodeJsonList('{"a":1}\n{"a":2}\n')).toHaveLength(2);
  });
  it('returns [] for empty/garbage', () => {
    expect(decodeJsonList('')).toEqual([]);
    expect(decodeJsonList('not json')).toEqual([]);
  });
});

describe('parseContainers', () => {
  it('normalizes names array, state and structured ports', () => {
    const raw = JSON.stringify([
      {
        Id: 'abc123',
        Names: ['web'],
        Image: 'docker.io/library/nginx:latest',
        State: 'running',
        Status: 'Up 3 minutes',
        Ports: [{ host_ip: '0.0.0.0', host_port: 8080, container_port: 80, protocol: 'tcp' }],
      },
    ]);
    const [c] = parseContainers(raw);
    expect(c.id).toBe('abc123');
    expect(c.names).toEqual(['web']);
    expect(c.state).toBe('running');
    expect(c.ports).toBe('0.0.0.0:8080->80/tcp');
  });
});

describe('parseImages', () => {
  it('expands a Names array into one row per repo:tag', () => {
    const raw = JSON.stringify([
      { Id: 'sha1', Names: ['docker.io/library/node:20', 'docker.io/library/node:latest'], Size: 120 },
    ]);
    const rows = parseImages(raw);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ repository: 'docker.io/library/node', tag: '20', size: 120 });
    expect(rows[1].tag).toBe('latest');
  });

  it('falls back to Repository/Tag fields (older podman)', () => {
    const raw = JSON.stringify([{ Id: 'sha2', Repository: 'alpine', Tag: '3.19' }]);
    expect(parseImages(raw)[0]).toMatchObject({ reference: 'alpine:3.19' });
  });
});

describe('object parsers', () => {
  it('parseVolumes defaults driver to local', () => {
    expect(parseVolumes('[{"Name":"data"}]')[0]).toMatchObject({ name: 'data', driver: 'local' });
  });
  it('parseNetworks tolerates lowercase keys', () => {
    expect(parseNetworks('[{"name":"podman","id":"n1","driver":"bridge"}]')[0]).toMatchObject({
      name: 'podman',
      id: 'n1',
      driver: 'bridge',
    });
  });
  it('parsePods counts containers from the array', () => {
    const raw = JSON.stringify([{ Id: 'p1', Name: 'pod1', Status: 'Running', Containers: [{}, {}] }]);
    expect(parsePods(raw)[0]).toMatchObject({ name: 'pod1', containers: 2 });
  });
});
