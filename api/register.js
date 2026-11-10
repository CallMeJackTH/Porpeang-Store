const crypto = require('crypto');
const { admin, authUser, body, USERNAME_RE, emailFor } = require('./_lib/sb');

// Best-effort per-instance throttle for account creation (Supabase Auth also rate-limits sign-ins per IP).
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 600000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 10;
}
const fail = (res, status, error) => res.status(status).json({ error });

// Creates a new player, or converts a legacy (Google) player to a username/password player
// WITHOUT changing its id, so saves / leaderboard / rooms keep working.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return fail(res, 405, 'method');
  try {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
    if (limited(ip)) return fail(res, 429, 'rate_limited');

    const b = body(req);
    const username = typeof b.username === 'string' ? b.username.trim() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    const claimCode = typeof b.claimCode === 'string' ? b.claimCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : '';
    if (!USERNAME_RE.test(username)) return fail(res, 400, 'bad_username');
    if (password.length < 6 || password.length > 72) return fail(res, 400, 'bad_password');

    const db = admin();
    const lower = username.toLowerCase();
    const email = emailFor(username);

    const { data: taken } = await db.from('players').select('id').eq('username_lower', lower).maybeSingle();
    if (taken) return fail(res, 409, 'username_taken');

    // --- which legacy player (if any) is being claimed? ---
    let legacyId = null, claimHash = null;
    if (claimCode) {
      claimHash = crypto.createHash('sha256').update(claimCode).digest('hex');
      const { data: c } = await db.from('player_claims').select('player_id,expires_at,used_at').eq('code_hash', claimHash).maybeSingle();
      if (!c || c.used_at || new Date(c.expires_at) < new Date()) return fail(res, 400, 'bad_claim');
      legacyId = c.player_id;
    } else {
      const u = await authUser(req, db);           // an old session that still holds the legacy account
      if (u) {
        const { data: row } = await db.from('players').select('id,is_legacy,claimed').eq('id', u.id).maybeSingle();
        if (row && row.is_legacy && !row.claimed) legacyId = row.id;
      }
    }

    // --- convert legacy player (same id, data untouched) ---
    if (legacyId) {
      const { data: pl } = await db.from('players').select('id,is_legacy,claimed').eq('id', legacyId).maybeSingle();
      if (!pl || !pl.is_legacy || pl.claimed) return fail(res, 400, 'bad_claim');
      if (claimHash) {
        const { data: used } = await db.from('player_claims').update({ used_at: new Date().toISOString() }).eq('code_hash', claimHash).is('used_at', null).select('code_hash');
        if (!used || !used.length) return fail(res, 400, 'bad_claim');
      }
      const undo = async () => { if (claimHash) await db.from('player_claims').update({ used_at: null }).eq('code_hash', claimHash); };
      const { error: ue } = await db.auth.admin.updateUserById(legacyId, { email, password, email_confirm: true, user_metadata: { username } });
      if (ue) { await undo(); return fail(res, /already|exist|registered/i.test(ue.message || '') ? 409 : 500, /already|exist|registered/i.test(ue.message || '') ? 'username_taken' : 'server'); }
      const { error: pe } = await db.from('players').update({ username, username_lower: lower, claimed: true }).eq('id', legacyId);
      if (pe) { await undo(); return fail(res, pe.code === '23505' ? 409 : 500, pe.code === '23505' ? 'username_taken' : 'server'); }
      await db.from('leaderboard').update({ display_name: username }).eq('user_id', legacyId);
      await db.from('room_members').update({ display_name: username }).eq('user_id', legacyId);
      return res.status(200).json({ ok: true, username, claimed: true });
    }

    // --- brand-new player ---
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username } });
    if (error || !data || !data.user) {
      const dup = error && (error.status === 422 || /already|exist|registered/i.test(error.message || ''));
      return fail(res, dup ? 409 : 500, dup ? 'username_taken' : 'server');
    }
    const id = data.user.id;
    const { error: e2 } = await db.from('players').insert({ id, username, username_lower: lower, is_legacy: false, claimed: true });
    if (e2) {
      try { await db.auth.admin.deleteUser(id); } catch (_) {}
      return fail(res, e2.code === '23505' ? 409 : 500, e2.code === '23505' ? 'username_taken' : 'server');
    }
    return res.status(200).json({ ok: true, username });
  } catch (e) {
    return fail(res, 500, e.message === 'missing_env' ? 'missing_env' : 'server');
  }
};
