// A scripted match that exercises the whole sim: moving, digging, a bridge collapse, a dam break and flood,
// fighting, capturing, building, undo/redo and end turn. Returns the state hash after every step.
// Pure and deterministic: given the same sim code it must give the same list, in Node and in the browser.
(function (root) {
'use strict';

function runScenario(B, rounds = 6, rules) {
  const S = B.newState(rules);              // rules version: undefined = the latest
  const log = [['start', B.stateHash(S)]];
  const turns = [];
  const goldAt = new Map();                      // builder id → the gold column it's heading for                              // what a client would send each End turn (if the core can record it)
  const note = label => log.push([label, B.stateHash(S)]);
  const cx = B.W >> 1, cz = B.D >> 1;
  const dist = (u, x, z) => Math.abs(u.x - x) + Math.abs(u.z - z);

  // One player action, journaled like the browser does it. Only digging changes blocks, so only a dig
  // has a collapse and flood to resolve (the browser runs settle() only after a dig, too).
  const action = (label, fn) => {
    B.beginAction(S);
    const ok = fn();
    if (ok && label.startsWith('dig')) B.resolve(S);
    B.endAction(S);
    if (ok) note(label);
    return ok;
  };
  // Step toward (gx, gz): the reachable cell closest to it (ties: first found, which is deterministic).
  const walk = (u, gx, gz) => {
    let best = null, bd = dist(u, gx, gz);
    for (const k of B.moveRange(S, u, B.moveOf(u)).keys()) {
      const [x, y, z] = k.split(',').map(Number), d = Math.abs(x - gx) + Math.abs(z - gz);
      if (d < bd) { bd = d; best = [x, y, z]; }
    }
    if (best) action(`move ${u.id} ${best}`, () => B.moveUnit(S, u, ...best));
  };
  const nearestEnemy = u => {
    let best = null;
    for (const v of S.units) if (!v.dead && v.team !== u.team && (!best || dist(u, v.x, v.z) < dist(u, best.x, best.z))) best = v;
    return best;
  };
  // The first block of a column, from the ground up, that this unit can dig from where it stands.
  const digTarget = (u, x, z, mat) => {
    for (let y = 1; y < B.H; y++) if (S.g[B.idx(x, y, z)] === mat && B.canDig(S, u, x, y, z)) return [x, y, z];
    return null;
  };

  // Roles for Blue's three starting soldiers; everyone else hunts the nearest enemy.
  const DAM = [cx, cz - 19], PILLAR = [cx - 16 + 5, cz + 16], VILLAGE = [cx - 14, cz + 4];
  const roles = {
    0: { goal: DAM, dig: [...DAM, B.WOOD] },                   // walk up to the dam, dig its lowest block in reach
    1: { goal: [PILLAR[0] - 1, PILLAR[1]], dig: [...PILLAR, B.WOOD] },
    2: { goal: VILLAGE, capture: true },
  };

  for (let turn = 0; turn < rounds * 2; turn++) {
    // Rules 3 (only builders dig, ladders): each side's first new unit is a builder.
    const firstBuild = S.lad && !S.units.some(v => v.team === S.team && v.type === 'builder');
    const want = firstBuild ? 'builder' : S.team ? 'spearman' : 'soldier';
    if (B.canBuild(S, want)) action(`build ${S.team}`, () => !!B.buildUnit(S, want));
    for (let k = 0; k < S.units.length; k++) {
      const u = S.units[k];                     // look it up fresh: undo/redo replaces the unit objects
      if (u.dead || u.team !== S.team || u.moved) continue;
      if (u.type === 'builder' && S.lad) {
        // Head for this side's nearest gold column (climbing out of shafts on their ladders); once standing on it,
        // dig straight down 3 a turn: ladders appear, and the gold 3-7 under the ground gets mined.
        if (!goldAt.has(u.id)) {
          let best = Infinity, at = [cx, cz];
          for (let i = 0; i < S.g.length; i++) {
            if (S.g[i] !== B.GOLD) continue;
            const x = i % B.W, z = ((i / B.W) | 0) % B.D;
            if ((x < cx) !== (u.team === 0)) continue;
            const d = Math.abs(x - u.x) + Math.abs(z - u.z);
            if (d < best) { best = d; at = [x, z]; }
          }
          goldAt.set(u.id, at);
        }
        const [gx, gz] = goldAt.get(u.id);
        if (u.x !== gx || u.z !== gz) walk(u, gx, gz);
        for (let n = 0; n < 3; n++) {
          const b = S.units[k];
          if (b.x !== gx || b.z !== gz) break;
          if (!B.canDig(S, b, b.x, b.y - 1, b.z) || !action(`dig ${b.id} ${[b.x, b.y - 1, b.z]}`, () => B.dig(S, S.units[k], b.x, b.y - 1, b.z))) break;
        }
        continue;
      }
      const r = roles[u.id] || {};
      const foe = nearestEnemy(u);
      const goal = r.goal || (foe ? [foe.x, foe.z] : [cx, cz]);
      walk(u, ...goal);
      const target = S.units.find(v => B.canAttack(S, u, v));
      if (target) { action(`attack ${u.id}->${target.id}`, () => B.attack(S, u, target)); continue; }
      if (r.capture && B.canCapture(S, u)) { action(`capture ${u.id}`, () => B.capture(S, u)); continue; }
      if (r.dig) {
        const c = digTarget(u, ...r.dig);
        if (c && action(`dig ${u.id} ${c}`, () => B.dig(S, S.units[k], ...c))) {
          // Undo the whole dig (with its collapse/flood), check we're back, then redo it.
          const after = B.stateHash(S);
          B.undo(S); note('undo');
          B.redo(S); note('redo');
          if (B.stateHash(S) !== after) note('REDO MISMATCH');
        }
      }
    }
    if (B.turnGroups) turns.push({ groups: JSON.parse(JSON.stringify(B.turnGroups(S))), hash: B.stateHash(S) });
    B.endTurn(S);
    if (S.wnext.length) B.resolve(S);
    note(`end turn ${turn}`);
  }
  log.turns = turns;
  log.rules = S.rules || 1;
  return log;
}

if (typeof module === 'object' && module.exports) module.exports = { runScenario };
else root.runScenario = runScenario;
})(typeof globalThis !== 'undefined' ? globalThis : this);
