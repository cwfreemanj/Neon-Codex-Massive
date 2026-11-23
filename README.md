# Neon Codex Massive — multiplayer server

One small Node process: a WebSocket game server (hub rooms of 50, chat, friends, parties + Ready Up, guilds, quests,
leaderboards, shared player hubs) plus two HTTP endpoints (`/health`, `/wix/credit`). Saves to two JSON files in `DATA_DIR`.

```
npm install
npm test                      # 50-check smoke test (spawns its own server on a temp folder)
PORT=8080 DATA_DIR=./data node server.js
```

## 1 · Deploy on Railway (≈10 minutes)

1. Push this `server/` folder to a GitHub repo (the `.gitignore` already excludes `node_modules` and `data`).
2. Railway → **New Project → Deploy from GitHub repo** → pick it. Railway detects Node and runs `npm start`.
3. **Add a Volume** (Settings → Volumes) mounted at `/data`. *Without a volume all accounts and guilds are wiped on every redeploy.*
4. **Variables**:

| Variable | Value |
|---|---|
| `DATA_DIR` | `/data` |
| `WIX_SHARED_SECRET` | a long random string (e.g. `openssl rand -hex 32`) — the same one goes into Wix Secrets Manager |
| `ALLOWED_ORIGINS` | comma list of sites allowed to connect, e.g. `https://yourname.github.io,https://www.yoursite.com` (empty = allow all) |
| `DEV_GRANT` | leave unset in production (`1` lets any client give itself free stars — testing only) |

5. Settings → **Networking → Generate domain**. Your game address is `wss://<that-domain>` (check `https://<that-domain>/health`).
6. Open `hub_showcase.html`, find `<script id="nca-config">` near the top and put the address in `server:`.
   For a quick test without editing, add `?server=wss://<domain>` to the page URL (the game remembers it).

Railway restarts: the server flushes to disk on SIGTERM and every 1.5 s after a change, writes are atomic (temp file + rename).
One instance only — rooms live in memory, so don't scale to several replicas (a 50-per-room hub with a few hundred players fits one small instance).

## 2 · GitHub Pages (the game file)

Commit `hub_showcase.html` as `index.html` to a repo with Pages enabled. Nothing else is needed: it is one self-contained file.
Add the Pages origin to `ALLOWED_ORIGINS`.

## 3 · Wix (embed + star purchases)

**Embed:** Add → Embed Code → *Embed a site* with your GitHub Pages URL (or paste the file in an HTML component). Make it full-width, ~800 px tall.

**Money flow (the game never touches card data):**

```
game ──ready──▶ Wix page code ──identity {id,ts,sig}──▶ game          (links the Wix member to the game account)
game ──buy sku──▶ Wix page code ──startPayment──▶ Wix Pay checkout
Wix backend (on payment success) ──POST /wix/credit {memberId, orderId, stars}  + HMAC header──▶ this server ──ws {t:'stars'}──▶ game
```

Put the shared secret in **Wix Secrets Manager** as `NCA_SECRET`, the server URL as `NCA_SERVER_HTTP` (e.g. `https://xxxx.up.railway.app`).

### `backend/nca.web.js` (Velo backend web module)

```js
import { getSecret } from 'wix-secrets-backend';
import { fetch } from 'wix-fetch';
import { currentMember } from 'wix-members-backend';
import { createHmac } from 'crypto';

const PACKS = {                      // the ONLY place that decides what a purchase is worth
  stars_100:  { stars: 100,  price: 0.99 },
  stars_550:  { stars: 550,  price: 4.99 },
  stars_1200: { stars: 1200, price: 9.99 },
  stars_2600: { stars: 2600, price: 19.99 },
  stars_7000: { stars: 7000, price: 49.99 },
};

export async function getIdentity() {                 // called by the page; proves who the member is
  const m = await currentMember.getMember();
  if (!m) return null;
  const secret = await getSecret('NCA_SECRET');
  const ts = Date.now();
  return { id: m._id, ts, sig: createHmac('sha256', secret).update(m._id + '|' + ts).digest('hex') };
}

export async function createOrder(sku) {              // returns a Wix Pay payment id
  const p = PACKS[sku]; if (!p) throw new Error('bad sku');
  const m = await currentMember.getMember(); if (!m) throw new Error('login required');
  const wixPay = await import('wix-pay-backend');
  const payment = await wixPay.createPayment({ items: [{ name: `${p.stars} Stars`, price: p.price }], amount: p.price, currency: 'USD' });
  return { paymentId: payment.id, sku, memberId: m._id };
}

export async function creditStars(paymentId, sku, memberId) {   // call after the payment succeeded
  const wixPay = await import('wix-pay-backend');
  const pay = await wixPay.getPaymentStatus?.(paymentId);       // verify server-side that it really was paid
  if (pay && pay.status !== 'Successful') throw new Error('not paid');
  const p = PACKS[sku]; const secret = await getSecret('NCA_SECRET');
  const body = JSON.stringify({ memberId, orderId: paymentId, stars: p.stars, sku });
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  const url = (await getSecret('NCA_SERVER_HTTP')) + '/wix/credit';
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig }, body });
  return r.json();
}
```

