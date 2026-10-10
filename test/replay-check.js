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
  // Gold (rules 3): mirrored between the sides at the same depth under each side's ground; builders mine it for 75.
  {
    const G = B.newState(3, 4242), top = (x, z) => { let y = B.H - 1; while (y > 0 && ![1, 2, 3, 7].includes(G.g[B.idx(x, y, z)])) y--; return y; };
    let blue = 0, red = 0, mirrored = true;
    for (let i = 0; i < B.N; i++) {
      if (G.g[i] !== B.GOLD) continue;
      const x = i % B.W, z = ((i / B.W) | 0) % B.D, y = (i / B.WD) | 0;
      if (x < B.W / 2) { blue++; const mx = B.W - 1 - x, my = y - top(x, z) + top(mx, z); if (G.g[B.idx(mx, my, z)] !== B.GOLD) mirrored = false; }
      else red++;
    }
    if (blue > 20 && blue === red && mirrored) console.log(`ok   gold: ${blue} blocks each side, mirrored at equal depth`);
    else fail(`gold: blue ${blue}, red ${red}, mirrored ${mirrored}`);
    const i = G.g.findIndex(v => v === B.GOLD), gx = i % B.W, gz = ((i / B.W) | 0) % B.D, gy = (i / B.WD) | 0;
    G.team = gx < B.W / 2 ? 0 : 1;
    const soldier = { id: 99, type: 'soldier', team: G.team, x: gx, y: gy + 1, z: gz, hp: 10, dead: false };
    const builder = { ...soldier, type: 'builder' };
    const before = G.gold[G.team];
    B.beginAction(G);
    const soldierDug = B.dig(G, soldier, gx, gy, gz), builderDug = B.dig(G, builder, gx, gy, gz);
    B.endAction(G);
    const gained = G.gold[G.team] - before;
    B.undo(G);
    if (!soldierDug && builderDug && gained === 75 && G.gold[G.team] === before && G.g[i] === B.GOLD)
      console.log('ok   gold: only builders mine it, +75 at once, undo puts block and gold back');
    else fail(`gold mining: soldier ${soldierDug}, builder ${builderDug}, gained ${gained}, after undo ${G.gold[G.team] - before}`);
    const old = B.newState(2);
    if (old.buildings.length === 10 && !old.g.includes(B.GOLD) && B.newState(3).buildings.length === 2) console.log('ok   rules 2 keeps villages and no gold; rules 3 has only the bases');
    else fail('rules 2 vs 3 maps');
  }
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
    // The latest rules (gold, builders, ladders) must play out identically in the browser too.
    const latest = await page.evaluate(() => runScenario(BlockSim).map(([l, h]) => l + ' ' + h).join('|'));
    if (latest === log2.map(([l, h]) => l + ' ' + h).join('|')) console.log(`ok   chromium: latest rules, ${log2.length} steps identical to Node`);
    else fail('chromium: latest rules differ from Node');

    const game = await browser.newPage();
    const errors = [];
    game.on('pageerror', e => errors.push(e.message));
    game.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await game.goto('file://' + path.join(root, 'sim.html'));
    const start = B.stateHash(B.newState());     // the page opens on the latest rules, map seed 1
    const hud = () => game.waitForFunction(h => document.getElementById('hash').textContent === h, start, { timeout: 10000 })
      .then(() => true, () => false);
    if (await hud()) console.log(`ok   sim.html: loads, HUD shows ${start}`);
    else fail(`sim.html: HUD shows ${await game.textContent('#hash')}, expected ${start}`);
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
