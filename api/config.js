const { URL_, ANON } = require('./_lib/sb');

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !ANON) {
    res.status(500).json({ error: 'missing_env' });
    return;
  }
  // Only public values are returned. The service role key never leaves the server.
  res.status(200).json({ url: URL_, anonKey: ANON });
};