### Page code (the page that holds the HTML component, say `#game`)

```js
import wixPay from 'wix-pay-frontend';
import { getIdentity, createOrder, creditStars } from 'backend/nca.web';

$w.onReady(() => {
  $w('#game').onMessage(async (event) => {
    const m = event.data; if (!m || m.source !== 'nca') return;
    if (m.type === 'ready') {
      const id = await getIdentity();
      if (id) $w('#game').postMessage({ source: 'wix', type: 'identity', ...id });
    }
    if (m.type === 'buy') {
      try {
        const o = await createOrder(m.sku);
        const res = await wixPay.startPayment(o.paymentId);
        if (res.status === 'Successful' || res.status === 'Offline') {
          await creditStars(o.paymentId, o.sku, o.memberId);
          $w('#game').postMessage({ source: 'wix', type: 'buyResult', ok: true });
        } else $w('#game').postMessage({ source: 'wix', type: 'buyResult', ok: false, error: 'Payment was not completed.' });
      } catch (e) { $w('#game').postMessage({ source: 'wix', type: 'buyResult', ok: false, error: 'Something went wrong.' }); }
    }
  });
});
```

> Wix Velo's payment API names change between versions — treat the two snippets as a template and check them against the current
> `wix-pay-backend` / `wix-pay-frontend` docs. What matters to this server is only the last step: a **signed POST** to `/wix/credit`.

**What the server checks on `/wix/credit`:** `x-signature` must equal `HMAC_SHA256(WIX_SHARED_SECRET, rawBody)`; `orderId` is idempotent (a retry never pays twice);
if the member hasn't linked a game account yet the stars wait and are released the first time that member signs in.

**Testing without Wix:** run the server with `DEV_GRANT=1` and open the game with `?wixtest=1` — the shop then fakes a checkout and credits stars.

## 4 · Accounts

* Default: a name + a random secret token kept in the browser (`localStorage`). Only the SHA-256 of the token is stored on the server.
* Inside Wix: the page sends a signed identity; the account is linked to that Wix member, so signing in on a new device just works.
* Names are 3–16 characters, unique (case-insensitive), with a small profanity filter. Chat is filtered and rate-limited.

## 5 · Protocol (JSON over WebSocket) — for reference

Client → server: `hello{name,token?,wix?,hero,pal}` · `join{scene,inst?}` · `pos{x,y,z,f,s,a,k,u}` (10 Hz) · `appear` · `chat{ch:room|party|guild|whisper,to,text}` ·
`profile{id}` · `friend{op:add|accept|decline|remove|list,id}` · `party{op:invite|accept|decline|leave|kick|promote}` · `ready{op:start|answer|cancel}` ·
`guild{op:info|list|create|invite|accept|join|leave|kick|rank|edit|disband|claim}` · `lb{cat}` · `quests` / `qclaim{i}` · `stat{levels,kills,chapters,bosses}` ·
`ev{k,n}` · `stat{levels,pres,…}` · `stars{d}` · `hubpub{scenes,public}` / `hubget{id}` · `save{blob}` / `loadsave`.

Server → client: `welcome`, `room`, `join`, `leave`, `snap`, `appear`, `chat`, `notice`, `invite`, `party`, `ready`, `ready_state`, `ready_end`, `go`,
`friends`, `guild`, `guilds`, `lb`, `quests`, `stars`, `profile`, `hubdata`, `hubpub`, `savedata`, `saved`, `denied`, `kicked`.

## 6 · Game features that touch the server

* **Prestige:** each champion can prestige at level 30 (stat ranks then count ×(1+0.1·prestige), max 25). The client reports it in `hello` / `appear` (`pr`) and `stat` (`pres`); the server clamps to 0–25, shows it to other players and adds 30 power per prestige to the power leaderboard.
* **Difficulty (Easy/Medium/Hard per chapter)** is entirely client-side.
* **Training Grounds** (one arena per champion, medals saved in your own save data) are client-only and solo: the client joins them as a plain scene, so the server treats them like any other solo scene and nobody else is shown. Nothing is earned there, so no star/XP traffic reaches the server.
* **Client updates in this bundle** (all client-side, no server change needed): room culling, wall-run/wall-jump, Esc-frees-mouse-first, shatter deaths, enemy colliders, softer hit-stop, prestige auras, Training Grounds. `client/hub_showcase.html` is the matching game file – commit it as `index.html` for GitHub Pages.

