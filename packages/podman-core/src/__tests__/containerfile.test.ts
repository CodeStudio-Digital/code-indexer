import { describe, it, expect } from 'vitest';
import {
  chooseStack,
  renderContainerfile,
  renderDockerignore,
  type ContainerStack,
} from '../containerfile.js';

const NONE = {
  hasPackageJson: false,
  hasRequirements: false,
  hasPyproject: false,
  hasGoMod: false,
  hasIndexHtml: false,
};

describe('chooseStack', () => {
  it('go.mod wins', () => {
    expect(chooseStack({ ...NONE, hasGoMod: true })).toEqual({ stack: 'go', port: 8080 });
  });
  it('package.json with start → node', () => {
    expect(chooseStack({ ...NONE, hasPackageJson: true, scripts: { start: 'node .' } })).toEqual({
      stack: 'node',
      port: 3000,
    });
  });
  it('package.json with build but no start → static', () => {
    expect(chooseStack({ ...NONE, hasPackageJson: true, scripts: { build: 'vite build' } })).toEqual({
      stack: 'static',
      port: 8080,
    });
  });
  it('requirements.txt → python', () => {
    expect(chooseStack({ ...NONE, hasRequirements: true })?.stack).toBe('python');
  });
  it('bare index.html → static', () => {
    expect(chooseStack({ ...NONE, hasIndexHtml: true })?.stack).toBe('static');
  });
  it('nothing recognizable → null', () => {
    expect(chooseStack(NONE)).toBeNull();
  });
});

describe('renderContainerfile — security defaults', () => {
  const stacks: ContainerStack[] = ['node', 'python', 'go', 'static'];
  it('every stack is multi-stage or minimal and non-root', () => {
    for (const s of stacks) {
      const f = renderContainerfile(s, { port: 1234, hasBuild: true, hasPackageJson: true });
      expect(f).toMatch(/# syntax=docker\/dockerfile/);
      // Non-root: an explicit USER, a distroless :nonroot base, or the
      // nginx-unprivileged image (which runs as uid 101 by default).
      expect(/USER \S+|:nonroot|unprivileged/.test(f)).toBe(true);
    }
  });
  it('node pins alpine base, runs as node user, exposes the port', () => {
    const f = renderContainerfile('node', { port: 3000, hasBuild: true });
    expect(f).toContain('FROM node:20-alpine');
    expect(f).toContain('USER node');
    expect(f).toContain('EXPOSE 3000');
  });
  it('go uses distroless nonroot final stage', () => {
    expect(renderContainerfile('go', {})).toContain('gcr.io/distroless/static:nonroot');
  });
});

describe('renderDockerignore', () => {
  it('node ignores node_modules and never ships the Containerfile/.env', () => {
    const ig = renderDockerignore('node');
    expect(ig).toContain('node_modules');
    expect(ig).toContain('.env');
    expect(ig).toContain('Containerfile');
  });
});
