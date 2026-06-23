/**
 * E2E SSH vault sync hook. Unlock with a vault passphrase (derives the KEK,
 * unwraps the account-global VDK from the synced `vault_meta` doc), then a manual
 * "Sync now": push every local host ENCRYPTED with the VDK (the real SSH
 * password/key travels, AES-GCM-sealed), pull this workspace's host docs, decrypt
 * them, and re-seal their secrets with the local OS keychain before saving.
 *
 * The server is zero-knowledge: it only ever stores the wrapped VDK + ciphertext.
 * State (workspaceId, doc maps, versions, cursor, ciphertext cache) persists per
 * project; the VDK lives in memory only (cleared on lock/unmount).
 *
 * v1 scope: hosts with INLINE secrets. Identity-referenced secrets and the jump
 * chain don't travel yet (re-link on the other device) — documented follow-up.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { cloudCall } from '../../../lib/cloud/cloud-client.js';
import { CloudError } from '../../../lib/cloud/cloud-errors.js';
import {
  deriveKek,
  generateVdk,
  wrapVdk,
  unwrapVdk,
  makeVerifier,
  checkVerifier,
  defaultKdfParams,
  encryptJson,
  decryptJson,
  generateIdentityKeyPair,
  wrapIdentityPrivate,
  unwrapIdentityPrivate,
  generateTvk,
  wrapTvkForMember,
  unwrapTvkFromMember,
  generateSigningKeyPair,
  signGrant,
  verifyGrantSig,
  type KdfParams,
  type RecordEnvelope,
  type RecordAad,
} from '@mcp/vault-crypto';
import * as api from '../api.js';
import type { SshHost } from '../types.js';
import { planVaultPush, planVaultApply, type VaultCacheEntry, type VaultPushRecord } from './vault-sync-core.js';

const META_DOC = 'vault:meta';
/** OWASP-2024 floor; the local mint uses 650k. Reject anything weaker the server might serve. */
const MIN_KDF_ITERATIONS = 600_000;

/** Reject server-supplied KDF params that would weaken the KEK (downgrade defense). */
function validateKdf(kdf: KdfParams): void {
  if (!kdf || kdf.alg !== 'PBKDF2' || kdf.hash !== 'SHA-256') {
    throw new Error('vault_meta: unsupported KDF algorithm');
  }
  if (typeof kdf.iterations !== 'number' || kdf.iterations < MIN_KDF_ITERATIONS) {
    throw new Error('vault_meta: KDF iterations below the client minimum');
  }
  if (typeof kdf.salt !== 'string' || kdf.salt.length < 16 || kdf.salt.length > 256) {
    throw new Error('vault_meta: malformed KDF salt');
  }
}

interface VaultMetaBody {
  kdf: KdfParams;
  wrappedVdk: string;
  vdkId: string;
  verifier: RecordEnvelope;
  /** ECDH identity (encryption) + ECDSA identity (grant signing), added lazily for back-compat. */
  identityPub?: string;
  wrappedIdentityPriv?: string;
  sigPub?: string;
  wrappedSigPriv?: string;
}

/** The unlocked vault held in memory (never persisted). */
interface UnlockedVault {
  key: CryptoKey;
  vdkId: string;
  identityPub: string;
  identityPrivPkcs8: string;
  /** ECDSA signing identity — signs team grants (a recipient verifies against the pinned key). */
  sigPub: string;
  sigPrivPkcs8: string;
}

/** Plaintext host record carried in the vault (secrets decrypted from the keychain). */
interface VaultHostRecord {
  label: string;
  hostname: string;
  port: number;
  username: string;
  auth_method: SshHost['auth_method'];
  password?: string;
  privateKey?: string;
  passphrase?: string;
  group_name: string | null;
  tags: string[];
  agent_forwarding: boolean;
}

