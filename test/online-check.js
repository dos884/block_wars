// Two real browsers play each other through the server: Blue creates a match with the button, Red opens the link,
// they trade turns, and both screens must agree on the state hash after every turn.
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
    await blue.click('#onlineBtn');
    await blue.waitForURL(/\?m=/);
    await blue.waitForSelector('#shareView:not([hidden])');
    const link = await blue.inputValue('#shareLink');
    ok(/\/\?m=[\w-]+$/.test(link), 'Blue creates a match and gets an invite link');
    await blue.click('#shareClose');
    ok(await waitLine(blue, 'Your turn'), `Blue: "${await line(blue)}"`);

    await red.goto(link.replace(/^https?:\/\/[^/]+/, site));
    ok(await waitLine(red, 'Waiting for Blue'), `Red joins: "${await line(red)}"`);
    await red.keyboard.press('e');
    ok((await red.textContent('#status')).includes('Not your turn'), 'Red cannot end Blue\'s turn');

    // Blue: build a soldier and end the turn.
    await blue.click('#buildBtn');
    await blue.click('#buildPanel button:first-child');
    ok((await blue.textContent('#acount')).startsWith('1'), 'Blue builds a soldier (1 action)');
    await blue.keyboard.press('e');
    ok(await waitLine(blue, 'Waiting for Red'), `Blue sent the turn: "${await line(blue)}"`);
    ok(await waitLine(red, 'Your turn'), `Red receives it: "${await line(red)}"`);
    ok(await hash(red) === await hash(blue), `same hash on both screens after turn 1 (${await hash(red)})`);

    // Red: build a spearman (second button) and end the turn.
    await red.click('#buildBtn');
    await red.click('#buildPanel button:nth-child(2)');
    await red.keyboard.press('e');
    ok(await waitLine(blue, 'Your turn'), 'Blue receives Red\'s turn');
    ok(await waitLine(red, 'Waiting for Blue'), 'Red sees its turn was sent');
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
    ok(await waitLine(third, 'Watching'), `a third visitor watches: "${await line(third)}"`);
    ok(!(await blue.isVisible('#onlineBtn')) && !(await blue.isVisible('#reset')), 'no Play online / Reset buttons inside a match');
    await blue.screenshot({ path: path.join(__dirname, 'out', 'online-blue.png') });
    ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    await browser.close();
    if (srv) srv.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})();