## 7 · Honest limits

* **Enemies and combat are not shared.** Every player simulates their own enemies; in a party instance you see your friends move, act and chat, but each client fights its own copy of the monsters.
* The server holds the **star balance** and caps how fast stars can be earned (400/min) and rejects spending more than the balance, but combat results come from the client, so a determined cheater could still inflate kills/levels. Leaderboards are trust-based.
* Everything is in memory + JSON files: fine for hundreds of players, not for tens of thousands.

### Wall-jump hardening + F8 readout
- A Space press next to a wall while airborne now always kicks off (even if the "catch" was lost after an attack/ability).
- Press **F8** in-game for a small live readout of the wall-jump state and the reason the last jump press did or didn't kick.
- **Wall-jump guard**: a final per-frame check (runs last in the player update) that forces the correct wall state — pending kicks always fire, the launch force can't be swallowed, wall-running can't stall while attached, and the run/flip animation overrides attack/hurt poses. F8 shows how often it had to step in.

## Update: elites, codex, prices, guild hill
- Chapters 4+ spawn 60% fewer foes per room; remaining foes scale up with chapter and room (`elites.js`).
- Random Elites (generated chapters 2-7): Rare (blue), Epic (purple), Legendary (yellow), Mythic (red-violet) - larger, with auras, ground novas from Epic up, richer XP/star rewards.
- Codex rebuilt (`codex.js`): Overview stats, per-champion pages, per-foe bio/attributes/record, Elites tab. Stats are tracked from this version on.
- Build-hub prices x5 (client-side `PRICE_X` in builder.js; server unchanged).
- Guild Hall now stands on a hill beside the hub town in campaign and multiplayer (existing saved hubs are migrated once).
- F8 wall-jump overlay now shows the last 7 events plus build stamp.
- Wall jump: final bone-level enforcement (`enforcePose` in walljump.js) re-applies the wall-run stride / flip after every other animation writer each frame; F8 overlay shows live rig values (legs, rootX, enforced count).

## Update: Alita, evasion, stagger resistance, ground hazards, bigger hotbar
- **New champion: Alita, the Knife Dancer** (900 stars). Wall-jumps like Akira/Vesper. Basic attack = fast throwing knives (small hitboxes); abilities: Knife Barrage (30 knives), Smoke Bomb (+65% evasion for you inside the cloud, foes inside slowed), Freeze Bomb (freezes an area), Fire Bomb (burns an area), Slipstream dash, Backflip Volley. Server `HEROES` list updated (`server/server.js`); Training Grounds arena "Knife Court" added.
- **Stagger / stun resistance** (`evasion.js`): ordinary foes resist 20-50% of staggers, heavy foes 75-90%, elites 75-90% by rarity, bosses 85-90%. A resisted hit still deals damage but does not stagger; the foe keeps moving and attacking.
- **Evasion**: new "Evasion" stat for every champion (max rank 10, +2.5% each, shown in the stat sheet; Alita has 12% innate, Vesper 10%, Akira 8%). Dodged attacks deal no damage ("DODGE"). Quick/slippery foes, elites and bosses can dodge your hits ("MISS"). Codex tracks dodges/misses.
- **Ground hazards** (`hazards.js`): The Maw and Acid Spitter spit toxic sludge (damage + poison); Vexis and Rift Mender throw frost patches (freeze); Cindermaw Colossus and Cinder Bomber throw fire patches (damage + burn); Hollow Queen and Rift Mender open pulling rifts; the Void Sovereign uses all four. Minion versions are smaller and weaker. Status chips (Frozen / Poisoned / Burning / Evasive) appear above the hotbar. Client-side only, no server change.
- **Hotbar**: larger ability names, big gold key badges, and a numeric cooldown timer on every slot (decimals under 10s).
- Fast thin projectiles (knives) now use a swept hit test so they can't tunnel through foes on slow frames.

## Update: room-clear fix, build-mode lock-down, Alita tweak
- **Rooms that could not be cleared (e.g. Chapter 3 room 1):** two causes, both fixed client-side.
  1. Kill objectives counted the *unscaled* spawner size, but Easy spawns ~20% fewer foes (Hard spawns more), so the tracker asked for foes that never existed (13 needed / 10 spawned). `stepDone` in `play.js` now uses the same difficulty-scaled count as the spawner.
  2. Foes could spawn inside walls or props (a few in every chapter) and sit unseen. New `rescue.js` lifts foes onto free ground the moment they spawn and re-checks every 1.5s, and audits the active kill objective: a spawn slot with no living foe is counted as cleared, so the way forward can't be blocked.