interface SyncState {
  workspaceId: string;
  hostMap: Record<string, string>; // local host id → clientDocId
  versions: Record<string, number>; // clientDocId → server version
  cursor: number;
  bodyCache: Record<string, VaultCacheEntry>; // clientDocId → {hash, ciphertext}
  // Team sharing (per org): `${orgId}:${localHostId}` → org clientDocId (idempotent share),
  // org clientDocId → local host id (idempotent pull), versions + cursor for the org feed.
  orgShareMap: Record<string, string>;
  teamHostMap: Record<string, string>;
  teamVersions: Record<string, number>;
  teamCursor: number;
  // Pinned identity keys (TOFU trust store): a server can't substitute a key undetected.
  memberEncPins: Record<string, string>; // accountId → ECDH public key (admin pins recipients)
  orgGranterSigPins: Record<string, string>; // orgId → granter ECDSA signing key (member pins granter)
  // Last-applied monotonic seq per doc — the rollback/replay high-water mark.
  appliedSeq: Record<string, number>;
  teamAppliedSeq: Record<string, number>;
}

export interface VaultSyncSummary {
  pushed: number;
  conflicts: number;
  pulledApplied: number;
  at: number;
}

const key = (projectId: number) => `mcp-sshvault:${projectId}`;
const newId = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

function load(projectId: number): SyncState {
  try {
    const raw = localStorage.getItem(key(projectId));
    if (raw) {
      const p = JSON.parse(raw) as Partial<SyncState>;
      return {
        workspaceId: p.workspaceId ?? newId(),
        hostMap: p.hostMap ?? {},
        versions: p.versions ?? {},
        cursor: p.cursor ?? 0,
        bodyCache: p.bodyCache ?? {},
        orgShareMap: p.orgShareMap ?? {},
        teamHostMap: p.teamHostMap ?? {},
        teamVersions: p.teamVersions ?? {},
        teamCursor: p.teamCursor ?? 0,
        memberEncPins: p.memberEncPins ?? {},
        orgGranterSigPins: p.orgGranterSigPins ?? {},
        appliedSeq: p.appliedSeq ?? {},
        teamAppliedSeq: p.teamAppliedSeq ?? {},
      };
    }
  } catch {
    /* fresh workspace */
  }
  return { workspaceId: newId(), hostMap: {}, versions: {}, cursor: 0, bodyCache: {}, orgShareMap: {}, teamHostMap: {}, teamVersions: {}, teamCursor: 0, memberEncPins: {}, orgGranterSigPins: {}, appliedSeq: {}, teamAppliedSeq: {} };
}

function save(projectId: number, s: SyncState): void {
  try {
    localStorage.setItem(key(projectId), JSON.stringify(s));
  } catch {
    /* storage full — sync still works this session */
  }
}

async function hostToRecord(h: SshHost): Promise<VaultHostRecord> {
  return {
    label: h.label,
    hostname: h.hostname,
    port: h.port,
    username: h.username,
    auth_method: h.auth_method,
    password: h.enc_password ? await api.decryptSecret(h.enc_password) : undefined,
    privateKey: h.enc_private_key ? await api.decryptSecret(h.enc_private_key) : undefined,
    passphrase: h.enc_passphrase ? await api.decryptSecret(h.enc_passphrase) : undefined,
    group_name: h.group_name,
    tags: (() => {
      try {
        return JSON.parse(h.tags_json || '[]') as string[];
      } catch {
        return [];
      }
    })(),
    agent_forwarding: !!h.agent_forwarding,
  };
}

/** Vault record → createHost/patchHost body (re-seal secrets with the OS keychain). */
async function recordToHostBody(r: VaultHostRecord): Promise<Record<string, unknown>> {
  return {
    label: r.label,
    hostname: r.hostname,
    port: r.port,
    username: r.username,
    auth_method: r.auth_method,
    group_name: r.group_name,
    tags: r.tags,
    agent_forwarding: r.agent_forwarding,
    enc_password: r.password ? await api.encryptSecret(r.password) : null,
    enc_private_key: r.privateKey ? await api.encryptSecret(r.privateKey) : null,
    enc_passphrase: r.passphrase ? await api.encryptSecret(r.passphrase) : null,
  };
}

