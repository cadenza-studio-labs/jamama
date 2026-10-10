import { Miniflare } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
let values = {};
try { values = JSON.parse(await readFile('.private-runtime.json', 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
values.SESSION_ENCRYPTION_KEY ||= process.env.SESSION_ENCRYPTION_KEY || randomBytes(32).toString('hex');
const preview = new Miniflare({ modules: true, scriptPath: 'dist/server/index.js', port: 4184, host: '127.0.0.1', compatibilityDate: '2025-07-18',
  bindings: { ...values, PUBLIC_URL: 'http://127.0.0.1:4184' }, d1Databases: { DB: 'jamama-preview' }, d1Persist: '.local-runtime/db' });
const DB = await preview.getD1Database('DB');
await DB.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY)');
for (const file of (await readdir('drizzle')).filter((name) => name.endsWith('.sql'))) {
  if (await DB.prepare('SELECT name FROM _local_migrations WHERE name = ?').bind(file).first()) continue;
  for (const statement of (await readFile('drizzle/' + file, 'utf8')).split('--> statement-breakpoint')) if (statement.trim()) await DB.exec(statement.trim().replaceAll('\n', ' '));
  await DB.prepare('INSERT INTO _local_migrations(name) VALUES (?)').bind(file).run();
}
console.log('Jamama preview: ' + await preview.ready);
async function close() { await preview.dispose(); process.exit(0); }
process.on('SIGTERM', close); process.on('SIGINT', close);