- **Build mode:** the cursor is always visible (a play-mode reticle was leaving it hidden). Build mode can only ever be open on the player's own hub builds; the central hub, chapters and visited hubs can't be edited in Campaign or Multiplayer (even on a device that once used `?dev=1`; author tools now need `?dev=1` remembered **and** `?author=1` in the URL).
- **Alita:** basic knife attack is 40% slower.

## Update: living spawners in player hubs, shard colours
- **Placed creatures now fight.** Creatures dropped from the build palette were static props; in playtest/visit they are replaced by real enemies of the same kind at the same spot (respawn 10s, bosses 60s).
- **Spawners are rift crystals** (the enlarged anchor-crystal look: purple for enemy spawners, fire-orange for boss spawners) and stay visible in playtest. They keep respawning their foes: each dead foe returns after the spawner's **respawn (s)** field (minimum 5, default 10, boss 60; players can raise it). **Max 5 foes per spawner** (older saves are clamped).
- **Fresh every entry:** in player-built scenes (own hub playtest and visited hubs) kills are never saved, so foes and spawners are back each time you re-enter. Enemies are simulated per player (see "Honest limits"), so a visitor killing everything never changes what another visitor sees; the server already lets up to 50 players share one hub room (`h:<owner>:<scene>`).
- **Glass shards** from dead enemies now keep the enemy's own palette (body-part colours nudged toward its accent colour, only lightly whitened); the burst flashes use the same tint.

## Renamed: Neon Codex Massive
The game is now **Neon Codex Massive** (browser tab title, loading screen, top-left logo, main menu, server banner/README/package description). Internal identifiers are unchanged so nothing breaks: save keys (`nca_*`), the `nca_server` folder/zip name, the `neon-codex-server` package name, the `/health` `game: 'neon-codex'` field and the Railway URL. In-story mentions of "the Neon Codex" (the book the chapters are about) are lore and stay.

## Update: full mobile support (phones & tablets)
The game file now detects touch devices and switches to a mobile layout. Desktop is unchanged: on a mouse/keyboard computer none of the mobile code runs.
- **Detection & landscape**: phones/tablets are detected automatically (`?mobile=1` forces the touch version, `?mobile=0` the desktop version, `?mobile=auto` resets; the choice is remembered on that device). Portrait shows a "rotate your device" screen. The first tap enters full screen (Android, iPad) and locks landscape. iPhone Safari has no full-screen API for web pages, so players use Share → Add to Home Screen.
- **Layout**: the desktop interface is laid out on a virtual screen ≥540 px tall and scaled to the phone, so every menu, panel and dialog keeps its desktop layout. In windowed mode this uses the viewport meta tag; in full screen (where Chrome ignores it) it uses CSS zoom, and the page sees one consistent virtual coordinate space. Phones start on the "medium" graphics preset with a capped pixel ratio (auto-quality still adapts).
- **Play controls**: floating move stick on the left half (drag past the ring or tap 🏃 to sprint), drag the right half to look, pinch to zoom. The real hotbar becomes a thumb cluster: ATTACK (tap / hold for combos or bow draw, drag it to aim), abilities 1-4 on an arc, extra abilities in a bottom row, ROLL, BLOCK (hold), JUMP. Cooldowns, mana and icons stay live. The interact prompt is a big TAP button. ⏸ pauses; ☰ opens every keyboard-only function (champion, chapters, journal, attributes, codex, build, studio, camera, free aim, sound, chat/social/profile in multiplayer) plus touch settings (button size, look speed, left/right-handed, invert, vibration).
- **Build mode**: 1 finger selects/drags/paints, drag-then-lift to place, 1 finger on empty ground orbits, 2 fingers pan + pinch-zoom; an action bar rotates/scales/raises/lowers/focuses/copies/deletes; side panels collapse with edge tabs.
- **Design Studio**: 1 finger orbits / moves parts, 2 fingers pan + pinch-zoom.
- **Text**: the tutorial, journal controls list, dialogue footer and studio hints describe touch controls on mobile; the tutorial's steps and goals are unchanged.
- **Integrity**: touch controls drive the same code paths as keyboard/mouse (synthetic key/mouse events and the camera variables mouse-look writes), so combat, abilities, cooldowns, tutorial tracking, multiplayer and saves are untouched. No server change.
- **Wix embed**: for full screen inside the Wix iframe, the iframe needs `allow="fullscreen"`.
