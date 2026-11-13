# ร้านเพียงพอ — Multiplayer & Cloud Save

Original game (single `index.html`) + Supabase Auth / Realtime / Postgres + Vercel serverless API.
The original UI and gameplay are untouched; only new buttons/panels were added in the same style.

## Project structure
```
index.html              game (original + username login + online features)
api/config.js           returns PUBLIC Supabase URL + anon key + email domain from env
api/_lib/gamestate.js   state validation shared by saves and rooms, wealth formula, earning-budget helpers
api/_lib/limits.js      rate limits + earning budgets (DB functions from migration_006, in-memory fallback)
api/register.js         create player / convert a legacy Google player (server validates, service role)
api/me.js               returns the player that owns the verified session
api/save.js             cloud save (server-side validation, writes leaderboard)
api/room.js             create / join / leave / current / members / start / state / sync
api/leaderboard.js      top 100 + your rank
supabase/schema.sql                      original tables, RLS, realtime policies
supabase/migration_001_username_login.sql  players table + legacy migration (run after schema.sql)
supabase/migration_002_rooms_compat.sql    room_code/owner_id/max_players/status/last_seen columns (matches api/room.js)
supabase/migration_003 … 005              shared room world, 30-day rooms, team leaderboard
supabase/migration_006_rate_limits.sql     DB-backed rate limits + earning budgets (anti-cheat)
supabase/fix_room_realtime.sql             helper functions + private Realtime policies for room:<CODE> (run last)
assets/background_sound.webm               background music (toggle in Settings → เพลงประกอบ)
tests/                                     `npm test` — API + anti-cheat tests with an in-memory fake Supabase
vercel.json  package.json  .env.example  .vercelignore
```
(`auth/callback.html` is the old Google OAuth callback. It is no longer used by the game and can be deleted.)

## Setup
**1. Supabase**
1. SQL Editor → run, in this order: `supabase/schema.sql` (fresh project only), `migration_001_username_login.sql`, `migration_002_rooms_compat.sql`, `migration_003_room_shared_state.sql`, `migration_004_keep_rooms_alive.sql`, `migration_005_team_leaderboard.sql`, **`migration_006_rate_limits.sql`**, then **`fix_room_realtime.sql`** last. Every script is safe to re-run and keeps all existing data. Skip the ones you already applied.
2. Authentication → Providers: keep **Email** enabled (used internally for password hashing/sessions); **disable Google**.
3. Authentication → Sign In / Providers → turn **OFF "Allow new users to sign up"** and keep **Anonymous sign-ins OFF**, so accounts can only be created through `/api/register`. (The API also rejects any session that has no `players` row.)
4. Realtime → Settings: **Allow public access** OFF (rooms use private channels).

**2. Vercel** env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server only). Optional `PLAYER_EMAIL_DOMAIN`. A template is in `.env.example`.

**3. Deploy** and redeploy after changing env vars.

## Migrating existing (Google) players
The migration keeps every existing id, so saves / leaderboard / rooms are untouched. Each legacy player gets a row in `players` (`is_legacy=true, claimed=false`, auto name like `Somchai_a1b2c3`) and **cannot play until they set a username + password**:
- **Still has the old session in the browser** → opening the game shows "ย้ายข้อมูลเดิม": pick a username + password. Same id, all data kept.
- **No old session** → admin runs `select public.admin_issue_claim('Somchai_a1b2c3');` (list candidates with the query inside the migration file) and gives the one-time code (72 h) to the player, who enters it under "ผู้เล่นใหม่ → มีรหัสย้ายข้อมูลเดิม".

