/* ============ Neon Codex Massive · multiplayer server ============
   One Node process: HTTP (health + Wix webhook) and WebSocket (game).  Persistence = two JSON files in DATA_DIR (mount a Railway volume there).
   Env:  PORT (Railway sets it) · DATA_DIR (default ./data) · WIX_SHARED_SECRET (HMAC secret shared with your Wix backend) ·
         ALLOWED_ORIGINS (comma list, e.g. https://you.github.io,https://www.yoursite.com – empty = allow all) · DEV_GRANT=1 (lets clients ask for test stars)
   See README.md for the protocol and deployment steps. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
/* Railway sets RAILWAY_VOLUME_MOUNT_PATH when a volume is attached: use it automatically if DATA_DIR was not set. */
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const DATA_DIR = process.env.DATA_DIR || VOLUME || path.join(__dirname, 'data');
const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
const PERSISTENT = !ON_RAILWAY || (!!VOLUME && path.resolve(DATA_DIR).startsWith(path.resolve(VOLUME)));
const SECRET = process.env.WIX_SHARED_SECRET || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const DEV_GRANT = process.env.DEV_GRANT === '1';
const HUB_CAP = 50, PARTY_MAX = 8, GUILD_COST = 1000, GUILD_MAX = 50;
const TICK_MS = 100, EARN_PER_MIN = 400;
fs.mkdirSync(DATA_DIR, { recursive: true });
const D_SAVES = path.join(DATA_DIR, 'saves'), D_HUBS = path.join(DATA_DIR, 'hubs'), D_BAK = path.join(DATA_DIR, 'backups');
for (const d of [D_SAVES, D_HUBS, D_BAK]) fs.mkdirSync(d, { recursive: true });
if (!PERSISTENT) console.warn('\n' + '!'.repeat(78) + '\n!! WARNING: running on Railway WITHOUT a volume. Every redeploy or restart ERASES all accounts,\n!! cloud saves, guilds and player hubs. Fix: Railway → this service → Settings → Volumes → add a\n!! volume mounted at /data (DATA_DIR is picked up automatically). See README §1.\n' + '!'.repeat(78) + '\n');

/* ---------------------------------------------------------------- persistence */
const F_PLAYERS = path.join(DATA_DIR, 'players.json'), F_GUILDS = path.join(DATA_DIR, 'guilds.json'), F_MISC = path.join(DATA_DIR, 'misc.json');
function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
const players = new Map(Object.entries(readJSON(F_PLAYERS, {})));
const guilds = new Map(Object.entries(readJSON(F_GUILDS, {})));
const misc = readJSON(F_MISC, { orders: {}, pending: {}, seq: 1 }); misc.pendingEnt = misc.pendingEnt || {}; misc.coupons = misc.coupons || {};
let dirty = false, saveT = null;
function markDirty() { dirty = true; if (!saveT) saveT = setTimeout(flush, 1500); }
function writeAtomic(f, obj) { const t = f + '.tmp'; fs.writeFileSync(t, typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)); fs.renameSync(t, f); }
/* big per-player data lives in its own files so players.json stays small and fast to rewrite:
   saves/<id>.json (cloud save, previous version kept as <id>.prev.json) · hubs/<id>.json (published scenes) · hubs/<id>.jpg (Atlas preview shot) */
const safeId = id => String(id).replace(/[^a-z0-9]/gi, '').slice(0, 40);
const blobPath = (kind, id) => kind === 'save' ? path.join(D_SAVES, safeId(id) + '.json') : kind === 'shot' ? path.join(D_HUBS, safeId(id) + '.jpg') : path.join(D_HUBS, safeId(id) + '.json');
const pendingBlobs = new Map();   // "kind:id" -> {kind,id,v}  (v === null deletes)
function putBlob(kind, id, v) { pendingBlobs.set(kind + ':' + id, { kind, id, v }); markDirty(); }
function getBlob(kind, id) {
  const pb = pendingBlobs.get(kind + ':' + id); if (pb) return pb.v;
  try { const raw = fs.readFileSync(blobPath(kind, id)); return kind === 'shot' ? raw : JSON.parse(raw.toString('utf8')); } catch (e) { return null; }
}
function flushBlobs() {
  for (const [k, b] of [...pendingBlobs]) {
    const f = blobPath(b.kind, b.id);
    try {
      if (b.v === null) { try { fs.unlinkSync(f); } catch (e) { } }
      else { if (b.kind === 'save' && fs.existsSync(f)) { try { fs.copyFileSync(f, f.replace(/\.json$/, '.prev.json')); } catch (e) { } } writeAtomic(f, b.kind === 'shot' ? b.v : JSON.stringify(b.v)); }
      if (pendingBlobs.get(k) === b) pendingBlobs.delete(k);
    } catch (e) { console.error('blob save failed', k, e.message); dirty = true; }
  }
}
function flush() { saveT = null; if (!dirty) return; dirty = false; try { flushBlobs(); writeAtomic(F_PLAYERS, Object.fromEntries(players)); writeAtomic(F_GUILDS, Object.fromEntries(guilds)); writeAtomic(F_MISC, misc); } catch (e) { console.error('save failed', e.message); dirty = true; } if (dirty && !saveT) saveT = setTimeout(flush, 5000); }
/* hourly snapshot of the small files (accounts, guilds, orders); the last 72 are kept */
function backup() { try { const tag = new Date().toISOString().slice(0, 13).replace(/[:T]/g, '-'); writeAtomic(path.join(D_BAK, 'state-' + tag + '.json'), JSON.stringify({ t: now(), players: Object.fromEntries(players), guilds: Object.fromEntries(guilds), misc })); const all = fs.readdirSync(D_BAK).filter(f => f.startsWith('state-')).sort(); for (const f of all.slice(0, Math.max(0, all.length - 72))) fs.unlinkSync(path.join(D_BAK, f)); } catch (e) { console.error('backup failed', e.message); } }
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
const HEROES = ['starr', 'aurealius', 'willow', 'akira', 'talos', 'dante', 'seraphine', 'vesper', 'brigid', 'fenn', 'leander', 'nyx', 'moros', 'alita', 'rhoka', 'isolde', 'cassian', 'maeve', 'rook', 'elara', 'lucia', 'luxio'];
/* ---- premium content (Book II: The Rise of the Corinthians) ----
   ITEMS: what each real-money SKU unlocks (prices live in your Wix backend PACKS table, see README).
   COUPONS: comma list in env COUPON_CODES (default ALLOFTHEM) – unlocks every locked champion incl. the premium ones. */
