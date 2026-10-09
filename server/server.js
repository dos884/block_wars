// Block Wars server: players, matches, quick play and "your turn" notifications, stored in SQLite.
// Every turn is checked by replaying it with the same sim code the browser runs (sim-core.js).
// No framework and no npm dependencies: node:http, node:sqlite and node:crypto only.
//
// Players are guests by default: POST /api/players gives a secret token, sent as "Authorization: Bearer <token>".
// Linking a Google account lets the same player sign in on another device.
//
//   GET  /api/config                         → { googleClientId, vapidKey }
//   POST /api/players                        → { id, token, name }             new guest player
//   GET  /api/me                             → { id, name, google, searching, games: [...] }
//   POST /api/me                  { name }   → rename
//   POST /api/me/google     { credential }   → { id, name, switched }          link Google, or become the linked player
//   POST /api/me/push     { subscription }   → store a Web Push subscription
//   POST /api/quick                          → { match } or { waiting: true }  quick play: pair with whoever waits
//   GET  /api/quick                          → { match } | { waiting } | {}    waits up to 25 s for a pairing
//   DELETE /api/quick                        → stop searching
//   POST /api/matches                        → { id }                          invite match, you are Blue
//   POST /api/matches/:id/join               → { team: 1 }                     take the Red seat
//   GET  /api/matches/:id?since=n&rev=r      → { rev, you, names, winner, count, turns } waits ≤25 s if rev is current
//   POST /api/matches/:id/turns  { n, groups, hash }                            submit turn n; replayed and checked
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const B = require(process.env.SIM_CORE || path.join(__dirname, '..', 'sim-core.js'));

const PORT = +process.env.PORT || 8787;
const DB_PATH = process.env.DB || path.join(__dirname, 'dev.sqlite');
const DATA_DIR = path.dirname(DB_PATH);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const PUSH_CONTACT = process.env.PUSH_CONTACT || 'https://cubewars.io';
const STATIC = process.env.STATIC;             // dev/tests only: also serve the game files (Caddy does it in production)
const MAX_BODY = 512 * 1024;
const WAIT_MS = 25000;
const CACHE_SIZE = 24;                         // live sim states kept in memory (~7 MB each)
const MAX_OPEN_GAMES = 30;                     // unfinished matches per player
const SEARCH_FOR = 24 * 3600e3;                // a quick-play search lasts a day: it's turn-based, nobody has to wait live

/* ---------- Storage ---------- */
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, google TEXT UNIQUE, created INTEGER NOT NULL, seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (           -- one per device; token = sha256 of the device's secret
    token TEXT PRIMARY KEY, player TEXT NOT NULL, created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY, created INTEGER NOT NULL, updated INTEGER NOT NULL,
    t0 TEXT NOT NULL, t1 TEXT,                 -- old invite matches: sha256 of each seat's token
    rev INTEGER NOT NULL DEFAULT 0,            -- bumps on every change, for long-polling
    turns INTEGER NOT NULL DEFAULT 0, winner INTEGER NOT NULL DEFAULT -1
  );
  CREATE TABLE IF NOT EXISTS turns (
    match TEXT NOT NULL, n INTEGER NOT NULL, team INTEGER NOT NULL,
    body TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL,
    PRIMARY KEY (match, n)
  );
  CREATE TABLE IF NOT EXISTS queue (
    player TEXT PRIMARY KEY, created INTEGER NOT NULL, matched TEXT
  );
  CREATE TABLE IF NOT EXISTS pushsubs (
    endpoint TEXT PRIMARY KEY, player TEXT NOT NULL, sub TEXT NOT NULL, created INTEGER NOT NULL
  );
