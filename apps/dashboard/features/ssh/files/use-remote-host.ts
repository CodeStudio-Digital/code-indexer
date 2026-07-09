/**
 * Resolves the selected saved host into a live SFTP adapter. Handles the
 * TOFU host-key prompt on the FIRST op (so the pane's later list/realpath calls
 * are already trusted), and closes the previous host's SFTP session on switch.
 */
import { useEffect, useRef, useState } from 'react';
import type { SshConnectSpec } from '@mcp/api-bus';
import { findHostByKey, resolveSpecFromHost, sftpClose, sftpListWithTrust, type NeedTrust } from '../api.js';
import type { SshHost, SshIdentity } from '../types.js';
import { createRemoteAdapter } from './remote-adapter.js';
import type { FsAdapter } from './fs-adapter.js';

export function useRemoteHost(hostId: string, hosts: SshHost[], identities: SshIdentity[], onNeedTrust: NeedTrust) {
  const [spec, setSpec] = useState<SshConnectSpec | null>(null);
  const [adapter, setAdapter] = useState<FsAdapter | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const specRef = useRef<SshConnectSpec | null>(null);

  useEffect(() => {
    const prev = specRef.current;
    if (prev) void sftpClose(prev.hostId).catch(() => undefined);
    specRef.current = null;
    setSpec(null);
    setAdapter(null);
    setError(null);
    const host = findHostByKey(hosts, hostId);
    if (!hostId || !host) return;
    let cancelled = false;
    setConnecting(true);
    void (async () => {
      try {
        const s = await resolveSpecFromHost(host, hosts, identities);
        if (cancelled) return;
        await sftpListWithTrust(s, '.', onNeedTrust); // TOFU on the first op
        if (cancelled) return;
        specRef.current = s;
        setSpec(s);
        setAdapter(createRemoteAdapter(s, host.label));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setConnecting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  return { spec, adapter, error, connecting };
}
