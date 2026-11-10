const { admin, authPlayer } = require('./_lib/sb');

// Returns the player that owns the verified session (used right after login).
module.exports = async (req, res) => {
  try {
    const db = admin();
    const p = await authPlayer(req, db, { allowUnclaimed: true });
    if (!p) return res.status(401).json({ error: 'unauthorized' });
    if (p.claimed) await db.from('players').update({ last_login_at: new Date().toISOString() }).eq('id', p.id);
    res.status(200).json({ player: { id: p.id, username: p.username, claimed: !!p.claimed } });
  } catch (e) {
    res.status(500).json({ error: e.message === 'missing_env' ? 'missing_env' : 'server' });
  }
};
