/* ============ Neon Codex Massive · multiplayer server ============
   One Node process: HTTP (health + Wix webhook) and WebSocket (game).  Persistence = two JSON files in DATA_DIR (mount a Railway volume there).
   Env:  PORT (Railway sets it) · DATA_DIR (default ./data) · WIX_SHARED_SECRET (HMAC secret shared with your Wix backend) ·
         ALLOWED_ORIGINS (comma list, e.g. https://you.github.io,https://www.yoursite.com – empty = allow all) · DEV_GRANT=1 (lets clients ask for test stars)
   See README.md for the protocol and deployment steps. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SECRET = process.env.WIX_SHARED_SECRET || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const DEV_GRANT = process.env.DEV_GRANT === '1';
const HUB_CAP = 50, PARTY_MAX = 8, GUILD_COST = 1000, GUILD_MAX = 50;
const TICK_MS = 100, EARN_PER_MIN = 400;
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------------------------------------------------------- persistence */
const F_PLAYERS = path.join(DATA_DIR, 'players.json'), F_GUILDS = path.join(DATA_DIR, 'guilds.json'), F_MISC = path.join(DATA_DIR, 'misc.json');
function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
const players = new Map(Object.entries(readJSON(F_PLAYERS, {})));
const guilds = new Map(Object.entries(readJSON(F_GUILDS, {})));
const misc = readJSON(F_MISC, { orders: {}, pending: {}, seq: 1 });
let dirty = false, saveT = null;
function markDirty() { dirty = true; if (!saveT) saveT = setTimeout(flush, 1500); }
function writeAtomic(f, obj) { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, f); }
function flush() { saveT = null; if (!dirty) return; dirty = false; try { writeAtomic(F_PLAYERS, Object.fromEntries(players)); writeAtomic(F_GUILDS, Object.fromEntries(guilds)); writeAtomic(F_MISC, misc); } catch (e) { console.error('save failed', e.message); dirty = true; } }
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { dirty = true; flush(); process.exit(0); });

/* ---------------------------------------------------------------- helpers */
const now = () => Date.now();
const rid = n => crypto.randomBytes(n).toString('hex');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d = 0) => (typeof v === 'number' && isFinite(v)) ? v : d;
const q2 = v => Math.round(v * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const weekKey = () => { const d = new Date(), j = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return d.getUTCFullYear() + 'w' + Math.floor(((d - j) / 864e5 + j.getUTCDay()) / 7); };
const BAD = /(fuck|shit|bitch|cunt|nigg|fag|rape|nazi|hitler)/i;
const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const maskBad = s => s.replace(new RegExp(BAD.source, 'gi'), m => '*'.repeat(m.length));
const validName = s => /^[A-Za-z0-9 _\-]{3,16}$/.test(s) && !BAD.test(s) && !/^\s|\s$/.test(s);
function hmac(data) { return crypto.createHmac('sha256', SECRET).update(data).digest('hex'); }
function safeEq(a, b) { try { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); } catch (e) { return false; } }
function seeded(seed) { let h = 1779033703 ^ seed.length; for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; } return () => { h = Math.imul(h ^ h >>> 16, 2246822507); h = Math.imul(h ^ h >>> 13, 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; }; }

/* ---------------------------------------------------------------- game data */
const HEROES = ['starr', 'aurealius', 'willow', 'akira', 'talos', 'dante', 'seraphine', 'vesper', 'brigid', 'fenn', 'leander', 'nyx', 'moros', 'alita'];
const GUILD_ICONS = ['⚔', '🛡', '🏹', '🔥', '❄', '⚡', '🌿', '💀', '👑', '🐉', '🌙', '☀', '🦅', '🐺', '💎', '🔱'];
const G_LV = [0, 120, 480, 1200, 2700, 5400, 9600, 15600, 24000, 36000]; // total member playtime (minutes) needed for level 1..10
const guildLevel = g => { let l = 1; for (let i = 1; i < G_LV.length; i++) if (g.play >= G_LV[i]) l = i + 1; return l; };
const guildCap = l => Math.min(GUILD_MAX, 10 + 5 * (l - 1));
const guildPerks = l => ({ xp: +(0.02 * l).toFixed(3), star: +Math.min(0.1, 0.01 * l).toFixed(3), hp: +(0.01 * l).toFixed(3), pm: +(0.005 * l).toFixed(3), cap: guildCap(l) });
const QT = [
  { id: 'kill', ev: 'kill', n: [25, 40, 60], r: [20, 30, 45], t: n => `Defeat ${n} enemies` },
  { id: 'chapter', ev: 'chapter', n: [1], r: [50], t: () => 'Complete a story chapter' },
  { id: 'boss', ev: 'boss', n: [1], r: [40], t: () => 'Defeat a chapter boss' },
  { id: 'play', ev: 'play', n: [15, 30], r: [25, 50], t: n => `Spend ${n} minutes in the arena` },
  { id: 'build', ev: 'place', n: [10, 25], r: [15, 30], t: n => `Place ${n} models in your dungeon` },
  { id: 'party', ev: 'pchapter', n: [1], r: [60], t: () => 'Complete a chapter with a party' },];
const GQT = (L, size) => [
  { id: 'kill', ev: 'kill', goal: 300 + 60 * L + 10 * size, t: 'Defeat enemies together' },
  { id: 'chapter', ev: 'chapter', goal: 3 + L, t: 'Complete chapters' },
  { id: 'play', ev: 'play', goal: 240 + 60 * L, t: 'Minutes played together' }];

/* ---------------------------------------------------------------- state */
const online = new Map();          // pid -> conn
const rooms = new Map();           // roomId -> {id, scene, cap, members:Set<pid>}
const parties = new Map();         // partyId -> {id, leader, members:[pid], ready:null, allowed:Set<roomKey>}
const names = new Map(); for (const p of players.values()) names.set(p.name.toLowerCase(), p.id);

