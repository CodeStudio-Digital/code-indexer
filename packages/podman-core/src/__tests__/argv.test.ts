import { describe, it, expect } from 'vitest';
import {
  runArgs,
  psArgs,
  buildArgs,
  rmArgs,
  logsArgs,
  stopArgs,
} from '../argv.js';
import { volumeCreateArgs, podCreateArgs, composeArgs } from '../argv-objects.js';

describe('container argv', () => {
  it('builds a detached run with name, ports, env, volume, command', () => {
    expect(
      runArgs({
        image: 'node:20-alpine',
        name: 'web',
        detach: true,
        ports: ['8080:80'],
        env: { NODE_ENV: 'production' },
        volumes: ['/srv/app:/app'],
        workdir: '/app',
        command: ['npm', 'start'],
      }),
    ).toEqual([
      'run', '-d', '--name', 'web',
      '-p', '8080:80',
      '-e', 'NODE_ENV=production',
      '-v', '/srv/app:/app',
      '-w', '/app',
      'node:20-alpine',
      'npm', 'start',
    ]);
  });

  it('places the image after all flags and extraArgs before it', () => {
    const args = runArgs({ image: 'alpine', extraArgs: ['--userns=keep-id'] });
    expect(args).toEqual(['run', '--userns=keep-id', 'alpine']);
    expect(args.indexOf('alpine')).toBe(args.length - 1);
  });

  it('ps -a requests json', () => {
    expect(psArgs({ all: true })).toEqual(['ps', '-a', '--format', 'json']);
  });

  it('stop honors grace, rm honors force+volumes, logs honors tail', () => {
    expect(stopArgs('c1', 5)).toEqual(['stop', '-t', '5', 'c1']);
    expect(rmArgs('c1', { force: true, volumes: true })).toEqual(['rm', '-f', '-v', 'c1']);
    expect(logsArgs('c1', { tail: 100 })).toEqual(['logs', '--tail', '100', 'c1']);
  });

  it('build wires tag, file, no-cache, build-args and context', () => {
    expect(
      buildArgs({ tag: 'app:dev', file: 'Containerfile', noCache: true, buildArgs: { V: '1' }, context: '.' }),
    ).toEqual(['build', '-t', 'app:dev', '-f', 'Containerfile', '--no-cache', '--build-arg', 'V=1', '.']);
  });
});

describe('object argv', () => {
  it('volume create with driver + label', () => {
    expect(volumeCreateArgs('data', { driver: 'local', labels: { app: 'x' } })).toEqual([
      'volume', 'create', '-d', 'local', '--label', 'app=x', 'data',
    ]);
  });

  it('pod create with ports', () => {
    expect(podCreateArgs('p1', { ports: ['80:80'] })).toEqual([
      'pod', 'create', '--name', 'p1', '-p', '80:80',
    ]);
  });

  it('compose up -d with explicit file', () => {
    expect(composeArgs('up', { file: 'compose.yaml', detach: true })).toEqual([
      'compose', '-f', 'compose.yaml', 'up', '-d',
    ]);
  });
});
