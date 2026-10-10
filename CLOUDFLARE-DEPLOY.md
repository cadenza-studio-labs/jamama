# Independent Cloudflare deployment

The Worker configuration identifies a database once provisioning completes. Keep its account and database IDs in `wrangler.jsonc`; runtime credentials belong only in Cloudflare secrets or ignored local configuration.

The existing build bundles the application and its public assets into `dist/server/index.js`. Wrangler needs no separate static-assets binding, Node compatibility flag, Sites manifest, or OpenAI account. Pin Wrangler in the repository and commit the lockfile before deployment.

## First provisioning

Run from the new Jamama repository. Log in to the intended shared Cloudflare account, then verify the account before creating resources.

```sh
npx wrangler login
npx wrangler whoami
npx wrangler d1 create jamama-cloud
```

Create the database once. If that name already exists, stop and inspect it; do not delete or reuse it automatically. Add the returned UUID as `database_id` in the `DB` entry of `wrangler.jsonc`. Record the verified account ID as `account_id` when the login can access several accounts. Database and account IDs are configuration, not credentials.

Validate the configuration, verify the new database identity, then list and apply its migrations:

```sh
node scripts/check-cloud-config.mjs
npx wrangler d1 info jamama-cloud
npx wrangler d1 migrations list jamama-cloud --remote
npx wrangler d1 migrations apply jamama-cloud --remote
```

Use only the newly provisioned database. Do not run this initial schema against the inaccessible former Sites database or a database already containing Jamama tables without matching Wrangler migration records. `migrations apply` records each filename in `d1_migrations`; repeating it applies only outstanding files. Do not use a bare `d1 execute --file` for subsequent deployments.

The current `drizzle/0000_yummy_maestro.sql` is compatible with Wrangler: its `--> statement-breakpoint` markers are SQL line comments, and each real statement is terminated. Top-level `.sql` files are discovered with `migrations_dir: "drizzle"`; Drizzle metadata JSON is ignored. Keep existing migration files immutable and append generated migrations later.

## Runtime configuration

Configure these values in Cloudflare, not in source:

- `SESSION_ENCRYPTION_KEY`: a new, cryptographically random 32-byte key encoded as 64 hexadecimal characters.
- `APPLE_MUSIC_DEVELOPER_TOKEN`: a signed token permitting the new public origin. Keep the Apple private signing key outside the repository.
- `SPOTIFY_CLIENT_ID`: the registered Spotify application’s public client ID.
- `PUBLIC_URL`: the final stable HTTPS origin. The Worker can derive its initial origin from the request until this is set.

For the initial release, an ignored mode-0600 JSON file can supply these values without exposing them in shell arguments. Upload it with the code:

```sh
npm ci
npm run build
npm test
npm run validate
node scripts/check-cloud-config.mjs
npx wrangler deploy --secrets-file .env.production.json
```

Ignore `.env.production.json`, `.env*`, `.dev.vars*`, `.wrangler/`, and local runtime stores before creating the file. Do not commit it or print it. A secret file upload preserves existing secrets absent from the file. Later, use `npx wrangler secret put NAME` for updates, entering values in its hidden prompt. Never rotate `SESSION_ENCRYPTION_KEY` while retaining its encrypted database rows.

Use the actual deployment URL, never a guessed hostname. Add its exact `/auth/spotify/callback` URL in Spotify’s developer dashboard. Set `PUBLIC_URL` and renew the Apple developer token for that same origin. Visitors will need fresh provider sign-in; old browser sessions and old Sites databases are not imported. Spotify development-mode restrictions still apply.

## Later releases

```sh
npm ci
npm run build
npm test
npm run validate
node scripts/check-cloud-config.mjs
npx wrangler d1 migrations list jamama-cloud --remote
npx wrangler d1 migrations apply jamama-cloud --remote
npx wrangler deploy
```

The remote migration step is safe to repeat because Wrangler tracks applied filenames. A failed migration rolls back that migration; earlier successful migrations remain applied. Resolve its exact error before repeating deployment.

Share the Git repository with trusted contributors and invite hosting maintainers to the same Cloudflare account. Code contribution permissions and production deployment permissions can remain separate. ChatGPT account access is no longer required to maintain this Worker.

## Primary references

- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Renewing Apple playback configuration

Apple developer tokens have a maximum lifetime of six months. The local signing key remains on its owner’s Mac. With an ignored `.private-signing.json` containing `teamId`, `keyId`, and `keyPath`, and existing `.env.production.json` runtime values, run `node scripts/apple-token.mjs https://jamama-cloud.jamama-cadenza.workers.dev`, then `npx wrangler deploy --secrets-file .env.production.json`. The helper preserves the session encryption key and updates only the Apple token and public origin. Never put the private key or signing configuration in GitHub.

The GitHub check template lives in `automation/github-checks.yml`. Enable it under `.github/workflows` only through an account with GitHub workflow permission.
