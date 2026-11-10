# ร้านเพียงพอ — Multiplayer & Cloud Save

Original game (single `index.html`) + Supabase Auth / Realtime / Postgres + Vercel serverless API.
The original UI and gameplay are untouched; only new buttons/panels were added in the same style.

## Project structure
```
index.html              game (original + username login + online features)
api/config.js           returns PUBLIC Supabase URL + anon key + email domain from env
api/register.js         create player / convert a legacy Google player (server validates, service role)
api/me.js               returns the player that owns the verified session
api/save.js             cloud save (server-side validation, writes leaderboard)
api/room.js             create / join / leave / current / members
api/leaderboard.js      top 100 + your rank
supabase/schema.sql                      original tables, RLS, realtime policies
supabase/migration_001_username_login.sql  players table + legacy migration (run after schema.sql)
vercel.json  package.json  .env.example
```
(`auth/callback.html` — Google OAuth callback — was removed.)

## Setup
**1. Supabase**
1. SQL Editor → run `supabase/schema.sql` (fresh project only), then **`supabase/migration_001_username_login.sql`** (always; safe to re-run, keeps all existing data).
2. Authentication → Providers: keep **Email** enabled (used internally for password hashing/sessions); **disable Google**.
3. Authentication → Sign In / Providers → turn **OFF "Allow new users to sign up"** and keep **Anonymous sign-ins OFF**, so accounts can only be created through `/api/register`. (The API also rejects any session that has no `players` row.)
4. Realtime → Settings: **Allow public access** OFF (rooms use private channels).

**2. Vercel** env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server only). Optional `PLAYER_EMAIL_DOMAIN`.

**3. Deploy** and redeploy after changing env vars.

## Migrating existing (Google) players
The migration keeps every existing id, so saves / leaderboard / rooms are untouched. Each legacy player gets a row in `players` (`is_legacy=true, claimed=false`, auto name like `Somchai_a1b2c3`) and **cannot play until they set a username + password**:
- **Still has the old session in the browser** → opening the game shows "ย้ายข้อมูลเดิม": pick a username + password. Same id, all data kept.
- **No old session** → admin runs `select public.admin_issue_claim('Somchai_a1b2c3');` (list candidates with the query inside the migration file) and gives the one-time code (72 h) to the player, who enters it under "ผู้เล่นใหม่ → มีรหัสย้ายข้อมูลเดิม".

## How it works
- **Login**: username + password. Username 3–20 chars, `A–Z a–z 0–9 _`, case-insensitive unique (checked in the UI, in `/api/register`, and by a DB unique index + CHECK). New players are created server-side (`auth.admin.createUser`, internal e-mail `<username>@PLAYER_EMAIL_DOMAIN`, never mailed); returning players sign in with `signInWithPassword` directly from the browser (per-IP rate limiting by Supabase). The password is only sent to Supabase, hashed there, never stored in the browser. The Supabase session (access/refresh token) is persisted by the SDK so the player stays signed in.
- **Player ID**: the UUID created at registration (`players.id`, equals the JWT `sub`). The server always derives it from the verified JWT — the client can never send or forge an id. Cloud Save, Rooms (multiplayer/friends) and Leaderboard are all keyed by it.
- **Cloud save**: autosave every 15 s when state changed, on tab hide / close (`keepalive`), and on logout. Single row per user (`player_saves` PK = user id) so no duplicates. Nothing is uploaded before the cloud save is loaded, so a stale device can't overwrite it by accident. If both a cloud and a different local save exist, the player picks which to keep.
- **Rooms**: Dock 👥 / Menu → Multiplayer. Create a private room (6-char code) or join with the code only (max 8). Membership is stored in the DB and restored on reconnect; expired rooms (24 h) are cleaned up. Positions/actions use Supabase Realtime **private** broadcast + presence channels `room:<CODE>`, protected by RLS on `realtime.messages` (members only). Other players are drawn in the shop/farm with the game's own character model.
- **Leaderboard**: Menu → Leaderboard and 🏆 in the game HUD. Top 100 by wealth; refreshes live via Realtime `postgres_changes`, plus a 30 s fallback.
- **Security**: RLS on all tables; clients can only *read* their own save; every write (saves, leaderboard, rooms) goes through the API with the service role after verifying the user's JWT. The server sanitizes the state, computes wealth itself, caps money growth between saves (≈ 60,000 + 400/s) and caps a first-ever save by day.

## Known limits
The game logic runs in the browser, so server checks are plausibility limits, not a full authoritative simulation. Two devices on the same account use last-write-wins.
