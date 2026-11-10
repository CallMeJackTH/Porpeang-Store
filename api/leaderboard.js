const { admin, authUser } = require('./_lib/sb');

module.exports = async (req, res) => {
  try {
    const db = admin();
    const { data, error } = await db.from('leaderboard')
      .select('user_id,display_name,avatar_url,money,wealth')
      .order('wealth', { ascending: false }).order('updated_at', { ascending: true }).limit(100);
    if (error) return res.status(500).json({ error: 'db' });
    const rows = (data || []).map((r, i) => ({ rank: i + 1, id: r.user_id, name: r.display_name, avatar: r.avatar_url, money: r.money, wealth: r.wealth }));

    let me = null;
    const user = await authUser(req, db);
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
