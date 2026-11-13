// Minimal in-memory stand-in for the Supabase client (service role), enough for api/*.js.
// Also mirrors the SQL functions of supabase/migration_006_rate_limits.sql (rl_hit / take_budget).
const crypto = require('crypto');
const UNIQUE = { game_rooms: [['room_code']], players: [['username_lower']] };
const DEFAULTS = {
  game_rooms: () => ({ id: crypto.randomUUID(), status: 'waiting', max_players: 4, team_wealth: 0, team_money: 0, team_day: 1, created_at: new Date().toISOString() })
};

function makeDb() {
  const db = { T: {}, offset: 0, rpcMissing: false };
  db.now = () => Date.now() + db.offset;           // controllable clock for refill tests
  const rows = n => (db.T[n] = db.T[n] || []);

  db.rpc = async (name, a) => {
    if (db.rpcMissing) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.' + name } };
    if (name === 'rl_hit') {
      const r = rows('rate_limits'); let x = r.find(q => q.key === a.p_key); const now = db.now();
      if (!x) { x = { key: a.p_key, window_start: now, hits: 1 }; r.push(x); }
      else if (x.window_start < now - a.p_window_seconds * 1000) { x.window_start = now; x.hits = 1; } else x.hits++;
      return { data: x.hits <= a.p_max, error: null };
    }
    if (name === 'take_budget') {
      if (!(a.p_amount > 0)) return { data: 0, error: null };
      const r = rows('budgets'); let x = r.find(q => q.key === a.p_key); const now = db.now();
      if (!x) { x = { key: a.p_key, tokens: a.p_cap, updated_at: now }; r.push(x); }
      const tokens = Math.min(a.p_cap, x.tokens + a.p_rate * Math.max(0, (now - x.updated_at) / 1000));
      const grant = Math.min(a.p_amount, Math.floor(tokens));
      x.tokens = tokens - grant; x.updated_at = now;
      return { data: grant, error: null };
    }
    return { data: null, error: { code: 'PGRST202', message: 'unknown function' } };
  };

  db.from = name => {
    const q = { op: 'select', f: [], ord: [], lim: null, sg: null, payload: null, opt: {}, ret: false };
    const self = q;
    q.select = (c, o) => { if (q.op !== 'select') q.ret = true; q.opt = o || {}; return self; };
    q.eq = (k, v) => (q.f.push(r => r[k] === v), self);
    q.neq = (k, v) => (q.f.push(r => r[k] !== v), self);
    q.gt = (k, v) => (q.f.push(r => r[k] > v), self);
    q.lt = (k, v) => (q.f.push(r => r[k] < v), self);
    q.in = (k, arr) => (q.f.push(r => arr.includes(r[k])), self);
    q.order = (k, o) => (q.ord.push([k, !(o && o.ascending === false)]), self);
    q.limit = n => (q.lim = n, self);
    q.maybeSingle = () => (q.sg = 'maybe', self);
    q.single = () => (q.sg = 'one', self);
    q.insert = p => (q.op = 'insert', q.payload = p, self);
    q.update = p => (q.op = 'update', q.payload = p, self);
    q.upsert = (p, o) => (q.op = 'upsert', q.payload = p, q.opt = o || {}, self);
    q.delete = () => (q.op = 'delete', self);
    q.then = (res, rej) => Promise.resolve().then(exec).then(res, rej);

    const match = r => q.f.every(fn => fn(r));
    const dup = (n, row, skip) => (UNIQUE[n] || []).some(cols => rows(n).some(r => r !== skip && cols.every(c => r[c] === row[c])));
    const shape = list => {
      if (q.sg === 'maybe') return { data: list[0] ? JSON.parse(JSON.stringify(list[0])) : null, error: null };
      if (q.sg === 'one') return list[0] ? { data: JSON.parse(JSON.stringify(list[0])), error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      return { data: JSON.parse(JSON.stringify(list)), error: null };
    };
    function exec() {
      const t = rows(name);
      if (q.op === 'select') {
        let l = t.filter(match);
        q.ord.forEach(([k, asc]) => l.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (asc ? 1 : -1)));
        if (q.lim != null) l = l.slice(0, q.lim);
        if (q.opt.head) return { data: null, count: l.length, error: null };
        const out = shape(l); if (q.opt.count) out.count = l.length; return out;
      }
      if (q.op === 'insert') {
        const row = Object.assign((DEFAULTS[name] ? DEFAULTS[name]() : {}), q.payload);
        if (dup(name, row)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        t.push(row); return q.ret ? shape([row]) : { data: null, error: null };
      }
      if (q.op === 'update') {
        const l = t.filter(match); l.forEach(r => Object.assign(r, q.payload));
        return q.ret ? shape(l) : { data: null, error: null };
      }
      if (q.op === 'upsert') {
        const keys = String(q.opt.onConflict || '').split(',').filter(Boolean);
        const ex = t.find(r => keys.every(k => r[k] === q.payload[k]));
        if (ex) { if (!q.opt.ignoreDuplicates) Object.assign(ex, q.payload); }
        else t.push(Object.assign({}, q.payload));
        return { data: null, error: null };
      }
      if (q.op === 'delete') { db.T[name] = t.filter(r => !match(r)); return { data: null, error: null }; }
    }
    return q;
  };
  return db;
}
module.exports = { makeDb };