function send(c, o) { if (c && c.ws && c.ws.readyState === 1) { try { c.ws.send(JSON.stringify(o)); } catch (e) { } } }
function sendId(id, o) { send(online.get(id), o); }
function sendRoom(room, o, except) { if (!room) return; const s = JSON.stringify(o); for (const id of room.members) { if (id === except) continue; const c = online.get(id); if (c && c.ws.readyState === 1) try { c.ws.send(s); } catch (e) { } } }

function newPlayer(name) {
  const id = 'p' + (misc.seq++).toString(36) + rid(2);
  const p = { id, name, created: now(), hero: 'starr', pal: {}, pres: {}, stars: 0, earned: 0, levels: {}, kills: 0, chapters: 0, bosses: 0, play: 0, friends: [], frIn: [], guild: null, gInv: [], q: null, hub: { public: false, scenes: null, updated: 0 }, save: null, lastSeen: now() };
  players.set(id, p); names.set(name.toLowerCase(), id); markDirty(); return p;
}
const power = p => Object.values(p.levels || {}).reduce((a, b) => a + b, 0) + 30 * Object.values(p.pres || {}).reduce((a, b) => a + b, 0);
function setPres(p, v) { if (v == null) return; p.pres = p.pres || {}; p.pres[p.hero] = clamp(v | 0, 0, 25); }
function appearance(p) { return { id: p.id, name: p.name, hero: p.hero, pal: p.pal, lv: (p.levels && p.levels[p.hero]) || 1, pr: (p.pres && p.pres[p.hero]) || 0, tag: p.guild && guilds.get(p.guild) ? guilds.get(p.guild).tag : '' }; }
function profileOf(p, viewer) {
  const g = p.guild && guilds.get(p.guild);
  return { id: p.id, name: p.name, hero: p.hero, pal: p.pal, levels: p.levels, pres: p.pres || {}, power: power(p), kills: p.kills, chapters: p.chapters, bosses: p.bosses, play: p.play, online: online.has(p.id), created: p.created,
    guild: g ? { id: g.id, name: g.name, tag: g.tag, icon: g.icon, level: guildLevel(g) } : null, hubPublic: !!(p.hub && p.hub.public && p.hub.scenes), friend: !!(viewer && viewer.friends.includes(p.id)), self: !!(viewer && viewer.id === p.id), party: online.get(p.id) ? !!online.get(p.id).party : false };
}

/* ---------------------------------------------------------------- rooms */
function hubRoom() { for (const r of rooms.values()) if (r.scene === 'hub' && r.kind === 'hub' && r.members.size < HUB_CAP) return r; const r = { id: 'hub#' + (misc.seq++), scene: 'hub', kind: 'hub', cap: HUB_CAP, members: new Set() }; rooms.set(r.id, r); return r; }
function leaveRoom(c) {
  const r = c.room; if (!r) return; r.members.delete(c.id); c.room = null; sendRoom(r, { t: 'leave', id: c.id });
  if (!r.members.size) rooms.delete(r.id);
}
function joinRoom(c, room, scene) {
  if (c.room === room) return; leaveRoom(c); room.members.add(c.id); c.room = room; c.scene = scene;
  const list = []; for (const id of room.members) { const o = online.get(id); if (o && id !== c.id) list.push({ ...appearance(o.p), x: o.x, y: o.y, z: o.z, f: o.f, s: o.s, a: o.a, k: o.k || '', u: o.u || 0 }); }
  send(c, { t: 'room', room: room.id, scene, cap: room.cap, players: list, count: room.members.size });
  sendRoom(room, { t: 'join', p: { ...appearance(c.p), x: c.x, y: c.y, z: c.z, f: c.f, s: c.s, a: c.a } }, c.id);
}
function handleJoin(c, m) {
  const scene = cleanText(m.scene, 24); if (!scene) return;
  if (scene === 'hub' && !m.inst) { if (c.room && c.room.scene === 'hub' && c.room.kind === 'hub') return; return joinRoom(c, hubRoom(), 'hub'); }
  if (m.inst && typeof m.inst === 'string') {
    const key = cleanText(m.inst, 64), pt = c.party && parties.get(c.party);
    if (key.startsWith('p:')) { // party instance: only members of a party whose ready-check approved it
      if (!pt || !pt.allowed.has(key)) return send(c, { t: 'notice', kind: 'bad', text: 'That instance is not open to you.' });
      let r = rooms.get(key); if (!r) { r = { id: key, scene, kind: 'inst', cap: PARTY_MAX, members: new Set() }; rooms.set(key, r); } if (r.members.size >= r.cap && !r.members.has(c.id)) return send(c, { t: 'notice', kind: 'bad', text: 'Instance is full.' });
      return joinRoom(c, r, scene);
    }
    if (key.startsWith('h:')) { // a player hub (room per owner+scene): public ones can be visited; capacity 50
      const ownerId = key.split(':')[1], owner = players.get(ownerId); if (!owner || !(owner.hub.public || owner.id === c.id || (pt && pt.allowed.has('h:' + ownerId)))) return send(c, { t: 'notice', kind: 'bad', text: 'That hub is private.' });
      let r = rooms.get(key); if (!r) { r = { id: key, scene, kind: 'hubvisit', cap: HUB_CAP, members: new Set() }; rooms.set(key, r); } if (r.members.size >= r.cap && !r.members.has(c.id)) return send(c, { t: 'notice', kind: 'bad', text: 'That hub is full.' });
      return joinRoom(c, r, scene);
    }
  }
  leaveRoom(c); c.scene = scene; send(c, { t: 'room', room: null, scene, players: [], count: 1 }); // solo scene: nobody else visible
}

