import { describe, expect, it } from 'vitest';
import { parseSshConfig } from '../ssh-config-parser.js';

describe('parseSshConfig', () => {
  it('parses Host blocks with HostName/User/Port/IdentityFile/ProxyJump', () => {
    const cfg = `
# my servers
Host prod
    HostName 10.0.0.5
    User deploy
    Port 2222
    IdentityFile ~/.ssh/id_ed25519
    ProxyJump bastion

Host bastion
    HostName bastion.example.com
    User jump
`;
    expect(parseSshConfig(cfg)).toEqual([
      { alias: 'prod', hostName: '10.0.0.5', user: 'deploy', port: 2222, identityFile: '~/.ssh/id_ed25519', proxyJump: 'bastion' },
      { alias: 'bastion', hostName: 'bastion.example.com', user: 'jump' },
    ]);
  });

  it('skips wildcard Host patterns and defaults HostName to the alias', () => {
    const cfg = `
Host *
    ServerAliveInterval 60
Host plain
    User root
Host *.internal
    User svc
`;
    expect(parseSshConfig(cfg)).toEqual([{ alias: 'plain', hostName: 'plain', user: 'root' }]);
  });

  it('accepts Key=value, is case-insensitive, and strips comments', () => {
    const cfg = `Host=web\nHOSTNAME = web.example.com  # prod web\nport=22`;
    expect(parseSshConfig(cfg)).toEqual([{ alias: 'web', hostName: 'web.example.com', port: 22 }]);
  });

  it('takes the first concrete alias when several are listed; ProxyJump none disables', () => {
    const cfg = `Host a b c\n  HostName h\n  ProxyJump none`;
    expect(parseSshConfig(cfg)).toEqual([{ alias: 'a', hostName: 'h' }]);
  });

  it('ignores a malformed port and an empty config', () => {
    expect(parseSshConfig('Host x\n HostName h\n Port abc')).toEqual([{ alias: 'x', hostName: 'h' }]);
    expect(parseSshConfig('')).toEqual([]);
  });
});
