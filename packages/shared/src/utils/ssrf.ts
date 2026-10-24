/**
 * SSRF host classification — shared, zero-dependency so both the code-agent
 * web tools and the API-client send proxy use ONE battle-tested guard.
 *
 * `isPrivateHost` returns true for hostnames that resolve to private/loopback/
 * link-local/special ranges (v4 + v6), IPv4-mapped IPv6, and obfuscated numeric/
 * hex IP literals (e.g. `2130706433`, `0x7f000001`) that bypass a naive
 * dotted-quad regex. It is hostname-level only — it does NOT defeat DNS-rebinding
 * (a public name resolving to a private IP); that needs resolve-and-pin.
 */
import { isIP } from 'node:net';

/** A literal IPv4 octet quad in a private/loopback/special range. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return (
    a === 127 || // loopback 127/8
    a === 10 || // private 10/8
    a === 0 || // "this host" 0/8 (0.0.0.0 etc.)
    (a === 172 && b >= 16 && b <= 31) || // private 172.16/12
    (a === 192 && b === 168) || // private 192.168/16
    (a === 169 && b === 254) || // link-local 169.254/16 (cloud metadata)
    (a === 100 && b >= 64 && b <= 127) || // shared carrier space
    (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) || // protocol assignments/documentation
    (a === 192 && b === 88 && parts[2] === 99) || // deprecated relay range
    (a === 198 && (b === 18 || b === 19 || (b === 51 && parts[2] === 100))) ||
    (a === 203 && b === 0 && parts[2] === 113) || a >= 224 // multicast/reserved
  );
}

/** Should an outbound request to `hostname` be refused as private/internal? */
export function isPrivateHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (!host) return true;
  // Strip IPv6 zone id and surrounding brackets from `[::1]` style hosts.
  host = host.replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, '').replace(/\.$/, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const kind = isIP(host);
  if (kind === 4) return isPrivateIpv4(host);
  if (kind === 6) {
    // WHATWG canonicalization converts dotted/mapped forms to hexadecimal.
    // Only global unicast is eligible; transition, local, documentation and
    // protocol ranges are intentionally unavailable to public-page fetching.
    const canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    const first = parseInt(canonical.split(':')[0], 16);
    if (!(first >= 0x2000 && first <= 0x3fff)) return true;
    if (first === 0x2002 || first === 0x3fff) return true;
    const second = parseInt(canonical.split(':')[1] || '0', 16);
    return first === 0x2001 && (second <= 0x1ff || second === 0xdb8);
  }

  // Not a recognized DNS name or dotted-quad: a bare integer or hex literal
  // (`2130706433`, `0x7f000001`) is an obfuscated IP — refuse it outright. Also
  // refuse dotted forms with hex/octal octets that `isIP` rejects.
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) return true;
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){1,3}$/i.test(host)) return true;

  return false;
}
