# UPGRADE_PROGRESS

## Completed phases
1. Inspect + map features -> done (see file audit below)
2. Economy / transaction history -> done (client `rec()` hooks, server `cleanTx/mergeTx`, UI tab)
3. Daily missions -> done (client progress, server-paid, claim-once, day-boundary reset)
4. Shop upgrades -> done (`api/action.js`, progressive price, UI)
5. Rain + crop growth -> done (deterministic schedule, `b` bonus field, exactly-once mark `rn`)
6. BGM volume -> done (Settings slider, local persistence)
7. 8 PM closing -> done (client removal/stop/reject + server refusal in shared rooms)
8. Controls + gun price -> done (CSS media rule, G guards, 100,000 via server)
9. Multiplayer/persistence/responsive -> done (SHK keys, afterSrv baseline, dock fits narrow phones)
10. Regression tests -> `npm test`: 47 passed, 0 failed

## Files
Modified: index.html, api/save.js, api/_lib/gamestate.js, tests/run.js, README.md
Created: api/action.js, api/_lib/economy.js, UPGRADE_PROGRESS.md
Not touched: api/room.js, api/register.js, api/_lib/limits.js, api/_lib/sb.js, api/me.js, api/leaderboard.js, api/config.js, supabase/*, assets/*, auth/*, vercel.json, package.json

## Commands run
npm test (before: 29 passed; after: 47 passed). node --check on both inline scripts (via the test suite).

## Remaining / not verified
- No real browser or live Supabase/Vercel here: responsive layouts, touch controls, audio autoplay, real-time sync are NOT RUN (manual checklist in the final report).
