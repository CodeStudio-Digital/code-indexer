/**
 * Generate the Ed25519 keypair for the plugin Market.
 *   node scripts/keygen.mjs
 * Public key (PEM)  -> set MCP_MARKET_PUBKEY on the host/IDE (verifies bundles).
 * Private key (b64) -> `wrangler secret put MARKET_SIGNING_PRIVKEY` (signs bundles).
 */
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privPkcs8B64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

console.log('=== MCP_MARKET_PUBKEY (host env — full PEM, keep the BEGIN/END lines) ===');
console.log(pubPem.trim());
console.log('\n=== MARKET_SIGNING_PRIVKEY (wrangler secret put — base64 pkcs8) ===');
console.log(privPkcs8B64);
