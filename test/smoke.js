'use strict';
// Smoke test: spawns the server on a temp dir and drives it with real websocket clients.
const { spawn } = require('child_process'), WebSocket = require('ws'), http = require('http'), crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path');
const PORT = 18000 + Math.floor(Math.random() * 1000), SECRET = 'test-secret', DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-'));
let fails = 0, passes = 0;
const ok = (c, m) => { if (c) { passes++; console.log('  ok  ' + m); } else { fails++; console.log('  FAIL ' + m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hmac = d => crypto.createHmac('sha256', SECRET).update(d).digest('hex');
function client(url) {
  const ws = new WebSocket(url), c = { ws, log: [], waiters: [] };
  ws.on('message', d => { const m = JSON.parse(d); c.log.push(m); c.waiters = c.waiters.filter(w => { if (w.f(m)) { w.r(m); return false; } return true; }); });
  c.open = new Promise(r => ws.on('open', r));
  c.send = o => ws.send(JSON.stringify(o));
  c.wait = (f, ms = 2000) => { const hit = c.log.find(f); if (hit) return Promise.resolve(hit); return new Promise((res, rej) => { const w = { f, r: res }; c.waiters.push(w); setTimeout(() => { c.waiters = c.waiters.filter(x => x !== w); rej(new Error('timeout')); }, ms); }); };
  c.last = t => [...c.log].reverse().find(m => m.t === t);
  c.clear = () => { c.log.length = 0; };
  return c;
}
async function login(url, name, extra) { const c = client(url); await c.open; c.send({ t: 'hello', name, hero: 'starr', pal: {}, ...extra }); c.w = await c.wait(m => m.t === 'welcome' || m.t === 'denied'); return c; }
function get(p, headers, raw) { return new Promise(res => { http.get({ port: PORT, path: p, headers: headers || {} }, rs => { const ch = []; rs.on('data', d => ch.push(d)); rs.on('end', () => { const b = Buffer.concat(ch); res({ code: rs.statusCode, type: rs.headers['content-type'], buf: b, j: raw ? null : (() => { try { return JSON.parse(b.toString() || '{}'); } catch (e) { return {}; } })() }); }); }); }); }
function postJ(p, o, headers) { return new Promise(res => { const r = http.request({ port: PORT, path: p, method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) } }, rs => { let b = ''; rs.on('data', d => b += d); rs.on('end', () => res({ code: rs.statusCode, j: JSON.parse(b || '{}') })); }); r.end(JSON.stringify(o)); }); }
function startServer(extra) { const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DIR, WIX_SHARED_SECRET: SECRET, DEV_GRANT: '1', COOL_SCALE: '0', LB_TTL: '0', ...(extra || {}) }, stdio: ['ignore', 'pipe', 'inherit'] }); return new Promise(r => srv.stdout.on('data', d => { if (/on :/.test(d)) r(srv); })); }
const SHOT = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]).toString('base64');
function post(p, body, sig) { return new Promise(res => { const r = http.request({ port: PORT, path: p, method: 'POST', headers: { 'x-signature': sig } }, rs => { let b = ''; rs.on('data', d => b += d); rs.on('end', () => res({ code: rs.statusCode, j: JSON.parse(b || '{}') })); }); r.end(body); }); }