/* ---------------------------------------------------------------- stars / stats / quests */
function pushStars(p, why) { sendId(p.id, { t: 'stars', bal: p.stars, why: why || '' }); }
function addStars(p, d, why, earn) {
  if (!d) return p.stars;
  if (d > 0 && earn) { const c = online.get(p.id); const t = now(); if (c) { c.bucket = Math.min(EARN_PER_MIN, (c.bucket == null ? EARN_PER_MIN : c.bucket) + (t - (c.bt || t)) / 60000 * EARN_PER_MIN); c.bt = t; d = Math.min(d, Math.floor(c.bucket)); c.bucket -= d; } }
  if (d < 0 && p.stars + d < 0) return -1;
  p.stars += d; if (d > 0) p.earned = (p.earned || 0) + d; markDirty(); pushStars(p, why); return p.stars;
}
function ensureQuests(p) {
  const day = today(); if (p.q && p.q.day === day) return p.q;
  const R = seeded(p.id + day), pool = QT.slice(), list = [];
  for (let i = 0; i < 3 && pool.length; i++) { const t = pool.splice(Math.floor(R() * pool.length), 1)[0], k = Math.floor(R() * t.n.length); list.push({ id: t.id, ev: t.ev, goal: t.n[k], reward: t.r[k], have: 0, claimed: false, text: t.t(t.n[k]) }); }
  p.q = { day, list }; markDirty(); return p.q;
}
function questEvent(p, ev, n) {
  const q = ensureQuests(p); let ch = false;
  for (const it of q.list) if (it.ev === ev && it.have < it.goal) { it.have = Math.min(it.goal, it.have + n); ch = true; }
  if (ch) { markDirty(); sendId(p.id, { t: 'quests', q }); }
  const g = p.guild && guilds.get(p.guild); if (g) guildEvent(g, ev, n, p.id);
}
function guildQuests(g) { const w = weekKey(); if (!g.gq || g.gq.week !== w) { g.gq = { week: w, list: GQT(guildLevel(g), Object.keys(g.members).length).map(x => ({ ...x, have: 0 })), claimed: {}, contrib: {} }; markDirty(); } return g.gq; }
function guildEvent(g, ev, n, pid) { const gq = guildQuests(g); let ch = false; for (const it of gq.list) if (it.ev === ev && it.have < it.goal) { it.have = Math.min(it.goal, it.have + n); gq.contrib[pid] = (gq.contrib[pid] || 0) + n; ch = true; } if (ch) { markDirty(); } }

/* ---------------------------------------------------------------- friends / party */
function friendList(p) { return p.friends.map(id => players.get(id)).filter(Boolean).map(f => { const c = online.get(f.id); return { id: f.id, name: f.name, hero: f.hero, online: !!c, scene: c ? c.scene : null }; }); }
function pushFriends(p) { sendId(p.id, { t: 'friends', list: friendList(p), req: p.frIn.map(id => players.get(id)).filter(Boolean).map(f => ({ id: f.id, name: f.name })) }); }
function partyState(pt) { return { id: pt.id, leader: pt.leader, max: PARTY_MAX, members: pt.members.map(id => { const c = online.get(id); const p = players.get(id); return { id, name: p.name, hero: p.hero, lv: (p.levels && p.levels[p.hero]) || 1, online: !!c }; }) }; }
function pushParty(pt) { const s = { t: 'party', party: partyState(pt) }; for (const id of pt.members) sendId(id, s); }
function leaveParty(c, why) {
  const pt = c.party && parties.get(c.party); c.party = null; if (!pt) return; pt.members = pt.members.filter(i => i !== c.id);
  send(c, { t: 'party', party: null, why });
  if (pt.members.length < 2) { for (const id of pt.members) { const o = online.get(id); if (o) o.party = null; sendId(id, { t: 'party', party: null, why: 'disbanded' }); } parties.delete(pt.id); return; }
  if (pt.leader === c.id) pt.leader = pt.members[0];
  if (pt.ready) { pt.ready = null; for (const id of pt.members) sendId(id, { t: 'ready_end', reason: 'member left' }); }
  pushParty(pt);
}
function startReady(c, m) {
  const pt = c.party && parties.get(c.party); if (!pt || pt.leader !== c.id) return send(c, { t: 'notice', kind: 'bad', text: 'Only the party leader can start a Ready Up.' });
  if (pt.ready) return; const d = m.dest || {}; const dest = { type: d.type === 'hub' ? 'hub' : 'chapter', scene: cleanText(d.scene, 24), owner: cleanText(d.owner, 24), name: cleanText(d.name, 40) };
  if (!dest.scene && dest.type === 'chapter') return;
  const ans = {}; for (const id of pt.members) ans[id] = id === c.id ? true : null;
  pt.ready = { dest, ans, exp: now() + 20000 };
  const pack = { t: 'ready', dest, leader: c.id, exp: pt.ready.exp, members: pt.members.map(id => ({ id, name: players.get(id).name, ans: ans[id] })) };
  for (const id of pt.members) sendId(id, pack); checkReady(pt);
}
function checkReady(pt) {
  const r = pt.ready; if (!r) return; const out = { t: 'ready_state', members: pt.members.map(id => ({ id, name: players.get(id).name, ans: r.ans[id] })) };
  for (const id of pt.members) sendId(id, out);
  if (pt.members.some(id => r.ans[id] === false)) { pt.ready = null; for (const id of pt.members) sendId(id, { t: 'ready_end', reason: 'declined' }); return; }
  if (pt.members.every(id => r.ans[id] === true)) {
    const d = r.dest; let key = d.type === 'hub' ? 'h:' + (d.owner || pt.leader) : 'p:' + pt.id + ':' + d.scene;
    if (d.type === 'hub') { const owner = players.get(d.owner || pt.leader); if (!owner) { pt.ready = null; return; } if (!owner.hub.scenes) { pt.ready = null; for (const id of pt.members) sendId(id, { t: 'ready_end', reason: 'that player has not built a hub yet' }); return; } }
    pt.allowed.add(key); pt.ready = null;
    for (const id of pt.members) sendId(id, { t: 'go', dest: d, inst: key });
  }
}

