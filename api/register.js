const crypto = require('crypto');
const { admin, authUser, body, USERNAME_RE, emailFor } = require('./_lib/sb');

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
const isMissingTable = e => !!e && (e.code === '42P01' || e.code === 'PGRST205');
const isDuplicate = e => !!e && (e.code === '23505' || /already|exist|registered/i.test(e.message || ''));

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

    // Verify the required player table before creating an Auth account.
    const { data: taken, error: checkError } = await db
      .from('players')
      .select('id')
      .eq('username_lower', lower)
      .maybeSingle();

    if (checkError) {
      console.error('[register] players lookup failed:', checkError.code, checkError.message);
      return fail(res, 503, isMissingTable(checkError) ? 'schema_missing' : 'database_error');
    }
    if (taken) return fail(res, 409, 'username_taken');

    let legacyId = null;
    let claimHash = null;

    if (claimCode) {
      claimHash = crypto.createHash('sha256').update(claimCode).digest('hex');
      const { data: claim, error: claimError } = await db
        .from('player_claims')
        .select('player_id,expires_at,used_at')
        .eq('code_hash', claimHash)
        .maybeSingle();

      if (claimError) {
        console.error('[register] player_claims lookup failed:', claimError.code, claimError.message);
        return fail(res, 503, isMissingTable(claimError) ? 'schema_missing' : 'database_error');
      }
      if (!claim || claim.used_at || new Date(claim.expires_at) < new Date()) {
        return fail(res, 400, 'bad_claim');
      }
      legacyId = claim.player_id;
    } else {
      const oldUser = await authUser(req, db);
      if (oldUser) {
        const { data: row, error: rowError } = await db
          .from('players')
          .select('id,is_legacy,claimed')
          .eq('id', oldUser.id)
          .maybeSingle();

        if (rowError) {
          console.error('[register] legacy player lookup failed:', rowError.code, rowError.message);
          return fail(res, 503, isMissingTable(rowError) ? 'schema_missing' : 'database_error');
        }
        if (row && row.is_legacy && !row.claimed) legacyId = row.id;
      }
    }

    // Convert an existing legacy account without changing its UUID or game data.
    if (legacyId) {
      const { data: legacy, error: legacyError } = await db
        .from('players')
        .select('id,is_legacy,claimed')
        .eq('id', legacyId)
        .maybeSingle();

      if (legacyError) {
        console.error('[register] legacy player validation failed:', legacyError.code, legacyError.message);
        return fail(res, 503, isMissingTable(legacyError) ? 'schema_missing' : 'database_error');
      }
      if (!legacy || !legacy.is_legacy || legacy.claimed) return fail(res, 400, 'bad_claim');

      if (claimHash) {
        const { data: used, error: useError } = await db
          .from('player_claims')
          .update({ used_at: new Date().toISOString() })
          .eq('code_hash', claimHash)
          .is('used_at', null)
          .select('code_hash');

        if (useError) {
          console.error('[register] claim code update failed:', useError.code, useError.message);
          return fail(res, 503, 'database_error');
        }
        if (!used || !used.length) return fail(res, 400, 'bad_claim');
      }

      const undoClaim = async () => {
        if (claimHash) {
          await db.from('player_claims').update({ used_at: null }).eq('code_hash', claimHash);
        }
      };

      const { error: authError } = await db.auth.admin.updateUserById(legacyId, {
        email,
        password,
        email_confirm: true,
        user_metadata: { username }
      });

      if (authError) {
        await undoClaim();
        console.error('[register] legacy Auth update failed:', authError.status, authError.message);
        return fail(res, isDuplicate(authError) ? 409 : 503, isDuplicate(authError) ? 'username_taken' : 'auth_error');
      }

      const { error: playerError } = await db
        .from('players')
        .update({ username, username_lower: lower, claimed: true })
        .eq('id', legacyId);

      if (playerError) {
        await undoClaim();
        console.error('[register] legacy player update failed:', playerError.code, playerError.message);
        return fail(res, isDuplicate(playerError) ? 409 : 503, isDuplicate(playerError) ? 'username_taken' : 'database_error');
      }

      // These display-name updates are non-critical to authentication.
      await db.from('leaderboard').update({ display_name: username }).eq('user_id', legacyId);
      await db.from('room_members').update({ display_name: username }).eq('user_id', legacyId);

      return res.status(200).json({ ok: true, username, claimed: true });
    }

    // Create a new Auth account only after verifying the player table is available.
    const { data, error: createError } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username }
    });

    if (createError || !data || !data.user) {
      console.error('[register] Auth user creation failed:', createError && createError.status, createError && createError.message);
      return fail(
        res,
        isDuplicate(createError) ? 409 : 503,
        isDuplicate(createError) ? 'username_taken' : 'auth_error'
      );
    }

    const id = data.user.id;
    const { error: insertError } = await db.from('players').insert({
      id,
      username,
      username_lower: lower,
      is_legacy: false,
      claimed: true
    });

    if (insertError) {
      // Roll back the Auth user so failed registrations do not leave orphan accounts.
      try {
        await db.auth.admin.deleteUser(id);
      } catch (rollbackError) {
        console.error('[register] Auth rollback failed:', rollbackError && rollbackError.message);
      }
      console.error('[register] player insert failed:', insertError.code, insertError.message);
      return fail(
        res,
        isDuplicate(insertError) ? 409 : 503,
        isDuplicate(insertError) ? 'username_taken' : (isMissingTable(insertError) ? 'schema_missing' : 'database_error')
      );
    }

    return res.status(200).json({ ok: true, username });
  } catch (e) {
    console.error('[register] unexpected failure:', e && e.message);
    return fail(res, 500, e && e.message === 'missing_env' ? 'missing_env' : 'server');
  }
};
