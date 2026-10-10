# Jamama

Live app: https://jamama-cloud.jamama-cadenza.workers.dev

Jamama brings friends' Spotify and Apple Music libraries into one shared queue. The host plays matched recordings with their own music subscription. Recall is a guessing game using Apple Music playlists, recent listening, or a selected QQ Music playlist; Taste compares shared song selections.

This repository runs independently of ChatGPT Sites. Any coding tool or ChatGPT account can contribute. Production runs on Cloudflare Workers with a D1 database. Music streams directly from its service, while Jamama stores encrypted provider connections and shared request metadata.

## Local development

Use Node.js 22 or newer. Run `npm ci`, `npm run build`, `npm test`, and `npm run validate`. Run `npm run dev` to open the local app at `http://127.0.0.1:4184`.

Without provider credentials the preview still supports Jam creation and invitations. For real service sign-in, create an ignored `.private-runtime.json` containing your own runtime configuration. Its supported keys are `SPOTIFY_CLIENT_ID`, `APPLE_MUSIC_DEVELOPER_TOKEN`, and `SESSION_ENCRYPTION_KEY`. The latter is 32 random bytes encoded as 64 hex characters. Do not store private Apple signing keys in this repository.

## Deploying

See [CLOUDFLARE-DEPLOY.md](CLOUDFLARE-DEPLOY.md). Create a new D1 database, configure the Worker, upload provider configuration through Cloudflare secrets, and apply the tracked SQL migrations. Production provider sessions start fresh and require visitors to sign in again. Spotify developer access restrictions still apply.

The build bundles public assets into `dist/server/index.js`. It has no ChatGPT runtime or account dependency. The former Sites address and database are not part of this deployment.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Anyone can propose a code change by opening a pull request. Production changes remain limited to trusted maintainers.

## Provider and artwork credits

Official service marks are listed in `public/brands/SOURCES.md`. Included fonts retain their licenses in `public/fonts`. Artwork and music metadata are fetched from each service at runtime; this repository contains no personal music library or streaming audio.

The optional GitHub check workflow is in `automation/github-checks.yml`. A maintainer with workflow permission can enable it under `.github/workflows`. It runs builds and mocked tests without production secrets.

## QQ playlists in Recall

Connect Apple Music in Recall, then choose **QQ Music playlist**. Download the Mac metadata exporter from the quiz, unzip it, and run its launcher to choose a cached QQ playlist. Select the resulting JSON file in Recall and start the game.

QQ provides the song selection; Apple Music plays confirmed matching recordings with the user’s own subscription. Direct QQ streaming and timed clip control are not connected. Only the chosen playlist metadata is sent after Start. The quiz matches the first 100 selected songs, reports missing or uncertain recordings, and preserves the original QQ and Apple libraries.

The exporter reads QQ Music’s Mac cache without modifying it. Open the playlist in QQ Music first; unloaded songs may be unavailable. It exports no audio or login credentials. See `scripts/QQ-EXPORT-README.txt` for local instructions.