/* ---------------------------------------------------------------- guilds */
function guildState(g, viewerId) {
  const L = guildLevel(g), next = G_LV[L] || null, gq = guildQuests(g);
  return { id: g.id, name: g.name, tag: g.tag, icon: g.icon, tagline: g.tagline, open: !!g.open, level: L, play: g.play, next, cap: guildCap(L), perks: guildPerks(L), leader: g.leader,
    members: Object.entries(g.members).map(([pid, m]) => { const p = players.get(pid); return p ? { id: pid, name: p.name, hero: p.hero, rank: m.rank, play: m.play, online: online.has(pid) } : null; }).filter(Boolean).sort((a, b) => ({ leader: 0, officer: 1, member: 2 }[a.rank] - { leader: 0, officer: 1, member: 2 }[b.rank]) || b.play - a.play),
    quests: gq.list, claimed: !!(viewerId && gq.claimed[viewerId]), contrib: viewerId ? gq.contrib[viewerId] || 0 : 0 };
}
function pushGuild(g) { for (const pid of Object.keys(g.members)) { const c = online.get(pid); if (c) send(c, { t: 'guild', guild: guildState(g, pid) }); } }
function guildMsg(g, o) { for (const pid of Object.keys(g.members)) sendId(pid, o); }
function guildOp(c, m) {
  const p = c.p, g = p.guild && guilds.get(p.guild), op = m.op, bad = t => send(c, { t: 'notice', kind: 'bad', text: t });
  if (op === 'info') return send(c, { t: 'guild', guild: g ? guildState(g, p.id) : null, invites: p.gInv.map(i => ({ guild: i.guild, name: i.name, from: i.fromName })) });
  if (op === 'list') { const q = cleanText(m.q, 20).toLowerCase(); const rows = [...guilds.values()].filter(x => !q || x.name.toLowerCase().includes(q) || x.tag.toLowerCase() === q).map(x => ({ id: x.id, name: x.name, tag: x.tag, icon: x.icon, level: guildLevel(x), members: Object.keys(x.members).length, cap: guildCap(guildLevel(x)), open: !!x.open, tagline: x.tagline })).sort((a, b) => b.level - a.level || b.members - a.members).slice(0, 30); return send(c, { t: 'guilds', rows }); }
  if (op === 'create') {
    if (g) return bad('Leave your current guild first.');
    const name = cleanText(m.name, 20), tag = cleanText(m.tag, 4).toUpperCase().replace(/[^A-Z0-9]/g, ''), icon = clamp(m.icon | 0, 0, GUILD_ICONS.length - 1);
    if (name.length < 3 || BAD.test(name)) return bad('Guild name must be 3–20 characters.'); if (tag.length < 2) return bad('Tag must be 2–4 letters or numbers.');
    for (const x of guilds.values()) if (x.name.toLowerCase() === name.toLowerCase() || x.tag === tag) return bad('That guild name or tag is taken.');
    if (addStars(p, -GUILD_COST, 'guild') < 0) return bad(`A guild costs ${GUILD_COST} ★ (you have ${p.stars}).`);
    const gg = { id: 'g' + (misc.seq++).toString(36) + rid(2), name, tag, icon, tagline: cleanText(m.tagline, 60), leader: p.id, open: !!m.open, play: 0, created: now(), members: { [p.id]: { rank: 'leader', play: 0, joined: now() } } };
    guilds.set(gg.id, gg); p.guild = gg.id; markDirty(); send(c, { t: 'notice', kind: 'good', text: `Guild <b>${name}</b> founded!` }); return pushGuild(gg);
  }
  if (op === 'accept') { const inv = p.gInv.find(i => i.guild === m.guild); if (!inv) return bad('That invitation expired.'); return joinGuild(c, guilds.get(m.guild)); }
  if (op === 'join') { const gg = guilds.get(m.guild); if (!gg || !gg.open) return bad('That guild is invite-only.'); return joinGuild(c, gg); }
  if (!g) return bad('You are not in a guild.');
  const me = g.members[p.id];
  if (op === 'invite') {
    if (me.rank === 'member') return bad('Only officers and the leader can invite.'); const t = players.get(m.id); if (!t) return;
    if (t.guild) return bad(`${t.name} is already in a guild.`); if (Object.keys(g.members).length >= guildCap(guildLevel(g))) return bad('Guild is full — raise its level for more room.');
    t.gInv = t.gInv.filter(i => i.guild !== g.id).concat([{ guild: g.id, name: g.name, from: p.id, fromName: p.name, t: now() }]).slice(-5); markDirty();
    sendId(t.id, { t: 'invite', kind: 'guild', from: p.id, fromName: p.name, guild: g.id, guildName: g.name }); return send(c, { t: 'notice', kind: 'good', text: `Invited ${t.name}.` });
  }
  if (op === 'leave') { if (me.rank === 'leader' && Object.keys(g.members).length > 1) return bad('Promote a new leader first (or disband).'); return removeMember(g, p.id, 'left'); }
  if (op === 'kick') { const t = g.members[m.id]; if (!t || m.id === p.id) return; if (me.rank === 'member' || (me.rank === 'officer' && t.rank !== 'member')) return bad('You can’t remove that member.'); return removeMember(g, m.id, 'was removed'); }
  if (op === 'rank') { if (me.rank !== 'leader') return bad('Only the leader changes ranks.'); const t = g.members[m.id]; if (!t || m.id === p.id) return; const r = m.rank; if (r === 'leader') { me.rank = 'officer'; t.rank = 'leader'; g.leader = m.id; } else if (r === 'officer' || r === 'member') t.rank = r; markDirty(); return pushGuild(g); }
  if (op === 'edit') { if (me.rank !== 'leader') return bad('Only the leader edits the guild.'); if (m.tagline !== undefined) g.tagline = cleanText(m.tagline, 60); if (m.icon !== undefined) g.icon = clamp(m.icon | 0, 0, GUILD_ICONS.length - 1); if (m.open !== undefined) g.open = !!m.open; markDirty(); return pushGuild(g); }
  if (op === 'disband') { if (me.rank !== 'leader') return bad('Only the leader can disband.'); for (const pid of Object.keys(g.members)) { const q = players.get(pid); if (q) q.guild = null; sendId(pid, { t: 'guild', guild: null, why: 'Your guild was disbanded.' }); } guilds.delete(g.id); markDirty(); return; }
  if (op === 'claim') { const gq = guildQuests(g); if (gq.claimed[p.id]) return bad('Already claimed this week.'); if (!gq.list.every(i => i.have >= i.goal)) return bad('The guild quests are not finished yet.'); if (!(gq.contrib[p.id] > 0)) return bad('Contribute to the quests to earn a share.'); gq.claimed[p.id] = 1; addStars(p, 30 + 10 * guildLevel(g), 'guildquest', false); return pushGuild(g); }
}
function joinGuild(c, g) { const p = c.p; if (!g) return; if (p.guild) return send(c, { t: 'notice', kind: 'bad', text: 'Leave your current guild first.' }); if (Object.keys(g.members).length >= guildCap(guildLevel(g))) return send(c, { t: 'notice', kind: 'bad', text: 'That guild is full.' }); g.members[p.id] = { rank: 'member', play: 0, joined: now() }; p.guild = g.id; p.gInv = []; markDirty(); guildMsg(g, { t: 'chat', ch: 'guild', from: 'system', fromName: '', text: `${p.name} joined the guild.`, sys: 1, ts: now() }); pushGuild(g); send(c, { t: 'appear_all' }); broadcastAppear(c); }
function removeMember(g, pid, how) { const p = players.get(pid); delete g.members[pid]; if (p) p.guild = null; sendId(pid, { t: 'guild', guild: null, why: 'You ' + how + '.' }); const c = online.get(pid); if (c) broadcastAppear(c); if (!Object.keys(g.members).length) guilds.delete(g.id); else { if (g.leader === pid) { const n = Object.keys(g.members)[0]; g.leader = n; g.members[n].rank = 'leader'; } guildMsg(g, { t: 'chat', ch: 'guild', fromName: '', text: `${p ? p.name : 'A member'} ${how === 'left' ? 'left' : 'was removed from'} the guild.`, sys: 1, ts: now() }); pushGuild(g); } markDirty(); }
function broadcastAppear(c) { if (c.room) sendRoom(c.room, { t: 'appear', p: appearance(c.p) }); }