const PREMIUM = ['lucia', 'luxio'];
const LOCKED_ALL = ['seraphine', 'fenn', 'vesper', 'brigid', 'leander', 'nyx', 'moros', 'alita', 'rhoka', 'isolde', 'cassian', 'maeve', 'rook', 'elara', 'lucia', 'luxio'];
const ITEMS = { champ_lucia: { heroes: ['lucia'] }, champ_luxio: { heroes: ['luxio'] }, bundle_corinth: { heroes: ['lucia', 'luxio'], skins: ['lucia', 'luxio'] } };
const COUPONS = (process.env.COUPON_CODES || 'ALLOFTHEM').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

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
const tokenIdx = new Map();        // sha(token) -> pid (several devices per account)
{ let moved = 0; for (const p of players.values()) {
  if (p.tokenHash && !p.tokens) p.tokens = [p.tokenHash]; delete p.tokenHash; p.tokens = p.tokens || []; for (const h of p.tokens) tokenIdx.set(h, p.id);
  if (p.save && p.save.blob) { putBlob('save', p.id, { t: p.save.t, blob: p.save.blob }); p.save = { t: p.save.t }; moved++; }
  p.hub = p.hub || { public: false, updated: 0 }; if (p.hub.scenes) { putBlob('hub', p.id, p.hub.scenes); delete p.hub.scenes; p.hub.has = true; moved++; }
  hubStats(p); }
  console.log(`loaded ${players.size} players · ${guilds.size} guilds · ${[...players.values()].filter(p => p.hub && p.hub.has && p.hub.public).length} public hubs from ${DATA_DIR}${PERSISTENT ? '' : '  (NOT PERSISTENT)'}`);
  if (moved) { dirty = true; flush(); console.log('moved ' + moved + ' saves/hubs into per-player files'); } }
function hubStats(p) { const h = p.hub; h.plays = h.plays | 0; h.done = h.done | 0; h.likes = h.likes && typeof h.likes === 'object' ? h.likes : {}; h.seen = h.seen || {}; h.fin = h.fin || {}; return h; }

function send(c, o) { if (c && c.ws && c.ws.readyState === 1) { try { c.ws.send(JSON.stringify(o)); } catch (e) { } } }
function sendId(id, o) { send(online.get(id), o); }
function sendRoom(room, o, except) { if (!room) return; const s = JSON.stringify(o); for (const id of room.members) { if (id === except) continue; const c = online.get(id); if (c && c.ws.readyState === 1) try { c.ws.send(s); } catch (e) { } } }

function newPlayer(name) {
  const id = 'p' + (misc.seq++).toString(36) + rid(2);
  const p = { id, name, created: now(), hero: 'starr', pal: {}, pres: {}, stars: 0, earned: 0, levels: {}, kills: 0, chapters: 0, bosses: 0, play: 0, friends: [], frIn: [], guild: null, gInv: [], q: null, hub: { public: false, updated: 0, plays: 0, done: 0, likes: {}, seen: {}, fin: {} }, save: null, tokens: [], lastSeen: now() };
  players.set(id, p); names.set(name.toLowerCase(), id); markDirty(); return p;
}
const power = p => Object.values(p.levels || {}).reduce((a, b) => a + b, 0) + 30 * Object.values(p.pres || {}).reduce((a, b) => a + b, 0);
function setPres(p, v) { if (v == null) return; p.pres = p.pres || {}; p.pres[p.hero] = clamp(v | 0, 0, 25); }
function appearance(p) { return { id: p.id, name: p.name, hero: p.hero, pal: p.pal, lv: (p.levels && p.levels[p.hero]) || 1, pr: (p.pres && p.pres[p.hero]) || 0, tag: p.guild && guilds.get(p.guild) ? guilds.get(p.guild).tag : '' }; }
function profileOf(p, viewer) {
  const g = p.guild && guilds.get(p.guild);
  return { id: p.id, name: p.name, hero: p.hero, pal: p.pal, levels: p.levels, pres: p.pres || {}, power: power(p), kills: p.kills, chapters: p.chapters, bosses: p.bosses, play: p.play, online: online.has(p.id), created: p.created,
    guild: g ? { id: g.id, name: g.name, tag: g.tag, icon: g.icon, level: guildLevel(g) } : null, hubPublic: !!(p.hub && p.hub.public && p.hub.has), friend: !!(viewer && viewer.friends.includes(p.id)), self: !!(viewer && viewer.id === p.id), party: online.get(p.id) ? !!online.get(p.id).party : false };
}

