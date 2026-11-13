// Server-side game rules for the "remaining systems": upgrades, daily missions, the gun, rain schedule,
// transaction history. Everything here is pure (no I/O) so it can be unit-tested and shared by
// api/action.js (the only code allowed to change upgrade levels, mission claims and gun ownership),
// api/save.js and api/room.js (which must keep those fields intact when a client sends a whole state).

const GUN_PRICE = 100000;          // the one and only gun price. index.html shows the same number; the server never reads a client price.
const MAX_TX = 40;                 // transaction history kept per state
const MAX_AR = 30;                 // processed action ids remembered (replay protection)
const CLOSE_MIN = 1200;            // 20:00 in game minutes (06:00 = 360)

// ---------- shop upgrades ----------
// cost(level) = base * 1.8^level, rounded to 50. Effects are applied by the client from the (server-locked) level.
const UPGRADES = {
  cs: { max: 5, base: 2000 },      // customers arrive 8% faster per level
  dc: { max: 5, base: 3000 },      // 3% cheaper wholesale imports per level
  fm: { max: 3, base: 4000 }       // +1 unit per harvest per level
};
const UPGRADE_IDS = Object.keys(UPGRADES);
const upgradeCost = (id, level) => {
  const u = UPGRADES[id];
  if (!u || !Number.isInteger(level) || level < 0 || level >= u.max) return null;   // null = not buyable (unknown / maxed)
  return Math.round(u.base * Math.pow(1.8, level) / 50) * 50;
};
const upgradeSpend = up => {
  let t = 0;
  UPGRADE_IDS.forEach(id => { for (let l = 0; l < ((up && up[id]) | 0); l++) t += upgradeCost(id, l) || 0; });
  return t;
};

// ---------- daily missions (3 per in-game day, harder every few days) ----------
const MISSION_IDS = ['sell', 'earn', 'farm'];
const missionTarget = (id, d) => {
  d = Math.max(1, Math.min(100000, Math.round(d) || 1));
  if (id === 'sell') return Math.min(40, 3 + Math.floor(d * 0.7));
  if (id === 'earn') return Math.min(20000, Math.round((300 + d * 120) / 50) * 50);
  if (id === 'farm') return Math.min(10, 1 + Math.floor(d / 4));
  return null;
};
const missionReward = (id, d) => {
  const t = missionTarget(id, d);
  if (t == null) return null;
  if (id === 'sell') return 120 + t * 30;
  if (id === 'earn') return Math.round(t * 0.12 / 10) * 10;
  return 100 + t * 80;
};

// ---------- rain (deterministic per in-game day, so every client and the server agree) ----------
/*RAIN-BEGIN*/
function rainHash(n) { let x = Math.imul(n | 0, 2654435761) >>> 0; x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; }
function rainInfo(d) {
  d = Math.round(d) || 0;
  if (d < 2 || rainHash(d * 131 + 7) >= 0.3) return null;                    // day 1 never rains; ~30% of other days
  const s = 480 + Math.floor(rainHash(d * 17 + 3) * 49) * 10;                 // starts between 08:00 and 16:00
  return { s, e: s + 150 };
}
/*RAIN-END*/

// ---------- transactions ----------
const REASON_RE = /^[a-z0-9_]{1,16}$/;
const TXID_RE = /^[A-Za-z0-9_-]{1,24}$/;
function cleanTx(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set(), out = [];
  for (const t of list.slice(-MAX_TX * 2)) {
    if (!t || typeof t !== 'object') continue;
    const a = Math.round(Number(t.a));
    if (!(t.t === 'in' || t.t === 'out') || !Number.isFinite(a) || a < 1 || a > 1e9) continue;   // negative / zero / NaN amounts are invalid
    if (typeof t.i !== 'string' || !TXID_RE.test(t.i) || seen.has(t.i)) continue;                  // duplicate ids are dropped
    if (typeof t.r !== 'string' || !REASON_RE.test(t.r)) continue;
    seen.add(t.i);
    out.push({ i: t.i, t: t.t, a, r: t.r, d: Math.max(1, Math.min(100000, Math.round(Number(t.d)) || 1)), c: Math.max(0, Math.min(1200, Math.round(Number(t.c)) || 0)) });
  }
  return out.slice(-MAX_TX);
}
// Union by id: history is append-only for clients (they cannot delete or rewrite entries the server already holds).
function mergeTx(base, extra) {
  const a = cleanTx(base), seen = new Set(a.map(t => t.i));
  cleanTx(extra).forEach(t => { if (!seen.has(t.i)) { seen.add(t.i); a.push(t); } });
  return a.slice(-MAX_TX);
}

