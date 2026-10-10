# Contributing to Jamama

Create a branch or fork, make your change, and open a pull request. You can use any coding tool or ChatGPT account. Music accounts, developer credentials and production data are never needed to contribute.

Run `npm ci`, `npm run build`, `npm test`, and `npm run validate`. Run `npm run dev` for a local preview. Sign-in features need your own local provider configuration in an ignored `.private-runtime.json`; its keys are documented in README.md.

Keep the queue, matching, playback acknowledgments and manual pause behavior intact. Use mocked providers for automatic playback tests. Never change another person's music account for a test.

Maintainers review pull requests before merging. Deployment access is separate: authorized Cloudflare maintainers sign in with their own account and run `npm run db:deploy` followed by `npm run cloud:deploy`. Do not share login credentials or commit keys, tokens, provider sessions, private libraries, or runtime database files.

Add database changes as new SQL migrations in `drizzle`. Existing applied migration files must remain unchanged.

Cloudflare access and GitHub organization ownership can be assigned to additional trusted maintainers. GitHub access alone does not grant access to production music accounts.
