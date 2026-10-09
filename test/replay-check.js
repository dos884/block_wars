// Determinism check for the shared sim core. Run: npm test
// 1) Node: the scenario on sim-core.js must give exactly the hashes in golden.json (recorded from the original game).
// 2) Chromium: the same scenario on the same files in a real browser must give the same hashes.
// 3) Chromium: the real game page (sim.html) must load without errors, show the starting hash,
//    and End turn must give the same hash as Node.
'use strict';
const fs = require('fs'), path = require('path');
const B = require('../sim-core.js');
const { runScenario } = require('./scenario.js');

const root = path.join(__dirname, '..');
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden.json'), 'utf8'));
let failed = false;
const fail = msg => { failed = true; console.log('FAIL ' + msg); };

function compare(name, log) {
  const n = Math.max(log.length, golden.length);
  for (let k = 0; k < n; k++) {
    const a = log[k] || [], g = golden[k] || [];
    if (a[0] !== g[0] || a[1] !== g[1]) return fail(`${name}: step ${k} is ${a.join(' ')}, golden ${g.join(' ')}`);
  }
  console.log(`ok   ${name}: ${log.length} steps match golden (final ${log[log.length - 1][1]})`);
}

(async () => {
  compare('node', runScenario(B));

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.join(__dirname, 'blank.html'));
    await page.addScriptTag({ path: path.join(root, 'sim-core.js') });
    await page.addScriptTag({ path: path.join(__dirname, 'scenario.js') });
    compare('chromium', await page.evaluate(() => runScenario(BlockSim)));

    const game = await browser.newPage();
    const errors = [];
    game.on('pageerror', e => errors.push(e.message));
    game.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await game.goto('file://' + path.join(root, 'sim.html'));
    const hud = () => game.waitForFunction(h => document.getElementById('hash').textContent === h, golden[0][1], { timeout: 10000 })
      .then(() => true, () => false);
    if (await hud()) console.log(`ok   sim.html: loads, HUD shows ${golden[0][1]}`);
    else fail(`sim.html: HUD shows ${await game.textContent('#hash')}, expected ${golden[0][1]}`);
    const S = B.newState(); B.endTurn(S); const want = B.stateHash(S);
    await game.keyboard.press('e');
    const got = await game.waitForFunction(h => document.getElementById('hash').textContent === h, want, { timeout: 10000 })
      .then(() => want, async () => game.textContent('#hash'));
    if (got === want) console.log(`ok   sim.html: End turn → ${want}, same as Node`);
    else fail(`sim.html: End turn gave ${got}, Node gave ${want}`);
    if (errors.length) fail('sim.html errors: ' + errors.join(' | '));
  } finally {
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
})();
