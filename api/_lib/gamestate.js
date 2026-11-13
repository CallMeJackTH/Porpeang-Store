// Shared room game state: sanitising + merging of per-player changes.
// cleanState() is the same validation used by api/save.js for personal saves.
const MAX_MONEY = 1e9;
const MAX_DAY = 100000;
const BASE_ALLOW = 60000;      // legacy fallback: flat gain allowed per sync (used only when migration_006 is missing)
const PER_SEC_ALLOW = 400;     // sustained wealth gain allowed per second (budget refill rate)
const BUDGET_CAP = 300000;     // largest burst a budget can hold (= 60,000 + 400/s x 10 min)
const FIRST_SAVE_PER_DAY = 50000;   // plausibility cap per day for a first-ever save / explicit import
const FIRST_SAVE_MAX_DAY = 1000;    // the day used for that cap never exceeds this
const GUN_PRICE = 20000;
const GUN_MIN_PAYMENT = GUN_PRICE / 2;   // a free gun is refused; allows for income arriving in the same sync
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
  const plots = Array.isArray(s.plots) ? s.plots.slice(0, MAX_PLOTS).map(p => p && (p.c === 'ri' || p.c === 'vg') ? { c: p.c, d: Math.round(Number(p.d)) || 1 } : null) : Array(8).fill(null);
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
    tr: { d: s.tr && Math.round(Number(s.tr.d)) || 1, v: trv }
  };
}

// Keys replaced as a whole (last writer wins). Money, sales and stock are merged as deltas.
const SET_KEYS = ['plots', 'nest', 'hens', 'coop', 'emp', 'clerk', 'ev', 'pr', 'tr', 'wv', 'd', 'gun', 'clk'];

const int = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };

// Pure merge of one player's change into the shared state with hard per-call caps.
// The caller then limits the resulting wealth gain with a DB budget (see api/room.js) via shrinkWealth().
function applyChange(cur, change) {
  const next = JSON.parse(JSON.stringify(cur));
  const d = (change && change.delta) || {};
  let dm = int(d.m);
  dm = Math.max(-MAX_MONEY, Math.min(dm, BUDGET_CAP));
  next.m = Math.max(0, Math.min(MAX_MONEY, next.m + dm));
  const ds = int(d.sold);
  if (ds > 0) next.sold += Math.min(ds, 1000);
  for (const k of ITEMS) {
    const x = Math.max(-MAX_STOCK, Math.min(MAX_STOCK, int(d.st && d.st[k])));
    next.st[k] = Math.max(0, Math.min(MAX_STOCK, (next.st[k] || 0) + x));
  }
  const set = (change && change.set) || {};
  for (const k of SET_KEYS) {
    if (Object.prototype.hasOwnProperty.call(set, k)) next[k] = set[k];
  }
  if (Object.prototype.hasOwnProperty.call(set, 'd')) next.d = Math.min(cur.d + MAX_DAY_STEP, Math.max(cur.d, int(set.d) || cur.d));
  // The gun can only appear together with a real payment in the same sync, and never disappears.
  if (!cur.gun) {
    const paid = dm <= -GUN_MIN_PAYMENT;
    next.gun = (set.gun && paid) ? 1 : 0;
  } else {
    next.gun = 1;
  }
  return cleanState(next) || cur;
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

module.exports = { cleanState, applyChange, shrinkWealth, firstSaveCap, wealthOf, ITEMS, SET_KEYS, MAX_MONEY, BASE_ALLOW, PER_SEC_ALLOW, BUDGET_CAP, GUN_PRICE };
