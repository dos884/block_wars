// Block Wars match server: stores matches and turns in SQLite, and checks every turn by replaying it
// with the same sim code the browser runs (sim-core.js). No framework: node:http and node:sqlite only.
//
//   POST /api/matches                      → { id, team: 0, token }          create a match, you are Blue
//   POST /api/matches/:id/join             → { team: 1, token }              take the Red seat (once)
//   GET  /api/matches/:id?since=n&rev=r    → { rev, players, winner, turns } turns from n on; waits up to 25 s
//                                                                             for something new when rev is given
//   POST /api/matches/:id/turns            ← { token, n, groups, hash }      submit turn n; replayed and checked
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const B = require(process.env.SIM_CORE || path.join(__dirname, '..', 'sim-core.js'));

const PORT = +process.env.PORT || 8787;
const DB_PATH = process.env.DB || path.join(__dirname, 'dev.sqlite');
const MAX_BODY = 512 * 1024;
const WAIT_MS = 25000;
const CACHE_SIZE = 24;                         // live sim states kept in memory (~7 MB each)
const STATIC = process.env.STATIC;             // dev/tests only: also serve the game files (Caddy does it in production)

/* ---------- Storage ---------- */
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY, created INTEGER NOT NULL, updated INTEGER NOT NULL,
    t0 TEXT NOT NULL, t1 TEXT,                 -- sha256 of each seat's token; t1 is empty until someone joins
    rev INTEGER NOT NULL DEFAULT 0,            -- bumps on every change, for long-polling
    turns INTEGER NOT NULL DEFAULT 0, winner INTEGER NOT NULL DEFAULT -1
  );
  CREATE TABLE IF NOT EXISTS turns (
    match TEXT NOT NULL, n INTEGER NOT NULL, team INTEGER NOT NULL,
    body TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL,
    PRIMARY KEY (match, n)
  );
