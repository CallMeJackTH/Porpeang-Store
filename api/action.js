const { admin, authPlayer, body } = require('./_lib/sb');
const { cleanState, wealthOf, PER_SEC_ALLOW, BUDGET_CAP } = require('./_lib/gamestate');
const { applyAction } = require('./_lib/economy');
const { rlHit, takeBudget } = require('./_lib/limits');

// The ONLY place where upgrade levels, mission claims and gun ownership change.
// POST { action: 'buy_gun' | 'buy_upgrade' | 'claim_mission', id?, rid, shared? }
//  - prices, rewards, targets and ownership are computed here; nothing numeric is read from the request
//  - rid makes a request idempotent (replays / double taps / retries have no second effect)
//  - writes use compare-and-set on the stored version, so concurrent saves or purchases cannot double-spend
// shared:true acts on the room's shared world (the caller must be a member of a playing room), otherwise on the personal save.

const ACTIONS = ['buy_gun', 'buy_upgrade', 'claim_mission'];
const STATUS = { insufficient: 409, already_owned: 409, maxed: 409, already_claimed: 409, not_complete: 409, no_mission: 409 };

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const db = admin();
    const user = await authPlayer(req, db);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    if ((await rlHit(db, 'act:' + user.id, 60, 60)) === false) return res.status(429).json({ error: 'rate_limited' });

    const b = body(req);
    if (!ACTIONS.includes(b.action)) return res.status(400).json({ error: 'bad_action' });
    if (b.action === 'claim_mission' && (await rlHit(db, 'claim:' + user.id, 30, 3600)) === false) return res.status(429).json({ error: 'rate_limited' });
    const nowIso = new Date().toISOString();

    let room = null;
    if (b.shared) {
      const { data: m, error: e1 } = await db.from('room_members').select('room_id').eq('user_id', user.id).limit(1).maybeSingle();
      if (e1) return res.status(500).json({ error: 'db' });
      if (!m) return res.status(403).json({ error: 'not_member' });
      const { data: r, error: e2 } = await db.from('game_rooms').select('*').eq('id', m.room_id).gt('expires_at', nowIso).maybeSingle();
      if (e2) return res.status(500).json({ error: 'db' });
      if (!r) return res.status(403).json({ error: 'not_member' });
      if (r.status !== 'playing') return res.status(409).json({ error: 'not_started' });
      room = r;
    }

    let budgeted = null;   // wealth the budget already granted for this request (reused across retries)
    for (let attempt = 0; attempt < 5; attempt++) {
      const q = room
        ? await db.from('room_states').select('state,version').eq('room_id', room.id).maybeSingle()
        : await db.from('player_saves').select('state,version').eq('user_id', user.id).maybeSingle();
      if (q.error) return res.status(500).json({ error: 'db' });
      if (!q.data) return res.status(409).json({ error: room ? 'not_started' : 'no_save' });
      const cur = cleanState(q.data.state);
      if (!cur) return res.status(500).json({ error: 'bad_state' });

      const r = applyAction(cur, { action: b.action, id: b.id, rid: b.rid });
      if (!r.ok) return res.status(STATUS[r.error] || 400).json({ error: r.error });
      const out = { ok: true, duplicate: !!r.duplicate, delta: r.delta, up: r.state.up, ms: r.state.ms, gun: r.state.gun, tx: r.state.tx, version: q.data.version };
      if (r.duplicate) return res.status(200).json(out);

      if (r.delta > 0) {   // a reward is a wealth gain: it comes out of the same earning budget as everything else
        if (budgeted === null) {
          budgeted = await takeBudget(db, room ? 'room:' + room.id : 'save:' + user.id, r.delta, PER_SEC_ALLOW, BUDGET_CAP);
          if (budgeted === null) budgeted = r.delta;   // migration_006 missing: rewards are small and capped by the mission table
        }
        if (budgeted < r.delta) return res.status(429).json({ error: 'busy' });
      }

      const next = r.state, wealth = wealthOf(next), stamp = new Date().toISOString();
      let upd;
      if (room) {
        upd = await db.from('room_states').update({ state: next, version: q.data.version + 1, updated_by: user.id, updated_at: stamp })
          .eq('room_id', room.id).eq('version', q.data.version).select('version').maybeSingle();
      } else {
        upd = await db.from('player_saves').update({ state: next, money: next.m, wealth, day: next.d, version: q.data.version + 1, updated_at: stamp })
          .eq('user_id', user.id).eq('version', q.data.version).select('version').maybeSingle();
      }
      if (upd.error) return res.status(500).json({ error: 'db' });
      if (!upd.data) continue;   // somebody wrote first: redo on top of their result

      if (room) await db.from('game_rooms').update({ team_wealth: wealth, team_money: next.m, team_day: next.d }).eq('id', room.id);
      else await db.from('leaderboard').upsert({ user_id: user.id, display_name: user.username, avatar_url: '', money: next.m, wealth, updated_at: stamp }, { onConflict: 'user_id' });
      out.version = upd.data.version;
      return res.status(200).json(out);
    }
    return res.status(409).json({ error: 'busy' });
  } catch (e) {
    return res.status(500).json({ error: e && e.message === 'missing_env' ? 'missing_env' : 'server' });
  }
};
