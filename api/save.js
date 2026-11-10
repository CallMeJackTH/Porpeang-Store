const { admin, authUser, body } = require('./_lib/sb');

// Server-side limits. Money may grow only as fast as the game can legitimately produce it.
const MAX_MONEY = 1e9;
const MAX_DAY = 100000;
const BASE_ALLOW = 60000;      // flat allowance per save (a big VIP sale + trades)
const PER_SEC_ALLOW = 400;     // sustained gain allowed per second since the last save
const ITEMS = ['ma', 'fi', 'sa', 'su', 'eg', 'ri', 'wa', 'vg'];
const COST = { ma: 5, fi: 18, sa: 20, su: 20, eg: 4, ri: 100, wa: 5, vg: 8 };   // base cost per unit (server-side valuation)
const MAX_STOCK = 5000;
const FIRST_SAVE_PER_DAY = 50000;   // plausibility cap for a first-ever cloud save

function cleanState(s) {
  if (!s || typeof s !== 'object') return null;
  const m = Math.round(Number(s.m));
  const d = Math.round(Number(s.d));
  if (!Number.isFinite(m) || !Number.isFinite(d) || m < 0 || m > MAX_MONEY || d < 1 || d > MAX_DAY) return null;
  const st = {}, pr = {};
  for (const k of ITEMS) {
    const a = Math.round(Number(s.st && s.st[k]));
    const b = Math.round(Number(s.pr && s.pr[k]));
    st[k] = Number.isFinite(a) ? Math.max(0, Math.min(MAX_STOCK, a)) : 0;
    pr[k] = Number.isFinite(b) ? Math.max(1, Math.min(1e5, b)) : 1;
  }
  const plots = Array.isArray(s.plots) ? s.plots.slice(0, 8).map(p => p && (p.c === 'ri' || p.c === 'vg') ? { c: p.c, d: Math.round(Number(p.d)) || 1 } : null) : Array(8).fill(null);
  while (plots.length < 8) plots.push(null);
  const nest = Array.isArray(s.nest) ? s.nest.slice(0, 4).map(n => ({ d: Math.round(Number(n && n.d)) || 1 })) : [];
  const emp = s.emp && typeof s.emp === 'object' ? { sl: s.emp.sl ? 1 : 0 } : null;
  let ev = null;
  if (s.ev && typeof s.ev === 'object' && typeof s.ev.t === 'string') {
    ev = { t: s.ev.t.slice(0, 120) };
    if (typeof s.ev.w === 'string' && ITEMS.includes(s.ev.w)) ev.w = s.ev.w;
    ['x', 'sp', 'cm'].forEach(k => { const n = Number(s.ev[k]); if (Number.isFinite(n) && n >= 0 && n <= 20) ev[k] = n; });
  }
  const trv = {};
  if (s.tr && s.tr.v && typeof s.tr.v === 'object') {
    Object.keys(s.tr.v).slice(0, 100).forEach(k => {
      const n = Math.round(Number(s.tr.v[k]));
      if (/^[a-z]{3}[0-9][a-z]{2}$/.test(k) && Number.isFinite(n) && n >= 0 && n <= 1000) trv[k] = n;
    });
  }
  return {
    m, d, farm: 1, plots, nest, emp, ev,
    hens: Math.max(0, Math.min(8, Math.round(Number(s.hens)) || 0)),
    coop: Math.max(0, Math.min(12, Math.round(Number(s.coop)) || 0)),
    wv: Math.max(0, Math.round(Number(s.wv)) || 0),
    sold: Math.max(0, Math.round(Number(s.sold)) || 0),
    st, pr,
    tr: { d: s.tr && Math.round(Number(s.tr.d)) || 1, v: trv }
  };
}

function wealthOf(s) {
  // total wealth = cash + stock valued at base cost + farm assets. Computed on the server only.
  let w = s.m;
  for (const k of ITEMS) w += s.st[k] * COST[k];
  w += s.hens * 50;
  return Math.round(w);
}

module.exports = async (req, res) => {
  try {
    const db = admin();
    const user = await authUser(req, db);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    if (req.method === 'GET') {
      const { data, error } = await db.from('player_saves').select('state,version,updated_at').eq('user_id', user.id).maybeSingle();
      if (error) return res.status(500).json({ error: 'db' });
      return res.status(200).json({ save: data || null });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

    const b = body(req);
    const st = cleanState(b.state);
    if (!st) return res.status(400).json({ error: 'invalid_state' });
    const settings = b.settings && typeof b.settings === 'object' ? { sens: Number(b.settings.sens) || 1, inv: b.settings.inv ? 1 : 0 } : {};

    const { data: prev, error: e1 } = await db.from('player_saves').select('state,version,updated_at').eq('user_id', user.id).maybeSingle();
    if (e1) return res.status(500).json({ error: 'db' });

    let finalState = st;
    let clamped = false;
    if (!prev) {
      const cap = 5000 + st.d * FIRST_SAVE_PER_DAY;
      if (st.m > cap) { finalState = Object.assign({}, st, { m: cap }); clamped = true; }
    }
    if (prev && prev.state) {
      const old = prev.state;
      const secs = Math.max(1, (Date.now() - new Date(prev.updated_at).getTime()) / 1000);
      const allow = BASE_ALLOW + PER_SEC_ALLOW * Math.min(secs, 86400);
      if (st.d >= old.d && st.m - old.m > allow) {
        // reject suspicious jumps of money: keep the legit part only
        finalState = Object.assign({}, st, { m: Math.round(old.m + allow) });
        clamped = true;
      }
      if (st.d < old.d && !b.reset) finalState = Object.assign({}, finalState, { d: old.d });
    }
    const wealth = wealthOf(finalState);

    const { error: e2 } = await db.from('player_saves').upsert({
      user_id: user.id,
      state: finalState,
      settings,
      money: finalState.m,
      wealth,
      day: finalState.d,
      version: (prev ? prev.version : 0) + 1,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (e2) return res.status(500).json({ error: 'db' });

    // Leaderboard is written only here (service role). Clients cannot touch it.
    const meta = user.user_metadata || {};
    const name = String(meta.full_name || meta.name || (user.email || 'Player').split('@')[0]).slice(0, 40);
    const avatar = String(meta.avatar_url || meta.picture || '').slice(0, 500);
    const { error: e3 } = await db.from('leaderboard').upsert({
      user_id: user.id, display_name: name, avatar_url: avatar,
      money: finalState.m, wealth, updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (e3) return res.status(500).json({ error: 'db' });

    return res.status(200).json({ ok: true, clamped, state: clamped ? finalState : undefined, wealth });
  } catch (e) {
    return res.status(500).json({ error: e.message === 'missing_env' ? 'missing_env' : 'server' });
  }
};
