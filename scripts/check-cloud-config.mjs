import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
const db = config.d1_databases?.find((binding) => binding.binding === 'DB');
if (!db || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(db.database_id || '')) {
  throw new Error('Provision a new D1 database and add its returned database_id to wrangler.jsonc before deploying or applying remote migrations.');
}
if (db.migrations_dir !== 'drizzle' || config.main !== 'dist/server/index.js') {
  throw new Error('Keep Jamama’s generated Worker entry and Drizzle migration directory configured.');
}
console.log('Cloudflare configuration identifies a provisioned D1 database.');
