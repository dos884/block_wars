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
  // golden.json was recorded from the original game, so it's checked under rules version 1.
  const log = runScenario(B, 6, 1);
  compare('node', log);

  // Replay the match from its turn lists alone, as the server does, and as the opponent's browser does.
  const ends = log.filter(([l]) => l.startsWith('end turn')).map(([, h]) => h);
  const R = B.newState(log.rules);
  let bad = null;
  log.turns.forEach((t, k) => {
    const err = bad || B.replayTurn(R, t);
    if (!bad && err) bad = `turn ${k}: ${err}`;
    else if (!bad && B.stateHash(R) !== ends[k]) bad = `turn ${k}: replay ${B.stateHash(R)}, live ${ends[k]}`;
  });
  if (bad) fail('replay: ' + bad);
  else console.log(`ok   replay: ${log.turns.length} turns from action lists alone give the same hashes`);
  // A tampered turn must be refused.
  const T = B.newState(log.rules), cheat = JSON.parse(JSON.stringify(log.turns[0]));
  cheat.groups[1][0].x += 9;                    // move further than the unit can walk
  const why = B.replayTurn(T, cheat);
  if (why) console.log(`ok   replay: tampered turn refused (${why})`); else fail('replay: tampered turn was accepted');

  // The latest rules: same type vs same type dies in at most 2 hits from full health, the triangle's winner in 1.
  const L = B.newState();
  const hitsToKill = (a, d) => {
    const A = { type: a, hp: 10 }, X = { type: d, hp: 10 };
    for (let n = 1; n < 9; n++) {
      X.hp -= B.damageOf(L, A, X); if (X.hp <= 0) return n;
      if (!B.UNIT_TYPES[a].ranged && !B.UNIT_TYPES[d].ranged) { A.hp -= B.damageOf(L, X, A); if (A.hp <= 0) return Infinity; }
    }
    return Infinity;
  };
  const same = B.TYPES.map(t => hitsToKill(t, t)), tri = [['soldier', 'spearman'], ['spearman', 'knight'], ['knight', 'soldier']].map(([a, d]) => hitsToKill(a, d));
  if (same.every(n => n <= 2) && tri.every(n => n === 1)) console.log(`ok   rules ${L.rules}: same vs same in ${same.join('/')} hits, triangle wins in 1`);
  else fail(`rules ${L.rules}: same vs same ${same.join('/')}, triangle ${tri.join('/')}`);
  // The latest rules must replay from turn lists too (the server checks every new match this way).
  const log2 = runScenario(B), R2 = B.newState();
  const bad2 = log2.turns.map(t => B.replayTurn(R2, t)).find(e => e);
  if (bad2) fail('replay under latest rules: ' + bad2); else console.log(`ok   replay under rules ${R2.rules}: ${log2.turns.length} turns`);

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + path.join(__dirname, 'blank.html'));
    await page.addScriptTag({ path: path.join(root, 'sim-core.js') });
    await page.addScriptTag({ path: path.join(__dirname, 'scenario.js') });
    compare('chromium', await page.evaluate(() => runScenario(BlockSim, 6, 1)));

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
