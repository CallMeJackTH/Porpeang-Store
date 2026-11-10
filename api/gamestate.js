// Shared room game state: sanitising + merging of per-player changes.
// cleanState() is the same validation used by api/save.js for personal saves.
const MAX_MONEY = 1e9;
const MAX_DAY = 100000;
const BASE_ALLOW = 60000;      // flat money gain allowed per sync
const PER_SEC_ALLOW = 400;     // sustained gain allowed per second since the last sync
const ITEMS = ['ma', 'fi', 'sa', 'su', 'eg', 'ri', 'wa', 'vg'];
const MAX_STOCK = 5000;

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

// Keys replaced as a whole (last writer wins). Money, sales and stock are merged as deltas.
const SET_KEYS = ['plots', 'nest', 'hens', 'coop', 'emp', 'ev', 'pr', 'tr', 'wv', 'd'];

const int = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };

function applyChange(cur, change, secs) {
  const next = JSON.parse(JSON.stringify(cur));
  const d = (change && change.delta) || {};
  const allow = BASE_ALLOW + PER_SEC_ALLOW * Math.min(Math.max(secs || 1, 1), 86400);
  let dm = int(d.m);
  dm = Math.max(-MAX_MONEY, Math.min(dm, allow));
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
  if (Object.prototype.hasOwnProperty.call(set, 'd')) next.d = Math.max(cur.d, int(set.d) || cur.d);
  return cleanState(next) || cur;
}

module.exports = { cleanState, applyChange, ITEMS, SET_KEYS, MAX_MONEY };
