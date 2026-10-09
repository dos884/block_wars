// End-to-end check of the match server: create, join, play the scripted match turn by turn through the API,
// get cheats refused, long-poll for the opponent's turn, and survive a restart mid-match.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const B = require('../sim-core.js');
const { runScenario } = require('./scenario.js');

const PORT = 18787, base = `http://127.0.0.1:${PORT}/api/matches`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-')), DB = path.join(dir, 'test.sqlite');
let failed = false;
const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed = true; };

function start() {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'server.js')],
    { env: { ...process.env, PORT, DB }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise(res => p.stdout.on('data', d => { if (String(d).includes('server on')) res(p); }));
}
const stop = p => new Promise(res => { p.on('exit', res); p.kill(); });
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
}

(async () => {
  const turns = runScenario(B).turns;
  let srv = await start();
  try {
    const blue = await api('POST', base);
    ok(blue.status === 201 && blue.team === 0, `create match ${blue.id}`);
    const id = blue.id, url = `${base}/${id}`;
    const red = await api('POST', `${url}/join`);
    ok(red.status === 200 && red.team === 1, 'join as Red');
    ok((await api('POST', `${url}/join`)).status === 409, 'a third player is refused');

    const tok = k => (k % 2 ? red : blue).token;
    const submit = k => api('POST', `${url}/turns`, { token: tok(k), n: k, ...turns[k] });

    ok((await api('POST', `${url}/turns`, { token: red.token, n: 0, ...turns[0] })).status === 409, 'Red cannot play Blue\'s turn');
    ok((await api('POST', `${url}/turns`, { token: 'nope', n: 0, ...turns[0] })).status === 403, 'a stranger cannot play');
    const cheat = JSON.parse(JSON.stringify(turns[0])); cheat.groups[1][0].x += 9;
    const c = await api('POST', `${url}/turns`, { token: blue.token, n: 0, ...cheat });
    ok(c.status === 422, `illegal move refused (${c.error})`);
    const lie = await api('POST', `${url}/turns`, { token: blue.token, n: 0, ...turns[0], hash: 'deadbeef' });
    ok(lie.status === 422 && /desync/.test(lie.error), 'wrong hash refused');

    // Red long-polls while Blue plays turn 0: the poll must return with that turn.
    const { rev } = await api('GET', url);
    const poll = api('GET', `${url}?since=0&rev=${rev}`);
    await new Promise(r => setTimeout(r, 300));
    ok((await submit(0)).status === 200, 'turn 0 accepted (after the refused ones)');
    const got = await poll;
    ok(got.turns.length === 1 && got.turns[0].hash === turns[0].hash, 'long-poll delivers the new turn');
    const again = await submit(0);
    ok(again.status === 200, 'resending the same turn is harmless');

    for (let k = 1; k < 6; k++) { const r = await submit(k); if (r.status !== 200) { ok(false, `turn ${k}: ${r.error}`); break; } }
    await stop(srv); srv = await start();      // restart mid-match: the state must come back from the database
    let all = true;
    for (let k = 6; k < turns.length; k++) { const r = await submit(k); if (r.status !== 200) { all = false; ok(false, `turn ${k}: ${r.error}`); break; } }
    ok(all, `all ${turns.length} turns accepted, across a restart (dam break included)`);
    const end = await api('GET', `${url}?since=0`);
    ok(end.count === turns.length && end.turns.length === turns.length, 'match has every turn stored');
  } finally {
    await stop(srv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})();
