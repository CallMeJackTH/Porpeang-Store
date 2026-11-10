const { createClient } = require('@supabase/supabase-js');

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Username rules (must match the CHECK constraint in supabase/migration_001_username_login.sql)
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
// Internal login address derived from the username. No e-mail is ever sent to it.
const EMAIL_DOMAIN = process.env.PLAYER_EMAIL_DOMAIN || 'players.porpeang.app';
const emailFor = (username) => String(username).toLowerCase() + '@' + EMAIL_DOMAIN;

function admin() {
  if (!URL_ || !SERVICE) throw new Error('missing_env');
  return createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Verifies the caller's Supabase JWT (never trusts an id sent in the request body).
async function authUser(req, db) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return data.user;
}

// Verified JWT -> player row. The Player ID is ALWAYS taken from the verified token (sub).
// Unclaimed legacy (old Google) accounts are rejected unless allowUnclaimed is set.
async function authPlayer(req, db, opt) {
  const user = await authUser(req, db);
  if (!user) return null;
  const { data } = await db.from('players').select('id,username,is_legacy,claimed').eq('id', user.id).maybeSingle();
  if (!data) return null;
  if (!data.claimed && !(opt && opt.allowUnclaimed)) return null;
  return data;
}

function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}

module.exports = { URL_, ANON, SERVICE, USERNAME_RE, EMAIL_DOMAIN, emailFor, admin, authUser, authPlayer, body };
