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
const eco = require('../api/_lib/economy.js');
const action = require('../api/action.js');

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
  await test('a free gun is refused; sync can never grant or remove the gun (it is bought only via api/action.js, 100,000)', async () => {
    await mkRoom('hostD', []);
    let r = await sync('hostD', {}, { gun: 1 }); assert.strictEqual(r.json.state.gun, 0);
    r = await sync('hostD', { m: -100000 }, { gun: 1 }); assert.strictEqual(r.json.state.gun, 0, 'a client-claimed payment must not grant the gun');
    const g = await call(action, { user: 'hostD', body: { action: 'buy_gun', rid: 'rid-gun-0001', shared: 1 } });
    assert.strictEqual(g.status, 409); assert.strictEqual(g.json.error, 'insufficient');   // the room only has 20,000
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

  console.log('\n== Remaining systems (server rules) ==');
  const act = (u, b) => call(action, { user: u, body: b });
  const saved = u => stored(u).state;
  let _rid = 0; const rid = () => 'rid-test-' + (++_rid) + '-xxxx';
  const rainDay = (() => { for (let d = 2; d < 200; d++) if (eco.rainInfo(d)) return d; })();
  const dryDay = (() => { for (let d = 2; d < 200; d++) if (!eco.rainInfo(d)) return d; })();

  await test('gun price is exactly 100,000: server constant, refuses 99,999, ignores a client price, one purchase only', async () => {
    assert.strictEqual(eco.GUN_PRICE, 100000); assert.strictEqual(gs.GUN_PRICE, 100000);
    await saveAs('g1', S({ m: 99999, d: 5 }));
    let r = await act('g1', { action: 'buy_gun', rid: rid(), price: 1 }); assert.strictEqual(r.status, 409); assert.strictEqual(r.json.error, 'insufficient'); assert.strictEqual(saved('g1').gun, 0);
    await saveAs('g2', S({ m: 100000, d: 5 }));
    r = await act('g2', { action: 'buy_gun', rid: rid(), price: 1, cost: 1 }); assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(saved('g2').m, 0); assert.strictEqual(saved('g2').gun, 1); assert.strictEqual(r.json.delta, -100000);
    r = await act('g2', { action: 'buy_gun', rid: rid() }); assert.strictEqual(r.status, 409); assert.strictEqual(r.json.error, 'already_owned');
  });
  await test('personal save cannot give itself the gun, upgrades, claims or a bigger rain bonus; legit old gun stays', async () => {
    await saveAs('s1', S({ m: 5000, d: 5 }));
    await saveAs('s1', S({ m: 5000, d: 5, gun: 1, up: { cs: 5, dc: 5, fm: 3 }, ms: { d: 5, p: { sell: 1 }, c: { sell: 1 } } }));
    const st = saved('s1'); assert.strictEqual(st.gun, 0); assert.deepStrictEqual(st.up, { cs: 0, dc: 0, fm: 0 }); assert.deepStrictEqual(st.ms.c, {});
    await saveAs('s2', S({ m: 5000, d: 12, gun: 1 }));                       // old save made with the 20,000 gun: first upload keeps it when plausible
    assert.strictEqual(saved('s2').gun, 1);
    await saveAs('s2', S({ m: 5000, d: 12, gun: 0 })); assert.strictEqual(saved('s2').gun, 1, 'gun never disappears');
  });
  await test('upgrades: progressive prices, server-side validation, duplicate rid and race safe, max level', async () => {
    assert.deepStrictEqual([0, 1, 2, 3, 4].map(l => eco.upgradeCost('cs', l)), [2000, 3600, 6500, 11650, 21000]);
    assert.strictEqual(eco.upgradeCost('cs', 5), null); assert.strictEqual(eco.upgradeCost('zz', 0), null); assert.strictEqual(eco.upgradeCost('cs', -1), null);
    await saveAs('u1', S({ m: 2500, d: 5 }));
    const id = rid(); let r = await act('u1', { action: 'buy_upgrade', id: 'cs', rid: id, cost: -5000 });
    assert.strictEqual(r.status, 200); assert.strictEqual(saved('u1').m, 500); assert.strictEqual(saved('u1').up.cs, 1);
    r = await act('u1', { action: 'buy_upgrade', id: 'cs', rid: id }); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.duplicate, true);
    assert.strictEqual(saved('u1').m, 500); assert.strictEqual(saved('u1').up.cs, 1, 'same rid replayed: no second purchase');
    r = await act('u1', { action: 'buy_upgrade', id: 'cs', rid: rid() }); assert.strictEqual(r.json.error, 'insufficient');
    r = await act('u1', { action: 'buy_upgrade', id: 'nope', rid: rid() }); assert.strictEqual(r.status, 400);
    await saveAs('u2', S({ m: 2500, d: 5 }));
    const both = await Promise.all([act('u2', { action: 'buy_upgrade', id: 'cs', rid: rid() }), act('u2', { action: 'buy_upgrade', id: 'cs', rid: rid() })]);
    assert.strictEqual(both.filter(x => x.status === 200).length, 1, 'two parallel purchases with money for one: exactly one wins');
    assert.strictEqual(saved('u2').up.cs, 1); assert.strictEqual(saved('u2').m, 500);
    await saveAs('u3', S({ m: 5e6, d: 5 })); const rich = saved('u3'); assert.ok(rich.m <= 5000 + 5 * 50000);
    await saveAs('u4', S({ m: 250000, d: 5 }));
    for (let i = 0; i < 3; i++) assert.strictEqual((await act('u4', { action: 'buy_upgrade', id: 'fm', rid: rid() })).status, 200);
    assert.strictEqual((await act('u4', { action: 'buy_upgrade', id: 'fm', rid: rid() })).json.error, 'maxed');
  });
  await test('missions: targets grow, reward only once, client cannot unclaim, resets only on a new in-game day', async () => {
    assert.ok(['sell', 'earn', 'farm'].every(k => eco.missionTarget(k, 40) > eco.missionTarget(k, 1) && eco.missionReward(k, 40) > eco.missionReward(k, 1)));
    await saveAs('m1', S({ m: 5000, d: 5, ms: { d: 5, p: { sell: 2, earn: 0, farm: 0 }, c: {} } }));
    let r = await act('m1', { action: 'claim_mission', id: 'sell', rid: rid() }); assert.strictEqual(r.json.error, 'not_complete');
    await saveAs('m1', S({ m: 5000, d: 5, ms: { d: 5, p: { sell: 6 }, c: {} } }));
    r = await act('m1', { action: 'claim_mission', id: 'sell', rid: rid(), reward: 1e9 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json)); assert.strictEqual(saved('m1').m, 5000 + eco.missionReward('sell', 5));
    r = await act('m1', { action: 'claim_mission', id: 'sell', rid: rid() }); assert.strictEqual(r.json.error, 'already_claimed');
    await saveAs('m1', S({ m: saved('m1').m, d: 5, ms: { d: 5, p: { sell: 6 }, c: {} } }));            // client tries to wipe its claim
    r = await act('m1', { action: 'claim_mission', id: 'sell', rid: rid() }); assert.strictEqual(r.json.error, 'already_claimed');
    await saveAs('m1', S({ m: saved('m1').m, d: 6, ms: { d: 6, p: { sell: 4 }, c: {} } }));            // next in-game day
    assert.deepStrictEqual(saved('m1').ms.c, {}); assert.strictEqual(saved('m1').ms.d, 6);
    r = await act('m1', { action: 'claim_mission', id: 'sell', rid: rid() }); assert.strictEqual(r.json.error, 'not_complete');   // day-6 target is 7, progress only 4
    await saveAs('m1', S({ m: saved('m1').m, d: 6, ms: { d: 6, p: { sell: 7 }, c: {} } }));
    r = await act('m1', { action: 'claim_mission', id: 'sell', rid: rid() }); assert.strictEqual(r.status, 200);                // a new day: claimable again, once
  });

  console.log('\n== Remaining systems (rain, history, closing, rooms, compatibility) ==');
  const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); assert.ok(i >= 0 && j > i, 'marker ' + a); return html.slice(i, j); };

  await test('rain schedule: client and server compute the same days/times (1..3000); ~30% of days; never day 1', async () => {
    const mk = new Function(cut('/*RAIN-BEGIN*/', '/*RAIN-END*/') + '; return rainInfo;')();
    let n = 0;
    for (let d = 1; d <= 3000; d++) { assert.deepStrictEqual(mk(d), eco.rainInfo(d), 'day ' + d); if (eco.rainInfo(d)) n++; }
    assert.strictEqual(eco.rainInfo(1), null); assert.ok(n > 600 && n < 1200, 'rainy days ' + n);
    const r = eco.rainInfo(rainDay); assert.ok(r.s >= 480 && r.s <= 960 && r.e - r.s === 150);
  });
  await test('rain: eligible crops get exactly +1 once; ready crops do not; reload/duplicate ticks add nothing', async () => {
    const src = cut('/*RAIN-BEGIN*/', '/*RAIN-END*/') + 'const grown=p=>S.d-p.d+(p.b||0);' + cut('function isRain(', 'function rainFx(');
    const run = (S0, calls) => { const ctx = { S: S0, CROPS: { ri: { g: 2 }, vg: { g: 1 } }, toast() {}, snd() {}, hud() {}, fkey: '', Math, Object };
      ctx.window = ctx; vm.createContext(ctx); vm.runInContext(src + ';this.rainStep=rainStep;this.isRain=isRain;', ctx); for (let i = 0; i < calls; i++) ctx.rainStep(); return ctx; };
    const r = eco.rainInfo(rainDay);
    const base = { d: rainDay, clk: r.s + 5, plots: [{ c: 'ri', d: rainDay }, { c: 'vg', d: rainDay - 4 }, null, { c: 'ri', d: rainDay - 1, b: 0 }], rn: null };
    let c = run(JSON.parse(JSON.stringify(base)), 25);                                        // 25 ticks in the same rain event
    assert.strictEqual(c.S.plots[0].b, 1); assert.strictEqual(c.S.plots[1].b, undefined, 'a ripe crop is not advanced'); assert.strictEqual(c.S.plots[2], null);
    assert.strictEqual(c.S.plots[3].b, 1); assert.strictEqual(JSON.stringify(c.S.rn), JSON.stringify({ d: rainDay, a: 1 }));
    const reloaded = JSON.parse(JSON.stringify(c.S)); c = run(reloaded, 10);                  // page reload / reconnect: state carries the mark
    assert.strictEqual(c.S.plots[0].b, 1); assert.strictEqual(c.S.plots[3].b, 1);
    c = run(Object.assign(JSON.parse(JSON.stringify(base)), { clk: r.s - 5 }), 5); assert.strictEqual(c.S.rn, null, 'before the rain starts nothing happens');
    c = run(Object.assign(JSON.parse(JSON.stringify(base)), { d: dryDay, plots: [{ c: 'ri', d: dryDay }], clk: 900 }), 5); assert.strictEqual(c.S.rn, null, 'a dry day has no rain');
    const nxt = JSON.parse(JSON.stringify(c.S)); nxt.d = rainDay; nxt.clk = r.s + 5; nxt.rn = { d: rainDay - 1, a: 1 }; nxt.plots = [{ c: 'ri', d: rainDay }];
    c = run(nxt, 3); assert.strictEqual(c.S.plots[0].b, 1, 'yesterday mark does not block today');
    // shared room: only the clock owner applies it
    const ctx2 = { S: JSON.parse(JSON.stringify(base)), CROPS: { ri: { g: 2 }, vg: { g: 1 } }, toast() {}, snd() {}, hud() {}, fkey: '', CUGATE: () => false, Math, Object };
    ctx2.window = ctx2; vm.createContext(ctx2); vm.runInContext(src + ';this.rainStep=rainStep;', ctx2); ctx2.rainStep(); assert.strictEqual(ctx2.S.rn, null);
  });
  await test('rain on the server: bonus capped at one per rain day, new crops start at 0, dry days grant nothing', async () => {
    const base = gs.cleanState(S({ d: rainDay, plots: [{ c: 'ri', d: rainDay }, null, null, null, null, null, null, null] }));
    const ask = (cur, plots, rn) => gs.applyChange(cur, { set: { plots, rn } });
    const P = (o) => [o, null, null, null, null, null, null, null];
    let st = ask(base, P({ c: 'ri', d: rainDay, b: 7 }), { d: rainDay, a: 1 }); assert.strictEqual(st.plots[0].b, 1, 'b=7 claimed, +1 allowed'); assert.deepStrictEqual(st.rn, { d: rainDay, a: 1 });
    st = ask(st, P({ c: 'ri', d: rainDay, b: 2 }), { d: rainDay, a: 1 }); assert.strictEqual(st.plots[0].b, 1, 'same event again: no second bonus');
    st = ask(st, P({ c: 'ri', d: rainDay, b: 1 }), null); assert.strictEqual(st.plots[0].b, 1); assert.deepStrictEqual(st.rn, { d: rainDay, a: 1 }, 'mark cannot be erased to re-trigger');
    st = ask(st, [Object.assign({ c: 'vg', d: rainDay, b: 3 })].concat(Array(7).fill(null)), { d: rainDay, a: 1 }); assert.strictEqual(st.plots[0].b, undefined, 'a different/new crop starts with no bonus');
    const dry = gs.cleanState(S({ d: dryDay, plots: [{ c: 'ri', d: dryDay }, null, null, null, null, null, null, null] }));
    const stDry = ask(dry, P({ c: 'ri', d: dryDay, b: 1 }), { d: dryDay, a: 1 }); assert.strictEqual(stDry.plots[0].b, undefined); assert.strictEqual(stDry.rn, null);
  });
  await test('transactions: negative/zero/NaN/duplicate/malformed entries dropped, history append-only, capped at 40', async () => {
    const ok = { i: 'a1', t: 'in', a: 50, r: 'sale', d: 2, c: 400 };
    const out = eco.cleanTx([ok, ok, { i: 'a2', t: 'out', a: -5, r: 'sale' }, { i: 'a3', t: 'in', a: 0, r: 'sale' }, { i: 'a4', t: 'in', a: NaN, r: 'sale' }, { i: 'a5', t: 'x', a: 5, r: 'sale' }, { i: 'a 6', t: 'in', a: 5, r: 'sale' }, { i: 'a7', t: 'in', a: 5, r: 'BAD REASON' }, null, 'x']);
    assert.deepStrictEqual(out.map(t => t.i), ['a1']);
    assert.strictEqual(eco.cleanTx(Array.from({ length: 90 }, (_, i) => ({ i: 't' + i, t: 'in', a: 1, r: 'sale', d: 1, c: 0 }))).length, 40);
    assert.deepStrictEqual(eco.mergeTx([ok], [ok, { i: 'b1', t: 'out', a: 9, r: 'land', d: 2, c: 500 }]).map(t => t.i), ['a1', 'b1']);
    await saveAs('t1', S({ m: 2500, d: 5 })); await act('t1', { action: 'buy_upgrade', id: 'cs', rid: rid() });
    await saveAs('t1', S({ m: saved('t1').m, d: 5, tx: [] }));                                      // client tries to erase history
    assert.ok(saved('t1').tx.some(t => t.r === 'up_cs' && t.t === 'out' && t.a === 2000), 'server-recorded purchase survives');
    await saveAs('t1', S({ m: saved('t1').m, d: 5, tx: [ok, ok, Object.assign({}, ok, { a: -9 })] }));
    assert.strictEqual(saved('t1').tx.filter(t => t.i === 'a1').length, 1);
  });
  await test('personal save: days cannot be skipped to reset missions (max +10 per save); explicit import is exempt', async () => {
    await saveAs('d1', S({ m: 5000, d: 5 }));
    let r = await saveAs('d1', S({ m: 5000, d: 500 })); assert.strictEqual(r.json.clamped, true); assert.strictEqual(stored('d1').day, 15);
    r = await saveAs('d1', S({ m: 5000, d: 16 })); assert.ok(!r.json.clamped); assert.strictEqual(stored('d1').day, 16);
    r = await saveAs('d1', S({ m: 5000, d: 60 }), { reset: 1 }); assert.strictEqual(stored('d1').day, 60);
  });
  await test('backward compatibility: a pre-update saved state loads with safe defaults and round-trips', async () => {
    const old = { m: 7000, d: 9, farm: 1, plots: [{ c: 'ri', d: 8 }, null, null, null, null, null, null, null], nest: [], hens: 1, coop: 0, sold: 12, wv: 0, st: { ma: 3 }, pr: { ma: 7 }, tr: { d: 9, v: {} }, ev: null, gun: 1, clk: 500 };
    const c = gs.cleanState(old); assert.deepStrictEqual(c.up, { cs: 0, dc: 0, fm: 0 }); assert.strictEqual(c.ms, null); assert.deepStrictEqual(c.tx, []); assert.strictEqual(c.rn, null); assert.strictEqual(c.plots[0].b, undefined);
    const r = await saveAs('o1', old); assert.strictEqual(r.status, 200); assert.strictEqual(saved('o1').gun, 1); assert.strictEqual(saved('o1').m, 7000);
    const g = await call(save, { method: 'GET', user: 'o1' }); assert.strictEqual(g.json.save.state.sold, 12);
  });

  console.log('\n== Remaining systems (shared rooms) ==');
  await test('room: members buy upgrades/claim via api/action (shared:true); outsiders refused; replay safe; sync cannot touch server-owned fields', async () => {
    await mkRoom('rA', ['rB']);
    let r = await act('rB', { action: 'buy_upgrade', id: 'cs', rid: 'room-rid-0001', shared: 1 }); assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const view = await sync('rA', {}); assert.strictEqual(view.json.state.up.cs, 1); assert.strictEqual(view.json.state.m, 18000);   // both players see the team purchase
    r = await act('rB', { action: 'buy_upgrade', id: 'cs', rid: 'room-rid-0001', shared: 1 }); assert.strictEqual(r.json.duplicate, true);
    assert.strictEqual((await sync('rA', {})).json.state.m, 18000);
    r = await act('eve', { action: 'buy_upgrade', id: 'cs', rid: rid(), shared: 1 }); assert.strictEqual(r.status, 403);
    r = await sync('rA', {}, { up: { cs: 5, dc: 5, fm: 3 }, gun: 1, ar: [] }); assert.strictEqual(r.json.state.up.cs, 1); assert.strictEqual(r.json.state.up.dc, 0); assert.strictEqual(r.json.state.gun, 0);
    const msSet = { d: 3, p: { sell: 4, earn: 0, farm: 0 }, c: { sell: 1 } };
    r = await sync('rA', {}, { ms: msSet }); assert.deepStrictEqual(r.json.state.ms.c, {}, 'claims cannot be set by a client'); assert.strictEqual(r.json.state.ms.p.sell, 4);
    r = await sync('rB', {}, { ms: { d: 3, p: { sell: 2 }, c: {} } }); assert.strictEqual(r.json.state.ms.p.sell, 4, 'progress never goes down');
    r = await act('rA', { action: 'claim_mission', id: 'sell', rid: rid(), shared: 1 }); assert.strictEqual(r.json.error, 'not_complete');   // day-3 target is 5
    await sync('rA', {}, { ms: { d: 3, p: { sell: 5 }, c: {} } });
    r = await act('rA', { action: 'claim_mission', id: 'sell', rid: rid(), shared: 1 }); assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    r = await act('rB', { action: 'claim_mission', id: 'sell', rid: rid(), shared: 1 }); assert.strictEqual(r.json.error, 'already_claimed', 'the team mission pays once');
  });
  await test('room: shop closes at 20:00 in the shared clock - sales refused, clock cannot be wound back, next day reopens', async () => {
    await mkRoom('cA', ['cB']);
    let r = await sync('cA', { m: 100, sold: 1 }, { clk: 1000 }); assert.strictEqual(r.json.state.sold, 1); assert.strictEqual(r.json.state.m, 20100);
    r = await sync('cA', {}, { clk: 1205 }); assert.strictEqual(r.json.state.clk, 1200, 'clock is clamped to 20:00');
    r = await sync('cB', { m: 250, sold: 2, st: { ma: -2 } }); assert.strictEqual(r.json.state.sold, 1, 'sale after closing not counted'); assert.strictEqual(r.json.state.m, 20100, 'income of that sale not paid'); assert.strictEqual(r.json.state.st.ma, 0, 'and no stock taken');
    r = await sync('cB', {}, { clk: 400 }); assert.strictEqual(r.json.state.clk, 1200, 'clock cannot reopen the shop mid-day');
    r = await sync('cB', {}, { d: 4, clk: 360 }); assert.strictEqual(r.json.state.d, 4); assert.strictEqual(r.json.state.clk, 360);
    r = await sync('cB', { m: 50, sold: 1 }); assert.strictEqual(r.json.state.sold, 2, 'next day: sales count again');
  });

  console.log('\n== Remaining systems (client code, static + extracted-function tests) ==');
  const line = pre => { const l = html.split('\n').find(x => x.startsWith(pre)); assert.ok(l, 'line ' + pre); return l; };
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  await test('client mission / upgrade tables equal the server tables (days 1..300)', async () => {
    const t = new Function(line('const MIS=') + line('const MIK=') + line('const UPG=') + line('const upCost=') + '; return { MIS, UPG, upCost };')();
    for (let d = 1; d <= 300; d++) for (const k of eco.MISSION_IDS) { assert.strictEqual(t.MIS[k].t(d), eco.missionTarget(k, d), k + ' target d' + d); assert.strictEqual(t.MIS[k].r(d), eco.missionReward(k, d), k + ' reward d' + d); }
    for (const id of eco.UPGRADE_IDS) { assert.strictEqual(t.UPG[id].max, eco.UPGRADES[id].max); for (let l = 0; l <= 5; l++) assert.strictEqual(t.upCost(id, l), eco.upgradeCost(id, l), id + l); }
  });
  await test('gun price: 100,000 in index.html (one definition), README, server; buyGun never sends a price; no 20,000 left', async () => {
    assert.strictEqual((html.match(/const GUN_PRICE=/g) || []).length, 1); assert.ok(html.includes('const GUN_PRICE=100000;'));
    assert.ok(!/20,000|S\.m<20000|S\.m-=20000/.test(html), 'old price still present'); assert.ok(!/ปืน[^\n]{0,40}20,000/.test(readme));
    const bg = cut('async function buyGun(', 'async function claimMs'); assert.ok(bg.includes("srvAct({action:'buy_gun'})") && !/price|cost/.test(bg.replace(/GUN_PRICE/g, '')), 'client must not send a price');
    assert.ok(html.includes("S.m>=GUN_PRICE?'':'disabled'} onclick=\"buyGun(1)\"") && html.includes("onclick=\"buyGun()\">🔫 ซื้อปืน '+B(GUN_PRICE)"), 'both purchase paths (computer + John Wick) use GUN_PRICE');
  });
  await test('PC / mobile controls: combat buttons hidden for mouse+hover devices, kept for touch; G and click guards', async () => {
    assert.ok(html.includes('@media (hover:hover) and (pointer:fine){#pbtn,#gbtn{display:none!important}}'));
    assert.ok(html.includes('id="pbtn" onclick="punch()"') && html.includes('id="gbtn" onclick="shoot()"'), 'touch buttons still exist');
    const g = line("addEventListener('keydown',e=>{const t=e.target,tg=t&&t.tagName;if(e.key.toLowerCase()=='g'");
    ['INPUT', 'TEXTAREA', 'SELECT', 'isContentEditable', "$('md').style.display!='flex'", 'e.ctrlKey'].forEach(x => assert.ok(g.includes(x), 'G guard ' + x)); assert.ok(g.includes('shoot()'));
    const c = line("let clk=null;cv.addEventListener('pointerdown'"), u = line("['pointerup','pointercancel'].forEach(n=>cv.addEventListener"), c2 = c + u;
    assert.ok(c2.includes("e.pointerType=='mouse'&&e.button===0") && u.includes("$('md').style.display!='flex'") && u.includes('punch()'), 'left mouse click on the canvas punches, not while a dialog is open');
    assert.ok(html.includes('#dock{gap:4px') && html.includes('@media (max-width:430px){.dk{min-width:46px'), 'dock fits narrow phones with the extra button');
  });
  await test('BGM: slider in Settings, saved locally, one Audio instance, volume clamped', async () => {
    assert.ok(html.includes('id="vl" min="0" max="100"') && html.includes('oninput="cfgVol(this.value)"'));
    assert.strictEqual((html.match(/new Audio\(/g) || []).length, 1, 'only one Audio constructor call');
    let made = 0, saved = '', tm = 0;
    class A { constructor() { made++; this.volume = 1; this.addEventListener = () => {}; } }
    const ctx = { Audio: A, CFG: { vol: 0.3 }, cfgSave: () => { saved = JSON.stringify(ctx.CFG); }, $: () => null, bgmBad: 0, Math, Number };
    vm.createContext(ctx);
    vm.runInContext(line('let BGM=null;') + '\n' + line('const bgmVol=') + '\n' + line('function bgmEl(') + '\n' + line('let bgmBad=0;') + '\n' + line('function cfgVol(') + ';this.bgmEl=bgmEl;this.cfgVol=cfgVol;this.bgmVol=bgmVol;', ctx);
    for (let i = 0; i < 6; i++) ctx.bgmEl(); assert.strictEqual(made, 1, 'repeated calls reuse the same element');
    ctx.cfgVol(55); assert.strictEqual(ctx.CFG.vol, 0.55); assert.strictEqual(JSON.parse(saved).vol, 0.55); assert.strictEqual(ctx.bgmEl().volume, 0.55);
    ctx.cfgVol(999); assert.strictEqual(ctx.CFG.vol, 1); ctx.cfgVol(-4); assert.strictEqual(ctx.CFG.vol, 0); ctx.CFG.vol = 'junk'; assert.strictEqual(ctx.bgmVol(), 0.3);
    assert.ok(html.includes("document.addEventListener('pointerdown',()=>{if(CFG.music&&started&&(!BGM||BGM.paused))bgmSync()},true)"), 'autoplay is retried on the first user gesture');
    assert.ok(line('function bgmSync(').includes('p.catch(()=>{})'), 'a blocked play() is swallowed, never thrown');
  });
  await test('8 PM closing: customers removed, spawning/selling stopped by the game clock, next day reopens', async () => {
    let rendered = 0, cleared = 0;
    const ctx = { S: { clk: 1199 }, cu: { ph: 'wait' }, lv: [{}, {}], tm: 7, renderOrder: () => { rendered++; }, clearTimeout: () => { cleared++; }, window: {}, Math };
    vm.createContext(ctx);
    vm.runInContext(line('const closed=') + '\n' + line('function closeShop(') + ';this.closeShop=closeShop;this.closed=closed;', ctx);
    assert.strictEqual(ctx.closed(), false); ctx.S.clk = 1200; assert.strictEqual(ctx.closed(), true);
    ctx.closeShop(); vm.runInContext('cu===null&&lv.length===0', ctx) || assert.fail('customers must be gone'); assert.ok(cleared >= 1 && rendered >= 1);
    let timers = 0; const c2 = { S: { clk: 1200, ev: null }, cu: null, paused: false, tm: 0, clearTimeout() {}, setTimeout() { timers++; return 1; }, newCust() {}, Math, upLv: () => 0, closed: null };
    c2.closed = () => c2.S.clk >= 1200; vm.createContext(c2); vm.runInContext(line('function spawn('), c2); vm.runInContext('spawn()', c2); assert.strictEqual(timers, 0, 'no spawning while closed');
    c2.S.clk = 360; vm.runInContext('spawn()', c2); assert.strictEqual(timers, 1, 'next day (06:00): spawning resumes');
    const sellFn = line('function sell(auto)'); assert.ok(sellFn.includes("if(closed()&&!window.ADMVIP){toast('🔒"), 'purchases rejected while closed');
    assert.ok(line('function newCust(').includes('closed()&&!window.ADMVIP'), 'newCust refuses while closed');
    assert.ok(html.includes('if(closed()&&!window.ADMVIP&&(cu||lv.length))closeShop()'), 'customers removed every frame while closed (covers sync/reload)');
    assert.ok(html.includes("S.clk=360;S.ev=Math.random()") , 'endDay resets the in-game clock to 06:00');
    assert.ok(!/Date\.now\(\)[^;]{0,40}1200|new Date\(\)\.get(Hours|Minutes)/.test(line('const closed=') + line('function upd(')), 'closing uses the game clock, not real-world time');
  });
  await test('client wiring: server-only actions, tx hooks, mission hooks, shared keys, dock button', async () => {
    ['buy_gun', 'buy_upgrade', 'claim_mission'].forEach(a => assert.ok(html.includes("'" + a + "'") || html.includes('action:\'' + a + '\'')));
    assert.ok(html.includes("post('/api/action'") && html.includes('shared:shared?1:0'));
    ["W('sell'", "W('trade'", "W('buyLand'", "W('hireEmp'", "W('hireClerk'", "W('pickOpt'", "W('giveBeg'"].forEach(x => assert.ok(html.includes(x), x));
    assert.ok((html.match(/rec\(-300,'wage'\)/g) || []).length === 2);
    assert.ok(/const SHK=\[[^\]]*'up','ms','tx','rn'\]/.test(html), 'upgrades, missions, history and rain are shared in rooms');
    assert.ok(html.includes('onclick="hubOpen()"'));
    assert.ok(!/localStorage\.setItem\('ppss'[^\n]*up:/.test(html));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('Failed: ' + failures.join(' | ')); process.exit(1); }
})();
