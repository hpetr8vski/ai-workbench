# AI Workbench

A web app (and optional Discord bot) for generating images in parallel with
Google's Gemini image models ("Nano Banana" / "Nano Banana Pro") using a paid
Gemini API key.

- `server/` — Express backend that holds the API key and proxies calls to
  Gemini, capping concurrent requests to the model (`MAX_CONCURRENCY`).
  Persists every generation's image + metadata to `server/generations/`
  (survives restarts) and tracks cumulative token usage.
- `client/` — React (Vite) frontend: write a prompt, pick how many parallel
  iterations to run, drag & drop reference images, browse/reuse past
  generations, click any image for a large in-app preview.
- `bot/` — Discord bot that lets others generate images from a private
  channel using the same backend (same history log, same usage tracking).

## Setup

1. Install [Node.js](https://nodejs.org) (LTS) if you haven't already.
2. Get a Gemini API key at [Google AI Studio](https://aistudio.google.com/apikey),
   and link its Google Cloud project to a billing account so it runs on the
   paid tier (higher rate limits — required for reliable parallel generation).
3. Install dependencies:
   ```
   npm run install:all
   ```
4. Configure the server:
   ```
   copy server\.env.example server\.env
   ```
   Then edit `server/.env` and set `GEMINI_API_KEY` to your key.
5. Run server + client together:
   ```
   npm run dev
   ```
   Server runs on http://localhost:3001, client on http://localhost:5173
   (Vite proxies `/api` and `/generations` to the server).

## Discord bot (optional)

Lets coworkers generate images from a private Discord channel: they type a
prompt, optionally attach reference images, and the bot replies with the
result. See the full walkthrough for creating the bot application in Discord's
Developer Portal if you haven't already — summary:

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications),
   add a Bot, enable the **Message Content** privileged intent, and copy the bot token.
2. Under OAuth2 → URL Generator, generate an invite URL with the `bot` scope
   and permissions: View Channels, Send Messages, Attach Files, Read Message
   History, Add Reactions. Use it to invite the bot to your server.
3. Create/use a private channel restricted to the coworkers who should have
   access, and copy its Channel ID (enable Developer Mode in Discord settings
   first).
4. ```
   copy bot\.env.example bot\.env
   ```
   Edit `bot/.env`: set `DISCORD_BOT_TOKEN` (never commit or share this) and
   `DISCORD_CHANNEL_ID`. `GENERATE_SERVER_URL` should point at wherever
   `server/` is running (defaults to `http://localhost:3001`).
5. Run it (either standalone or as part of `npm run dev`, which now starts
   server + client + bot together):
   ```
   npm run dev:bot
   ```

Usage in Discord: type a prompt in the channel, optionally attach reference
images, and the bot replies with the generated image(s). Send `help` in the
channel for the flag syntax (`--ar`, `--size`, `--model`, `--n`).

The bot is just another client of the same `/api/generate` endpoint the web
app uses, so Discord-originated generations show up in the web app's history
and count toward the same token-usage totals.

**Heads up:** the bot needs `server/` reachable over the network at all times
it should be usable — running everything on your own machine only works
while your machine and `npm run dev` are both on. For always-on access,
`server/` (and the bot) need to run somewhere persistent (a small VPS, etc.)
rather than just your dev machine.

## Notes

- `MAX_CONCURRENCY` in `server/.env` limits how many Gemini calls run at once
  server-wide, regardless of how many requests come in (web app or bot) —
  raise it if your paid tier allows more throughput, lower it if you hit rate
  limit errors.
- `IMAGE_MODEL` defaults to `gemini-3-pro-image-preview`. If Google
  renames/aliases the model string, check
  https://ai.google.dev/gemini-api/docs/image-generation and update the value
  in `server/.env`.
- Never commit `server/.env` or `bot/.env` — they hold secrets.