## How it works
- **Login**: username + password. Username 3–20 chars, `A–Z a–z 0–9 _`, case-insensitive unique (checked in the UI, in `/api/register`, and by a DB unique index + CHECK). New players are created server-side (`auth.admin.createUser`, internal e-mail `<username>@PLAYER_EMAIL_DOMAIN`, never mailed); returning players sign in with `signInWithPassword` directly from the browser (per-IP rate limiting by Supabase). The password is only sent to Supabase, hashed there, never stored in the browser. The Supabase session (access/refresh token) is persisted by the SDK so the player stays signed in.
- **Player ID**: the UUID created at registration (`players.id`, equals the JWT `sub`). The server always derives it from the verified JWT — the client can never send or forge an id. Cloud Save, Rooms (multiplayer/friends) and Leaderboard are all keyed by it.
- **Cloud save**: autosave every 15 s when state changed, on tab hide / close (`keepalive`), and on logout. Single row per user (`player_saves` PK = user id) so no duplicates. Nothing is uploaded before the cloud save is loaded, so a stale device can't overwrite it by accident. If both a cloud and a different local save exist, the player picks which to keep.
- **Rooms**: Dock 👥 / Menu → Multiplayer. Create a private room (6-char code) or join with the code only (max 6). Membership is stored in the DB and restored on reconnect; expired rooms (24 h) are cleaned up. Positions/actions use Supabase Realtime **private** broadcast + presence channels `room:<CODE>`, protected by RLS on `realtime.messages` (members only). Other players are drawn in the shop/farm with the game's own character model.
- **Leaderboard**: Menu → Leaderboard and 🏆 in the game HUD. Top 100 by wealth; refreshes live via Realtime `postgres_changes`, plus a 30 s fallback.
- **Security**: RLS on all tables; clients can only *read* their own save; every write (saves, leaderboard, rooms) goes through the API with the service role after verifying the user's JWT. The server sanitizes the state and computes wealth (cash + stock at cost + hens) itself. Wealth may only grow as fast as an earning budget refills (400/s, bursts up to 300,000), per player for personal saves and per room for shared worlds (`take_budget` in migration_006; tune `PER_SEC_ALLOW` / `BUDGET_CAP` in `api/_lib/gamestate.js`). A state with no history (first save, or "use my local save") is checked against a day-based cap, and that exception is allowed once per 24 h. Requests are rate limited (saves 40/min, room calls 400/min, registrations 10 per 10 min per IP). The gun in a shared room is only accepted together with a real payment.
- **Background music**: `assets/background_sound.webm` starts when the player presses Play and can be switched off in Settings. The choice is stored on the device. Safari older than 17.4 cannot play WebM/Opus; the game then simply stays silent.

## Known limits
The game logic runs in the browser, so server checks are plausibility limits, not a full authoritative simulation: a determined cheater can still earn at the budget rate. Two devices on the same account use last-write-wins. Without migration_006 the API still works but falls back to per-instance memory limits and a time-based allowance, which are weaker.

## Tests
`npm test` runs the API / anti-cheat / client static checks with no network and no Supabase project.

## Daily missions, upgrades, rain, shop hours, gun (added in v1.2)

- **Gun price is 100,000** everywhere (`GUN_PRICE`). It is bought only through `POST /api/action` (`buy_gun`); the server uses its own price and refuses a second purchase.
- **`api/action.js`** is the only code that changes upgrade levels, mission claims and gun ownership (`buy_gun`, `buy_upgrade`, `claim_mission`). Every request carries a `rid` (replays do nothing) and writes use compare-and-set on the stored version. `shared:true` acts on the room's shared world.
- `api/save.js` / `api/room.js` keep those fields intact when a client sends a whole state (`lockServerFields` in `api/_lib/gamestate.js`). Rules live in `api/_lib/economy.js`.
- **Daily missions** (sell / earn / harvest) scale with the in-game day, reset only when the in-game day changes, and each reward is paid once. **Upgrades** (shop sign, wholesale discount, farm fertiliser) cost `base × 1.8^level`.
- **Rain**: deterministic per in-game day (about 30 % of days, never day 1). Each rain event adds exactly +1 growth day to crops that are not yet ripe; the day's mark is stored in the save / room state so reload and reconnect cannot repeat it.
- **Shop hours**: at 20:00 on the *game* clock all customers disappear and selling stops until the next in-game day. In shared rooms the server also refuses sales once the shared clock reads 20:00.
- **Transaction history** (`tx`, last 40 entries) is shown in the 🎯 panel → 📒 tab. **Music volume** slider is in Settings (saved in this browser only).
- No new SQL migration is needed: everything is stored inside the existing `state` JSON columns.