// ---------- state field sanitisers (used by gamestate.cleanState) ----------
function cleanUp(up) {
  const out = {};
  UPGRADE_IDS.forEach(id => { const n = Math.round(Number(up && up[id])); out[id] = Number.isFinite(n) ? Math.max(0, Math.min(UPGRADES[id].max, n)) : 0; });
  return out;
}
function cleanMs(ms) {
  if (!ms || typeof ms !== 'object') return null;
  const d = Math.round(Number(ms.d));
  if (!Number.isFinite(d) || d < 1 || d > 100000) return null;
  const p = {}, c = {};
  MISSION_IDS.forEach(id => {
    const n = Math.round(Number(ms.p && ms.p[id]));
    p[id] = Number.isFinite(n) ? Math.max(0, Math.min(1e7, n)) : 0;
    if (ms.c && ms.c[id]) c[id] = 1;
  });
  return { d, p, c };
}
const cleanRn = (rn, d) => (rn && typeof rn === 'object' && Math.round(Number(rn.d)) >= 1) ? { d: Math.round(Number(rn.d)), a: 1 } : null;
const cleanAr = ar => Array.isArray(ar) ? ar.filter(x => typeof x === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(x)).slice(-MAX_AR) : [];

// ---------- locks: server-owned fields a client may send but never change ----------
function lockMissions(oldMs, ms, d) {
  const sameDay = oldMs && oldMs.d === d;
  if (!ms || ms.d !== d) return sameDay ? oldMs : null;                      // missions only change at the in-game day boundary
  const p = {}, c = {};
  MISSION_IDS.forEach(id => {
    const o = sameDay ? (oldMs.p[id] || 0) : 0;
    p[id] = Math.max(o, Math.min(ms.p[id] || 0, missionTarget(id, d) * 2));  // progress never goes down within a day, and is bounded
    if (sameDay && oldMs.c[id]) c[id] = 1;                                   // claims come only from the stored state
  });
  return { d, p, c };
}
function lockRain(oldRn, rn, d) {
  if (oldRn && oldRn.d === d) return oldRn;
  if (rn && rn.d === d && rainInfo(d)) return { d, a: 1 };                   // a rain mark is valid only on a day that really has rain
  return oldRn && oldRn.d > d ? oldRn : null;
}
function lockPlots(oldPlots, plots, d, rn, oldRn) {
  const fresh = !!(rn && rn.d === d && !(oldRn && oldRn.d === d));           // exactly one new rain event this sync, at most
  return plots.map((p, i) => {
    if (!p) return p;
    const o = oldPlots && oldPlots[i];
    const same = o && o.c === p.c && o.d === p.d;
    let b = Math.max(0, Math.min(8, Math.round(Number(p.b)) || 0));
    const days = Math.max(0, d - p.d) + 1;                                   // at most one rain per day since planting
    if (oldPlots) b = Math.min(b, same ? ((o.b | 0) + (fresh ? 1 : 0)) : 0); // a new crop starts with no bonus
    b = Math.min(b, days);
    return b ? { c: p.c, d: p.d, b } : { c: p.c, d: p.d };
  });
}

// ---------- server-only actions ----------
// state: a cleaned state. Returns { ok:true, state, delta } or { ok:false, error }.
function applyAction(state, req) {
  const st = JSON.parse(JSON.stringify(state));
  const rid = String(req && req.rid || '');
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(rid)) return { ok: false, error: 'bad_rid' };
  if (st.ar.includes(rid)) return { ok: true, duplicate: true, state: st, delta: 0 };      // replayed request: no second effect
  const note = (type, amount, reason) => { st.tx = mergeTx(st.tx, [{ i: 'sv' + rid.slice(0, 20), t: type, a: amount, r: reason, d: st.d, c: st.clk == null ? 360 : st.clk }]); };
  let delta = 0;
  const act = req.action;
  if (act === 'buy_gun') {
    if (st.gun) return { ok: false, error: 'already_owned' };
    if (st.m < GUN_PRICE) return { ok: false, error: 'insufficient' };
    st.m -= GUN_PRICE; st.gun = 1; delta = -GUN_PRICE; note('out', GUN_PRICE, 'gun');
  } else if (act === 'buy_upgrade') {
    const id = String(req.id || '');
    if (!UPGRADES[id]) return { ok: false, error: 'bad_upgrade' };
    const cost = upgradeCost(id, st.up[id] | 0);
    if (cost == null) return { ok: false, error: 'maxed' };
    if (st.m < cost) return { ok: false, error: 'insufficient' };
    st.m -= cost; st.up[id] = (st.up[id] | 0) + 1; delta = -cost; note('out', cost, 'up_' + id);
  } else if (act === 'claim_mission') {
    const id = String(req.id || '');
    if (!MISSION_IDS.includes(id)) return { ok: false, error: 'bad_mission' };
    if (!st.ms || st.ms.d !== st.d) return { ok: false, error: 'no_mission' };
    if (st.ms.c[id]) return { ok: false, error: 'already_claimed' };
    if ((st.ms.p[id] || 0) < missionTarget(id, st.d)) return { ok: false, error: 'not_complete' };
    const r = missionReward(id, st.d);
    st.ms.c[id] = 1; st.m += r; delta = r; note('in', r, 'mission');
  } else return { ok: false, error: 'bad_action' };
  st.ar = st.ar.concat(rid).slice(-MAX_AR);
  return { ok: true, state: st, delta };
}

module.exports = {
  GUN_PRICE, MAX_TX, CLOSE_MIN, UPGRADES, UPGRADE_IDS, MISSION_IDS,
  upgradeCost, upgradeSpend, missionTarget, missionReward, rainInfo, rainHash,
  cleanTx, mergeTx, cleanUp, cleanMs, cleanRn, cleanAr, lockMissions, lockRain, lockPlots, applyAction
};
