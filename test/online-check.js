// Real browsers play each other through the server: Blue starts a friend match from the lobby, Red opens the link,
// they trade turns, and both screens must agree on the state hash after every turn. Then two strangers use Quick play.
// SITE=https://cubewars.io node test/online-check.js runs it against the live server instead of a local one.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright');

const PORT = 18788, site = process.env.SITE || `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-')), DB = path.join(dir, 'test.sqlite');
let failed = false;
const ok = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed = true; };

(async () => {
  const srv = process.env.SITE ? null : spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'server.js')],
    { env: { ...process.env, PORT, DB, STATIC: path.join(__dirname, '..') }, stdio: ['ignore', 'pipe', 'inherit'] });
  if (srv) await new Promise(res => srv.stdout.on('data', d => { if (String(d).includes('server on')) res(); }));
  const browser = await chromium.launch();
  const errors = [];
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, hasTouch: true });   // a phone-sized screen
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    return p;
  };
  const line = p => p.textContent('#netLine');
  const waitLine = (p, text) => p.waitForFunction(t => document.getElementById('netLine').textContent.includes(t), text, { timeout: 15000 })
    .then(() => true, () => false);
  const hash = p => p.textContent('#hash');
  try {
    const blue = await open(), red = await open();
    await blue.goto(site + '/');
    await blue.waitForFunction(() => document.getElementById('lName').value.length > 0, null, { timeout: 15000 });
    ok(await blue.isVisible('#lobby'), `lobby opens, Blue is "${await blue.inputValue('#lName')}"`);
    await blue.fill('#lName', 'Blue Tester');
    await blue.press('#lName', 'Enter');
    await blue.waitForTimeout(300);
    await blue.click('#lFriend');
    await blue.waitForURL(/\?m=/);
    await blue.waitForSelector('#shareView:not([hidden])');
    const link = await blue.inputValue('#shareLink');
    ok(/\/\?m=[\w-]+$/.test(link), 'Blue creates a match and gets an invite link');
    await blue.click('#shareClose');
    ok(await waitLine(blue, 'Your turn'), `Blue: "${await line(blue)}"`);

    await red.goto(link.replace(/^https?:\/\/[^/]+/, site));
    await red.waitForSelector('#joinView:not([hidden])', { timeout: 15000 });
    ok((await red.textContent('#joinText')).includes('Blue Tester'), `opening the link asks first: "${await red.textContent('#joinText')}"`);
    await blue.waitForTimeout(1500);
    ok((await line(blue)).includes('no opponent yet'), 'just opening the link does not take the seat');
    await red.click('#joinYes');
    ok(await waitLine(red, 'Waiting for Blue Tester'), `Red joins and sees the name: "${await line(red)}"`);
    await red.keyboard.press('e');
    ok((await red.textContent('#status')).includes('Not your turn'), 'Red cannot end Blue\'s turn');

    // Blue: build a soldier and end the turn.
    await blue.click('#buildBtn');
    await blue.click('#buildPanel button:first-child');
    ok((await blue.textContent('#acount')).startsWith('1'), 'Blue builds a soldier (1 action)');
    await blue.keyboard.press('e');
    ok(await waitLine(blue, 'Waiting for '), `Blue sent the turn: "${await line(blue)}"`);
    ok((await blue.textContent('#uname')).startsWith('Soldier') && (await blue.evaluate(() => document.getElementById('udot').style.background)).includes('59, 130, 196'),
      `after End turn Blue still looks at a Blue unit (${await blue.textContent('#uname')})`);
    ok((await blue.textContent('#ustate')).includes('Waiting for'), `Blue's status: "${await blue.textContent('#ustate')}"`);
    ok(await waitLine(red, 'Your turn'), `Red receives it: "${await line(red)}"`);
    ok(await hash(red) === await hash(blue), `same hash on both screens after turn 1 (${await hash(red)})`);

    // Red: build a spearman (second button) and end the turn.
    await red.click('#buildBtn');
    await red.click('#buildPanel button:nth-child(2)');
    await red.keyboard.press('e');
    ok(await waitLine(blue, 'Your turn'), 'Blue receives Red\'s turn');
    ok(await waitLine(red, 'Waiting for Blue Tester'), 'Red sees its turn was sent');
    ok(await hash(red) === await hash(blue), `same hash on both screens after turn 2 (${await hash(blue)})`);

    // Reloading keeps your seat and rebuilds the match from the server.
    const before = await hash(blue);
    await blue.reload();
    ok(await waitLine(blue, 'Your turn'), 'Blue reloads and keeps the seat');
    await blue.waitForFunction(h => document.getElementById('hash').textContent === h, before, { timeout: 10000 }).catch(() => {});
    ok(await hash(blue) === before, 'reloaded match has the same hash');

    // A third browser can only watch.
    const third = await open();
    await third.goto(link.replace(/^https?:\/\/[^/]+/, site));
    if (await third.waitForSelector('#joinView:not([hidden])', { timeout: 3000 }).then(() => true, () => false)) await third.click('#joinNo');
    ok(await waitLine(third, 'Watching'), `a third visitor watches: "${await line(third)}"`);
    ok(!(await blue.isVisible('#reset')) && !(await blue.isVisible('#hashBox')), 'no Reset button or debug hash inside a match');
    ok(!(await blue.isVisible('#cmdBtn')), 'no Commander button without ?debug');

    // Menu → the lobby lists the game with whose turn it is.
    await red.click('#menuBtn');
    await red.click('#mLobby');
    await red.waitForSelector('#lGames .game');
    ok((await red.textContent('#lGames .game')).includes('Their turn') && (await red.textContent('#lGames .game')).includes('Blue Tester'),
      `Red's lobby: "${(await red.textContent('#lGames .game')).trim()}"`);

    // Quick play between two strangers: the first waits, the second is paired, both land in the match.
    // Not on the live site: the test players could get paired with a real person waiting there.
    if (!process.env.SITE) {
    await red.screenshot({ path: path.join(__dirname, 'out', 'lobby.png') });
    // Close the friend-game tabs first: five 3D tabs at once is too much for software rendering on the server.
    for (const p of [blue, red, third]) await p.context().close();
    const q1 = await open(), q2 = await open();
    await q1.goto(site + '/'); await q2.goto(site + '/');
    for (const p of [q1, q2]) await p.waitForFunction(() => document.getElementById('lName').value.length > 0, null, { timeout: 15000 });
    await q1.click('#lQuick');
    ok(await q1.waitForSelector('#lSearch:not([hidden])', { timeout: 5000 }).then(() => true, () => false), 'quick play: first player is looking');
    await q2.click('#lQuick');
    await Promise.all([q1.waitForURL(/\?m=/, { timeout: 30000 }), q2.waitForURL(/\?m=/, { timeout: 30000 })]);
    ok(q1.url() === q2.url(), 'quick play: both players land in the same match');
    ok(await waitLine(q1, 'You are') && await waitLine(q2, 'You are'), `seated: "${await line(q1)}" / "${await line(q2)}"`);
    for (const p of [q1, q2]) {                // each player looks at their own army from the start
      const mine = (await line(p)).includes('Blue') ? '59, 130, 196' : '224, 69, 58';
      ok((await p.evaluate(() => document.getElementById('udot').style.background)).includes(mine), `own unit selected: ${await p.textContent('#uname')} (${(await line(p)).slice(0, 12)})`);
    }
    await q1.screenshot({ path: path.join(__dirname, 'out', 'quick-match.png') });

    // Menu → Quit game → confirm: the quitter loses, the other side sees who quit.
    await q1.click('#menuBtn');
    await q1.click('#mQuit');
    ok((await q1.textContent('#mTitle')).startsWith('Quit this game?'), `quit asks first: "${await q1.textContent('#mTitle')}"`);
    await q1.click('#mQuitYes');
    await q1.waitForSelector('#winView:not([hidden])', { timeout: 10000 });
    ok((await q1.textContent('#winText')) === 'You lose' && (await q1.textContent('#winSub')).includes('You quit'), `quitter sees: "${await q1.textContent('#winText')} ${await q1.textContent('#winSub')}"`);
    const seen = await q2.waitForSelector('#winView:not([hidden])', { timeout: 30000 }).then(() => true, () => false);
    ok(seen && (await q2.textContent('#winText')) === 'You win!' && (await q2.textContent('#winSub')).includes('quit the game')
      && (await q2.textContent('#ustate')) === 'Game over', `opponent sees: "${await q2.textContent('#winText')} ${await q2.textContent('#winSub')}"`);
    await q2.screenshot({ path: path.join(__dirname, 'out', 'quit.png') });
    }
    ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    if (srv) srv.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})();
