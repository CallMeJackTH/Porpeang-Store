const { admin, authPlayer, body } = require('./_lib/sb');
const { cleanState, lockServerFields, wealthOf, shrinkWealth, firstSaveCap, BASE_ALLOW, PER_SEC_ALLOW, BUDGET_CAP } = require('./_lib/gamestate');

const MAX_SAVE_DAY_STEP = 10;   // in-game days a personal save may advance in one request (the game flushes every 15 s); "use my local save" (reset) is exempt
const { rlHit, takeBudget } = require('./_lib/limits');

// Cloud save. Validation is shared with the room code (api/_lib/gamestate.js) so that every field the game
// stores (land plots, gun, clerk, clock, pending VIP, ...) survives a save/load round trip.
//
// Anti-cheat: a player's WEALTH (cash + stock at cost + hens) may only grow as fast as a per-player budget
// refills (PER_SEC_ALLOW per second, bursts up to BUDGET_CAP). A state that arrives without history
// (first save, or an explicit "use my local save" reset) is checked against a day-based plausibility cap,
// and that exception is granted once per 24 h per player.

module.exports = async (req, res) => {
  try {
    const db = admin();
    const user = await authPlayer(req, db);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    if (req.method === 'GET') {
      const { data, error } = await db.from('player_saves').select('state,version,updated_at').eq('user_id', user.id).maybeSingle();
      if (error) return res.status(500).json({ error: 'db' });
      return res.status(200).json({ save: data || null });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

    if ((await rlHit(db, 'save:' + user.id, 40, 60)) === false) return res.status(429).json({ error: 'rate_limited' });

    const b = body(req);
    let st = cleanState(b.state);
    if (!st) return res.status(400).json({ error: 'invalid_state' });
    const settings = b.settings && typeof b.settings === 'object' ? { sens: Number(b.settings.sens) || 1, inv: b.settings.inv ? 1 : 0 } : {};

    const { data: prev, error: e1 } = await db.from('player_saves').select('state,version,updated_at').eq('user_id', user.id).maybeSingle();
    if (e1) return res.status(500).json({ error: 'db' });

    const old = prev && prev.state ? cleanState(prev.state) : null;
    let clamped = false;
    if (old && !b.reset) {
      if (st.d < old.d) st = Object.assign({}, st, { d: old.d });
      else if (st.d > old.d + MAX_SAVE_DAY_STEP) { st = Object.assign({}, st, { d: old.d + MAX_SAVE_DAY_STEP }); clamped = true; }   // days cannot be skipped to reset daily missions
    }
    // Upgrade levels, mission claims, rain marks and the gun are server-owned: a client can only report progress.
    st = lockServerFields(st, old);
    const wNew = wealthOf(st);
    let finalState = st;

    if (!old) {
      // No history: plausibility cap by day (once per account; this is the first save).
      const cap = firstSaveCap(st.d);
      if (wNew > cap) { finalState = shrinkWealth(st, wNew - cap); clamped = true; }
    } else {
      if (st.d < old.d && !b.reset) finalState = Object.assign({}, finalState, { d: old.d });
      const gain = wNew - wealthOf(old);
      if (gain > 0) {
        let granted = await takeBudget(db, 'save:' + user.id, gain, PER_SEC_ALLOW, BUDGET_CAP);
        if (granted === null) {
          // migration_006 not applied yet: legacy rule based on time since the last save.
          const secs = Math.max(1, (Date.now() - new Date(prev.updated_at).getTime()) / 1000);
          granted = BASE_ALLOW + PER_SEC_ALLOW * Math.min(secs, 86400);
        }
        if (granted < gain) {
          let allowed = wealthOf(old) + granted;
          if (b.reset && (await rlHit(db, 'import:' + user.id, 1, 86400)) !== false) {
            allowed = Math.max(allowed, firstSaveCap(st.d));   // "use my local save": one plausibility-capped jump per day
          }
          if (wNew > allowed) { finalState = shrinkWealth(finalState, wNew - allowed); clamped = true; }
        }
      }
    }
    const wealth = wealthOf(finalState);

    const row = {
      state: finalState,
      settings,
      money: finalState.m,
      wealth,
      day: finalState.d,
      version: (prev ? prev.version : 0) + 1,
      updated_at: new Date().toISOString()
    };
    let e2;
    if (prev) {
      // Compare-and-set on the version: a purchase made through api/action.js between our read and write must not be overwritten.
      const r = await db.from('player_saves').update(row).eq('user_id', user.id).eq('version', prev.version).select('version').maybeSingle();
      e2 = r.error;
      if (!e2 && !r.data) return res.status(409).json({ error: 'busy' });
    } else {
      e2 = (await db.from('player_saves').upsert(Object.assign({ user_id: user.id }, row), { onConflict: 'user_id' })).error;
    }
    if (e2) return res.status(500).json({ error: 'db' });

    // Leaderboard is written only here (service role). Clients cannot touch it.
    const { error: e3 } = await db.from('leaderboard').upsert({
      user_id: user.id, display_name: user.username, avatar_url: '',
      money: finalState.m, wealth, updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (e3) return res.status(500).json({ error: 'db' });

    return res.status(200).json({ ok: true, clamped, state: clamped ? finalState : undefined, wealth });
  } catch (e) {
    return res.status(500).json({ error: e.message === 'missing_env' ? 'missing_env' : 'server' });
  }
};