(async () => {
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DIR, WIX_SHARED_SECRET: SECRET, DEV_GRANT: '1', COOL_SCALE: '0', LB_TTL: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => srv.stdout.on('data', d => { if (/on :/.test(d)) r(); }));
  const URL = 'ws://localhost:' + PORT;
  try {
    console.log('auth');
    const a = await login(URL, 'Alice'), b = await login(URL, 'Bobby');
    ok(a.w.t === 'welcome' && a.w.token, 'new player gets welcome + token');
    const dup = await login(URL, 'alice'); ok(dup.w.t === 'denied', 'duplicate name (case-insensitive) is denied');
    const bad = await login(URL, 'x'); ok(bad.w.t === 'denied', 'too-short name is denied');
    const bad2 = await login(URL, 'fuckyou'); ok(bad2.w.t === 'denied', 'profane name denied');
    a.ws.close(); await sleep(150);
    const a2 = await login(URL, '', { token: a.w.token }); ok(a2.w.t === 'welcome' && a2.w.id === a.w.id, 'token login restores same player');
    const kick = await login(URL, '', { token: a.w.token }); ok(!!a2.last('kicked') && kick.w.id === a.w.id, 'second login kicks first');
    a2.ws.close(); const A = kick;

    console.log('hub rooms + positions + chat');
    A.send({ t: 'join', scene: 'hub' }); b.send({ t: 'join', scene: 'hub' });
    const ra = await A.wait(m => m.t === 'room'); await b.wait(m => m.t === 'room');
    ok(ra.scene === 'hub', 'joined hub'); await A.wait(m => m.t === 'join' && m.p.name === 'Bobby');
    ok(true, 'Alice saw Bobby join');
    b.send({ t: 'pos', x: 5, y: 0, z: 7, f: 1.5, s: 4, a: 3 });
    const sn = await A.wait(m => m.t === 'snap' && m.p.some(r => r[0] === b.w.id)); ok(sn.p[0][1] === 5 && sn.p[0][3] === 7, 'position snapshot delivered');
    A.send({ t: 'chat', ch: 'room', text: 'hello <b>world</b> shit' });
    const ch = await b.wait(m => m.t === 'chat' && m.ch === 'room'); ok(ch.text === 'hello bworld/b ****' || ch.text.includes('****'), 'room chat delivered, filtered & sanitized: ' + ch.text);
    await sleep(700); A.send({ t: 'chat', ch: 'whisper', to: 'bobby', text: 'psst' }); const wh = await b.wait(m => m.t === 'chat' && m.ch === 'whisper'); ok(wh.fromName === 'Alice', 'whisper by name');

    console.log('hub sharding (52 clients -> 2 rooms of <=50)');
    const many = []; for (let i = 0; i < 50; i++) { const c = await login(URL, 'Bot' + String(i).padStart(2, '0')); c.send({ t: 'join', scene: 'hub' }); many.push(c); }
    await sleep(400); const rooms = new Set(); for (const c of [A, b, ...many]) { const r = c.last('room'); if (r) rooms.add(r.room); }
    const h = await new Promise(r => http.get({ port: PORT, path: '/health' }, rs => { let s = ''; rs.on('data', d => s += d); rs.on('end', () => r(JSON.parse(s))); }));
    ok(rooms.size === 2, '52 players are spread over 2 hub rooms (' + [...rooms].join(',') + ')'); ok(h.rooms === 2 && h.online === 52, '/health reports 52 online in 2 rooms');
    const counts = {}; for (const c of [A, b, ...many]) { const r = c.last('room'); counts[r.room] = (counts[r.room] || 0) + 1; } ok(Object.values(counts).every(n => n <= 50), 'no room above 50: ' + JSON.stringify(counts));
    for (const c of many) c.ws.close(); await sleep(300);

    console.log('friends');
    A.send({ t: 'friend', op: 'add', id: b.w.id }); const inv = await b.wait(m => m.t === 'invite' && m.kind === 'friend'); ok(inv.fromName === 'Alice', 'friend request arrives');
    b.send({ t: 'friend', op: 'accept', id: A.w.id }); await A.wait(m => m.t === 'friends' && m.list.length === 1); ok(true, 'friendship established both ways');

    console.log('party + ready up');
    const c3 = await login(URL, 'Cathy'); A.send({ t: 'party', op: 'invite', id: b.w.id }); await b.wait(m => m.t === 'invite' && m.kind === 'party');
    b.send({ t: 'party', op: 'accept', id: A.w.id }); const pa = await A.wait(m => m.t === 'party' && m.party && m.party.members.length === 2); ok(pa.party.leader === A.w.id, 'party formed, Alice leads');
    A.send({ t: 'party', op: 'invite', id: c3.w.id }); await c3.wait(m => m.t === 'invite'); c3.send({ t: 'party', op: 'accept', id: A.w.id }); await A.wait(m => m.t === 'party' && m.party && m.party.members.length === 3); ok(true, 'third member joins');
    b.send({ t: 'ready', op: 'start', dest: { type: 'chapter', scene: 'ch1' } }); await sleep(150); ok(!b.last('ready'), 'non-leader cannot start ready check');
    A.clear(); A.send({ t: 'join', scene: 'ch1', inst: 'p:' + pa.party.id + ':ch1' }); const den = await A.wait(m => m.t === 'notice'); ok(/not open/.test(den.text), 'cannot enter a party instance without ready-up');
    A.clear(); A.send({ t: 'ready', op: 'start', dest: { type: 'chapter', scene: 'ch1', name: 'Chapter 1' } });
    await b.wait(m => m.t === 'ready'); await c3.wait(m => m.t === 'ready'); ok(true, 'ready prompt reaches all members');
    b.send({ t: 'ready', op: 'answer', ok: true }); await sleep(100); ok(!A.last('go'), 'no transport until everyone accepts');
    c3.send({ t: 'ready', op: 'answer', ok: true }); const go = await A.wait(m => m.t === 'go'); await b.wait(m => m.t === 'go'); await c3.wait(m => m.t === 'go'); ok(go.inst.startsWith('p:'), 'all accepted → everyone transported: ' + go.inst);
    for (const c of [A, b, c3]) c.send({ t: 'join', scene: 'ch1', inst: go.inst }); const ri = await c3.wait(m => m.t === 'room' && m.scene === 'ch1'); await sleep(200);
    ok(ri.room === go.inst, 'party shares an instance room'); const outsider = await login(URL, 'Dave'); outsider.send({ t: 'join', scene: 'ch1', inst: go.inst }); const od = await outsider.wait(m => m.t === 'notice'); ok(/not open/.test(od.text), 'outsider cannot join party instance');
    console.log('shared enemies (co-op relay)');
    const ids = [A.w.id, b.w.id, c3.w.id], hostId = ri.host; ok(ids.includes(hostId), 'instance room names a host');
    const byId = { [A.w.id]: A, [b.w.id]: b, [c3.w.id]: c3 }, H = byId[hostId], G = [A, b, c3].filter(x => x !== H);
    for (const x of [A, b, c3]) x.clear();
    H.send({ t: 'co', d: { k: 's', e: [[1, 2.5, 0, 3, 0, 40, 0, 'run', 0]] } }); const cg1 = await G[0].wait(m => m.t === 'co'), cg2 = await G[1].wait(m => m.t === 'co');
    ok(cg1.from === hostId && cg2.d.e[0][5] === 40, 'host snapshot reaches every guest, stamped with the host id'); await sleep(80); ok(!H.last('co'), 'sender does not get its own snapshot back');
    G[0].send({ t: 'co', d: { k: 'h', hs: [[1, 25, 0, 0, 0, 0]] }, to: hostId }); const chh = await H.wait(m => m.t === 'co' && m.d.k === 'h'); await sleep(80);
    ok(chh.from === G[0].w.id && chh.d.hs[0][1] === 25 && !G[1].log.some(m => m.t === 'co' && m.d.k === 'h'), 'a guest hit goes to the host only');
    G[0].send({ t: 'co', d: { k: 'h', hs: [] }, to: outsider.w.id }); await sleep(80); ok(!outsider.last('co'), 'co cannot be aimed at someone outside the room');
    G[1].send({ t: 'fx', p: [1, 0, 2], b: [['d', 3, 2, 1, 1]] }); const cfx1 = await H.wait(m => m.t === 'fx'); await G[0].wait(m => m.t === 'fx'); ok(cfx1.from === G[1].w.id && cfx1.b[0][0] === 'd', 'effects / prop smashes relay to the room');
    const png = await (async () => { A.send({ t: 'ping', ts: 5 }); return A.wait(m => m.t === 'pong'); })(); ok(png.ts === 5 && png.now > 0, 'pong carries server time');
    for (const x of G) x.clear(); H.send({ t: 'join', scene: 'hub' }); const cho = await G[0].wait(m => m.t === 'host'); await G[1].wait(m => m.t === 'host');
    ok(cho.id !== hostId && G.some(x => x.w.id === cho.id), 'host leaving hands the enemies to a teammate');
    H.send({ t: 'join', scene: 'ch1', inst: go.inst }); const cback = await H.wait(m => m.t === 'room' && m.room === go.inst); ok(cback.host === cho.id, 'returning player rejoins as a guest of the new host');
    A.send({ t: 'ready', op: 'start', dest: { type: 'chapter', scene: 'ch2' } }); await b.wait(m => m.t === 'ready' && m.dest.scene === 'ch2'); b.send({ t: 'ready', op: 'answer', ok: false }); const re = await A.wait(m => m.t === 'ready_end'); ok(re.reason === 'declined', 'one decline cancels the ready-up');
    c3.send({ t: 'party', op: 'leave' }); await sleep(100); b.send({ t: 'party', op: 'invite', id: outsider.w.id }); await outsider.wait(m => m.t === 'invite'); ok(true, 'leader-less invite flow ok');
    outsider.send({ t: 'party', op: 'accept', id: b.w.id }); await sleep(100);

    console.log('stars + guild');
    A.send({ t: 'stars', d: 300, why: 'kills' }); const st = await A.wait(m => m.t === 'stars' && m.bal === 300); ok(st.bal === 300, 'earning credits the server balance');
    A.send({ t: 'stars', d: 100000, why: 'cheat' }); await sleep(200); ok(A.last('stars').bal <= 300 + 400, 'huge earn is rate-capped (' + A.last('stars').bal + ')');
    A.send({ t: 'stars', d: -5000, why: 'x' }); await A.wait(m => m.t === 'stars' && m.why === 'denied'); ok(true, 'spending more than balance is denied');
    A.send({ t: 'guild', op: 'create', name: 'Iron Wolves', tag: 'IRON', icon: 2 }); const gn = await A.wait(m => m.t === 'notice' && /costs/.test(m.text)); ok(true, 'guild creation refused without enough stars');
    A.send({ t: 'devgrant', n: 2000 }); await sleep(150); A.clear(); A.send({ t: 'guild', op: 'create', name: 'Iron Wolves', tag: 'IRON', icon: 2, tagline: 'We bite' });
    const gg = await A.wait(m => m.t === 'guild' && m.guild); ok(gg.guild.name === 'Iron Wolves' && gg.guild.level === 1 && gg.guild.cap === 10, 'guild founded (lvl 1, cap 10)'); const bal = A.last('stars'); ok(bal && bal.bal >= 1000, 'guild cost 1000 deducted (balance ' + (bal && bal.bal) + ')');
    A.send({ t: 'guild', op: 'invite', id: b.w.id }); await b.wait(m => m.t === 'invite' && m.kind === 'guild'); b.send({ t: 'guild', op: 'accept', guild: gg.guild.id }); const gj = await b.wait(m => m.t === 'guild' && m.guild); ok(gj.guild.members.length === 2, 'invited player joined');
    await sleep(700); A.send({ t: 'chat', ch: 'guild', text: 'wolves unite' }); const gc = await b.wait(m => m.t === 'chat' && m.ch === 'guild' && !m.sys); ok(gc.text === 'wolves unite', 'guild chat');
    b.send({ t: 'guild', op: 'edit', tagline: 'hax' }); await sleep(100); A.send({ t: 'guild', op: 'info' }); const gi = await A.wait(m => m.t === 'guild' && m.guild && m.guild.tagline); ok(gi.guild.tagline === 'We bite', 'members cannot edit guild');
    A.send({ t: 'guild', op: 'rank', id: b.w.id, rank: 'officer' }); await sleep(100); A.send({ t: 'guild', op: 'list' }); const gl = await A.wait(m => m.t === 'guilds'); ok(gl.rows.length === 1, 'guild list');

    console.log('quests + stats + leaderboard');
    ok(A.w.quests.list.length === 3, 'three daily quests'); const q0 = A.w.quests.list[0];
    A.send({ t: 'ev', k: q0.ev === 'play' ? 'kill' : q0.ev, n: 100 }); await sleep(200);
    A.send({ t: 'stat', levels: { starr: 7, akira: 3 }, kills: 150, chapters: 2 }); await sleep(100);
    A.send({ t: 'lb', cat: 'power' }); const lb = await A.wait(m => m.t === 'lb'); ok(lb.rows[0] && lb.rows[0].name === 'Alice' && lb.rows[0].score === 10, 'power leaderboard shows Alice (score 10) with hero for pedestal');
    A.send({ t: 'lb', cat: 'guild' }); const lg = await A.wait(m => m.t === 'lb' && m.cat === 'guild'); ok(lg.rows[0].name === 'Iron Wolves', 'guild leaderboard');
    A.send({ t: 'profile', id: b.w.id }); const pf = await A.wait(m => m.t === 'profile'); ok(pf.p.name === 'Bobby' && pf.p.friend && pf.p.guild && pf.p.guild.tag === 'IRON', 'profile payload has friend + guild');
    A.send({ t: 'stat', levels: { starr: 7, akira: 3 }, pres: { starr: 2, akira: 99 } }); await sleep(100);
    A.send({ t: 'lb', cat: 'power' }); const lp = await A.wait(m => m.t === 'lb' && m.cat === 'power' && m.rows[0] && m.rows[0].score > 10); ok(lp.rows[0].score === 10 + 30 * (2 + 25), 'prestige counts toward power (and is capped at 25) got ' + lp.rows[0].score);
    A.send({ t: 'appear', hero: 'starr', pal: {}, pr: 7 }); await sleep(120); b.send({ t: 'profile', id: A.w.id }); const pp = await b.wait(m => m.t === 'profile' && m.p.id === A.w.id); ok(pp.p.pres && pp.p.pres.starr === 7, 'appear updates the prestige shown to others');
    for (const hk of ['rhoka', 'isolde', 'cassian', 'maeve', 'rook', 'elara']) { A.send({ t: 'appear', hero: hk, pal: {} }); await sleep(60); } b.send({ t: 'profile', id: A.w.id }); const pnh = await b.wait(m => m.t === 'profile' && m.p.id === A.w.id && m.p.hero === 'elara'); ok(pnh.p.hero === 'elara', 'the six new champions are accepted by the server');
    A.send({ t: 'appear', hero: 'nobody', pal: {} }); await sleep(80); b.clear(); b.send({ t: 'profile', id: A.w.id }); const pn = await b.wait(m => m.t === 'profile' && m.p.id === A.w.id); ok(pn.p.hero === 'elara', 'unknown champion keys are still refused');
    A.send({ t: 'appear', hero: 'starr', pal: {} }); await sleep(60);

    console.log('hub publish');
    A.send({ t: 'hubpub', public: true, scenes: [{ id: 'mine-1', objs: [] }] }); await A.wait(m => m.t === 'hubpub'); b.send({ t: 'hubget', id: A.w.id }); const hd = await b.wait(m => m.t === 'hubdata'); ok(hd.scenes && hd.scenes.length === 1, 'public hub downloadable by others');
    b.send({ t: 'join', scene: 'mine-1', inst: 'h:' + A.w.id + ':mine-1' }); const hv = await b.wait(m => m.t === 'room' && m.room === 'h:' + A.w.id + ':mine-1'); ok(!!hv, 'visitor enters public hub room');

    console.log('wix credit webhook');
    const body = JSON.stringify({ memberId: 'wix-123', orderId: 'ord-1', stars: 500, sku: 'pack500' });
    ok((await post('/wix/credit', body, 'bad')).code === 401, 'bad signature rejected');
    const r1 = await post('/wix/credit', body, hmac(body)); ok(r1.j.ok && !r1.j.credited, 'valid credit for unlinked member is held pending');
    ok((await post('/wix/credit', body, hmac(body))).j.duplicate === true, 'same orderId is idempotent');
    const ts = Date.now(), wsig = hmac('wix-123|' + ts); const w = await login(URL, 'WixGuy', { wix: { id: 'wix-123', ts, sig: wsig } }); ok(w.w.stars === 500 && w.w.wix, 'linking the Wix member releases the pending 500 ★');
    const body2 = JSON.stringify({ memberId: 'wix-123', orderId: 'ord-2', stars: 100 }); const r2 = await post('/wix/credit', body2, hmac(body2)); const lst = await w.wait(m => m.t === 'stars' && m.bal === 600); ok(r2.j.credited && lst.bal === 600, 'credit for a linked, online member is pushed live');
    const forged = await login(URL, 'Forger', { wix: { id: 'wix-123', ts, sig: 'deadbeef' } }); ok(forged.w.t === 'welcome' && !forged.w.wix, 'forged Wix signature does not take over the account');

    console.log('accounts across devices');
    const pa1 = await login(URL, 'Paula'); ok(pa1.w.t === 'welcome' && pa1.w.hasPw === false, 'new account has no password yet');
    pa1.send({ t: 'setpw', pw: '123' }); const pws = await pa1.wait(m => m.t === 'pwset'); ok(!pws.ok, 'too-short password refused');
    pa1.clear(); pa1.send({ t: 'setpw', pw: 'sunflower9' }); const pwo = await pa1.wait(m => m.t === 'pwset'); ok(pwo.ok, 'password set');
    const tk = await login(URL, 'paula'); ok(tk.w.t === 'denied' && tk.w.code === 'taken' && tk.w.hasPw, 'name taken → asks for its password');
    const wr = await login(URL, 'Paula', { pw: 'wrong-one' }); ok(wr.w.t === 'denied' && wr.w.code === 'badpw', 'wrong password denied');
    const ph = await login(URL, 'PAULA', { pw: 'sunflower9' }); ok(ph.w.t === 'welcome' && ph.w.id === pa1.w.id && ph.w.token && ph.w.token !== pa1.w.token, 'name + password signs in on a second device (own token)');
    const pd = await login(URL, '', { token: pa1.w.token }); ok(pd.w.t === 'welcome' && pd.w.id === pa1.w.id, 'first device token still works');
    const pd2 = await login(URL, '', { token: ph.w.token }); ok(pd2.w.t === 'welcome' && pd2.w.id === pa1.w.id, 'second device token works too');
    for (let i = 0; i < 6; i++) await login(URL, 'Paula', { pw: 'nope' + i }); const thr = await login(URL, 'Paula', { pw: 'sunflower9' }); ok(thr.w.code === 'slow', 'repeated wrong passwords are throttled');
    const nk = await login(URL, '', { token: 'ab'.repeat(24), recover: true }); ok(nk.w.t === 'denied' && nk.w.code === 'nokey', 'unknown recovery key is refused (no ghost account)');
    const np = await login(URL, 'Quinn', { newpw: 'quinnpass' }); ok(np.w.hasPw, 'password can be chosen when creating the account');

    console.log('cloud save');
    pd2.clear(); pd2.send({ t: 'save', blob: { nca_prog_v1: '{"PROG":{"_hero":{"starr":{"lv":12,"pr":1}}}}' } }); const sv1 = await pd2.wait(m => m.t === 'saved'); ok(sv1.at > 0, 'save acknowledged');
    pd2.send({ t: 'loadsave' }); const ld = await pd2.wait(m => m.t === 'savedata'); ok(ld.save && /"lv":12/.test(ld.save.blob.nca_prog_v1), 'save loads back');
    pd2.send({ t: 'save', blob: null }); const sv0 = await pd2.wait(m => m.t === 'saved' && m.ok === false); ok(sv0.why === 'empty', 'empty save rejected with a reason (not silently)');

    console.log('hub atlas');
    const scenes = [{ id: 'mine-1', name: 'Bone Garden', desc: 'Mind the spikes', theme: 'crypt', w: 60, d: 60, objs: [{ k: 'spawner', d: { kind: 'brute', count: 3 } }, { k: 'parasite' }, { k: 'bossSpawn', d: { kind: 'maw' } }, { k: 'tree' }],
      quest: { title: 'The Garden', steps: [{ type: 'kill', text: 'Clear the brutes' }, { type: 'boss', text: 'Slay the Maw' }] } }, { id: 'mine-2', name: 'Vault', objs: [] }];
    pd2.clear(); pd2.send({ t: 'hubpub', public: true, scenes, shot: SHOT }); const hp = await pd2.wait(m => m.t === 'hubpub');
    ok(hp.entry && hp.entry.title === 'Bone Garden' && hp.entry.meta.mon.brute === 3 && hp.entry.meta.mon.parasite === 1 && hp.entry.meta.boss.maw === 1 && !hp.entry.meta.mon.tree, 'publish computes monsters/bosses from the scenes');
    ok(hp.entry.meta.quests === 1 && hp.entry.meta.obj[0].steps.length === 2 && hp.entry.meta.scenes === 2, 'publish lists objectives and scene count');
    b.clear(); b.send({ t: 'atlas', op: 'list' }); const al = await b.wait(m => m.t === 'atlas' && m.op === 'list'); const row = al.rows.find(r => r.id === pa1.w.id); ok(row && row.shot > 0 && row.plays === 0 && row.likes === 0, 'Atlas lists the hub with a preview shot');
    b.send({ t: 'hubget', id: pa1.w.id }); await b.wait(m => m.t === 'hubdata' && m.id === pa1.w.id); b.clear(); b.send({ t: 'hubget', id: pa1.w.id }); await b.wait(m => m.t === 'hubdata' && m.id === pa1.w.id);
    b.send({ t: 'atlas', op: 'get', id: pa1.w.id }); const g1 = await b.wait(m => m.t === 'atlas' && m.op === 'entry'); ok(g1.row.plays === 1, 'a visit counts one play (repeat visits within 20 min do not)');
    pd2.clear(); pd2.send({ t: 'hubget', id: pa1.w.id }); await pd2.wait(m => m.t === 'hubdata'); pd2.send({ t: 'atlas', op: 'mine' }); const mine = await pd2.wait(m => m.t === 'atlas' && m.op === 'mine'); ok(mine.row.plays === 1 && mine.row.mine, 'owner visiting their own hub adds no play');
    b.clear(); b.send({ t: 'atlas', op: 'like', id: pa1.w.id, on: true }); const lk = await b.wait(m => m.t === 'atlas' && m.op === 'entry'); ok(lk.row.likes === 1 && lk.row.liked, 'like');
    b.clear(); b.send({ t: 'atlas', op: 'like', id: pa1.w.id, on: true }); const lk2 = await b.wait(m => m.t === 'atlas' && m.op === 'entry'); ok(lk2.row.likes === 1, 'liking twice still counts once');
    pd2.clear(); pd2.send({ t: 'atlas', op: 'like', id: pa1.w.id, on: true }); const own = await pd2.wait(m => m.t === 'notice'); ok(/own hub/.test(own.text), 'cannot like your own hub');
    b.clear(); b.send({ t: 'atlas', op: 'done', id: pa1.w.id, sec: 245 }); const dn = await b.wait(m => m.t === 'atlas' && m.op === 'entry'); ok(dn.row.done === 1 && dn.row.best.sec === 245 && dn.row.best.name === 'Bobby' && dn.cleared, 'completion counted with best clear time');
    b.clear(); b.send({ t: 'atlas', op: 'done', id: pa1.w.id, sec: 100 }); const dn2 = await b.wait(m => m.t === 'atlas' && m.op === 'entry'); ok(dn2.row.done === 1 && !dn2.cleared, 'same player clearing again soon is not double-counted');
    const hl = await get('/atlas?sort=liked'); ok(hl.code === 200 && hl.j.rows.some(r => r.id === pa1.w.id && r.likes === 1), 'HTTP Atlas list (campaign mode)');
    const im = await get('/atlas/shot/' + pa1.w.id + '.jpg', {}, true); ok(im.code === 200 && /image\/jpeg/.test(im.type) && im.buf[0] === 0xff && im.buf[1] === 0xd8, 'preview shot served as a JPEG');
    const hh = await get('/atlas/hub/' + pa1.w.id); ok(hh.code === 200 && hh.j.scenes.length === 2, 'HTTP hub download (campaign play)');
    const he = await get('/atlas/entry/' + pa1.w.id); ok(he.j.row.plays === 2, 'anonymous campaign play counted');
    const hd2 = await postJ('/atlas/done/' + pa1.w.id, { sec: 90, name: 'Camper' }); ok(hd2.j.row.done === 2 && hd2.j.row.best.sec === 90 && hd2.j.row.best.name === 'Camper', 'campaign completion counted, new best time');
    ok((await postJ('/atlas/like/' + pa1.w.id, { on: true })).code === 401, 'campaign like without an account is refused');
    const tl = await postJ('/atlas/like/' + pa1.w.id, { on: true }, { 'x-token': a.w.token }); ok(tl.j.row.likes === 2 && tl.j.row.liked, 'campaign like with the multiplayer token');
    pd2.clear(); pd2.send({ t: 'hubvis', public: false }); await pd2.wait(m => m.t === 'hubpub' && m.vis); const hidden = await get('/atlas'); ok(!hidden.j.rows.some(r => r.id === pa1.w.id) && (await get('/atlas/hub/' + pa1.w.id)).code === 404, 'unlisting hides the hub from the Atlas');
    pd2.send({ t: 'hubvis', public: true }); await sleep(100);
    const h1 = await get('/health'); ok(h1.j.persistent === true && h1.j.hubs >= 1, '/health reports persistence + hub count');

    console.log('persistence');
    srv.kill('SIGTERM'); await sleep(500);
    const saved = JSON.parse(fs.readFileSync(path.join(DIR, 'players.json'), 'utf8')); ok(Object.values(saved).some(p => p.name === 'Alice' && p.kills >= 150) && Object.values(saved).some(p => p.wix === 'wix-123' && p.stars === 600), 'players.json written on shutdown');
    ok(!JSON.stringify(saved).includes('nca_prog_v1') && fs.existsSync(path.join(DIR, 'saves', pa1.w.id + '.json')) && fs.existsSync(path.join(DIR, 'hubs', pa1.w.id + '.jpg')), 'saves / hubs / shots live in their own files, players.json stays small');
    const srv2 = await startServer({ COOL_SCALE: '1' });
    try {
      const back = await login(URL, 'Paula', { pw: 'sunflower9' }); ok(back.w.t === 'welcome' && back.w.hasSave && back.w.hasPw, 'after a restart: account, password and save are still there');
      back.send({ t: 'loadsave' }); const ls2 = await back.wait(m => m.t === 'savedata'); ok(ls2.save && /"lv":12/.test(ls2.save.blob.nca_prog_v1), 'after a restart: the cloud save restores');
      const ar = await get('/atlas'); const r2 = ar.j.rows.find(r => r.id === pa1.w.id); ok(r2 && r2.done === 2 && r2.likes === 2 && r2.plays === 2, 'after a restart: Atlas stats kept');
      back.clear(); for (let i = 1; i <= 3; i++) back.send({ t: 'save', blob: { nca_prog_v1: '{"burst":' + i + '}' } });
      await back.wait(m => m.t === 'saved'); await sleep(1300); const acks = back.log.filter(m => m.t === 'saved').length; back.send({ t: 'loadsave' }); const lb3 = await back.wait(m => m.t === 'savedata');
      ok(acks === 2 && lb3.save.blob.nca_prog_v1 === '{"burst":3}', 'a burst of saves is coalesced, the newest is kept (not dropped)');
      back.send({ t: 'save', blob: { nca_prog_v1: '{"burst":4}' } }); back.send({ t: 'save', blob: { nca_prog_v1: '{"last":"on-close"}' } }); back.ws.close(); await sleep(300);
      const again = await login(URL, 'Paula', { pw: 'sunflower9' }); again.send({ t: 'loadsave' }); const lc = await again.wait(m => m.t === 'savedata'); ok(lc.save.blob.nca_prog_v1 === '{"last":"on-close"}', 'the save sent while closing the tab is written, not lost');
      ok(fs.existsSync(path.join(DIR, 'saves', pa1.w.id + '.prev.json')), 'previous save version kept as a rollback copy');
    } finally { srv2.kill('SIGTERM'); await sleep(400); }
  } catch (e) { fails++; console.log('  FAIL exception: ' + e.stack); }
  try { srv.kill(); } catch (e) { }
  console.log(`\n${passes} passed, ${fails} failed`); process.exit(fails ? 1 : 0);
})();
