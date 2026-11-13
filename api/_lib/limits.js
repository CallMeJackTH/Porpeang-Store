// Rate limiting + earning budgets.
// Preferred backend: Postgres functions from supabase/migration_006_rate_limits.sql (shared by every serverless instance).
// If that migration has not been applied yet, everything still works: request limits fall back to
// per-instance memory, and money budgets return null so callers use their time-based legacy allowance.

const mem = new Map();

function memHit(key, max, windowSec) {
  const now = Date.now();
  const arr = (mem.get(key) || []).filter(t => now - t < windowSec * 1000);
  arr.push(now);
  mem.set(key, arr);
  if (mem.size > 20000) mem.clear();
  return arr.length <= max;
}

const isMissingFn = e => !!e && (e.code === '42883' || e.code === 'PGRST202' || /could not find the function|does not exist/i.test(e.message || ''));
let warned = false;
function warnMissing(e) {
  if (!warned) { warned = true; console.error('[limits] migration_006 not applied, using in-memory fallback:', e && (e.code || e.message)); }
}

// true = allowed, false = limit exceeded.
async function rlHit(db, key, max, windowSec) {
  try {
    const { data, error } = await db.rpc('rl_hit', { p_key: key, p_max: max, p_window_seconds: windowSec });
    if (!error && typeof data === 'boolean') return data;
    if (error) { if (isMissingFn(error)) warnMissing(error); else console.error('[limits] rl_hit failed:', error.code, error.message); }
  } catch (e) { console.error('[limits] rl_hit threw:', e && e.message); }
  return memHit(key, max, windowSec);
}

// Token bucket for earnings. Returns how much of `amount` is granted (0..amount),
// or null when the DB function is unavailable (caller falls back to its legacy rule).
async function takeBudget(db, key, amount, rate, cap) {
  if (!(amount > 0)) return 0;
  try {
    const { data, error } = await db.rpc('take_budget', { p_key: key, p_amount: Math.round(amount), p_rate: rate, p_cap: cap });
    if (!error && data != null && Number.isFinite(Number(data))) return Math.max(0, Math.min(Math.round(amount), Number(data)));
    if (error) { if (isMissingFn(error)) warnMissing(error); else console.error('[limits] take_budget failed:', error.code, error.message); }
  } catch (e) { console.error('[limits] take_budget threw:', e && e.message); }
  return null;
}

module.exports = { rlHit, takeBudget, memHit };
