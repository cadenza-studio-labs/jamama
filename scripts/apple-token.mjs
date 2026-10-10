import { readFile, writeFile, chmod } from 'node:fs/promises';
import { createPrivateKey, sign } from 'node:crypto';

const origin = new URL(process.argv[2] || '').origin;
if (!origin.startsWith('https://')) throw new Error('Use the production HTTPS address.');
const config = JSON.parse(await readFile('.private-signing.json', 'utf8'));
if (!/^[A-Z0-9]{10}$/.test(config.teamId || '') || !/^[A-Z0-9]{10}$/.test(config.keyId || '')) throw new Error('Set your Apple team and key IDs in the ignored local signing configuration.');
const now = Math.floor(Date.now() / 1000);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const message = encode({ alg: 'ES256', kid: config.keyId }) + '.' + encode({ iss: config.teamId, iat: now - 60, exp: now + 180 * 86400, origin: [origin] });
const key = createPrivateKey(await readFile(config.keyPath, 'utf8'));
const token = message + '.' + sign('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
const values = JSON.parse(await readFile('.env.production.json', 'utf8'));
values.PUBLIC_URL = origin; values.APPLE_MUSIC_DEVELOPER_TOKEN = token;
await writeFile('.env.production.json', JSON.stringify(values), { mode: 0o600 }); await chmod('.env.production.json', 0o600);
console.log('Apple Music configuration updated locally; the private signing key stays on this Mac.');