/* ---------------------------------------------------------------- leaderboards */
const LB = { cache: {}, t: 0 };
function leaderboard(cat) {
  if (now() - LB.t > (process.env.LB_TTL != null ? +process.env.LB_TTL : 5000)) { LB.cache = {}; LB.t = now(); } if (LB.cache[cat]) return LB.cache[cat];
  let rows;
  if (cat === 'guild') rows = [...guilds.values()].map(g => ({ id: g.id, name: g.name, tag: g.tag, icon: g.icon, score: g.play, level: guildLevel(g), members: Object.keys(g.members).length })).sort((a, b) => b.score - a.score).slice(0, 50);
  else { const f = { power, kills: p => p.kills, chapters: p => p.chapters, play: p => p.play, bosses: p => p.bosses }[cat] || power; rows = [...players.values()].filter(p => f(p) > 0).map(p => ({ ...appearance(p), score: f(p) })).sort((a, b) => b.score - a.score).slice(0, 50); }
  return LB.cache[cat] = rows;
}

/* ---------------------------------------------------------------- connection handling */
function authenticate(m) {
  const name = cleanText(m.name, 16); let p = null, token = null, newTok = null;
  // Wix identity (signed by your Wix backend): {id, ts, sig}
  const w = m.wix; let wixId = null;
  if (w && SECRET && typeof w.id === 'string' && safeEq(hmac(w.id + '|' + num(w.ts)), w.sig) && Math.abs(now() - num(w.ts)) < 2 * 864e5) wixId = cleanText(w.id, 64);
  if (wixId) p = [...players.values()].find(x => x.wix === wixId) || null;
  if (!p && m.token && typeof m.token === 'string') { const h = sha(m.token); p = [...players.values()].find(x => x.tokenHash === h) || null; }
  if (!p) { if (!validName(name)) return { err: 'Names are 3–16 letters, numbers, spaces, _ or -.' }; if (names.has(name.toLowerCase())) return { err: 'That name is taken — pick another.' }; p = newPlayer(name); newTok = rid(24); p.tokenHash = sha(newTok); }
  if (wixId && !p.wix) { p.wix = wixId; const pend = misc.pending[wixId]; if (pend) { p.stars += pend; delete misc.pending[wixId]; } markDirty(); }
  return { p, token: newTok };
}
function onHello(c, m) {
  const a = authenticate(m); if (a.err) return send(c, { t: 'denied', text: a.err });
  const p = a.p; const old = online.get(p.id); if (old && old !== c) { send(old, { t: 'kicked', text: 'Signed in from another place.' }); try { old.ws.close(); } catch (e) { } dropConn(old); }
  c.p = p; c.id = p.id; online.set(p.id, c); p.lastSeen = now();
  if (HEROES.includes(m.hero)) p.hero = m.hero; if (m.pal && typeof m.pal === 'object') p.pal = cleanPal(m.pal); setPres(p, m.pr);
  c.bucket = EARN_PER_MIN; c.bt = now(); c.joined = now();
  const g = p.guild && guilds.get(p.guild); if (p.guild && !g) p.guild = null;
  send(c, { t: 'welcome', id: p.id, name: p.name, token: a.token, stars: p.stars, wix: !!p.wix, profile: profileOf(p, p), quests: ensureQuests(p), guild: g ? guildState(g, p.id) : null, invites: p.gInv.map(i => ({ guild: i.guild, name: i.name, from: i.fromName })), hasSave: !!p.save, saveT: p.save ? p.save.t : 0, devGrant: DEV_GRANT, caps: { hub: HUB_CAP, party: PARTY_MAX, guildCost: GUILD_COST }, icons: GUILD_ICONS, lvTable: G_LV });
  pushFriends(p); markDirty();
}
const cleanPal = o => { const r = {}; for (const k of ['armor', 'trim', 'cloth', 'glow', 'hair', 'skin']) if (typeof o[k] === 'string' && /^#[0-9a-fA-F]{6}$/.test(o[k])) r[k] = o[k]; return r; };
function dropConn(c) {
  if (!c.id || online.get(c.id) !== c) return; leaveRoom(c); leaveParty(c, 'offline'); online.delete(c.id); const p = c.p; p.lastSeen = now(); p.play += 0; markDirty();
  for (const f of p.friends) sendId(f, { t: 'presence', id: p.id, online: false });
}
const COOL = { chat: 600, friend: 400, party: 300, guild: 300, hubpub: 15000, lb: 500, profile: 150, ready: 500, sync: 3000 };
const COOL_SCALE = process.env.COOL_SCALE != null ? +process.env.COOL_SCALE : 1; // tests set 0
function limited(c, k) { const t = now(); c.cd = c.cd || {}; if (c.cd[k] && t - c.cd[k] < (COOL[k] || 0) * COOL_SCALE) return true; c.cd[k] = t; return false; }
function onMessage(c, raw) {
  let m; try { m = JSON.parse(raw); } catch (e) { return; } if (!m || typeof m.t !== 'string') return;
  if (m.t === 'hello') return onHello(c, m);
  const p = c.p; if (!p) return;
  switch (m.t) {
    case 'ping': return send(c, { t: 'pong', ts: m.ts });
    case 'join': return handleJoin(c, m);
    case 'pos': c.x = q2(clamp(num(m.x), -400, 400)); c.y = q2(clamp(num(m.y), -50, 200)); c.z = q2(clamp(num(m.z), -400, 400)); c.f = q2(num(m.f)); c.s = q2(clamp(num(m.s), 0, 30)); c.a = clamp(m.a | 0, 0, 31); c.k = typeof m.k === 'string' ? m.k.replace(/[^a-z0-9_]/gi, '').slice(0, 14) : ''; c.u = q2(clamp(num(m.u), 0, 1)); c.moved = true; return;
    case 'appear': { if (HEROES.includes(m.hero)) p.hero = m.hero; if (m.pal && typeof m.pal === 'object') p.pal = cleanPal(m.pal); setPres(p, m.pr); markDirty(); return broadcastAppear(c); }
    case 'emote': if (c.room && !limited(c, 'chat')) sendRoom(c.room, { t: 'emote', id: c.id, e: clamp(m.e | 0, 0, 15) }); return;
    case 'chat': {
      if (limited(c, 'chat')) return; let text = maskBad(cleanText(m.text, 200)); if (!text) return; const ch = m.ch, base = { t: 'chat', ch, from: p.id, fromName: p.name, tag: appearance(p).tag, text, ts: now() };
      if (ch === 'room') return sendRoom(c.room, base);
      if (ch === 'party') { const pt = c.party && parties.get(c.party); if (!pt) return send(c, { t: 'notice', kind: 'bad', text: 'You are not in a party.' }); for (const id of pt.members) sendId(id, base); return; }
      if (ch === 'guild') { const g = p.guild && guilds.get(p.guild); if (!g) return send(c, { t: 'notice', kind: 'bad', text: 'You are not in a guild.' }); return guildMsg(g, base); }
      if (ch === 'whisper') { const tid = m.to && (players.has(m.to) ? m.to : names.get(String(m.to).toLowerCase())); const t = tid && online.get(tid); if (!t) return send(c, { t: 'notice', kind: 'bad', text: 'That player is not online.' }); base.to = t.id; base.toName = t.p.name; send(t, base); return send(c, base); }
      return;
    }
    case 'profile': { if (limited(c, 'profile')) return; const t = players.get(m.id) || (m.name && players.get(names.get(String(m.name).toLowerCase()))); if (t) send(c, { t: 'profile', p: profileOf(t, p) }); return; }
    case 'friend': {
      if (limited(c, 'friend')) return; const t = players.get(m.id); if (m.op === 'list') return pushFriends(p); if (!t || t.id === p.id) return;
      if (m.op === 'add') { if (p.friends.includes(t.id)) return send(c, { t: 'notice', kind: 'bad', text: 'Already friends.' }); if (p.friends.length >= 100) return send(c, { t: 'notice', kind: 'bad', text: 'Friend list full.' }); if (p.frIn.includes(t.id)) { return friendLink(p, t); } if (!t.frIn.includes(p.id)) t.frIn.push(p.id); markDirty(); sendId(t.id, { t: 'invite', kind: 'friend', from: p.id, fromName: p.name }); pushFriends(t); return send(c, { t: 'notice', kind: 'good', text: `Friend request sent to ${t.name}.` }); }
      if (m.op === 'accept') { if (!p.frIn.includes(t.id)) return; return friendLink(p, t); }
      if (m.op === 'decline') { p.frIn = p.frIn.filter(i => i !== t.id); markDirty(); return pushFriends(p); }
      if (m.op === 'remove') { p.friends = p.friends.filter(i => i !== t.id); t.friends = t.friends.filter(i => i !== p.id); markDirty(); pushFriends(p); pushFriends(t); return; }
      return;
    }
    case 'party': {
      if (limited(c, 'party')) return; const op = m.op, bad = t => send(c, { t: 'notice', kind: 'bad', text: t });
      if (op === 'invite') { const t = online.get(m.id); if (!t || t.id === p.id) return bad('That player is not online.'); let pt = c.party && parties.get(c.party); if (pt && pt.members.length >= PARTY_MAX) return bad(`Parties hold ${PARTY_MAX} players.`); if (t.party) return bad(`${t.p.name} is already in a party.`); t.invites = (t.invites || []).filter(i => i.from !== p.id); t.invites.push({ from: p.id, t: now() }); send(t, { t: 'invite', kind: 'party', from: p.id, fromName: p.name }); return send(c, { t: 'notice', kind: 'good', text: `Party invite sent to ${t.p.name}.` }); }
      if (op === 'accept') { const inv = (c.invites || []).find(i => i.from === m.id && now() - i.t < 60000); if (!inv) return bad('That invite expired.'); const l = online.get(m.id); if (!l) return bad('The inviter went offline.'); if (c.party) return bad('Leave your party first.'); let pt = l.party && parties.get(l.party); if (!pt) { pt = { id: 'P' + (misc.seq++).toString(36), leader: l.id, members: [l.id], ready: null, allowed: new Set() }; parties.set(pt.id, pt); l.party = pt.id; } if (pt.members.length >= PARTY_MAX) return bad('That party is full.'); pt.members.push(c.id); c.party = pt.id; c.invites = []; pushParty(pt); for (const id of pt.members) sendId(id, { t: 'chat', ch: 'party', text: `${p.name} joined the party.`, sys: 1, ts: now() }); return; }
      if (op === 'decline') { c.invites = (c.invites || []).filter(i => i.from !== m.id); return; }
      if (op === 'leave') return leaveParty(c, 'left');
      const pt = c.party && parties.get(c.party); if (!pt) return;
      if (op === 'kick') { if (pt.leader !== c.id || m.id === c.id) return; const t = online.get(m.id); if (t && t.party === pt.id) leaveParty(t, 'kicked'); return; }
      if (op === 'promote') { if (pt.leader !== c.id || !pt.members.includes(m.id)) return; pt.leader = m.id; return pushParty(pt); }
      return;
    }
    case 'ready': {
      if (m.op === 'start') { if (limited(c, 'ready')) return; return startReady(c, m); }
      if (m.op === 'answer') { const pt = c.party && parties.get(c.party); if (!pt || !pt.ready) return; pt.ready.ans[c.id] = !!m.ok; return checkReady(pt); }
      if (m.op === 'cancel') { const pt = c.party && parties.get(c.party); if (pt && pt.ready && pt.leader === c.id) { pt.ready = null; for (const id of pt.members) sendId(id, { t: 'ready_end', reason: 'cancelled' }); } return; }
      return;
    }
    case 'guild': if (limited(c, 'guild')) return; return guildOp(c, m);
    case 'lb': { if (limited(c, 'lb')) return; const rows = leaderboard(cleanText(m.cat, 10) || 'power'); return send(c, { t: 'lb', cat: m.cat, rows: rows.slice(0, m.top ? clamp(m.top | 0, 1, 50) : 50) }); }
    case 'stat': { // the client reports its progress (used for profiles & leaderboards)
      const L = m.levels && typeof m.levels === 'object' ? m.levels : {}; for (const k of HEROES) if (L[k] != null) p.levels[k] = clamp(L[k] | 0, 1, 60);
      const PR = m.pres && typeof m.pres === 'object' ? m.pres : null; if (PR) { p.pres = p.pres || {}; for (const k of HEROES) if (PR[k] != null) p.pres[k] = clamp(PR[k] | 0, 0, 25); }
      const grow = (key, v, cap) => { v = clamp(v | 0, 0, 1e9); if (v > p[key] && v - p[key] <= cap) p[key] = v; else if (v > p[key]) p[key] += cap; };
      if (m.kills != null) grow('kills', m.kills, 400); if (m.chapters != null) p.chapters = Math.max(p.chapters, clamp(m.chapters | 0, 0, 7)); if (m.bosses != null) grow('bosses', m.bosses, 3); markDirty(); return;
    }
    case 'ev': { const k = cleanText(m.k, 10), n = clamp(m.n | 0, 1, 200); const ok = ['kill', 'chapter', 'boss', 'place', 'pchapter', 'smash'].includes(k); if (!ok) return; c.evb = c.evb || { t: now(), n: 0 }; if (now() - c.evb.t > 60000) c.evb = { t: now(), n: 0 }; if (c.evb.n + n > 400) return; c.evb.n += n; if (k === 'kill') p.kills += n; return questEvent(p, k, n); }
    case 'quests': return send(c, { t: 'quests', q: ensureQuests(p) });
    case 'qclaim': { const q = ensureQuests(p), it = q.list[m.i | 0]; if (!it || it.claimed || it.have < it.goal) return; it.claimed = true; addStars(p, it.reward, 'quest', false); markDirty(); return send(c, { t: 'quests', q }); }
    case 'stars': { // the client earned (+) or spent (-) stars; the server keeps the real balance
      const d = clamp(m.d | 0, -100000, 100000); if (!d) return pushStars(p); if (d > 0) addStars(p, d, m.why, true); else if (addStars(p, d, m.why) < 0) pushStars(p, 'denied'); return;
    }
    case 'devgrant': if (DEV_GRANT) addStars(p, clamp(m.n | 0, 1, 5000), 'devgrant', false); return;
    case 'hubpub': { if (limited(c, 'hubpub')) return; const sc = m.scenes; if (!Array.isArray(sc) || sc.length < 1 || sc.length > 6) return send(c, { t: 'notice', kind: 'bad', text: 'A hub needs 1–6 scenes.' }); const s = JSON.stringify(sc); if (s.length > 1500000) return send(c, { t: 'notice', kind: 'bad', text: 'Your hub is too large to publish.' }); p.hub = { public: !!m.public, scenes: sc, updated: now() }; markDirty(); return send(c, { t: 'hubpub', ok: true, public: p.hub.public }); }
    case 'hubget': { const t = players.get(m.id); if (!t || !t.hub.scenes || !(t.hub.public || t.id === p.id || (c.party && parties.get(c.party) && parties.get(c.party).allowed.has('h:' + t.id)))) return send(c, { t: 'hubdata', id: m.id, err: 'private' }); return send(c, { t: 'hubdata', id: t.id, name: t.name, scenes: t.hub.scenes }); }
    case 'save': { if (limited(c, 'sync')) return; const s = JSON.stringify(m.blob || null); if (s.length < 3e6) { p.save = { t: now(), blob: m.blob }; markDirty(); send(c, { t: 'saved', at: p.save.t }); } return; }
    case 'loadsave': return send(c, { t: 'savedata', save: p.save });
    case 'setname': return;
  }
}
function friendLink(p, t) { p.frIn = p.frIn.filter(i => i !== t.id); t.frIn = t.frIn.filter(i => i !== p.id); if (!p.friends.includes(t.id)) p.friends.push(t.id); if (!t.friends.includes(p.id)) t.friends.push(p.id); markDirty(); pushFriends(p); pushFriends(t); sendId(t.id, { t: 'notice', kind: 'good', text: `${p.name} is now your friend.` }); sendId(p.id, { t: 'notice', kind: 'good', text: `${t.name} is now your friend.` }); }

/* ---------------------------------------------------------------- loops */
setInterval(() => { // 10 Hz position snapshots, per room
  for (const r of rooms.values()) { if (r.members.size < 2) continue; const arr = []; for (const id of r.members) { const c = online.get(id); if (c && c.moved) { arr.push([id, c.x, c.y, c.z, c.f, c.s, c.a, c.k || '', c.u || 0]); } } if (!arr.length) continue; sendRoom(r, { t: 'snap', p: arr }); for (const id of r.members) { const c = online.get(id); if (c) c.moved = false; } }
}, TICK_MS);
setInterval(() => { // once a minute: playtime, guild playtime, ready-check timeouts, stale invites
  for (const c of online.values()) { if (!c.p || !c.room) continue; c.p.play += 1; questEvent(c.p, 'play', 1); const g = c.p.guild && guilds.get(c.p.guild); if (g) { g.play += 1; if (g.members[c.p.id]) g.members[c.p.id].play += 1; } }
  markDirty();
}, 60000);
setInterval(() => { for (const pt of parties.values()) if (pt.ready && now() > pt.ready.exp) { pt.ready = null; for (const id of pt.members) sendId(id, { t: 'ready_end', reason: 'timed out' }); } }, 1000);
setInterval(() => { for (const c of online.values()) if (c.alive === false) { try { c.ws.terminate(); } catch (e) { } } else { c.alive = false; try { c.ws.ping(); } catch (e) { } } }, 30000);

/* ---------------------------------------------------------------- HTTP (health + Wix webhook) */
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type,x-signature' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/' || req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json', ...cors }); return res.end(JSON.stringify({ ok: true, game: 'neon-codex', online: online.size, rooms: rooms.size, players: players.size, guilds: guilds.size })); }
  if (req.method === 'POST' && req.url === '/wix/credit') {
    let body = ''; req.on('data', d => { body += d; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(o)); };
      if (!SECRET) return send(503, { ok: false, error: 'WIX_SHARED_SECRET not set' });
      if (!safeEq(hmac(body), req.headers['x-signature'] || '')) return send(401, { ok: false, error: 'bad signature' });
      let j; try { j = JSON.parse(body); } catch (e) { return send(400, { ok: false }); }
      const member = cleanText(j.memberId, 64), order = cleanText(j.orderId, 80), stars = clamp(j.stars | 0, 1, 100000);
      if (!member || !order || !stars) return send(400, { ok: false, error: 'memberId, orderId and stars are required' });
      if (misc.orders[order]) return send(200, { ok: true, duplicate: true });
      misc.orders[order] = { member, stars, t: now() };
      const p = [...players.values()].find(x => x.wix === member);
      if (p) addStars(p, stars, 'purchase', false); else misc.pending[member] = (misc.pending[member] || 0) + stars;
      markDirty(); send(200, { ok: true, credited: !!p });
    });
    return;
  }
  res.writeHead(404, cors); res.end('not found');
});
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024, verifyClient: (info, cb) => { if (!ORIGINS.length) return cb(true); const o = info.origin || ''; cb(ORIGINS.some(x => o === x || o.startsWith(x)), 403, 'origin not allowed'); } });
wss.on('connection', ws => {
  const c = { ws, alive: true, p: null, id: null, room: null, party: null, x: 0, y: 0, z: 0, f: 0, s: 0, a: 0, scene: null };
  const key = ws._socket && ws._socket.remoteAddress; ws.on('pong', () => { c.alive = true; });
  let cnt = 0, t0 = now(); ws.on('message', d => { const t = now(); if (t - t0 > 1000) { t0 = t; cnt = 0; } if (++cnt > 80) return; try { onMessage(c, d.toString()); } catch (e) { console.error('msg error', e.message); } });
  ws.on('close', () => dropConn(c)); ws.on('error', () => { });
  setTimeout(() => { if (!c.p) { try { ws.close(); } catch (e) { } } }, 15000);
});
server.listen(PORT, () => console.log(`Neon Codex Massive server on :${PORT} · data in ${DATA_DIR} · wix=${SECRET ? 'on' : 'off'} · origins=${ORIGINS.join(',') || '*'}`));
module.exports = { server, wss, players, guilds, hmac };