`);
// Matches got player seats (p0 = Blue, p1 = Red) and a kind after the first release.
const cols = db.prepare('PRAGMA table_info(matches)').all().map(c => c.name);
if (!cols.includes('p0')) db.exec(`ALTER TABLE matches ADD COLUMN p0 TEXT; ALTER TABLE matches ADD COLUMN p1 TEXT;
  ALTER TABLE matches ADD COLUMN kind TEXT NOT NULL DEFAULT 'invite';
  CREATE INDEX IF NOT EXISTS matches_p0 ON matches (p0); CREATE INDEX IF NOT EXISTS matches_p1 ON matches (p1);`);

const q = {
  insertPlayer: db.prepare('INSERT INTO players (id, name, created, seen) VALUES (?, ?, ?, ?)'),
  insertSession: db.prepare('INSERT INTO sessions (token, player, created) VALUES (?, ?, ?)'),
  playerByToken: db.prepare('SELECT players.* FROM sessions JOIN players ON players.id = sessions.player WHERE sessions.token = ?'),
  moveSessions: db.prepare('UPDATE sessions SET player = ? WHERE player = ?'),
  playerByGoogle: db.prepare('SELECT * FROM players WHERE google = ?'),
  playerName: db.prepare('SELECT name FROM players WHERE id = ?'),
  seen: db.prepare('UPDATE players SET seen = ? WHERE id = ?'),
  rename: db.prepare('UPDATE players SET name = ? WHERE id = ?'),
  linkGoogle: db.prepare('UPDATE players SET google = ? WHERE id = ?'),
  moveSeats0: db.prepare('UPDATE matches SET p0 = ? WHERE p0 = ? AND (p1 IS NULL OR p1 != ?)'),
  moveSeats1: db.prepare('UPDATE matches SET p1 = ? WHERE p1 = ? AND (p0 IS NULL OR p0 != ?)'),
  insertMatch: db.prepare('INSERT INTO matches (id, created, updated, t0, p0, p1, kind) VALUES (?, ?, ?, \'\', ?, ?, ?)'),
  getMatch: db.prepare('SELECT * FROM matches WHERE id = ?'),
  join: db.prepare('UPDATE matches SET p1 = ?, rev = rev + 1, updated = ? WHERE id = ? AND p1 IS NULL AND t1 IS NULL AND p0 != ?'),
  myGames: db.prepare(`SELECT * FROM matches WHERE p0 = ? OR p1 = ? ORDER BY (winner < 0) DESC, updated DESC LIMIT 50`),
  openGames: db.prepare('SELECT COUNT(*) n FROM matches WHERE (p0 = ? OR p1 = ?) AND winner < 0'),
  turnsFrom: db.prepare('SELECT n, team, body FROM turns WHERE match = ? AND n >= ? ORDER BY n'),
  getTurn: db.prepare('SELECT body FROM turns WHERE match = ? AND n = ?'),
  insertTurn: db.prepare('INSERT INTO turns (match, n, team, body, hash, created) VALUES (?, ?, ?, ?, ?, ?)'),
  afterTurn: db.prepare('UPDATE matches SET turns = turns + 1, rev = rev + 1, winner = ?, updated = ? WHERE id = ?'),
  queued: db.prepare('SELECT * FROM queue WHERE player = ?'),
  enqueue: db.prepare('INSERT OR REPLACE INTO queue (player, created, matched) VALUES (?, ?, NULL)'),
  oldestWaiting: db.prepare('SELECT * FROM queue WHERE matched IS NULL AND player != ? AND created > ? ORDER BY created LIMIT 1'),
  setMatched: db.prepare('UPDATE queue SET matched = ? WHERE player = ?'),
  dequeue: db.prepare('DELETE FROM queue WHERE player = ?'),
  expireQueue: db.prepare('DELETE FROM queue WHERE matched IS NULL AND created < ?'),
  addSub: db.prepare('INSERT OR REPLACE INTO pushsubs (endpoint, player, sub, created) VALUES (?, ?, ?, ?)'),
  subsOf: db.prepare('SELECT * FROM pushsubs WHERE player = ?'),
  dropSub: db.prepare('DELETE FROM pushsubs WHERE endpoint = ?'),
  moveSubs: db.prepare('UPDATE pushsubs SET player = ? WHERE player = ?'),
};

const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const newId = n => crypto.randomBytes(n).toString('base64url');
const nameOf = id => (id && q.playerName.get(id) || {}).name || null;

/* ---------- Names: friendly defaults, and a light clean-up of what people type ---------- */
const ADJ = ['Brave', 'Sneaky', 'Mighty', 'Clever', 'Rusty', 'Jolly', 'Swift', 'Sturdy', 'Lucky', 'Bold', 'Quiet', 'Grumpy', 'Happy', 'Wild', 'Tiny', 'Giant'];
const NOUN = ['Badger', 'Beaver', 'Mole', 'Otter', 'Golem', 'Knight', 'Digger', 'Builder', 'Archer', 'Fox', 'Owl', 'Yak', 'Llama', 'Gecko', 'Panda', 'Moose'];
const randomName = () => ADJ[crypto.randomInt(ADJ.length)] + ' ' + NOUN[crypto.randomInt(NOUN.length)];
const cleanName = s => String(s || '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);

/* ---------- Live states: a match replayed up to its last turn ---------- */
const cache = new Map();                       // id → { S, n }, in least-recently-used order
function liveState(id) {
  let c = cache.get(id);
  if (c) { cache.delete(id); cache.set(id, c); return c; }
  const S = B.newState();
  const rows = q.turnsFrom.all(id, 0);
  for (const r of rows) {
    const err = B.replayTurn(S, JSON.parse(r.body));
    if (err) throw new Error(`stored match ${id} turn ${r.n} no longer replays: ${err}`);
  }
  c = { S, n: rows.length };
  cache.set(id, c);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return c;
}

/* ---------- Long-poll waiters, per match and per player's quick-play search ---------- */
const waiters = new Map();                     // key → Set of { wake, player }
function wait(key, player, req, onWake) {
  let done = false;
  const w = { player, wake: () => { if (done) return; done = true; clearTimeout(timer); set.delete(w); onWake(); } };
  const set = waiters.get(key) || new Set();
  waiters.set(key, set); set.add(w);
  const timer = setTimeout(w.wake, WAIT_MS);
  req.on('close', () => { if (!done) { done = true; clearTimeout(timer); set.delete(w); } });
}
function notify(key) {
  const set = waiters.get(key);
  if (!set) return;
  waiters.delete(key);
  for (const w of set) w.wake();
}
const watching = (key, player) => [...(waiters.get(key) || [])].some(w => w.player === player);

/* ---------- Web Push, without a library ----------
   Pushes carry no payload (so nothing needs encrypting): the service worker asks /api/me what's new.
   The server signs each push with its VAPID key (ES256 JWT), generated once and kept next to the database. */
const vapid = (() => {
  const file = path.join(DATA_DIR, 'vapid.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first start */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const v = { publicKey: raw.toString('base64url'), privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }) };
  fs.writeFileSync(file, JSON.stringify(v), { mode: 0o600 });
  return v;
})();
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin, exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const unsigned = b64({ typ: 'JWT', alg: 'ES256' }) + '.' + b64({ aud, exp, sub: PUSH_CONTACT });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `vapid t=${unsigned}.${sig}, k=${vapid.publicKey}`;
}
async function push(player) {
  for (const row of q.subsOf.all(player)) {
    try {
      const r = await fetch(row.endpoint, { method: 'POST', headers: { authorization: vapidHeader(row.endpoint), ttl: '86400', urgency: 'high', 'content-length': '0' } });
      if (r.status === 404 || r.status === 410) q.dropSub.run(row.endpoint);      // the browser unsubscribed
      else if (!r.ok) console.warn(`push to ${new URL(row.endpoint).host}: ${r.status}`);
    } catch (e) { console.warn('push failed: ' + e.message); }
  }
}
// Tell everyone watching a match that it changed, and push to the other player unless they're watching it.
// (Check who's watching before waking the long-polls: waking them ends their wait.)
function changed(match, other) {
  const away = other && !watching(match, other);
  notify(match);
  if (away) push(other);
}

/* ---------- Google sign-in: verify the ID token Google's button hands the page ---------- */
let googleKeys = { at: 0, keys: [] };
async function googleKey(kid) {
  if (Date.now() - googleKeys.at > 3600e3 || !googleKeys.keys.some(k => k.kid === kid)) {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    googleKeys = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = googleKeys.keys.find(k => k.kid === kid);
  return jwk && crypto.createPublicKey({ key: jwk, format: 'jwk' });
}
async function verifyGoogle(credential) {
  const [h, p, s] = String(credential || '').split('.');
  if (!h || !p || !s) return null;
  const head = JSON.parse(Buffer.from(h, 'base64url')), body = JSON.parse(Buffer.from(p, 'base64url'));
  if (head.alg !== 'RS256') return null;
  const key = await googleKey(head.kid);
  if (!key || !crypto.verify('sha256', Buffer.from(h + '.' + p), key, Buffer.from(s, 'base64url'))) return null;
  const okIss = body.iss === 'accounts.google.com' || body.iss === 'https://accounts.google.com';
  if (!okIss || body.aud !== GOOGLE_CLIENT_ID || !(body.exp * 1000 > Date.now()) || !body.sub) return null;
  return body;
}

/* ---------- Abuse limits: per address per hour ---------- */
const hits = new Map();
function allow(kind, ip, max) {
  const key = kind + ip, now = Date.now(), list = (hits.get(key) || []).filter(t => now - t < 3600e3);
  if (list.length >= max) return false;
  list.push(now); hits.set(key, list);
  return true;
}
setInterval(() => { hits.clear(); q.expireQueue.run(Date.now() - SEARCH_FOR); }, 3600e3).unref();

/* ---------- HTTP helpers ---------- */
class Fail extends Error { constructor(code, msg) { super(msg); this.code = code; } }
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((ok, bad) => {
    let size = 0; const parts = [];
    req.on('data', d => { size += d.length; if (size > MAX_BODY) { bad(new Fail(413, 'too big')); req.destroy(); } else parts.push(d); });
    req.on('end', () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts)) : {}); } catch { bad(new Fail(400, 'bad json')); } });
    req.on('error', bad);
  });
}
function whoIs(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  const p = m && q.playerByToken.get(sha(m[1]));
  if (p && Date.now() - p.seen > 60e3) q.seen.run(Date.now(), p.id);
  return p || null;
}
const need = p => { if (!p) throw new Fail(401, 'sign in first'); return p; };
const seatOf = (m, p) => !p ? -1 : m.p0 === p.id ? 0 : m.p1 === p.id ? 1 : -1;

function gameSummary(m, me) {
  const team = seatOf(m, me), opp = team === 0 ? m.p1 : m.p0;
  return { id: m.id, kind: m.kind, team, opponent: nameOf(opp), joined: !!(m.p1 || m.t1), turns: m.turns, winner: m.winner,
           myTurn: m.winner < 0 && m.turns % 2 === team && !!(m.p1 || m.t1 || m.turns === 0), updated: m.updated };
}
function matchView(m, since, me) {
  const turns = q.turnsFrom.all(m.id, since).map(r => ({ n: r.n, team: r.team, ...JSON.parse(r.body) }));
  return { id: m.id, rev: m.rev, you: seatOf(m, me), names: [nameOf(m.p0), nameOf(m.p1)], players: [true, !!(m.p1 || m.t1)],
           winner: m.winner, count: m.turns, turns };
}
function createMatch(kind, p0, p1) {
  const id = newId(6), now = Date.now();
  q.insertMatch.run(id, now, now, p0, p1, kind);
  return id;
}

/* ---------- Routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  if (STATIC && parts[0] !== 'api') return serveStatic(url, res);
  if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  const now = Date.now(), route = req.method + ' ' + parts.slice(1, 3).join('/');
  const me = whoIs(req);

  if (route === 'GET config') return send(res, 200, { googleClientId: GOOGLE_CLIENT_ID || null, vapidKey: vapid.publicKey });

  if (route === 'POST players') {
    if (!allow('player', ip, 60)) throw new Fail(429, 'too many new players from here, try again later');
    const token = newId(24), id = newId(8), name = randomName();
    q.insertPlayer.run(id, name, now, now);
    q.insertSession.run(sha(token), id, now);
    return send(res, 201, { id, token, name });
  }

  if (parts[1] === 'me') {
    need(me);
    if (route === 'GET me') {
      const games = q.myGames.all(me.id, me.id).map(m => gameSummary(m, me));
      const queued = q.queued.get(me.id);
      return send(res, 200, { id: me.id, name: me.name, google: !!me.google, searching: !!queued && !queued.matched, games });
    }
    const body = await readJson(req);
    if (route === 'POST me') {
      const name = cleanName(body.name);
      if (!name) throw new Fail(400, 'pick a name');
      q.rename.run(name, me.id);
      return send(res, 200, { name });
    }
    if (route === 'POST me/google') {
      if (!GOOGLE_CLIENT_ID) throw new Fail(404, 'Google sign-in is not set up');
      const g = await verifyGoogle(body.credential).catch(() => null);
      if (!g) throw new Fail(401, 'Google sign-in failed');
      const owner = q.playerByGoogle.get(g.sub);
      if (!owner) { q.linkGoogle.run(g.sub, me.id); return send(res, 200, { id: me.id, name: me.name }); }
      if (owner.id === me.id) return send(res, 200, { id: me.id, name: me.name });
      // This Google account already has a player (from another device): this device becomes that player,
      // and brings along whatever it played as a guest. The device keeps its token.
      q.moveSeats0.run(owner.id, me.id, owner.id); q.moveSeats1.run(owner.id, me.id, owner.id);
      q.moveSubs.run(owner.id, me.id);
      q.moveSessions.run(owner.id, me.id);
      return send(res, 200, { id: owner.id, name: owner.name, switched: true });
    }
    if (route === 'POST me/push') {
      const s = body.subscription;
      const okUrl = /^https:\/\//.test(s && s.endpoint) || (process.env.PUSH_TEST && /^http:\/\/127\.0\.0\.1:/.test(s && s.endpoint));
      if (!s || typeof s.endpoint !== 'string' || !okUrl || s.endpoint.length > 1000) throw new Fail(400, 'bad subscription');
      q.addSub.run(s.endpoint, me.id, JSON.stringify(s), now);
      return send(res, 200, { ok: true });
    }
    throw new Fail(404, 'not found');
  }

  if (parts[1] === 'quick') {
    need(me);
    if (req.method === 'DELETE') { const r = q.queued.get(me.id); if (r && !r.matched) q.dequeue.run(me.id); return send(res, 200, {}); }
    const mine = q.queued.get(me.id);
    if (mine && mine.matched) { q.dequeue.run(me.id); return send(res, 200, { match: mine.matched }); }
    if (req.method === 'GET') {
      if (!mine) return send(res, 200, {});
      return wait('quick:' + me.id, me.id, req, () => {
        const r = q.queued.get(me.id);
        if (r && r.matched) { q.dequeue.run(me.id); return send(res, 200, { match: r.matched }); }
        send(res, 200, r ? { waiting: true } : {});
      });
    }
    if (req.method === 'POST') {
      if (q.openGames.get(me.id, me.id).n >= MAX_OPEN_GAMES) throw new Fail(409, 'finish some of your games first');
      const other = q.oldestWaiting.get(me.id, now - SEARCH_FOR);
      if (!other) { if (!mine) q.enqueue.run(me.id, now); return send(res, 200, { waiting: true }); }
      const blueFirst = crypto.randomInt(2) === 0;                  // who plays Blue (and moves first) is a coin flip
      const id = createMatch('quick', blueFirst ? other.player : me.id, blueFirst ? me.id : other.player);
      q.setMatched.run(id, other.player);
      if (mine) q.dequeue.run(me.id);
      changed('quick:' + other.player, other.player);
      return send(res, 200, { match: id });
    }
  }

  if (parts[1] !== 'matches') return send(res, 404, { error: 'not found' });
  const id = parts[2], action = parts[3];

  if (req.method === 'POST' && !id) {
    need(me);
    if (!allow('match', ip, 60)) throw new Fail(429, 'too many new matches, try again later');
    if (q.openGames.get(me.id, me.id).n >= MAX_OPEN_GAMES) throw new Fail(409, 'finish some of your games first');
    return send(res, 201, { id: createMatch('invite', me.id, null), team: 0 });
  }

  const m = id && q.getMatch.get(id);
  if (!m) return send(res, 404, { error: 'no such match' });

  if (req.method === 'POST' && action === 'join') {
    need(me);
    if (seatOf(m, me) >= 0) return send(res, 200, { team: seatOf(m, me) });
    if (!q.join.run(me.id, now, id, me.id).changes) throw new Fail(409, 'match is full');
    changed(id, m.p0);
    return send(res, 200, { team: 1 });
  }

  if (req.method === 'GET' && !action) {
    const since = Math.max(0, parseInt(url.searchParams.get('since'), 10) || 0);
    const rev = url.searchParams.get('rev');
    if (rev === null || +rev !== m.rev) return send(res, 200, matchView(m, since, me));
    return wait(id, me && me.id, req, () => send(res, 200, matchView(q.getMatch.get(id), since, me)));
  }

  if (req.method === 'POST' && action === 'turns') {
    const body = await readJson(req);
    // The seat: your player account, or (old invite matches) the seat token from back then.
    const legacy = body.token && (sha(body.token) === m.t0 ? 0 : m.t1 && sha(body.token) === m.t1 ? 1 : -1);
    const seat = seatOf(m, me) >= 0 ? seatOf(m, me) : legacy >= 0 ? legacy : -1;
    if (seat < 0) throw new Fail(403, 'not a player in this match');
    const turn = { groups: body.groups, hash: body.hash };
    const text = JSON.stringify(turn);
    if (body.n !== m.turns) {
      // A retry of a turn that already got through (e.g. the reply was lost) is fine; anything else is stale.
      const old = Number.isInteger(body.n) && body.n % 2 === seat && q.getTurn.get(id, body.n);
      if (old && old.body === text) return send(res, 200, { ok: true, n: body.n });
      throw new Fail(409, 'out of date: the match is at turn ' + m.turns);
    }
    if (seat !== m.turns % 2) throw new Fail(409, 'not your turn');
    if (m.winner >= 0) throw new Fail(409, 'match is over');
    if (text.length > MAX_BODY) throw new Fail(413, 'turn too big');
    const live = liveState(id);
    const t0 = Date.now();
    const err = B.replayTurn(live.S, turn);
    if (err) {
      cache.delete(id);                        // half-applied: rebuild from storage next time
      console.warn(`match ${id} turn ${m.turns} refused: ${err}`);
      throw new Fail(422, 'turn refused: ' + err);
    }
    live.n++;
    q.insertTurn.run(id, m.turns, seat, text, turn.hash, now);
    q.afterTurn.run(live.S.winner, now, id);
    changed(id, seat === 0 ? m.p1 : m.p0);
    console.log(`match ${id} turn ${m.turns} ok (${turn.groups.length} groups, ${Date.now() - t0} ms)`);
    return send(res, 200, { ok: true, n: m.turns });
  }

  return send(res, 405, { error: 'method not allowed' });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
                '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveStatic(url, res) {
  const name = url.pathname === '/' ? 'sim.html' : path.basename(url.pathname);     // flat folder, no paths
  const type = TYPES[path.extname(name)];
  const file = path.join(STATIC, name);
  if (!type || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (e instanceof Fail) return send(res, e.code, { error: e.message });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'server error' });
  });
});
server.requestTimeout = 0;                     // long-polls stay open on purpose
server.listen(PORT, '127.0.0.1', () => console.log(`block wars server on 127.0.0.1:${PORT}, db ${DB_PATH}`));
module.exports = server;
