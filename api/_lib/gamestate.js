// Shared room game state: sanitising + merging of per-player changes.
// cleanState() is the same validation used by api/save.js for personal saves.
const eco = require('./economy');
const MAX_MONEY = 1e9;
const MAX_DAY = 100000;
const BASE_ALLOW = 60000;      // legacy fallback: flat gain allowed per sync (used only when migration_006 is missing)
const PER_SEC_ALLOW = 400;     // sustained wealth gain allowed per second (budget refill rate)
const BUDGET_CAP = 300000;     // largest burst a budget can hold (= 60,000 + 400/s x 10 min)
const FIRST_SAVE_PER_DAY = 50000;   // plausibility cap per day for a first-ever save / explicit import
const FIRST_SAVE_MAX_DAY = 1000;    // the day used for that cap never exceeds this
const GUN_PRICE = eco.GUN_PRICE;          // 100,000. The gun is bought only through api/action.js; sync/save can never grant it
const MAX_DAY_STEP = 5;                  // the shared day can advance at most this much per sync
const ITEMS = ['ma', 'fi', 'sa', 'su', 'eg', 'ri', 'wa', 'vg', 'yo', 'ju', 'sd', 'cf', 'sn', 'bd', 'ic', 'ch'];
const BASE_PRICE = { ma: 7, fi: 25, sa: 28, su: 27, eg: 6, ri: 130, wa: 8, vg: 12, yo: 12, ju: 14, sd: 15, cf: 18, sn: 20, bd: 28, ic: 25, ch: 20 };   // default sell price (matches index.html)
const COST = { ma: 5, fi: 18, sa: 20, su: 20, eg: 4, ri: 100, wa: 5, vg: 8, yo: 8, ju: 9, sd: 10, cf: 12, sn: 14, bd: 18, ic: 15, ch: 12 };   // ต้องตรงกับ api/save.js
const MAX_STOCK = 5000;
const MAX_PLOTS = 20;          // 8 starting plots + 3 land purchases x 4 (keep in sync with landCost() in index.html)

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
    pr[k] = Number.isFinite(b) ? Math.max(1, Math.min(1e5, b)) : (BASE_PRICE[k] || 1);
  }
  const plots = Array.isArray(s.plots) ? s.plots.slice(0, MAX_PLOTS).map(p => p && (p.c === 'ri' || p.c === 'vg') ? { c: p.c, d: Math.round(Number(p.d)) || 1, b: Math.max(0, Math.min(8, Math.round(Number(p.b)) || 0)) } : null).map(p => p && !p.b ? { c: p.c, d: p.d } : p) : Array(8).fill(null);
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
    gun: s.gun ? 1 : 0,
    clerk: s.clerk && typeof s.clerk === 'object' ? {} : null,
    sold: Math.max(0, Math.round(Number(s.sold)) || 0),
    clk: Number.isFinite(Number(s.clk)) && s.clk !== null ? Math.max(0, Math.min(1200, Math.round(Number(s.clk)))) : 360,   // เวลาในร้าน (360 = 06:00)
    vipPend: s.vipPend ? 1 : 0,                                                                                           // มี VIP รออยู่
    st, pr,
    tr: { d: s.tr && Math.round(Number(s.tr.d)) || 1, v: trv },
    up: eco.cleanUp(s.up), ms: eco.cleanMs(s.ms), tx: eco.cleanTx(s.tx), ar: eco.cleanAr(s.ar), rn: eco.cleanRn(s.rn)
  };
}

// Keys replaced as a whole (last writer wins). Money, sales and stock are merged as deltas.
const SET_KEYS = ['plots', 'nest', 'hens', 'coop', 'emp', 'clerk', 'ev', 'pr', 'tr', 'wv', 'd', 'gun', 'clk', 'ms', 'tx', 'rn'];
// Never taken from a client: upgrade levels, processed action ids (api/action.js changes them), and the gun.

const int = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };

// Pure merge of one player's change into the shared state with hard per-call caps.
// The caller then limits the resulting wealth gain with a DB budget (see api/room.js) via shrinkWealth().
function applyChange(cur, change) {
  const next = JSON.parse(JSON.stringify(cur));
  const d = (change && change.delta) || {};
  let dm = int(d.m);
  dm = Math.max(-MAX_MONEY, Math.min(dm, BUDGET_CAP));
  // The shared clock is clamped to 1200 (20:00). Once it says so, a sync that reports sales is refused: no sale counted, no income, no stock taken.
  const closedSale = (cur.clk == null ? 360 : cur.clk) >= eco.CLOSE_MIN && int(d.sold) > 0;
  if (closedSale) dm = Math.min(dm, 0);
  next.m = Math.max(0, Math.min(MAX_MONEY, next.m + dm));
  let ds = int(d.sold);
  if (closedSale) ds = 0;
  if (ds > 0) next.sold += Math.min(ds, 1000);
  for (const k of ITEMS) {
    let x = Math.max(-MAX_STOCK, Math.min(MAX_STOCK, int(d.st && d.st[k])));
    if (closedSale && x < 0) x = 0;
    next.st[k] = Math.max(0, Math.min(MAX_STOCK, (next.st[k] || 0) + x));
  }
  const set = (change && change.set) || {};
  for (const k of SET_KEYS) {
    if (Object.prototype.hasOwnProperty.call(set, k)) next[k] = set[k];
  }
  if (Object.prototype.hasOwnProperty.call(set, 'd')) next.d = Math.min(cur.d + MAX_DAY_STEP, Math.max(cur.d, int(set.d) || cur.d));
  // Server-owned fields come from the stored state, never from the client.
  next.gun = cur.gun ? 1 : 0;
  // The shop clock only moves forward inside a day (a client cannot reopen a closed shop); it resets only with a new day.
  if (next.d === cur.d && Number.isFinite(Number(cur.clk))) next.clk = Math.max(Number(cur.clk), Number(next.clk) || 0);
  if (Object.prototype.hasOwnProperty.call(set, 'tx')) next.tx = eco.mergeTx(cur.tx, set.tx); else next.tx = cur.tx;
  const cleaned = cleanState(next);
  return cleaned ? lockServerFields(cleaned, cleanState(cur) || cur) : cur;
}

// Restores everything only the server may change (see api/action.js) and bounds the client-reported parts.
// old = the stored state, or null for a state that arrives without history (first save / explicit import).
function lockServerFields(st, old) {
  const out = JSON.parse(JSON.stringify(st));
  if (old) {
    out.up = Object.assign({}, old.up); out.ar = (old.ar || []).slice(); out.gun = old.gun ? 1 : 0;
  } else {
    // No history: purchases that the server never saw are accepted only if the whole state is plausible for its day.
    const cap = firstSaveCap(out.d);
    if (wealthOf(out) + eco.upgradeSpend(out.up) + (out.gun ? GUN_PRICE : 0) > cap) { out.up = eco.cleanUp({}); out.gun = 0; }
    out.ar = [];
  }
  out.tx = eco.mergeTx(old && old.tx, out.tx);
  out.ms = eco.lockMissions(old && old.ms, out.ms, out.d);
  out.rn = eco.lockRain(old && old.rn, out.rn, out.d);
  out.plots = eco.lockPlots(old && old.plots, out.plots, out.d, out.rn, old && old.rn);
  return out;
}

// Lowers a state's wealth by `excess` (money first, then stock, then hens). Never goes below zero.
function shrinkWealth(s, excess) {
  let rem = Math.round(excess);
  if (!(rem > 0)) return s;
  const out = JSON.parse(JSON.stringify(s));
  const takeM = Math.min(out.m, rem);
  out.m -= takeM; rem -= takeM;
  if (rem > 0) {
    const order = ITEMS.slice().sort((a, b) => COST[b] - COST[a]);
    for (const k of order) {
      if (rem <= 0) break;
      const n = Math.min(out.st[k] || 0, Math.ceil(rem / COST[k]));
      out.st[k] -= n; rem -= n * COST[k];
    }
  }
  if (rem > 0 && out.hens) {
    const n = Math.min(out.hens, Math.ceil(rem / 50));
    out.hens -= n; rem -= n * 50;
  }
  return out;
}

// Largest wealth a state of day `d` may have when it arrives without history (first save / explicit import).
const firstSaveCap = d => Math.min(MAX_MONEY, 5000 + Math.min(Math.max(1, d), FIRST_SAVE_MAX_DAY) * FIRST_SAVE_PER_DAY);

// ความมั่งคั่งของโลกร่วม (คิดบนเซิร์ฟเวอร์เท่านั้น) = เงินสด + สต็อกตามราคาทุน + แม่ไก่
function wealthOf(s) {
  let w = s.m;
  for (const k of ITEMS) w += (s.st[k] || 0) * COST[k];
  w += (s.hens || 0) * 50;
  return Math.round(w);
}

module.exports = { cleanState, applyChange, lockServerFields, shrinkWealth, firstSaveCap, wealthOf, ITEMS, SET_KEYS, MAX_MONEY, BASE_ALLOW, PER_SEC_ALLOW, BUDGET_CAP, GUN_PRICE };