export function useSshVaultSync(projectId: number) {
  const [state, setState] = useState<SyncState>(() => load(projectId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<VaultSyncSummary | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const vdkRef = useRef<UnlockedVault | null>(null);

  useEffect(() => {
    setState(load(projectId));
    setError(null);
    setLast(null);
    setUnlocked(false);
    vdkRef.current = null;
  }, [projectId]);

  const persist = useCallback(
    (next: SyncState) => {
      setState(next);
      save(projectId, next);
    },
    [projectId],
  );

  /** Derive the VDK + identity from the passphrase: unwrap the synced vault_meta, or mint a new vault. */
  const unlock = useCallback(async (passphrase: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const pull = await cloudCall('sync.pull', { kinds: ['vault_meta'], sinceVersion: 0 });
      const metaDoc = pull.documents.find((d) => d.kind === 'vault_meta' && d.clientDocId === META_DOC && !d.deleted);

      let kek: CryptoKey;
      let vdk: CryptoKey;
      let vdkId: string;
      let meta: VaultMetaBody;
      let baseVersion = 0;
      if (metaDoc) {
        meta = metaDoc.body as VaultMetaBody;
        baseVersion = metaDoc.version;
        validateKdf(meta.kdf); // server-supplied params — reject a KDF downgrade
        kek = await deriveKek(passphrase, meta.kdf);
        try {
          vdk = await unwrapVdk(kek, meta.wrappedVdk);
        } catch {
          throw new Error('wrong_passphrase');
        }
        if (!(await checkVerifier(vdk, meta.verifier))) throw new Error('wrong_passphrase');
        vdkId = meta.vdkId;
      } else {
        const kdf = defaultKdfParams();
        kek = await deriveKek(passphrase, kdf);
        const gen = await generateVdk();
        vdk = gen.key;
        vdkId = gen.vdkId;
        meta = { kdf, wrappedVdk: await wrapVdk(kek, vdk), vdkId, verifier: await makeVerifier(vdk) };
      }

      // Ensure an ECDH identity keypair (encryption) + an ECDSA signing keypair
      // (grant authentication) for team sharing: generate + persist if absent.
      let identityPub = meta.identityPub;
      let identityPrivPkcs8: string;
      let metaChanged = !metaDoc;
      if (meta.wrappedIdentityPriv && identityPub) {
        identityPrivPkcs8 = await unwrapIdentityPrivate(kek, meta.wrappedIdentityPriv);
      } else {
        const id = await generateIdentityKeyPair();
        identityPub = id.publicSpki;
        identityPrivPkcs8 = id.privatePkcs8;
        meta = { ...meta, identityPub, wrappedIdentityPriv: await wrapIdentityPrivate(kek, id.privatePkcs8) };
        metaChanged = true;
      }
      let sigPub = meta.sigPub;
      let sigPrivPkcs8: string;
      if (meta.wrappedSigPriv && sigPub) {
        sigPrivPkcs8 = await unwrapIdentityPrivate(kek, meta.wrappedSigPriv);
      } else {
        const sk = await generateSigningKeyPair();
        sigPub = sk.publicSpki;
        sigPrivPkcs8 = sk.privatePkcs8;
        meta = { ...meta, sigPub, wrappedSigPriv: await wrapIdentityPrivate(kek, sk.privatePkcs8) };
        metaChanged = true;
      }

      if (metaChanged) {
        const res = await cloudCall('sync.push', { documents: [{ kind: 'vault_meta', clientDocId: META_DOC, baseVersion, updatedAtMs: Date.now(), body: meta }] });
        // First-unlock RACE: two devices unlocking a brand-new vault concurrently
        // each mint a different VDK. The server enforces create-once on vault_meta,
        // so a fresh mint (baseVersion 0) that lost comes back as a conflict. We
        // must then ADOPT the canonical VDK — otherwise we'd sync hosts under a
        // VDK no other device can read (orphaned ciphertext).
        const metaRes = res.results.find((r) => r.clientDocId === META_DOC);
        if (!metaDoc && metaRes && metaRes.status === 'conflict') {
          const repull = await cloudCall('sync.pull', { kinds: ['vault_meta'], sinceVersion: 0 });
          const canon = repull.documents.find((d) => d.kind === 'vault_meta' && d.clientDocId === META_DOC && !d.deleted);
          const cmeta = canon ? (canon.body as VaultMetaBody) : null;
          if (cmeta && cmeta.vdkId !== vdkId) {
            validateKdf(cmeta.kdf);
            const ckek = await deriveKek(passphrase, cmeta.kdf);
            try {
              vdk = await unwrapVdk(ckek, cmeta.wrappedVdk); // same passphrase ⇒ unwraps cleanly
            } catch {
              throw new Error('wrong_passphrase');
            }
            if (!(await checkVerifier(vdk, cmeta.verifier))) throw new Error('wrong_passphrase');
            vdkId = cmeta.vdkId;
            if (cmeta.wrappedIdentityPriv && cmeta.identityPub) {
              identityPub = cmeta.identityPub;
              identityPrivPkcs8 = await unwrapIdentityPrivate(ckek, cmeta.wrappedIdentityPriv);
            }
            if (cmeta.wrappedSigPriv && cmeta.sigPub) {
              sigPub = cmeta.sigPub;
              sigPrivPkcs8 = await unwrapIdentityPrivate(ckek, cmeta.wrappedSigPriv);
            }
          }
        }
      }
      // Publish my ECDH public key so org admins can wrap a Team Vault Key to me (idempotent).
      await cloudCall('account.vaultKeyPut', { publicSpki: identityPub }).catch(() => undefined);

      vdkRef.current = { key: vdk, vdkId, identityPub, identityPrivPkcs8, sigPub, sigPrivPkcs8 };
      setUnlocked(true);
    } catch (e) {
      setError(e instanceof CloudError ? e.message : e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  const sync = useCallback(async (): Promise<void> => {
    const vdk = vdkRef.current;
    if (!vdk) {
      setError('locked');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const cur = load(projectId);
      const hostMap = { ...cur.hostMap };
      const versions = { ...cur.versions };
      const appliedSeq = { ...cur.appliedSeq };
      const now = Date.now();
      const enc = (v: unknown, aad: RecordAad) => encryptJson(vdk.key, v, aad);
      const dec = (e: RecordEnvelope, aad: RecordAad) => decryptJson<VaultHostRecord>(vdk.key, e, aad);

      // 1) PUSH local hosts (encrypted).
      const hosts = await api.listHosts(projectId);
      const clientDocIdFor = (id: number): string => {
        const k = String(id);
        if (!hostMap[k]) hostMap[k] = `${cur.workspaceId}:${newId()}`;
        return hostMap[k];
      };
      const pushRecords: VaultPushRecord[] = [];
      for (const h of hosts) {
        pushRecords.push({ clientDocId: clientDocIdFor(h.id), kind: 'ssh_host', record: await hostToRecord(h) });
      }
      const plan = await planVaultPush(pushRecords, cur.workspaceId, vdk.vdkId, enc, (cid) => versions[cid] ?? 0, (cid) => cur.bodyCache[cid], now);
      let conflicts = 0;
      if (plan.items.length > 0) {
        const res = await cloudCall('sync.push', { documents: plan.items });
        for (const r of res.results) {
          versions[r.clientDocId] = r.version;
          if (r.status === 'conflict') conflicts += 1;
        }
      }

      // 2) PULL this workspace's host docs and apply (decrypt → re-seal → upsert).
      const pull = await cloudCall('sync.pull', { kinds: ['ssh_host'], sinceVersion: cur.cursor });
      const actions = await planVaultApply<VaultHostRecord>(pull.documents, cur.workspaceId, cur.workspaceId, vdk.vdkId, dec, (cid) => versions[cid] ?? 0, (cid) => appliedSeq[cid] ?? 0);
      const localIdFor = (cid: string): number | undefined => {
        const hit = Object.entries(hostMap).find(([, v]) => v === cid);
        return hit ? Number(hit[0]) : undefined;
      };
      for (const a of actions) {
        const localId = localIdFor(a.clientDocId);
        if (a.deleted) {
          if (localId != null) {
            await api.deleteHost(projectId, localId);
            delete hostMap[String(localId)];
          }
        } else if (a.record) {
          const body = await recordToHostBody(a.record);
          if (localId != null) await api.patchHost(projectId, localId, body);
          else {
            const created = await api.createHost(projectId, body);
            hostMap[String(created.id)] = a.clientDocId;
          }
          appliedSeq[a.clientDocId] = a.seq; // advance the rollback high-water
        }
        versions[a.clientDocId] = a.version;
      }

      persist({
        ...cur,
        hostMap,
        versions,
        appliedSeq,
        cursor: Math.max(cur.cursor, pull.cursor),
        bodyCache: { ...cur.bodyCache, ...plan.cache },
      });
      setLast({ pushed: plan.items.length, conflicts, pulledApplied: actions.length, at: now });
    } catch (e) {
      setError(e instanceof CloudError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [projectId, persist]);

  const linkWorkspace = useCallback(
    (id: string) => {
      const trimmed = id.trim();
      if (!trimmed) return;
      // Reset sync bookkeeping but KEEP the pinned-keys trust store.
      persist({ ...load(projectId), workspaceId: trimmed, hostMap: {}, versions: {}, cursor: 0, bodyCache: {}, orgShareMap: {}, teamHostMap: {}, teamVersions: {}, teamCursor: 0 });
      setLast(null);
    },
    [persist, projectId],
  );

  /**
   * Share this project's hosts with an org (admin). Mints a fresh Team Vault Key,
   * wraps it to every member who published a key, and pushes the hosts encrypted
   * with the TVK to the org feed. A fresh TVK each call = a rotation.
   * v1: one shared vault per org (`projectWorkspaceId = org:<orgId>`).
   */
  const shareWithOrg = useCallback(
    async (orgId: string): Promise<void> => {
      const v = vdkRef.current;
      if (!v) {
        setError('locked');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const cur = load(projectId);
        const pwid = `org:${orgId}`;
        const orgShareMap = { ...cur.orgShareMap };
        const { key: tvk, tvkId } = await generateTvk();

        const { members } = await cloudCall('orgs.vaultMembers', { orgId });
        // Pin each member's encryption key (TOFU). If the server returns a key
        // that DIFFERS from what we pinned, skip that member — never wrap the TVK
        // to a substituted (possibly attacker-controlled) key.
        const memberEncPins = { ...cur.memberEncPins };
        const skipped: string[] = [];
        const eligible = members.filter((m) => {
          const pinned = memberEncPins[m.accountId];
          if (pinned && pinned !== m.publicSpki) {
            skipped.push(m.accountId);
            return false;
          }
          memberEncPins[m.accountId] = m.publicSpki; // first-seen → pin
          return true;
        });
        const grants = await Promise.all(
          eligible.map(async (m) => {
            const w = await wrapTvkForMember({ privatePkcs8: v.identityPrivPkcs8, publicSpki: v.identityPub }, m.publicSpki, tvk, tvkId);
            // Sign the grant so a recipient can authenticate it against my pinned signing key.
            const signature = await signGrant(v.sigPrivPkcs8, tvkId, m.publicSpki, w.wrapped);
            return { accountId: m.accountId, wrappedKey: w.wrapped, granterPub: w.granterPub, tvkId: w.tvkId, granterSigPub: v.sigPub, signature };
          }),
        );
        await cloudCall('orgs.vaultGrantsPut', { orgId, projectWorkspaceId: pwid, grants });

        const hosts = await api.listHosts(projectId);
        const docIdFor = (id: number): string => {
          const k = `${orgId}:${id}`;
          if (!orgShareMap[k]) orgShareMap[k] = `${pwid}:${newId()}`;
          return orgShareMap[k];
        };
        const records: VaultPushRecord[] = [];
        for (const h of hosts) records.push({ clientDocId: docIdFor(h.id), kind: 'ssh_host', record: await hostToRecord(h) });
        const plan = await planVaultPush(records, pwid, tvkId, (val, aad) => encryptJson(tvk, val, aad), () => 0, () => undefined, Date.now());
        if (plan.items.length > 0) await cloudCall('orgs.vaultPush', { orgId, documents: plan.items });

        persist({ ...cur, orgShareMap, memberEncPins });
        setLast({ pushed: plan.items.length, conflicts: 0, pulledApplied: 0, at: Date.now() });
        if (skipped.length > 0) setError(`member_key_changed:${skipped.length}`);
      } catch (e) {
        setError(e instanceof CloudError ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [projectId, persist],
  );

  /** Pull an org's shared hosts (member): verify + unwrap my grant → decrypt → upsert locally. */
  const pullTeam = useCallback(
    async (orgId: string): Promise<void> => {
      const v = vdkRef.current;
      if (!v) {
        setError('locked');
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const cur = load(projectId);
        const pwid = `org:${orgId}`;
        const { grant } = await cloudCall('orgs.vaultGrantsMine', { orgId, projectWorkspaceId: pwid });
        if (!grant) {
          setError('no_grant');
          return;
        }
        // AUTHENTICATE the grant before trusting it. The signature covers
        // (tvkId, recipientPub, wrappedKey); verifying it with MY OWN encryption
        // key as the recipient detects both a forged grant and a server that
        // substituted my pubkey at the admin (the signed recipientPub wouldn't
        // match my real key). Then pin the granter's signing key per org (TOFU):
        // a later change is rejected, so the server can't swap in a forged signer.
        const sigOk = await verifyGrantSig(grant.granterSigPub, grant.tvkId, v.identityPub, grant.wrappedKey, grant.signature);
        if (!sigOk) {
          setError('grant_unverified');
          return;
        }
        const orgGranterSigPins = { ...cur.orgGranterSigPins };
        const pinned = orgGranterSigPins[orgId];
        if (pinned && pinned !== grant.granterSigPub) {
          setError('granter_key_changed');
          return;
        }
        orgGranterSigPins[orgId] = grant.granterSigPub; // first-seen → pin (TOFU)
        const tvk = await unwrapTvkFromMember(v.identityPrivPkcs8, { wrapped: grant.wrappedKey, granterPub: grant.granterPub, tvkId: grant.tvkId });
        const pull = await cloudCall('orgs.vaultPull', { orgId, kinds: ['ssh_host'], sinceVersion: cur.teamCursor });
        const teamHostMap = { ...cur.teamHostMap };
        const teamVersions = { ...cur.teamVersions };
        const teamAppliedSeq = { ...cur.teamAppliedSeq };
        const actions = await planVaultApply<VaultHostRecord>(pull.documents, pwid, pwid, grant.tvkId, (e, aad) => decryptJson<VaultHostRecord>(tvk, e, aad), (cid) => teamVersions[cid] ?? 0, (cid) => teamAppliedSeq[cid] ?? 0);
        for (const a of actions) {
          const localId = teamHostMap[a.clientDocId] ? Number(teamHostMap[a.clientDocId]) : undefined;
          if (a.deleted) {
            if (localId != null) {
              await api.deleteHost(projectId, localId);
              delete teamHostMap[a.clientDocId];
            }
          } else if (a.record) {
            const body = await recordToHostBody({ ...a.record, group_name: a.record.group_name ?? `team:${orgId}` });
            if (localId != null) await api.patchHost(projectId, localId, body);
            else {
              const created = await api.createHost(projectId, body);
              teamHostMap[a.clientDocId] = String(created.id);
            }
            teamAppliedSeq[a.clientDocId] = a.seq; // advance the rollback high-water
          }
          teamVersions[a.clientDocId] = a.version;
        }
        persist({ ...cur, teamHostMap, teamVersions, teamAppliedSeq, teamCursor: Math.max(cur.teamCursor, pull.cursor), orgGranterSigPins });
        setLast({ pushed: 0, conflicts: 0, pulledApplied: actions.length, at: Date.now() });
      } catch (e) {
        setError(e instanceof CloudError ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [projectId, persist],
  );

  return { workspaceId: state.workspaceId, busy, error, last, unlocked, unlock, sync, linkWorkspace, shareWithOrg, pullTeam };
}
