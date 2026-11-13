// Run with:  npm test   (or: node tests/run.js)   — no network, no Supabase project and no extra packages needed.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const { makeDb } = require('./fakedb');
const ROOT = path.join(__dirname, '..');

let DB = makeDb();
const origLoad = Module._load;
Module._load = function (req, parent, ...r) {
  if (req === '@supabase/supabase-js') return { createClient: () => ({}) };
  if (req === './_lib/sb' && parent && /[\\/]api[\\/][^\\/]+\.js$/.test(parent.filename)) {
    return { admin: () => DB, authUser: async () => null, authPlayer: async rq => {
      const u = String(rq.headers.authorization || '').replace('Bearer ', ''); return u ? { id: u, username: u, claimed: true } : null; },
      body: rq => rq.body || {}, USERNAME_RE: /^[A-Za-z0-9_]{3,20}$/, emailFor: u => u + '@x.test' };
  }
  return origLoad.call(this, req, parent, ...r);
};
const save = require('../api/save.js');
const room = require('../api/room.js');
const register = require('../api/register.js');
const gs = require('../api/_lib/gamestate.js');

const call = async (handler, o) => {
  const out = { status: 200, json: null };
  const res = { setHeader() {}, status(c) { out.status = c; return res; }, json(j) { out.json = j; return res; } };
  await handler({ method: o.method || 'POST', headers: { authorization: 'Bearer ' + (o.user || ''), 'x-forwarded-for': o.ip || '1.1.1.1' }, body: o.body, query: o.query }, res);
  return out;
};
const S = (over) => Object.assign({ m: 5000, d: 1, plots: Array(8).fill(null), nest: [], hens: 0, coop: 0, wv: 0, sold: 0,
  st: {}, pr: {}, tr: { d: 1, v: {} }, ev: null }, over || {});
const saveAs = (user, state, extra) => call(save, { user, body: Object.assign({ state }, extra || {}) });
const stored = u => DB.T.player_saves.find(r => r.user_id === u);

let pass = 0, fail = 0; const failures = [];
async function test(name, fn) {
  DB = makeDb();
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; failures.push(name); console.log('  FAIL  ' + name + '\n        ' + String(e.message).split('\n').join('\n        ')); }
}

