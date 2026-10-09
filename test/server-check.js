// End-to-end check of the server: guest players, invite matches, quick play, the scripted match played turn by
// turn through the API, cheats refused, long-polls, a restart mid-match, and signed Web Push requests.
'use strict';
const { spawn } = require('node:child_process');
const http = require('node:http'), crypto = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const B = require('../sim-core.js');
const { runScenario } = require('./scenario.js');

const PORT = 18787, api0 = `http://127.0.0.1:${PORT}/api`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-')), DB = path.join(dir, 'test.sqlite');
let failed = false;
const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed = true; };

function start() {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'server.js')],
    { env: { ...process.env, PORT, DB, PUSH_TEST: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise(res => p.stdout.on('data', d => { if (String(d).includes('server on')) res(p); }));
}
const stop = p => new Promise(res => { p.on('exit', res); p.kill(); });
async function api(method, url, body, who) {
  const headers = { 'content-type': 'application/json' };
  if (who) headers.authorization = 'Bearer ' + who.token;
  const r = await fetch(api0 + url, { method, headers, body: body && JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
}
const player = () => api('POST', '/players');

// A fake push service: records requests so we can check the server's VAPID signature.
const pushes = [];
const pushSrv = http.createServer((req, res) => { pushes.push({ url: req.url, auth: req.headers.authorization }); res.writeHead(201); res.end(); });
function vapidValid(auth, publicKey) {
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(\S+)$/.exec(auth || '');
  if (!m || m[4] !== publicKey) return false;
  const raw = Buffer.from(m[4], 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  return crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'))
    && claims.aud === `http://127.0.0.1:${pushSrv.address().port}` && claims.exp * 1000 > Date.now();
}

(async () => {
  const turns = runScenario(B).turns;
  await new Promise(r => pushSrv.listen(0, '127.0.0.1', r));
  let srv = await start();
  try {
    const blue = await player(), red = await player(), eve = await player();
    ok(blue.status === 201 && blue.name && blue.token, `guest player "${blue.name}"`);
    ok((await api('GET', '/me')).status === 401, 'no token, no profile');
    ok((await api('POST', '/me', { name: '  Dana‮<3  ' }, red)).name === 'Dana<3', 'rename cleans up the name');
    ok((await api('POST', '/matches')).status === 401, 'creating a match needs a player');

    const m = await api('POST', '/matches', null, blue);
    const url = `/matches/${m.id}`;
    ok(m.status === 201, `create invite match ${m.id}`);
    ok((await api('POST', `${url}/join`, null, blue)).team === 0, 'the creator joining is harmless');
    ok((await api('POST', `${url}/join`, null, red)).team === 1, 'join as Red');
    ok((await api('POST', `${url}/join`, null, eve)).status === 409, 'a third player is refused');
    const view = await api('GET', `${url}?since=0`, null, red);
    ok(view.you === 1 && view.names[0] === blue.name && view.names[1] === 'Dana<3', 'match shows names and your seat');

    const who = k => (k % 2 ? red : blue);
    const submit = k => api('POST', `${url}/turns`, { n: k, ...turns[k] }, who(k));
    ok((await api('POST', `${url}/turns`, { n: 0, ...turns[0] }, red)).status === 409, 'Red cannot play Blue\'s turn');
    ok((await api('POST', `${url}/turns`, { n: 0, ...turns[0] }, eve)).status === 403, 'a stranger cannot play');
    const cheat = JSON.parse(JSON.stringify(turns[0])); cheat.groups[1][0].x += 9;
    ok((await api('POST', `${url}/turns`, { n: 0, ...cheat }, blue)).status === 422, 'illegal move refused');
    const lie = await api('POST', `${url}/turns`, { n: 0, ...turns[0], hash: 'deadbeef' }, blue);
    ok(lie.status === 422 && /desync/.test(lie.error), 'wrong hash refused');

    // Red subscribes to pushes; Blue's turn should reach Red's (fake) push service, properly signed.
    const { vapidKey } = await api('GET', '/config');
    const endpoint = `http://127.0.0.1:${pushSrv.address().port}/push/red`;
    ok((await api('POST', '/me/push', { subscription: { endpoint, keys: {} } }, red)).ok, 'Red subscribes to notifications');
    ok((await api('POST', '/me/push', { subscription: { endpoint: 'javascript:alert(1)' } }, red)).status === 400, 'a bogus subscription is refused');

    const { rev } = await api('GET', url, null, red);
    const poll = api('GET', `${url}?since=0&rev=${rev}`, null, red);       // Red is watching the match…
    await new Promise(r => setTimeout(r, 300));
    ok((await submit(0)).status === 200, 'turn 0 accepted (after the refused ones)');
    const got = await poll;
    ok(got.turns.length === 1 && got.turns[0].hash === turns[0].hash, 'long-poll delivers the new turn');
    await new Promise(r => setTimeout(r, 300));
    ok(pushes.length === 0, 'no push while Red is watching the match');
    ok((await submit(0)).status === 200, 'resending the same turn is harmless');
    ok((await submit(1)).status === 200 && (await submit(2)).status === 200, 'turns 1 and 2 accepted');
    await new Promise(r => setTimeout(r, 500));
    ok(pushes.length === 1 && pushes[0].url === '/push/red', 'Red gets a push when it\'s their turn and they\'re away');
    ok(pushes.length && vapidValid(pushes[0].auth, vapidKey), 'the push is signed with the server\'s VAPID key');
    const me = await api('GET', '/me', null, red);
    ok(me.games.length === 1 && me.games[0].myTurn && me.games[0].opponent === blue.name, 'Red\'s game list says: your turn vs Blue');

    for (let k = 3; k < 6; k++) { const r = await submit(k); if (r.status !== 200) { ok(false, `turn ${k}: ${r.error}`); break; } }
    await stop(srv); srv = await start();      // restart mid-match: the state must come back from the database
    let all = true;
    for (let k = 6; k < turns.length; k++) { const r = await submit(k); if (r.status !== 200) { all = false; ok(false, `turn ${k}: ${r.error}`); break; } }
    ok(all, `all ${turns.length} turns accepted, across a restart (dam break included)`);
    ok((await api('GET', `${url}?since=0`)).count === turns.length, 'match has every turn stored');

    // Quick play: the first player waits, the second one gets paired with them.
    const a = await player(), b = await player();
    ok((await api('POST', '/quick', null, a)).waiting, 'quick play: first player waits');
    ok((await api('GET', '/me', null, a)).searching, 'their profile says searching');
    const aPoll = api('GET', '/quick', null, a);
    const pair = await api('POST', '/quick', null, b);
    ok(!!pair.match, 'quick play: second player is paired at once');
    ok((await aPoll).match === pair.match, 'the waiting player hears about it');
    const qm = await api('GET', `/matches/${pair.match}`, null, a);
    ok(qm.players[1] && qm.you >= 0 && qm.names.includes(a.name) && qm.names.includes(b.name), 'both are seated in the new match');
    ok(!(await api('POST', '/quick', null, b)).match, 'nobody else waiting: the next search waits');
    await api('DELETE', '/quick', null, b);
    ok(!(await api('GET', '/me', null, b)).searching, 'stop looking');

    // Quitting: the other side wins, the game takes no more turns; an unjoined invite is just cancelled.
    const qurl = `/matches/${pair.match}`;
    ok((await api('POST', `${qurl}/quit`, null, eve)).status === 403, 'a stranger cannot quit for you');
    const qa = qm.you;
    const quit = await api('POST', `${qurl}/quit`, null, a);
    ok(quit.status === 200 && quit.winner === 1 - qa, 'quitting gives the win to the other side');
    const after = await api('GET', `${qurl}?since=0`, null, b);
    ok(after.winner === 1 - qa && after.quit === qa, 'the match shows who quit');
    ok((await api('POST', `${qurl}/turns`, { n: 0, ...turns[0] }, qa === 0 ? a : b)).status === 409, 'no turns after a quit');
    ok((await api('POST', `${qurl}/quit`, null, b)).status === 409, 'cannot quit a finished game');
    const bg = (await api('GET', '/me', null, b)).games.find(g => g.id === pair.match);
    ok(bg && bg.quit === qa && bg.winner === bg.team, 'their game list: they quit, you won');
    const lone = await api('POST', '/matches', null, a);
    const c = await api('POST', `/matches/${lone.id}/quit`, null, a);
    ok(c.cancelled && (await api('GET', `/matches/${lone.id}`)).status === 404, 'quitting an unjoined invite cancels it');

    // Deleting your player: running games count as a quit, unjoined invites vanish, and you're gone.
    const d1 = await player(), d2 = await player();
    const dm = await api('POST', '/matches', null, d1); await api('POST', `/matches/${dm.id}/join`, null, d2);
    const dLone = await api('POST', '/matches', null, d1);
    ok((await api('DELETE', '/me', null, d1)).deleted, 'delete your player');
    ok((await api('GET', '/me', null, d1)).status === 401, 'its logins stop working');
    const dg = (await api('GET', '/me', null, d2)).games.find(g => g.id === dm.id);
    ok(dg && dg.winner === dg.team && dg.quit === 0 && dg.opponent === 'Deleted player', 'their opponent wins, vs "Deleted player"');
    ok((await api('GET', `/matches/${dLone.id}`)).status === 404, 'their unjoined invite is gone');
  } finally {
    await stop(srv);
    pushSrv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})();
