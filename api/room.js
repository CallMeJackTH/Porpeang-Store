const { admin, authUser, body } = require('./_lib/sb');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_MEMBERS = 8;
const ROOM_TTL_H = 24;

const genCode = () => {
  let c = '';
  const a = require('crypto').randomBytes(6);
  for (let i = 0; i < 6; i++) c += ALPHABET[a[i] % ALPHABET.length];
  return c;
};
const profileOf = u => {
  const m = u.user_metadata || {};
  return {
    name: String(m.full_name || m.name || (u.email || 'Player').split('@')[0]).slice(0, 40),
    avatar: String(m.avatar_url || m.picture || '').slice(0, 500)
  };
};

async function members(db, roomId) {
  const { data } = await db.from('room_members').select('user_id,display_name,avatar_url,joined_at').eq('room_id', roomId).order('joined_at');
  const ids = (data || []).map(x => x.user_id);
  let money = {};
  if (ids.length) {
    const { data: l } = await db.from('leaderboard').select('user_id,money,wealth').in('user_id', ids);
    (l || []).forEach(x => { money[x.user_id] = x; });
  }
  return (data || []).map(x => ({
    id: x.user_id, name: x.display_name, avatar: x.avatar_url,
    money: money[x.user_id] ? money[x.user_id].money : 0,
    wealth: money[x.user_id] ? money[x.user_id].wealth : 0
  }));
}

module.exports = async (req, res) => {
  try {
    const db = admin();
    const user = await authUser(req, db);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    const b = req.method === 'POST' ? body(req) : (req.query || {});
    const action = b.action;
    const pf = profileOf(user);
    const now = new Date();

    // clean up expired rooms (cascade removes members)
    await db.from('game_rooms').delete().lt('expires_at', now.toISOString());

    if (action === 'create') {
      // one active hosted room per player: reuse it
      const { data: mine } = await db.from('game_rooms').select('*').eq('host_id', user.id).gt('expires_at', now.toISOString()).maybeSingle();
      let room = mine;
      if (!room) {
        for (let i = 0; i < 6 && !room; i++) {
          const { data, error } = await db.from('game_rooms').insert({
            code: genCode(), host_id: user.id,
            expires_at: new Date(now.getTime() + ROOM_TTL_H * 3600e3).toISOString()
          }).select().single();
          if (!error) room = data;
        }
        if (!room) return res.status(500).json({ error: 'code_gen' });
      }
      await db.from('room_members').upsert({ room_id: room.id, user_id: user.id, display_name: pf.name, avatar_url: pf.avatar, joined_at: now.toISOString() }, { onConflict: 'room_id,user_id' });
      return res.status(200).json({ room: { id: room.id, code: room.code, host: room.host_id, expires_at: room.expires_at }, members: await members(db, room.id) });
    }

    if (action === 'join') {
      const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 6) return res.status(400).json({ error: 'bad_code' });
      const { data: room } = await db.from('game_rooms').select('*').eq('code', code).gt('expires_at', now.toISOString()).maybeSingle();
      if (!room) return res.status(404).json({ error: 'not_found' });
      const { data: cur } = await db.from('room_members').select('user_id').eq('room_id', room.id);
      const isIn = (cur || []).some(x => x.user_id === user.id);
      if (!isIn && (cur || []).length >= MAX_MEMBERS) return res.status(409).json({ error: 'full' });
      // leave any other room first (one room at a time)
      await db.from('room_members').delete().eq('user_id', user.id).neq('room_id', room.id);
      await db.from('room_members').upsert({ room_id: room.id, user_id: user.id, display_name: pf.name, avatar_url: pf.avatar, joined_at: now.toISOString() }, { onConflict: 'room_id,user_id' });
      return res.status(200).json({ room: { id: room.id, code: room.code, host: room.host_id, expires_at: room.expires_at }, members: await members(db, room.id) });
    }

    if (action === 'current') {
      const { data: mem } = await db.from('room_members').select('room_id').eq('user_id', user.id).limit(1).maybeSingle();
      if (!mem) return res.status(200).json({ room: null });
      const { data: room } = await db.from('game_rooms').select('*').eq('id', mem.room_id).gt('expires_at', now.toISOString()).maybeSingle();
      if (!room) { await db.from('room_members').delete().eq('user_id', user.id); return res.status(200).json({ room: null }); }
      return res.status(200).json({ room: { id: room.id, code: room.code, host: room.host_id, expires_at: room.expires_at }, members: await members(db, room.id) });
    }

    if (action === 'members') {
      const { data: mem } = await db.from('room_members').select('room_id').eq('user_id', user.id).maybeSingle();
      if (!mem) return res.status(403).json({ error: 'not_member' });
      return res.status(200).json({ members: await members(db, mem.room_id) });
    }

    if (action === 'leave') {
      const { data: mem } = await db.from('room_members').select('room_id').eq('user_id', user.id).maybeSingle();
      if (mem) {
        await db.from('room_members').delete().eq('user_id', user.id);
        const { count } = await db.from('room_members').select('user_id', { count: 'exact', head: true }).eq('room_id', mem.room_id);
        if (!count) await db.from('game_rooms').delete().eq('id', mem.room_id);
        else {
          const { data: r } = await db.from('game_rooms').select('host_id').eq('id', mem.room_id).maybeSingle();
          if (r && r.host_id === user.id) {
            const { data: nx } = await db.from('room_members').select('user_id').eq('room_id', mem.room_id).order('joined_at').limit(1).maybeSingle();
            if (nx) await db.from('game_rooms').update({ host_id: nx.user_id }).eq('id', mem.room_id);
          }
        }
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    return res.status(500).json({ error: e.message === 'missing_env' ? 'missing_env' : 'server' });
  }
};