(async () => {
  console.log('\n== Cloud save ==');
  await test('save keeps land (12 plots), gun, clerk, clock, pending VIP', async () => {
    const full = S({ m: 20000, d: 12, plots: Array(12).fill(null).map((_, i) => i < 2 ? { c: 'vg', d: 3 } : null), gun: 1, clerk: {}, clk: 500, vipPend: 1, hens: 2, emp: { sl: 0 } });
    const r = await saveAs('u1', full); assert.strictEqual(r.status, 200);
    const s = stored('u1').state;
    assert.strictEqual(s.plots.length, 12); assert.strictEqual(s.gun, 1); assert.deepStrictEqual(s.clerk, {});
    assert.strictEqual(s.clk, 500); assert.strictEqual(s.vipPend, 1); assert.strictEqual(s.plots[0].c, 'vg');
    const g = await call(save, { method: 'GET', user: 'u1' });
    assert.strictEqual(g.json.save.state.plots.length, 12); assert.strictEqual(g.json.save.state.gun, 1);
  });
  await test('first save cannot claim a huge day to mint money (cap 5,005,000 x... day-capped at 1000)', async () => {
    const r = await saveAs('u2', S({ m: 1e9, d: 100000 }));
    assert.strictEqual(r.json.clamped, true);
    assert.ok(stored('u2').wealth <= 50005000, 'wealth ' + stored('u2').wealth);
  });
  await test('11 back-to-back saves of +60,000 stay inside the 300,000 budget', async () => {
    await saveAs('u3', S({ m: 5000 }));
    let m = 5000, clampedCount = 0;
    for (let i = 0; i < 10; i++) { m += 60000; const r = await saveAs('u3', S({ m })); if (r.json.clamped) clampedCount++; }
    const w = stored('u3').wealth;
    assert.ok(w <= 5000 + 300000 + 100, 'wealth ' + w);   // before the fix this reached 605,000
    assert.ok(clampedCount >= 4, 'clamped ' + clampedCount);
  });
  await test('normal play (+3,000 per save x 20) is never clamped', async () => {
    await saveAs('u4', S({ m: 5000 })); let m = 5000;
    for (let i = 0; i < 20; i++) { m += 3000; const r = await saveAs('u4', S({ m })); assert.ok(!r.json.clamped, 'clamped at ' + i); }
    assert.strictEqual(stored('u4').money, 65000);
  });
  await test('budget refills over time (400/s): after 100 s about 40,000 is allowed again', async () => {
    await saveAs('u5', S({ m: 5000 }));
    await saveAs('u5', S({ m: 305000 }));                 // drains the 300,000 budget
    let r = await saveAs('u5', S({ m: 405000 }));         // +100,000 with an empty budget
    assert.strictEqual(r.json.clamped, true);
    DB.offset += 100000;                                  // 100 s later
    const before = stored('u5').money;
    r = await saveAs('u5', S({ m: before + 30000 })); assert.ok(!r.json.clamped, '+30k after 100s should pass');
    r = await saveAs('u5', S({ m: stored('u5').money + 100000 })); assert.strictEqual(r.json.clamped, true);
  });
  await test('"use my local save" (reset) may jump once per day, within the day-based cap', async () => {
    await saveAs('u6', S({ m: 10000, d: 5 }));
    let r = await saveAs('u6', S({ m: 2000000, d: 100 }), { reset: 1 });
    assert.ok(!r.json.clamped, 'first import should pass'); assert.strictEqual(stored('u6').money, 2000000);
    r = await saveAs('u6', S({ m: 4000000, d: 100 }), { reset: 1 });
    assert.strictEqual(r.json.clamped, true, 'second import within 24h must be clamped'); assert.ok(stored('u6').money < 2400000);
    await saveAs('u7', S({ m: 10000, d: 5 }));
    r = await saveAs('u7', S({ m: 2000000, d: 100 }));    // same jump WITHOUT the reset flag
    assert.strictEqual(r.json.clamped, true);
    await saveAs('u8', S({ m: 10000, d: 5 }));
    r = await saveAs('u8', S({ m: 9e8, d: 100 }), { reset: 1 }); assert.ok(stored('u8').wealth <= 5005000, 'cap ' + stored('u8').wealth);
  });
  await test('starting a new game (reset) with lower wealth is accepted as is', async () => {
    await saveAs('u9', S({ m: 90000, d: 9 }));
    const r = await saveAs('u9', S({ m: 5000, d: 1 }), { reset: 1 });
    assert.ok(!r.json.clamped); assert.strictEqual(stored('u9').day, 1);
  });
  await test('day cannot go backwards without reset', async () => {
    await saveAs('u10', S({ m: 5000, d: 9 })); await saveAs('u10', S({ m: 5000, d: 2 }));
    assert.strictEqual(stored('u10').day, 9);
  });
  await test('stock cannot be minted: +5000 of every item is clamped', async () => {
    await saveAs('u11', S({ m: 5000 }));
    const st = {}; ['ma','fi','sa','su','eg','ri','wa','vg','yo','ju','sd','cf','sn','bd','ic','ch'].forEach(k => st[k] = 5000);
    const r = await saveAs('u11', S({ m: 5000, st }));
    assert.strictEqual(r.json.clamped, true); assert.ok(stored('u11').wealth <= 5000 + 300000 + 100, 'wealth ' + stored('u11').wealth);
  });
  await test('rate limit: the 41st save within a minute gets HTTP 429', async () => {
    let last; for (let i = 0; i < 41; i++) last = await saveAs('u12', S({ m: 5000 }));
    assert.strictEqual(last.status, 429); assert.strictEqual(last.json.error, 'rate_limited');
  });
  await test('unauthenticated save is rejected (401)', async () => {
    const r = await saveAs('', S()); assert.strictEqual(r.status, 401);
  });

  console.log('\n== Shared rooms ==');
  async function mkRoom(host, members) {
    await saveAs(host, S({ m: 20000, d: 3, hens: 1 }));
    const c = await call(room, { user: host, body: { action: 'create' } }); assert.strictEqual(c.status, 200, JSON.stringify(c.json));
    const code = c.json.room.code;
    for (const m of members || []) { const j = await call(room, { user: m, body: { action: 'join', code } }); assert.strictEqual(j.status, 200, JSON.stringify(j.json)); }
    const s = await call(room, { user: host, body: { action: 'start', state: S() } }); assert.strictEqual(s.status, 200, JSON.stringify(s.json));
    return { code, state: s.json.state };
  }
  const sync = (u, delta, set) => call(room, { user: u, body: { action: 'sync', since: 0, delta, set } });
  await test('create / join / start / sync works for a legitimate play pattern', async () => {
    const { state } = await mkRoom('hostA', ['p2A']);
    assert.strictEqual(state.m, 20000);
    const r = await sync('p2A', { m: 140, sold: 1, st: { ma: -2 } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.state.m, 20140); assert.strictEqual(r.json.state.sold, 1);
    const g = await call(room, { method: 'GET', user: 'hostA', query: { action: 'state' } });
    assert.strictEqual(g.json.state.m, 20140);
  });
  await test('hammering sync with delta.m = 1e9 x 20 cannot exceed the 300,000 room budget', async () => {
    await mkRoom('hostB', ['p2B']); let last;
    for (let i = 0; i < 20; i++) last = await sync(i % 2 ? 'hostB' : 'p2B', { m: 1e9 });
    const w = gs.wealthOf(last.json.state);
    assert.ok(w <= 20000 + 50 + 300000 + 100, 'room wealth ' + w);       // before the fix: grew without bound
  });
  await test('room stock minting (+5000 of each item) is limited too', async () => {
    await mkRoom('hostC', []); const st = {}; ['ma','fi','sa','su','eg','ri','wa','vg','yo','ju','sd','cf','sn','bd','ic','ch'].forEach(k => st[k] = 5000);
    const r = await sync('hostC', { st }); assert.ok(gs.wealthOf(r.json.state) <= 20050 + 300000 + 100, String(gs.wealthOf(r.json.state)));
  });
  await test('a free gun is refused; a paid gun is accepted and cannot be removed', async () => {
    await mkRoom('hostD', []);
    let r = await sync('hostD', {}, { gun: 1 }); assert.strictEqual(r.json.state.gun, 0);
    r = await sync('hostD', { m: -20000 }, { gun: 1 }); assert.strictEqual(r.json.state.gun, 1); assert.strictEqual(r.json.state.m, 0);
    r = await sync('hostD', {}, { gun: 0 }); assert.strictEqual(r.json.state.gun, 1);
  });
  await test('shared day cannot jump more than 5 per sync', async () => {
    await mkRoom('hostE', []); const r = await sync('hostE', {}, { d: 99999 }); assert.strictEqual(r.json.state.d, 3 + 5);
  });
  await test('non-members and non-hosts are refused', async () => {
    await mkRoom('hostF', ['p2F']);
    assert.strictEqual((await sync('eveF', { m: 100 })).status, 403);
    const s = await call(room, { user: 'p2F', body: { action: 'start', state: S() } }); assert.strictEqual(s.status, 403); assert.strictEqual(s.json.error, 'not_host');
  });
  await test('starting a room without a cloud save cannot seed 1e9 money', async () => {
    const c = await call(room, { user: 'hostG', body: { action: 'create' } });
    const s = await call(room, { user: 'hostG', body: { action: 'start', state: S({ m: 1e9, d: 100000 }) } });
    assert.strictEqual(s.status, 200); assert.ok(gs.wealthOf(s.json.state) <= 50005000, String(gs.wealthOf(s.json.state)));
  });
  await test('room API rate limit: the 401st call in a minute gets HTTP 429', async () => {
    await mkRoom('hostH', []); let last;
    for (let i = 0; i < 400; i++) last = await call(room, { method: 'GET', user: 'hostH', query: { action: 'state' } });
    assert.strictEqual(last.status, 429);
  });
  await test('expired-room cleanup does not run on every request', async () => {
    await mkRoom('hostI', []); let selects = 0; const f = DB.from;
    DB.from = n => { const q = f(n); if (n === 'game_rooms') { const s = q.select; q.select = function () { return s.apply(this, arguments); }; const lt = q.lt; q.lt = function () { selects++; return lt.apply(this, arguments); }; } return q; };
    for (let i = 0; i < 20; i++) await call(room, { method: 'GET', user: 'hostI', query: { action: 'current' } });
    assert.ok(selects <= 1, 'cleanup scans: ' + selects);
  });

  console.log('\n== Fallback when migration_006 is NOT applied ==');
  await test('save still works; one huge jump is clamped by the legacy time rule', async () => {
    DB.rpcMissing = true;
    await saveAs('f1', S({ m: 5000 })); const r = await saveAs('f1', S({ m: 5000000 }));
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.clamped, true); assert.ok(stored('f1').money < 5000 + 60000 + 400 * 5, String(stored('f1').money));
  });
  await test('request limits still work from in-memory fallback', async () => {
    DB.rpcMissing = true; let last; for (let i = 0; i < 41; i++) last = await saveAs('f2', S({ m: 5000 }));
    assert.strictEqual(last.status, 429);
  });
  await test('room sync still works and is limited per call', async () => {
    DB.rpcMissing = true; await mkRoom('f3', []);
    const r = await sync('f3', { m: 1e9 }); assert.strictEqual(r.status, 200); assert.ok(r.json.state.m <= 20000 + 60000 + 400 * 5);
  });

  console.log('\n== Registration rate limit ==');
  await test('11th registration attempt from one IP in 10 minutes gets HTTP 429', async () => {
    const codes = []; for (let i = 0; i < 11; i++) codes.push((await call(register, { body: { username: 'a', password: 'x' }, ip: '9.9.9.9' })).status);
    assert.deepStrictEqual(codes.slice(0, 10), Array(10).fill(400)); assert.strictEqual(codes[10], 429);
    assert.strictEqual((await call(register, { body: { username: 'a', password: 'x' }, ip: '8.8.8.8' })).status, 400);
  });

  console.log('\n== gamestate helpers ==');
  await test('shrinkWealth removes the excess (money, then stock, then hens), overshoots by less than one unit, never goes negative', async () => {
    const s = gs.cleanState(S({ m: 1000, st: { ri: 10, ma: 50 }, hens: 2 }));
    const w = gs.wealthOf(s);
    for (const cut of [1, 500, 1000, 1500, 2300, w - 5, w]) { const o = gs.shrinkWealth(s, cut); assert.ok(o.m >= 0 && Object.values(o.st).every(v => v >= 0) && o.hens >= 0);
      assert.ok(gs.wealthOf(o) <= w - cut + 1 && gs.wealthOf(o) >= Math.max(0, w - cut - 100), `cut ${cut}: ${gs.wealthOf(o)} vs ${w - cut}`); }
  });

  console.log('\n== Static checks of the client ==');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  await test('every inline script in index.html parses', async () => { assert.strictEqual(scripts.length, 2); scripts.forEach(s => new vm.Script(s)); });
  await test('gardener timer is registered once', async () => { assert.strictEqual((html.match(/setInterval\(empTick,6000\)/g) || []).length, 1); });
  await test('music: asset exists (>1 MB) and Settings toggle is wired', async () => {
    assert.ok(fs.statSync(path.join(ROOT, 'assets/background_sound.webm')).size > 1e6);
    ['assets/background_sound.webm', 'cfgMusic()', 'id="mu"', 'music:1'].forEach(k => assert.ok(html.includes(k), k));
  });
  await test('project data fields: server whitelist covers every S.* property the game uses', async () => {
    const used = [...new Set([...html.matchAll(/\bS\.([A-Za-z_]\w*)/g)].map(m => m[1]))];
    const out = gs.cleanState(S({ gun: 1, clerk: {}, clk: 400, vipPend: 1, emp: { sl: 0 }, ev: { t: 'x' } }));
    const missing = used.filter(k => !(k in out)); assert.deepStrictEqual(missing, []);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failed: ' + failures.join(' | ')); process.exit(1); }
})();
