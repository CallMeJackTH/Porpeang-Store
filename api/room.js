const { admin, authPlayer, body } = require('./_lib/sb');
const { cleanState, applyChange } = require('./_lib/gamestate');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_MEMBERS = 6; // players per room
const ROOM_TTL_H = 24;

const genCode = () => {
  let code = '';
  const bytes = require('crypto').randomBytes(6);
  for (let i = 0; i < 6; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
  return code;
};

const profileOf = user => ({
  name: String(user.username || 'Player').slice(0, 40),
  avatar: ''
});

function logDbError(action, error) {
  if (error) {
    console.error('[room] ' + action + ' failed:', error.code || '', error.message || error);
  }
}

function dbFailure(res, action, error) {
  logDbError(action, error);
  return res.status(500).json({ error: 'database_error', action });
}

// The live schema stores room_code/owner_id and keeps player profiles in players.
// room_members intentionally contains only membership and presence fields.
async function getMembers(db, roomId) {
  const { data: memberships, error: memberError } = await db
    .from('room_members')
    .select('user_id,joined_at')
    .eq('room_id', roomId)
    .order('joined_at');

  if (memberError) return { error: memberError };

  const ids = (memberships || []).map(row => row.user_id);
  if (!ids.length) return { data: [] };

  const [playersResult, leaderboardResult] = await Promise.all([
    db.from('players').select('id,username').in('id', ids),
    db.from('leaderboard').select('user_id,money,wealth').in('user_id', ids)
  ]);

  if (playersResult.error) return { error: playersResult.error };
  if (leaderboardResult.error) return { error: leaderboardResult.error };

  const profiles = {};
  (playersResult.data || []).forEach(player => {
    profiles[player.id] = player;
  });

  const balances = {};
  (leaderboardResult.data || []).forEach(row => {
    balances[row.user_id] = row;
  });

  return {
    data: (memberships || []).map(row => {
      const profile = profiles[row.user_id] || {};
      const balance = balances[row.user_id] || {};
      return {
        id: row.user_id,
        name: profile.username || 'Player',
        avatar: '',
        money: Number(balance.money) || 0,
        wealth: Number(balance.wealth) || 0
      };
    })
  };
}

function roomPayload(room) {
  return {
    id: room.id,
    code: room.room_code,
    host: room.owner_id,
    expires_at: room.expires_at,
    playing: room.status === 'playing'
  };
}

async function sendRoom(res, db, room) {
  const result = await getMembers(db, room.id);
  if (result.error) return dbFailure(res, 'load_members', result.error);
  return res.status(200).json({ room: roomPayload(room), members: result.data });
}

// The room (still alive) that the caller belongs to.
async function myRoom(db, userId, nowIso) {
  const { data: m, error: e1 } = await db.from('room_members').select('room_id').eq('user_id', userId).limit(1).maybeSingle();
  if (e1) return { error: e1 };
  if (!m) return { room: null };
  const { data: room, error: e2 } = await db.from('game_rooms').select('*').eq('id', m.room_id).gt('expires_at', nowIso).maybeSingle();
  if (e2) return { error: e2 };
  return { room: room || null };
}

function extendedExpiry(now) {
  return new Date(now.getTime() + ROOM_TTL_H * 3600 * 1000).toISOString();
}

module.exports = async (req, res) => {
  try {
    const db = admin();
    const user = await authPlayer(req, db);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const b = req.method === 'POST' ? body(req) : (req.query || {});
    const action = b.action;
    const profile = profileOf(user);
    const now = new Date();
    const nowIso = now.toISOString();

    // Expired rooms are cleaned up without relying on an ON DELETE CASCADE rule.
    const { data: expiredRooms, error: expiredLookupError } = await db
      .from('game_rooms')
      .select('id')
      .lt('expires_at', nowIso);

    if (expiredLookupError) {
      logDbError('find_expired_rooms', expiredLookupError);
    } else if (expiredRooms && expiredRooms.length) {
      const expiredIds = expiredRooms.map(room => room.id);
      const { error: expiredMembersError } = await db
        .from('room_members')
        .delete()
        .in('room_id', expiredIds);
      if (expiredMembersError) logDbError('delete_expired_members', expiredMembersError);

      const { error: expiredDeleteError } = await db
        .from('game_rooms')
        .delete()
        .in('id', expiredIds);
      if (expiredDeleteError) logDbError('delete_expired_rooms', expiredDeleteError);
    }

    if (action === 'create') {
      // Reuse the player's existing active room, if one exists.
      const { data: existingRoom, error: existingError } = await db
        .from('game_rooms')
        .select('*')
        .eq('owner_id', user.id)
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingError) return dbFailure(res, 'find_owned_room', existingError);

      let room = existingRoom;
      if (!room) {
        // Retry only when a generated room code collides with the UNIQUE constraint.
        for (let attempt = 0; attempt < 6 && !room; attempt++) {
          const { data, error } = await db
            .from('game_rooms')
            .insert({
              room_code: genCode(),
              owner_id: user.id,
              max_players: MAX_MEMBERS,
              expires_at: new Date(now.getTime() + ROOM_TTL_H * 3600 * 1000).toISOString()
            })
            .select()
            .single();

          if (!error) {
            room = data;
          } else if (error.code === '23505') {
            logDbError('room_code_collision', error);
          } else {
            return dbFailure(res, 'create_room', error);
          }
        }

        if (!room) return res.status(503).json({ error: 'room_code_unavailable' });
      }

      const { error: membershipError } = await db
        .from('room_members')
        .upsert({
          room_id: room.id,
          user_id: user.id,
          joined_at: nowIso,
          last_seen: nowIso
        }, { onConflict: 'room_id,user_id' });

      if (membershipError) return dbFailure(res, 'add_host_to_room', membershipError);
      return sendRoom(res, db, room);
    }

    if (action === 'join') {
      const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 6) return res.status(400).json({ error: 'bad_code' });

      const { data: room, error: roomError } = await db
        .from('game_rooms')
        .select('*')
        .eq('room_code', code)
        .in('status', ['waiting', 'playing'])
        .gt('expires_at', nowIso)
        .maybeSingle();

      if (roomError) return dbFailure(res, 'find_room', roomError);
      if (!room) return res.status(404).json({ error: 'not_found' });

      const { data: currentMembers, error: currentMembersError } = await db
        .from('room_members')
        .select('user_id')
        .eq('room_id', room.id);

      if (currentMembersError) return dbFailure(res, 'count_room_members', currentMembersError);

      const alreadyInRoom = (currentMembers || []).some(row => row.user_id === user.id);
      const capacity = MAX_MEMBERS; // ignore the old max_players=4 stored on existing rooms
      if (!alreadyInRoom && (currentMembers || []).length >= capacity) {
        return res.status(409).json({ error: 'full' });
      }

      // Add to the destination first; only leave the previous room after this succeeds.
      const { error: membershipError } = await db
        .from('room_members')
        .upsert({
          room_id: room.id,
          user_id: user.id,
          joined_at: nowIso,
          last_seen: nowIso
        }, { onConflict: 'room_id,user_id' });

      if (membershipError) return dbFailure(res, 'join_room', membershipError);

      const { error: leaveOtherRoomsError } = await db
        .from('room_members')
        .delete()
        .eq('user_id', user.id)
        .neq('room_id', room.id);

      if (leaveOtherRoomsError) {
        logDbError('leave_previous_room', leaveOtherRoomsError);
        // Roll back the new membership rather than leaving the player in two rooms.
        await db.from('room_members').delete().eq('room_id', room.id).eq('user_id', user.id);
        return dbFailure(res, 'leave_previous_room', leaveOtherRoomsError);
      }

      return sendRoom(res, db, room);
    }

    if (action === 'current') {
      const { data: membership, error: membershipError } = await db
        .from('room_members')
        .select('room_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle();

      if (membershipError) return dbFailure(res, 'find_current_membership', membershipError);
      if (!membership) return res.status(200).json({ room: null });

      const { data: room, error: roomError } = await db
        .from('game_rooms')
        .select('*')
        .eq('id', membership.room_id)
        .gt('expires_at', nowIso)
        .maybeSingle();

      if (roomError) return dbFailure(res, 'load_current_room', roomError);
      if (!room) {
        const { error: cleanupError } = await db
          .from('room_members')
          .delete()
          .eq('user_id', user.id);
        if (cleanupError) return dbFailure(res, 'cleanup_stale_membership', cleanupError);
        return res.status(200).json({ room: null });
      }

      return sendRoom(res, db, room);
    }

    if (action === 'members') {
      const { data: membership, error: membershipError } = await db
        .from('room_members')
        .select('room_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle();

      if (membershipError) return dbFailure(res, 'find_membership', membershipError);
      if (!membership) return res.status(403).json({ error: 'not_member' });

      const result = await getMembers(db, membership.room_id);
      if (result.error) return dbFailure(res, 'load_members', result.error);
      return res.status(200).json({ members: result.data });
    }

    if (action === 'leave') {
      const { data: membership, error: membershipError } = await db
        .from('room_members')
        .select('room_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle();

      if (membershipError) return dbFailure(res, 'find_membership', membershipError);
      if (membership) {
        const { error: leaveError } = await db
          .from('room_members')
          .delete()
          .eq('room_id', membership.room_id)
          .eq('user_id', user.id);

        if (leaveError) return dbFailure(res, 'leave_room', leaveError);

        const { count, error: countError } = await db
          .from('room_members')
          .select('user_id', { count: 'exact', head: true })
          .eq('room_id', membership.room_id);

        if (countError) return dbFailure(res, 'count_remaining_members', countError);

        if (!count) {
          const { error: deleteRoomError } = await db
            .from('game_rooms')
            .delete()
            .eq('id', membership.room_id);
          if (deleteRoomError) return dbFailure(res, 'delete_empty_room', deleteRoomError);
        } else {
          const { data: room, error: ownerLookupError } = await db
            .from('game_rooms')
            .select('owner_id')
            .eq('id', membership.room_id)
            .maybeSingle();

          if (ownerLookupError) return dbFailure(res, 'find_room_owner', ownerLookupError);

          if (room && room.owner_id === user.id) {
            const { data: nextHost, error: nextHostError } = await db
              .from('room_members')
              .select('user_id')
              .eq('room_id', membership.room_id)
              .order('joined_at')
              .limit(1)
              .maybeSingle();

            if (nextHostError) return dbFailure(res, 'select_new_room_owner', nextHostError);

            if (nextHost) {
              const { error: transferError } = await db
                .from('game_rooms')
                .update({ owner_id: nextHost.user_id })
                .eq('id', membership.room_id);

              if (transferError) return dbFailure(res, 'transfer_room_owner', transferError);
            }
          }
        }
      }

      return res.status(200).json({ ok: true });
    }

    if (action === 'start') {
      // Host only: put the whole room into one shared world, seeded from the host's own save.
      const mine = await myRoom(db, user.id, nowIso);
      if (mine.error) return dbFailure(res, 'find_my_room', mine.error);
      if (!mine.room) return res.status(403).json({ error: 'not_member' });
      const room = mine.room;
      if (room.owner_id !== user.id) return res.status(403).json({ error: 'not_host' });

      let { data: rs, error: rsError } = await db.from('room_states').select('state,version').eq('room_id', room.id).maybeSingle();
      if (rsError) return dbFailure(res, 'load_room_state', rsError);

      if (!rs) {
        const { data: save, error: saveError } = await db.from('player_saves').select('state').eq('user_id', user.id).maybeSingle();
        if (saveError) return dbFailure(res, 'load_host_save', saveError);
        let st = save && save.state ? cleanState(save.state) : null;
        if (!st) {
          st = cleanState(b.state);
          if (st) {
            const cap = 5000 + st.d * 50000;
            if (st.m > cap) st.m = cap;
          }
        }
        if (!st) return res.status(400).json({ error: 'invalid_state' });

        const { error: insError } = await db.from('room_states')
          .upsert({ room_id: room.id, state: st, version: 1, updated_by: user.id, updated_at: nowIso },
            { onConflict: 'room_id', ignoreDuplicates: true });
        if (insError) return dbFailure(res, 'create_room_state', insError);

        const again = await db.from('room_states').select('state,version').eq('room_id', room.id).maybeSingle();
        if (again.error || !again.data) return dbFailure(res, 'reload_room_state', again.error || { message: 'missing' });
        rs = again.data;
      }

      const expires = extendedExpiry(now);
      const { error: updError } = await db.from('game_rooms').update({ status: 'playing', expires_at: expires }).eq('id', room.id);
      if (updError) return dbFailure(res, 'start_room', updError);

      const result = await getMembers(db, room.id);
      if (result.error) return dbFailure(res, 'load_members', result.error);
      return res.status(200).json({
        room: roomPayload(Object.assign({}, room, { status: 'playing', expires_at: expires })),
        members: result.data,
        state: rs.state,
        version: rs.version
      });
    }

    if (action === 'state') {
      const mine = await myRoom(db, user.id, nowIso);
      if (mine.error) return dbFailure(res, 'find_my_room', mine.error);
      if (!mine.room) return res.status(403).json({ error: 'not_member' });
      const { data: rs, error: rsError } = await db.from('room_states').select('state,version').eq('room_id', mine.room.id).maybeSingle();
      if (rsError) return dbFailure(res, 'load_room_state', rsError);
      if (!rs || mine.room.status !== 'playing') return res.status(409).json({ error: 'not_started' });
      return res.status(200).json({ room: roomPayload(mine.room), state: rs.state, version: rs.version });
    }

    if (action === 'sync') {
      // Merge this player's changes (money/stock/sales as deltas, other fields as whole values).
      const mine = await myRoom(db, user.id, nowIso);
      if (mine.error) return dbFailure(res, 'find_my_room', mine.error);
      if (!mine.room) return res.status(403).json({ error: 'not_member' });
      const room = mine.room;
      if (room.status !== 'playing') return res.status(409).json({ error: 'not_started' });

      const hasChange = !!(b.delta || b.set);
      for (let attempt = 0; attempt < 5; attempt++) {
        const { data: rs, error: rsError } = await db.from('room_states').select('state,version,updated_at').eq('room_id', room.id).maybeSingle();
        if (rsError) return dbFailure(res, 'load_room_state', rsError);
        if (!rs) return res.status(409).json({ error: 'not_started' });

        if (!hasChange) {
          if (Number(b.since) === Number(rs.version)) return res.status(200).json({ unchanged: true, version: rs.version });
          return res.status(200).json({ state: rs.state, version: rs.version });
        }

        const secs = (now.getTime() - new Date(rs.updated_at).getTime()) / 1000;
        const next = applyChange(rs.state, { delta: b.delta, set: b.set }, secs);
        const { data: upd, error: updError } = await db.from('room_states')
          .update({ state: next, version: rs.version + 1, updated_by: user.id, updated_at: nowIso })
          .eq('room_id', room.id)
          .eq('version', rs.version)
          .select('version')
          .maybeSingle();
        if (updError) return dbFailure(res, 'save_room_state', updError);
        if (!upd) continue; // someone else wrote first: merge again on top of their result

        // Keep an active room alive.
        if (new Date(room.expires_at).getTime() - now.getTime() < (ROOM_TTL_H - 1) * 3600 * 1000) {
          await db.from('game_rooms').update({ expires_at: extendedExpiry(now) }).eq('id', room.id);
        }
        return res.status(200).json({ state: next, version: upd.version });
      }
      return res.status(409).json({ error: 'busy' });
    }

    return res.status(400).json({ error: 'bad_action' });
  } catch (error) {
    console.error('[room] unexpected failure:', error && error.message);
    return res.status(500).json({
      error: error && error.message === 'missing_env' ? 'missing_env' : 'server'
    });
  }
};