`);
const q = {
  insertMatch: db.prepare('INSERT INTO matches (id, created, updated, t0) VALUES (?, ?, ?, ?)'),
  getMatch: db.prepare('SELECT * FROM matches WHERE id = ?'),
  join: db.prepare('UPDATE matches SET t1 = ?, rev = rev + 1, updated = ? WHERE id = ? AND t1 IS NULL'),
  turnsFrom: db.prepare('SELECT n, team, body FROM turns WHERE match = ? AND n >= ? ORDER BY n'),
  getTurn: db.prepare('SELECT body FROM turns WHERE match = ? AND n = ?'),
  insertTurn: db.prepare('INSERT INTO turns (match, n, team, body, hash, created) VALUES (?, ?, ?, ?, ?, ?)'),
  afterTurn: db.prepare('UPDATE matches SET turns = turns + 1, rev = rev + 1, winner = ?, updated = ? WHERE id = ?'),
};

const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const newId = n => crypto.randomBytes(n).toString('base64url');

/* ---------- Live states: the match replayed up to its last turn ---------- */
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

/* ---------- Long-poll waiters ---------- */
const waiters = new Map();                     // id → Set of callbacks
function notify(id) {
  const set = waiters.get(id);
  if (!set) return;
  waiters.delete(id);
  for (const f of set) f();
}

/* ---------- Abuse limits: a few match creations per address per hour ---------- */
const created = new Map();
function allowCreate(ip) {
  const now = Date.now(), list = (created.get(ip) || []).filter(t => now - t < 3600e3);
  if (list.length >= 30) return false;
  list.push(now); created.set(ip, list);
  return true;
}

/* ---------- HTTP ---------- */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}
function readJson(req) {
  return new Promise((ok, bad) => {
    let size = 0; const parts = [];
    req.on('data', d => { size += d.length; if (size > MAX_BODY) { bad(Object.assign(new Error('too big'), { code: 413 })); req.destroy(); } else parts.push(d); });
    req.on('end', () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts)) : {}); } catch { bad(Object.assign(new Error('bad json'), { code: 400 })); } });
    req.on('error', bad);
  });
}
function matchView(m, since) {
  const turns = q.turnsFrom.all(m.id, since).map(r => ({ n: r.n, team: r.team, ...JSON.parse(r.body) }));
  return { id: m.id, rev: m.rev, players: [true, !!m.t1], winner: m.winner, count: m.turns, turns };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
function serveStatic(url, res) {
  const name = url.pathname === '/' ? 'sim.html' : path.basename(url.pathname);   // flat folder, no paths
  const type = TYPES[path.extname(name)];
  const file = path.join(STATIC, name);
  if (!type || !require('node:fs').existsSync(file)) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  require('node:fs').createReadStream(file).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);       // api, matches, :id, action
  if (STATIC && parts[0] !== 'api') return serveStatic(url, res);
  if (parts[0] !== 'api' || parts[1] !== 'matches') return send(res, 404, { error: 'not found' });
  const id = parts[2], action = parts[3];
  const now = Date.now();

  if (req.method === 'POST' && !id) {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
    if (!allowCreate(ip)) return send(res, 429, { error: 'too many new matches, try again later' });
    const mid = newId(6), token = newId(18);
    q.insertMatch.run(mid, now, now, sha(token));
    return send(res, 201, { id: mid, team: 0, token });
  }

  const m = id && q.getMatch.get(id);
  if (!m) return send(res, 404, { error: 'no such match' });

  if (req.method === 'POST' && action === 'join') {
    const token = newId(18);
    if (!q.join.run(sha(token), now, id).changes) return send(res, 409, { error: 'match is full' });
    notify(id);
    return send(res, 200, { team: 1, token });
  }

  if (req.method === 'GET' && !action) {
    const since = Math.max(0, parseInt(url.searchParams.get('since'), 10) || 0);
    const rev = url.searchParams.get('rev');
    if (rev === null || +rev !== m.rev) return send(res, 200, matchView(m, since));
    // Nothing new yet: hold the request until something changes or the wait runs out.
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); set.delete(finish); send(res, 200, matchView(q.getMatch.get(id), since)); };
    const set = waiters.get(id) || new Set();
    waiters.set(id, set); set.add(finish);
    const timer = setTimeout(finish, WAIT_MS);
    req.on('close', () => { done = true; clearTimeout(timer); set.delete(finish); });
    return;
  }

  if (req.method === 'POST' && action === 'turns') {
    const body = await readJson(req);
    const seat = !body.token ? -1 : sha(body.token) === m.t0 ? 0 : m.t1 && sha(body.token) === m.t1 ? 1 : -1;
    if (seat < 0) return send(res, 403, { error: 'not a player in this match' });
    const turn = { groups: body.groups, hash: body.hash };
    const text = JSON.stringify(turn);
    if (body.n !== m.turns) {
      // A retry of a turn that already got through (e.g. the reply was lost) is fine; anything else is stale.
      const old = Number.isInteger(body.n) && body.n % 2 === seat && q.getTurn.get(id, body.n);
      if (old && old.body === text) return send(res, 200, { ok: true, n: body.n });
      return send(res, 409, { error: 'out of date: the match is at turn ' + m.turns });
    }
    const team = m.turns % 2;                  // Blue moves on even turns, Red on odd
    if (seat !== team) return send(res, 409, { error: 'not your turn' });
    if (m.winner >= 0) return send(res, 409, { error: 'match is over' });
    if (text.length > MAX_BODY) return send(res, 413, { error: 'turn too big' });
    const live = liveState(id);
    const t0 = Date.now();
    const err = B.replayTurn(live.S, turn);
    if (err) {
      cache.delete(id);                        // half-applied: rebuild from storage next time
      console.warn(`match ${id} turn ${m.turns} refused: ${err}`);
      return send(res, 422, { error: 'turn refused: ' + err });
    }
    live.n++;
    q.insertTurn.run(id, m.turns, team, text, turn.hash, now);
    q.afterTurn.run(live.S.winner, now, id);
    notify(id);
    console.log(`match ${id} turn ${m.turns} ok (${turn.groups.length} groups, ${Date.now() - t0} ms)`);
    return send(res, 200, { ok: true, n: m.turns });
  }

  return send(res, 405, { error: 'method not allowed' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (e.code === 400 || e.code === 413) return send(res, e.code, { error: e.message });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'server error' });
  });
});
server.requestTimeout = 0;                     // long-polls stay open on purpose
server.listen(PORT, '127.0.0.1', () => console.log(`block wars server on 127.0.0.1:${PORT}, db ${DB_PATH}`));
module.exports = server;
