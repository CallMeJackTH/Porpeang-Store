const { admin, authPlayer } = require('./_lib/sb');

// อันดับทีม: 1 ห้อง = 1 ทีม จัดอันดับด้วยความมั่งคั่งของโลกร่วม (ไม่เปิดเผยรหัสห้อง)
async function teamBoard(req, res, db) {
  const nowIso = new Date().toISOString();
  const { data: rooms, error } = await db.from('game_rooms')
    .select('id,team_wealth,team_money,team_day,created_at')
    .eq('status', 'playing').gt('expires_at', nowIso).gt('team_wealth', 0)
    .order('team_wealth', { ascending: false }).order('created_at', { ascending: true }).limit(100);
  if (error) return res.status(500).json({ error: 'db' });

  const ids = (rooms || []).map(r => r.id);
  const names = {}, counts = {};
  if (ids.length) {
    const { data: mem } = await db.from('room_members').select('room_id,user_id,joined_at').in('room_id', ids).order('joined_at');
    const uids = [...new Set((mem || []).map(m => m.user_id))];
    const { data: pl } = uids.length ? await db.from('players').select('id,username').in('id', uids) : { data: [] };
    const nm = {}; (pl || []).forEach(p => { nm[p.id] = p.username; });
    (mem || []).forEach(m => { (names[m.room_id] = names[m.room_id] || []).push(nm[m.user_id] || 'Player'); counts[m.room_id] = (counts[m.room_id] || 0) + 1; });
  }

  let myRoomId = null;
  const user = await authPlayer(req, db);
  if (user) {
    const { data: m } = await db.from('room_members').select('room_id').eq('user_id', user.id).limit(1).maybeSingle();
    if (m) myRoomId = m.room_id;
  }

  const rows = (rooms || []).map((r, i) => {
    const n = names[r.id] || [];
    return { rank: i + 1, name: 'ทีม ' + (n[0] || '—'), members: n.slice(0, 6), count: counts[r.id] || 0,
      day: Number(r.team_day) || 1, money: Number(r.team_money) || 0, wealth: Number(r.team_wealth) || 0, mine: r.id === myRoomId };
  });

  let me = null;
  if (myRoomId && !rows.some(r => r.mine)) {
    const { data: mine } = await db.from('game_rooms').select('team_wealth,team_money,team_day,status').eq('id', myRoomId).maybeSingle();
    if (mine && mine.status === 'playing' && Number(mine.team_wealth) > 0) {
      const { count } = await db.from('game_rooms').select('id', { count: 'exact', head: true })
        .eq('status', 'playing').gt('expires_at', nowIso).gt('team_wealth', mine.team_wealth);
      me = { rank: (count || 0) + 1, money: Number(mine.team_money) || 0, wealth: Number(mine.team_wealth) || 0, day: Number(mine.team_day) || 1 };
    }
  }
  return res.status(200).json({ rows, me });
}

module.exports = async (req, res) => {
  try {
    const db = admin();
    if ((req.query || {}).type === 'team') return await teamBoard(req, res, db);
    const { data, error } = await db.from('leaderboard')
      .select('user_id,display_name,avatar_url,money,wealth')
      .order('wealth', { ascending: false }).order('updated_at', { ascending: true }).limit(100);
    if (error) return res.status(500).json({ error: 'db' });
    const rows = (data || []).map((r, i) => ({ rank: i + 1, id: r.user_id, name: r.display_name, avatar: r.avatar_url, money: r.money, wealth: r.wealth }));

    let me = null;
    const user = await authPlayer(req, db);
    if (user) {
      const { data: mine } = await db.from('leaderboard').select('money,wealth').eq('user_id', user.id).maybeSingle();
      if (mine) {
        const { count } = await db.from('leaderboard').select('user_id', { count: 'exact', head: true }).gt('wealth', mine.wealth);
        me = { rank: (count || 0) + 1, money: mine.money, wealth: mine.wealth };
      }
    }
    res.status(200).json({ rows, me });
  } catch (e) {
    res.status(500).json({ error: e.message === 'missing_env' ? 'missing_env' : 'server' });
  }
};