/* ---------------------------------------------------------------- rooms */
function hubRoom() { for (const r of rooms.values()) if (r.scene === 'hub' && r.kind === 'hub' && r.members.size < HUB_CAP) return r; const r = { id: 'hub#' + (misc.seq++), scene: 'hub', kind: 'hub', cap: HUB_CAP, members: new Set() }; rooms.set(r.id, r); return r; }
/* shared enemies (client COOP): every room has ONE host that runs the real enemy AI — the first member; when the host leaves,
   the longest-present remaining member takes over and the room is told ({t:'host'}). */
function pickHost(r) { const h = r.members.values().next().value || null; if (h !== r.host) { r.host = h; if (h) sendRoom(r, { t: 'host', id: h }); } }
function leaveRoom(c) {
  const r = c.room; if (!r) return; r.members.delete(c.id); c.room = null; sendRoom(r, { t: 'leave', id: c.id });
  if (!r.members.size) { rooms.delete(r.id); return; } if (r.host === c.id || !r.members.has(r.host)) pickHost(r);
}
function joinRoom(c, room, scene) {
  if (c.room === room) return; leaveRoom(c); room.members.add(c.id); c.room = room; c.scene = scene; if (!room.host || !room.members.has(room.host)) room.host = c.id;
  const list = []; for (const id of room.members) { const o = online.get(id); if (o && id !== c.id) list.push({ ...appearance(o.p), x: o.x, y: o.y, z: o.z, f: o.f, s: o.s, a: o.a, k: o.k || '', u: o.u || 0 }); }
  send(c, { t: 'room', room: room.id, scene, cap: room.cap, players: list, count: room.members.size, host: room.host });
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
    if (d.type === 'hub') { const owner = players.get(d.owner || pt.leader); if (!owner) { pt.ready = null; return; } if (!owner.hub.has) { pt.ready = null; for (const id of pt.members) sendId(id, { t: 'ready_end', reason: 'that player has not built a hub yet' }); return; } }
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
/* passwords are optional: they let a player sign in to the same account from any browser or device with name + password */
const PW_MIN = 6;
function pwMake(pw) { const salt = rid(12); return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') }; }
function pwOk(p, pw) { if (!p.pw || typeof pw !== 'string' || !pw) return false; try { return safeEq(crypto.scryptSync(pw, p.pw.salt, 32).toString('hex'), p.pw.hash); } catch (e) { return false; } }
function addToken(p) { const tok = rid(24), h = sha(tok); p.tokens = (p.tokens || []).concat(h); while (p.tokens.length > 12) tokenIdx.delete(p.tokens.shift()); tokenIdx.set(h, p.id); markDirty(); return tok; }
const pwFails = new Map();         // name/ip -> {n, t}
/* entitlements: p.ent = {heroes:{lucia:1}, skins:{lucia:1}, all:1} */
function entOf(p) { const e = p.ent || {}; return { heroes: Object.assign({}, e.heroes), skins: Object.assign({}, e.skins), all: !!e.all }; }
function grantEnt(p, g, why) { p.ent = p.ent || { heroes: {}, skins: {} }; p.ent.heroes = p.ent.heroes || {}; p.ent.skins = p.ent.skins || {};
  for (const h of g.heroes || []) if (HEROES.includes(h)) p.ent.heroes[h] = 1; for (const h of g.skins || []) if (HEROES.includes(h)) p.ent.skins[h] = 1; if (g.all) p.ent.all = 1;
  markDirty(); sendId(p.id, { t: 'ent', ent: entOf(p), why: why || '' }); return entOf(p); }
const ALL_GRANT = { heroes: LOCKED_ALL, skins: PREMIUM, all: 1 };
function redeem(p, code) { const c = String(code || '').trim().toUpperCase(); if (!c || !COUPONS.includes(c)) return null;
  misc.coupons[c] = (misc.coupons[c] || 0) + 1; markDirty(); return p ? grantEnt(p, ALL_GRANT, 'coupon') : entOf({ ent: { heroes: Object.fromEntries(LOCKED_ALL.map(h => [h, 1])), skins: Object.fromEntries(PREMIUM.map(h => [h, 1])), all: 1 } }); }
function throttled(k) { const f = pwFails.get(k); return !!(f && f.n >= 6 && now() - f.t < 10 * 60000); }
function failed(k) { const f = pwFails.get(k) || { n: 0, t: now() }; if (now() - f.t > 10 * 60000) { f.n = 0; f.t = now(); } f.n++; pwFails.set(k, f); }
function authenticate(m, ip) {
  const name = cleanText(m.name, 16); let p = null, newTok = null;
  // Wix identity (signed by your Wix backend): {id, ts, sig}
  const w = m.wix; let wixId = null;
  if (w && SECRET && typeof w.id === 'string' && safeEq(hmac(w.id + '|' + num(w.ts)), w.sig) && Math.abs(now() - num(w.ts)) < 2 * 864e5) wixId = cleanText(w.id, 64);
  if (wixId) p = [...players.values()].find(x => x.wix === wixId) || null;
  if (!p && m.token && typeof m.token === 'string') { const id = tokenIdx.get(sha(m.token)); p = id ? players.get(id) || null : null; }
  if (!p && name && names.has(name.toLowerCase())) {          // existing name: password sign-in
    const q = players.get(names.get(name.toLowerCase())), k1 = 'n:' + name.toLowerCase(), k2 = 'i:' + (ip || '');
    if (typeof m.pw === 'string' && m.pw) {
      if (throttled(k1) || throttled(k2)) return { err: 'Too many wrong passwords — wait a few minutes and try again.', code: 'slow' };
      if (pwOk(q, m.pw)) { p = q; newTok = addToken(p); } else { failed(k1); failed(k2); return { err: q.pw ? 'Wrong password for ' + q.name + '.' : q.name + ' has no password yet — sign in with its recovery key, then set one in Social → Account.', code: 'badpw', name: q.name, hasPw: !!q.pw }; }
    } else return { err: q.pw ? 'That name is taken. If it is yours, enter its password below.' : 'That name is taken. If it is yours, sign in with its recovery key (or pick another name).', code: 'taken', name: q.name, hasPw: !!q.pw };
  }
  if (!p && m.recover) return { err: 'That recovery key does not match any account on this server.', code: 'nokey' };
  if (!p) { if (!validName(name)) return { err: 'Names are 3–16 letters, numbers, spaces, _ or -.' }; p = newPlayer(name); newTok = addToken(p); if (typeof m.newpw === 'string' && m.newpw.length >= PW_MIN && m.newpw.length <= 64) p.pw = pwMake(m.newpw); }
  if (wixId && !p.wix) { p.wix = wixId; const pend = misc.pending[wixId]; if (pend) { p.stars += pend; delete misc.pending[wixId]; } const pe = misc.pendingEnt[wixId]; if (pe) { for (const s of pe) if (ITEMS[s]) { p.ent = p.ent || {}; grantEnt(p, ITEMS[s], 'purchase'); } delete misc.pendingEnt[wixId]; } markDirty(); }
  if (wixId && !newTok && !(m.token && tokenIdx.get(sha(m.token)) === p.id)) newTok = addToken(p);
  return { p, token: newTok };
}
function onHello(c, m) {
  const a = authenticate(m, c.ip); if (a.err) return send(c, { t: 'denied', text: a.err, code: a.code || '', name: a.name || '', hasPw: !!a.hasPw });
  const p = a.p; const old = online.get(p.id); if (old && old !== c) { send(old, { t: 'kicked', text: 'Signed in from another place.' }); try { old.ws.close(); } catch (e) { } dropConn(old); }
  c.p = p; c.id = p.id; online.set(p.id, c); p.lastSeen = now();
  if (HEROES.includes(m.hero)) p.hero = m.hero; if (m.pal && typeof m.pal === 'object') p.pal = cleanPal(m.pal); setPres(p, m.pr);
  c.bucket = EARN_PER_MIN; c.bt = now(); c.joined = now();
  const g = p.guild && guilds.get(p.guild); if (p.guild && !g) p.guild = null;
  send(c, { t: 'welcome', id: p.id, name: p.name, token: a.token, stars: p.stars, ent: entOf(p), wix: !!p.wix, profile: profileOf(p, p), quests: ensureQuests(p), guild: g ? guildState(g, p.id) : null, invites: p.gInv.map(i => ({ guild: i.guild, name: i.name, from: i.fromName })), hasSave: !!(p.save && p.save.t), saveT: p.save ? p.save.t | 0 : 0, hasPw: !!p.pw, devGrant: DEV_GRANT, caps: { hub: HUB_CAP, party: PARTY_MAX, guildCost: GUILD_COST }, icons: GUILD_ICONS, lvTable: G_LV });
  pushFriends(p); markDirty();
}
const cleanPal = o => { const r = {}; for (const k of ['armor', 'trim', 'cloth', 'glow', 'hair', 'skin']) if (typeof o[k] === 'string' && /^#[0-9a-fA-F]{6}$/.test(o[k])) r[k] = o[k]; if (o.v === 1 || o.v === 2) r.v = o.v; return r; };
function dropConn(c) {
  if (c.p) { if (c.savePend) applySave(c); if (c.hubPend) applyHub(c); }
  if (!c.id || online.get(c.id) !== c) return; leaveRoom(c); leaveParty(c, 'offline'); online.delete(c.id); const p = c.p; p.lastSeen = now(); p.play += 0; markDirty();
  for (const f of p.friends) sendId(f, { t: 'presence', id: p.id, online: false });
}
const COOL = { chat: 600, friend: 400, party: 300, guild: 300, hubpub: 4000, lb: 500, profile: 150, ready: 500, sync: 1000, atlas: 250, setpw: 2000, redeem: 1500 };
const COOL_SCALE = process.env.COOL_SCALE != null ? +process.env.COOL_SCALE : 1; // tests set 0
function bucket(c, k, rate, burst) { const b = (c.bk || (c.bk = {}))[k] || (c.bk[k] = { n: burst, t: now() }); const t = now(); b.n = Math.min(burst, b.n + (t - b.t) / 1000 * rate); b.t = t; if (b.n < 1) return false; b.n--; return true; }
function limited(c, k) { const t = now(); c.cd = c.cd || {}; if (c.cd[k] && t - c.cd[k] < (COOL[k] || 0) * COOL_SCALE) return true; c.cd[k] = t; return false; }
function applySave(c) { clearTimeout(c.saveT); c.saveT = null; const b = c.savePend; c.savePend = null; if (!b || !c.p) return; const t = now(); c.p.save = { t }; putBlob('save', c.p.id, { t, blob: b }); c.saveAt = t; send(c, { t: 'saved', at: t }); }
function applyHub(c) {
  clearTimeout(c.hubT); c.hubT = null; const m = c.hubPend; c.hubPend = null; if (!m || !c.p) return; const p = c.p, h = hubStats(p), t = now();
  putBlob('hub', p.id, m.scenes); if (m.shot) { putBlob('shot', p.id, Buffer.from(m.shot.split(',')[1], 'base64')); h.shotV = t; }
  h.has = true; h.public = !!m.public; h.updated = t; h.first = h.first || t; h.meta = hubMeta(m.scenes); c.hubAt = t; markDirty();
  send(c, { t: 'hubpub', ok: true, public: h.public, entry: atlasEntry(p, p) });
}
/* ---------------------------------------------------------------- Hub Atlas: browse, like, play and clear other players' hubs */
const ENEMIES = new Set(['mutant', 'parasite', 'nightshade', 'brute', 'pumpkin', 'razor', 'stalker', 'bulwark', 'golem', 'leaper', 'shockhopper', 'gorebull', 'ramshell', 'archer', 'sniper', 'hexer', 'spitter', 'mender', 'gravecaller', 'bomber', 'gorgrim', 'queen', 'vexis', 'colossus', 'sovereign', 'warrok', 'maw']);
const KIND_RX = /^[a-z][a-z0-9_]{1,24}$/;
function hubMeta(scenes) { // computed from the scenes themselves, never trusted from the client
  const mon = {}, boss = {}, obj = [], nm = []; let objs = 0, area = 0;
  for (const sc of scenes) {
    if (!sc || typeof sc !== 'object') continue; const list = Array.isArray(sc.objs) ? sc.objs : []; objs += list.length; area += clamp(num(sc.w, 60), 10, 200) * clamp(num(sc.d, 60), 10, 200); nm.push(cleanText(sc.name, 40) || 'Scene');
    for (const o of list) { if (!o || typeof o.k !== 'string') continue; const d = o.d && typeof o.d === 'object' ? o.d : {};
      if (o.k === 'spawner') { const k = String(d.kind || 'mutant'); if (KIND_RX.test(k)) mon[k] = (mon[k] || 0) + clamp((d.count | 0) || 1, 1, 5); }
      else if (o.k === 'bossSpawn') { const k = String(d.kind || 'warrok'); if (KIND_RX.test(k)) boss[k] = (boss[k] || 0) + 1; }
      else if (ENEMIES.has(o.k)) mon[o.k] = (mon[o.k] || 0) + 1; }
    const q = sc.quest; if (q && Array.isArray(q.steps) && q.steps.length) obj.push({ scene: cleanText(sc.name, 40) || 'Scene', title: cleanText(q.title, 48), steps: q.steps.slice(0, 12).map(st => ({ type: cleanText(st && st.type, 12), text: cleanText(st && st.text, 90) })) });
  }
  const main = scenes.find(x => x && x.id === 'mine-1') || scenes[0] || {};
  return { title: cleanText(main.name, 40) || 'Dungeon', desc: cleanText(main.desc, 220), theme: cleanText(main.theme, 20), scenes: scenes.length, names: nm.slice(0, 6), objs, area, mon, boss, obj, quests: obj.length };
}
function prune(o, keepMs) { const ks = Object.keys(o); if (ks.length < 400) return; const lim = now() - keepMs; for (const k of ks) if (o[k] < lim) delete o[k]; }
function countPlay(t, who) { const h = hubStats(t); if (h.seen[who] && now() - h.seen[who] < 20 * 60000) return false; h.seen[who] = now(); prune(h.seen, 864e5); h.plays++; markDirty(); return true; }
function countDone(t, who, sec) { const h = hubStats(t); if (!(h.meta && h.meta.quests)) return false; if (h.fin[who] && now() - h.fin[who] < 6 * 3600000) return false; h.fin[who] = now(); prune(h.fin, 7 * 864e5); h.done++; sec = clamp(sec | 0, 0, 86400); if (sec > 5) { h.tsum = (h.tsum || 0) + sec; h.tn = (h.tn || 0) + 1; } markDirty(); return { sec }; }
function hereCount(id) { const r = rooms.get('h:' + id); return r ? r.members.size : 0; }
function atlasEntry(p, viewer) {
  const h = hubStats(p), m = h.meta || {};
  return { id: p.id, name: p.name, hero: p.hero, pal: p.pal, lv: (p.levels && p.levels[p.hero]) || 1, pr: (p.pres && p.pres[p.hero]) || 0, tag: p.guild && guilds.get(p.guild) ? guilds.get(p.guild).tag : '',
    title: m.title || 'Dungeon', desc: m.desc || '', meta: m, plays: h.plays, likes: Object.keys(h.likes).length, done: h.done, best: h.best || null, avg: h.tn ? Math.round(h.tsum / h.tn) : 0,
    updated: h.updated || 0, first: h.first || 0, shot: h.shotV || 0, here: hereCount(p.id), online: online.has(p.id), public: !!h.public, liked: !!(viewer && h.likes[viewer.id]), mine: !!(viewer && viewer.id === p.id) };
}
const ATLAS_SORT = {
  top: (a, b) => score(b) - score(a), liked: (a, b) => Object.keys(b.hub.likes).length - Object.keys(a.hub.likes).length || b.hub.plays - a.hub.plays,
  played: (a, b) => b.hub.plays - a.hub.plays, done: (a, b) => b.hub.done - a.hub.done || b.hub.plays - a.hub.plays, new: (a, b) => (b.hub.updated || 0) - (a.hub.updated || 0) };
function score(p) { const h = p.hub, age = (now() - (h.updated || 0)) / 864e5; return Object.keys(h.likes).length * 4 + h.done * 3 + h.plays + hereCount(p.id) * 2 + (age < 3 ? 6 : age < 14 ? 2 : 0); }
function atlasList(viewer, sort, q, page) {
  q = cleanText(q, 24).toLowerCase(); sort = ATLAS_SORT[sort] ? sort : 'top';
  const all = [...players.values()].filter(p => p.hub && p.hub.has && p.hub.public && (!q || p.name.toLowerCase().includes(q) || ((p.hub.meta && p.hub.meta.title) || '').toLowerCase().includes(q))).sort(ATLAS_SORT[sort]);
  const per = 24, pg = clamp(page | 0, 0, 999);
  return { rows: all.slice(pg * per, pg * per + per).map(p => atlasEntry(p, viewer)), total: all.length, page: pg, per, sort };
}
function setLike(t, viewer, on) { const h = hubStats(t); if (t.id === viewer.id) return false; if (on) h.likes[viewer.id] = now(); else delete h.likes[viewer.id]; markDirty(); return true; }
function atlasOp(c, m) {
  const p = c.p, op = m.op, t = typeof m.id === 'string' ? players.get(m.id) : null;
  if (op === 'list') return send(c, { t: 'atlas', op: 'list', ...atlasList(p, m.sort, m.q, m.page) });
  if (op === 'mine') return send(c, { t: 'atlas', op: 'mine', row: p.hub && p.hub.has ? atlasEntry(p, p) : null });
  if (!t || !t.hub || !t.hub.has || !(t.hub.public || t.id === p.id)) return send(c, { t: 'atlas', op: 'gone', id: m.id });
  if (op === 'get') return send(c, { t: 'atlas', op: 'entry', row: atlasEntry(t, p) });
  if (op === 'like') { if (!setLike(t, p, !!m.on)) return send(c, { t: 'notice', kind: 'bad', text: 'You can’t like your own hub.' }); return send(c, { t: 'atlas', op: 'entry', row: atlasEntry(t, p) }); }
  if (op === 'done') { if (t.id === p.id) return; const r = countDone(t, 'p:' + p.id, m.sec); if (r && r.sec > 5 && (!t.hub.best || r.sec < t.hub.best.sec)) { t.hub.best = { sec: r.sec, name: p.name, id: p.id }; markDirty(); } return send(c, { t: 'atlas', op: 'entry', row: atlasEntry(t, p), cleared: !!r }); }
}
function onMessage(c, raw) {
  let m; try { m = JSON.parse(raw); } catch (e) { return; } if (!m || typeof m.t !== 'string') return;
  if (m.t === 'hello') return onHello(c, m);
  const p = c.p; if (!p) return;
  switch (m.t) {
    case 'ping': return send(c, { t: 'pong', ts: m.ts, now: now() });
    case 'co': { // shared-enemy traffic (host ⇄ guests): relayed inside the room, optionally to one member, stamped with the sender
      const r = c.room; if (!r || r.members.size < 2 || !m.d || typeof m.d !== 'object' || typeof m.d.k !== 'string') return;
      if (!bucket(c, 'co', 120, 240)) return; const raw = JSON.stringify(m.d); if (raw.length > 60000) return;
      const out = JSON.stringify({ t: 'co', d: m.d, from: c.id });
      if (typeof m.to === 'string') { if (!r.members.has(m.to) || m.to === c.id) return; const o = online.get(m.to); if (o && o.ws.readyState === 1) try { o.ws.send(out); } catch (e) { } return; }
      for (const id of r.members) { if (id === c.id) continue; const o = online.get(id); if (o && o.ws.readyState === 1) try { o.ws.send(out); } catch (e) { } } return; }
    case 'fx': { // other players' attack / ability effects + prop smashes (client FXN): relayed to the room
      const r = c.room; if (!r || r.members.size < 2 || !Array.isArray(m.b) || !m.b.length) return; if (!bucket(c, 'fx', 40, 80)) return;
      const o2 = { t: 'fx', b: m.b, p: Array.isArray(m.p) ? m.p.slice(0, 3) : null, from: c.id }; if (JSON.stringify(o2).length > 40000) return; sendRoom(r, o2, c.id); return; }
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
      if (m.kills != null) grow('kills', m.kills, 400); if (m.chapters != null) p.chapters = Math.max(p.chapters, clamp(m.chapters | 0, 0, 14)); if (m.bosses != null) grow('bosses', m.bosses, 3); markDirty(); return;
    }
    case 'ev': { const k = cleanText(m.k, 10), n = clamp(m.n | 0, 1, 200); const ok = ['kill', 'chapter', 'boss', 'place', 'pchapter', 'smash'].includes(k); if (!ok) return; c.evb = c.evb || { t: now(), n: 0 }; if (now() - c.evb.t > 60000) c.evb = { t: now(), n: 0 }; if (c.evb.n + n > 400) return; c.evb.n += n; if (k === 'kill') p.kills += n; return questEvent(p, k, n); }
    case 'quests': return send(c, { t: 'quests', q: ensureQuests(p) });
    case 'qclaim': { const q = ensureQuests(p), it = q.list[m.i | 0]; if (!it || it.claimed || it.have < it.goal) return; it.claimed = true; addStars(p, it.reward, 'quest', false); markDirty(); return send(c, { t: 'quests', q }); }
    case 'stars': { // the client earned (+) or spent (-) stars; the server keeps the real balance
      const d = clamp(m.d | 0, -100000, 100000); if (!d) return pushStars(p); if (d > 0) addStars(p, d, m.why, true); else if (addStars(p, d, m.why) < 0) pushStars(p, 'denied'); return;
    }
    case 'devgrant': if (DEV_GRANT) addStars(p, clamp(m.n | 0, 1, 5000), 'devgrant', false); return;
    case 'devbuy': if (DEV_GRANT && ITEMS[m.sku]) grantEnt(p, ITEMS[m.sku], 'purchase'); return;
    case 'redeem': { if (limited(c, 'redeem')) return send(c, { t: 'redeemed', ok: false, error: 'Wait a moment and try again.' }); const e = redeem(p, m.code); return send(c, e ? { t: 'redeemed', ok: true, ent: e } : { t: 'redeemed', ok: false, error: 'That code is not valid.' }); }
    case 'ent': return send(c, { t: 'ent', ent: entOf(p) });
    case 'hubpub': { // publish / update the player's hub (all their dungeon scenes) + the Atlas preview shot
      const sc = m.scenes; if (!Array.isArray(sc) || sc.length < 1 || sc.length > 6) return send(c, { t: 'notice', kind: 'bad', text: 'A hub needs 1–6 scenes.' });
      if (JSON.stringify(sc).length > 1500000) return send(c, { t: 'notice', kind: 'bad', text: 'Your hub is too large to publish.' });
      if (m.shot != null && !(typeof m.shot === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(m.shot) && m.shot.length < 400000)) m.shot = null;
      c.hubPend = { scenes: sc, public: !!m.public, shot: m.shot || null };   // a burst of saves becomes one write: the latest wins
      const wait = (COOL.hubpub * COOL_SCALE) - (now() - (c.hubAt || 0)); if (wait <= 0) applyHub(c); else if (!c.hubT) c.hubT = setTimeout(() => applyHub(c), wait); return; }
    case 'hubvis': { const h = hubStats(p); if (!h.has) return send(c, { t: 'notice', kind: 'bad', text: 'Save your hub in the Dungeon Forge first.' }); h.public = !!m.public; h.chosen = true; markDirty(); return send(c, { t: 'hubpub', ok: true, public: h.public, vis: true }); }
    case 'hubget': { const t = players.get(m.id); if (!t || !t.hub.has || !(t.hub.public || t.id === p.id || (c.party && parties.get(c.party) && parties.get(c.party).allowed.has('h:' + t.id)))) return send(c, { t: 'hubdata', id: m.id, err: 'private' });
      const scenes = getBlob('hub', t.id); if (!scenes) return send(c, { t: 'hubdata', id: m.id, err: 'private' });
      if (t.id !== p.id) countPlay(t, 'p:' + p.id);
      return send(c, { t: 'hubdata', id: t.id, name: t.name, scenes }); }
    case 'save': { // cloud save. Never dropped: a save that arrives too soon after the last one waits and is written moments later (the newest wins)
      if (!m.blob || typeof m.blob !== 'object') return send(c, { t: 'saved', ok: false, why: 'empty' });
      if (JSON.stringify(m.blob).length >= 3e6) return send(c, { t: 'saved', ok: false, why: 'big' });
      c.savePend = m.blob; const wait = (COOL.sync * COOL_SCALE) - (now() - (c.saveAt || 0)); if (wait <= 0) applySave(c); else if (!c.saveT) c.saveT = setTimeout(() => applySave(c), wait); return; }
    case 'loadsave': return send(c, { t: 'savedata', save: p.save && p.save.t ? getBlob('save', p.id) : null });
    case 'setpw': { if (limited(c, 'setpw')) return; const pw = typeof m.pw === 'string' ? m.pw : ''; if (pw.length < PW_MIN || pw.length > 64) return send(c, { t: 'pwset', ok: false, text: `Passwords are ${PW_MIN}–64 characters.` }); p.pw = pwMake(pw); markDirty(); return send(c, { t: 'pwset', ok: true, text: 'Password set — you can now sign in as ' + p.name + ' on any device.' }); }
    case 'atlas': { if (limited(c, 'atlas') && m.op !== 'done') return; return atlasOp(c, m); }
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
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type,x-signature,x-token', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/' || req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json', ...cors }); return res.end(JSON.stringify({ ok: true, game: 'neon-codex', online: online.size, rooms: rooms.size, players: players.size, guilds: guilds.size, hubs: [...players.values()].filter(p => p.hub && p.hub.has && p.hub.public).length, persistent: PERSISTENT, volume: !!VOLUME })); }
  if (req.url.startsWith('/atlas')) return atlasHttp(req, res, cors);
  if (req.url === '/redeem' || req.url === '/ent') return entHttp(req, res, cors);
  if (req.method === 'POST' && req.url === '/wix/credit') {
    let body = ''; req.on('data', d => { body += d; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(o)); };
      if (!SECRET) return send(503, { ok: false, error: 'WIX_SHARED_SECRET not set' });
      if (!safeEq(hmac(body), req.headers['x-signature'] || '')) return send(401, { ok: false, error: 'bad signature' });
      let j; try { j = JSON.parse(body); } catch (e) { return send(400, { ok: false }); }
      const member = cleanText(j.memberId, 64), order = cleanText(j.orderId, 80), item = ITEMS[j.sku] ? j.sku : null, stars = clamp(j.stars | 0, 1, 100000);
      if (item && member && order) { if (misc.orders[order]) return send(200, { ok: true, duplicate: true }); misc.orders[order] = { member, sku: item, t: now() };
        const p = [...players.values()].find(x => x.wix === member); if (p) grantEnt(p, ITEMS[item], 'purchase'); else (misc.pendingEnt[member] = misc.pendingEnt[member] || []).push(item);
        markDirty(); return send(200, { ok: true, credited: !!p, sku: item }); }
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
/* entitlements over HTTP (Campaign mode has no websocket): GET /ent (x-token) · POST /redeem {code} (x-token optional – without it the unlock is only stored on that device) */
const redeemHits = new Map();
function entHttp(req, res, cors) { const out = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors }); res.end(JSON.stringify(o)); };
  const tok = req.headers['x-token'], p = typeof tok === 'string' && tok ? players.get(tokenIdx.get(sha(tok))) || null : null;
  if (req.method === 'GET' && req.url === '/ent') return p ? out(200, { ok: true, ent: entOf(p) }) : out(401, { ok: false });
  if (req.method !== 'POST' || req.url !== '/redeem') return out(404, { ok: false });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  const h = redeemHits.get(ip) || { t: now(), n: 0 }; if (now() - h.t > 60000) { h.t = now(); h.n = 0; } h.n++; redeemHits.set(ip, h); if (redeemHits.size > 5000) redeemHits.clear(); if (h.n > 10) return out(429, { ok: false, error: 'Too many tries — wait a minute.' });
  let body = ''; req.on('data', d => { body += d; if (body.length > 2000) req.destroy(); });
  req.on('end', () => { let j = {}; try { j = JSON.parse(body || '{}'); } catch (e) { } const e = redeem(p, j.code); if (!e) return out(400, { ok: false, error: 'That code is not valid.' }); out(200, { ok: true, ent: e, account: !!p }); }); }
/* Atlas over plain HTTP: lets Campaign mode (no account needed) browse and play the hubs; likes need the multiplayer login token (x-token) */
const httpHits = new Map();
function atlasHttp(req, res, cors) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  const out = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors }); res.end(JSON.stringify(o)); };
  const hb = httpHits.get(ip) || { t: now(), n: 0 }; if (now() - hb.t > 60000) { hb.t = now(); hb.n = 0; } hb.n++; httpHits.set(ip, hb); if (httpHits.size > 5000) httpHits.clear();
  const u = new URL(req.url, 'http://x'), parts = u.pathname.split('/').filter(Boolean); // ['atlas', kind, id]
  const tok = req.headers['x-token'], viewer = typeof tok === 'string' && tok ? players.get(tokenIdx.get(sha(tok))) || null : null;
  const pub = id => { const t = players.get(String(id || '').replace(/\.jpg$/, '')); return t && t.hub && t.hub.has && t.hub.public ? t : null; };
  if (parts[1] === 'shot') { const t = pub(parts[2]), img = t && getBlob('shot', t.id); if (!img) { res.writeHead(404, cors); return res.end(); } res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=600', ...cors }); return res.end(img); }
  if (hb.n > 120) return out(429, { ok: false, error: 'slow down' });
  if (req.method === 'GET' && parts.length === 1) return out(200, { ok: true, ...atlasList(viewer, u.searchParams.get('sort'), u.searchParams.get('q'), +u.searchParams.get('page') || 0) });
  const t = pub(parts[2]); if (!t) return out(404, { ok: false, error: 'not found' });
  if (req.method === 'GET' && parts[1] === 'entry') return out(200, { ok: true, row: atlasEntry(t, viewer) });
  if (req.method === 'GET' && parts[1] === 'hub') { const scenes = getBlob('hub', t.id); if (!scenes) return out(404, { ok: false }); if (!viewer || viewer.id !== t.id) countPlay(t, viewer ? 'p:' + viewer.id : 'i:' + ip); return out(200, { ok: true, id: t.id, name: t.name, scenes }); }
  if (req.method === 'POST' && (parts[1] === 'like' || parts[1] === 'done')) {
    let body = ''; req.on('data', d => { body += d; if (body.length > 2000) req.destroy(); });
    req.on('end', () => { let j = {}; try { j = JSON.parse(body || '{}'); } catch (e) { }
      if (parts[1] === 'like') { if (!viewer) return out(401, { ok: false, error: 'Sign in to Multiplayer once to like hubs.' }); if (!setLike(t, viewer, !!j.on)) return out(400, { ok: false, error: 'You can’t like your own hub.' }); return out(200, { ok: true, row: atlasEntry(t, viewer) }); }
      if (viewer && viewer.id === t.id) return out(200, { ok: true, row: atlasEntry(t, viewer) });
      const r = countDone(t, viewer ? 'p:' + viewer.id : 'i:' + ip, j.sec); if (r && r.sec > 5 && (!t.hub.best || r.sec < t.hub.best.sec)) { t.hub.best = { sec: r.sec, name: viewer ? viewer.name : cleanText(j.name, 16) || 'A campaign champion', id: viewer ? viewer.id : null }; markDirty(); }
      return out(200, { ok: true, cleared: !!r, row: atlasEntry(t, viewer) }); });
    return;
  }
  return out(404, { ok: false });
}
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024, verifyClient: (info, cb) => { if (!ORIGINS.length) return cb(true); const o = info.origin || ''; cb(ORIGINS.some(x => o === x || o.startsWith(x)), 403, 'origin not allowed'); } });
wss.on('connection', (ws, req) => { ws._req = req;
  const c = { ws, alive: true, p: null, id: null, room: null, party: null, x: 0, y: 0, z: 0, f: 0, s: 0, a: 0, scene: null };
  c.ip = (ws._req && ws._req.headers && String(ws._req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || (ws._socket && ws._socket.remoteAddress) || ''; ws.on('pong', () => { c.alive = true; });
  let cnt = 0, t0 = now(); ws.on('message', d => { const t = now(); if (t - t0 > 1000) { t0 = t; cnt = 0; } if (++cnt > 80) return; try { onMessage(c, d.toString()); } catch (e) { console.error('msg error', e.message); } });
  ws.on('close', () => dropConn(c)); ws.on('error', () => { });
  setTimeout(() => { if (!c.p) { try { ws.close(); } catch (e) { } } }, 15000);
});
setInterval(backup, 3600000); setTimeout(backup, 60000);
server.listen(PORT, () => console.log(`Neon Codex Massive server on :${PORT} · data in ${DATA_DIR} · wix=${SECRET ? 'on' : 'off'} · origins=${ORIGINS.join(',') || '*'}`));
module.exports = { server, wss, players, guilds, hmac, flush, PERSISTENT };
