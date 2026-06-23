import { describe, it, expect } from 'vitest';
import { describeShell, shellLabel } from '../shell-info.js';

describe('describeShell', () => {
  it('names cmd.exe and steers away from Unix idioms on Windows', () => {
    const d = describeShell('win32');
    expect(d).toContain('win32');
    expect(d).toContain('cmd.exe');
    expect(d).toMatch(/findstr/);
    expect(d).toMatch(/\| head/); // calls out the banned pipe explicitly
    expect(d).toMatch(/powershell/i);
  });

  it('names bash + POSIX tools on linux/darwin', () => {
    expect(describeShell('linux')).toContain('/bin/bash');
    expect(describeShell('linux')).toMatch(/grep|sed|awk/);
    expect(describeShell('darwin')).toContain('macOS');
  });
});

describe('shellLabel', () => {
  it('reflects the platform', () => {
    expect(shellLabel('win32')).toContain('cmd.exe');
    expect(shellLabel('linux')).toContain('bash');
  });
});
