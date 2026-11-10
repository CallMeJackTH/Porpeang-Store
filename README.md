# ร้านเพียงพอ — Multiplayer & Cloud Save

Original game (single `index.html`) + Supabase Auth / Realtime / Postgres + Vercel serverless API.
The original UI and gameplay are untouched; only new buttons/panels were added in the same style.

## Project structure
```
index.html              game (original + online features)
auth/callback.html      Google OAuth callback (PKCE code exchange)
api/config.js           returns PUBLIC Supabase URL + anon key from env
api/save.js             cloud save (server-side validation, writes leaderboard)
api/room.js             create / join / leave / current / members
api/leaderboard.js      top 100 + your rank
supabase/schema.sql     tables, indexes, RLS, realtime policies
vercel.json  package.json  .env.example
```
Framework detected: plain static HTML (no Next/Vite) → Vercel static + `/api` functions.
Public keys are served via `/api/config`, so no build step and no code edits are needed.

## Setup (only 3 manual tasks)
**1. Supabase**
1. Create a project. SQL Editor → paste & run `supabase/schema.sql`.
2. Authentication → Providers → **Google**: enable, paste your Google OAuth Client ID/Secret.
   In Google Cloud Console add the redirect URI shown by Supabase (`https://<ref>.supabase.co/auth/v1/callback`).
3. Authentication → URL Configuration: set **Site URL** to your Vercel domain and add
   `https://YOUR-DOMAIN/auth/callback.html` to **Redirect URLs** (add `http://localhost:3000/auth/callback.html` for local dev).
4. Realtime → Settings: make sure **Allow public access** is OFF (rooms use private channels).

**2. Vercel**: import the repo/folder and add environment variables (Production + Preview):

| Name | Where it's used |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public (served by `/api/config`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public (served by `/api/config`) |
| `SUPABASE_SERVICE_ROLE_KEY` | server only (`/api/*`), never sent to the browser |

**3. Deploy** (`vercel --prod` or push to Git). Redeploy after changing env vars.

## How it works
- **Login**: Google via Supabase Auth (PKCE). Session restored automatically; logout and account switching in Menu → Account. All data is keyed by the Supabase user id.
- **Cloud save**: autosave every 15 s when state changed, on tab hide / close (`keepalive`), and on logout. Single row per user (`player_saves` PK = user id) so no duplicates. Nothing is uploaded before the cloud save is loaded, so a stale device can't overwrite it by accident. If both a cloud and a different local save exist, the player picks which to keep.
- **Rooms**: Dock 👥 / Menu → Multiplayer. Create a private room (6-char code) or join with the code only (max 8). Membership is stored in the DB and restored on reconnect; expired rooms (24 h) are cleaned up. Positions/actions use Supabase Realtime **private** broadcast + presence channels `room:<CODE>`, protected by RLS on `realtime.messages` (members only). Other players are drawn in the shop/farm with the game's own character model.
- **Leaderboard**: Menu → Leaderboard and 🏆 in the game HUD. Top 100 by wealth; refreshes live via Realtime `postgres_changes`, plus a 30 s fallback.
- **Security**: RLS on all tables; clients can only *read* their own save; every write (saves, leaderboard, rooms) goes through the API with the service role after verifying the user's JWT. The server sanitizes the state, computes wealth itself, caps money growth between saves (≈ 60,000 + 400/s) and caps a first-ever save by day.

## Known limits
The game logic runs in the browser, so server checks are plausibility limits, not a full authoritative simulation. Two devices on the same account use last-write-wins.
