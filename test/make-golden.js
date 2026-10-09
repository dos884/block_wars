// Record the scenario's hashes from the ORIGINAL single-file game (sim code inline in the HTML),
// so every later refactor step can be checked against the game as it was before the split.
// Usage: node test/make-golden.js <original.html>   → writes test/golden.json
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { runScenario } = require('./scenario.js');

const html = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const start = html.findIndex(l => l.includes('SIM — deterministic')) - 1;   // the /* ==== line above it
const end = html.findIndex(l => l.includes('VIEW — Three.js')) - 1;
if (start < 0 || end < 0) throw new Error('sim block markers not found');
const block = html.slice(start, end).join('\n');

// Same wrapper and resolve() as sim-core.js, around the original code.
const src = `'use strict';\n${block}\n
const MAX_WATER_STEPS = 20000;
function resolve(s) { while (gravityStep(s)); for (let n = 0; n < MAX_WATER_STEPS && waterStep(s); n++); }
({ W, D, H, WOOD, idx, newState, stateHash, moveOf, moveRange, moveUnit, canDig, dig, canAttack, attack,
   canCapture, capture, canBuild, buildUnit, beginAction, endAction, undo, redo, endTurn, resolve });`;
const B = vm.runInNewContext(src, {});
const log = runScenario(B);
fs.writeFileSync(path.join(__dirname, 'golden.json'), JSON.stringify(log, null, 0).replace(/\],\[/g, '],\n['));
console.log(`golden: ${log.length} steps, final ${log[log.length - 1].join(' ')}`);
