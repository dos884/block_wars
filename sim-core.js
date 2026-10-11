// Block Wars simulation core: pure, deterministic, integer-only. No Three.js, no DOM.
// Shared by the browser (sim.html loads it as a plain script → window.BlockSim)
// and by Node (require('./sim-core.js')), so the server replays turns with the same code.
(function (root) {
'use strict';

/* =========================================================
   SIM — deterministic, integer-only. Units live on grid cells.
   Each turn a unit can move to any cell in its move range, once.
   (Walking inside the range is a client-side visual; only the confirmed cell is real.)
   ========================================================= */
const W = 96, D = 96, H = 40;                  // the bases are ~5 turns apart at 6 tiles per turn
const WD = W * D, N = W * D * H;
const AIR = 0, GRASS = 1, DIRT = 2, STONE = 3, WOOD = 4, BEDROCK = 5, LEAVES = 6, GOLD = 7;
const SEED = 1;

const idx = (x, y, z) => x + z * W + y * WD;
const inGrid = (x, y, z) => x >= 0 && x < W && z >= 0 && z < D && y >= 0 && y < H;

function mix(a) {
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  return (a ^ (a >>> 16)) >>> 0;
}
const rnd = (a, b, c) => mix(Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791));

// The natural ground height of a column (before the bridge, reservoir and trees go on top).
function terrainTop(x, z, seed) {
  const S = 14;                                 // hill size
  const ix = (x / S) | 0, iz = (z / S) | 0, fx = x % S, fz = z % S;
  const a = rnd(ix, iz, seed) % 7, b = rnd(ix + 1, iz, seed) % 7;
  const c = rnd(ix, iz + 1, seed) % 7, d = rnd(ix + 1, iz + 1, seed) % 7;
  const h = ((a * (S - fx) * (S - fz) + b * fx * (S - fz) + c * (S - fx) * fz + d * fx * fz) / (S * S)) | 0;
  return 28 + h;                                // surface at 28..34: ~30 layers of underground to dig
}
function generate(seed, w) {
  const g = new Uint8Array(N);
  const heights = new Int32Array(WD);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const top = terrainTop(x, z, seed);
    heights[x + z * W] = top;
    for (let y = 0; y < top; y++) {
      g[idx(x, y, z)] = y === 0 ? BEDROCK : y < top - 3 ? STONE : y < top - 1 ? DIRT : GRASS;
    }
  }
  // Demo bridge near spawn: a wood deck on 4 wood pillars, gaps of 4 (wood reach 3 holds up to 6).
  // Break an inner pillar and the gap becomes 9, so the middle of that span crumbles.
  const BZ = (D >> 1) + 16, BX0 = (W >> 1) - 16, BX1 = BX0 + 30, PILLARS = [0, 5, 10, 15, 20, 25, 30].map(k => BX0 + k);
  let maxH = 0;
  for (let x = BX0; x <= BX1; x++) maxH = Math.max(maxH, heights[x + BZ * W]);
  const deckY = maxH + 3;
  for (const px of PILLARS) for (let y = heights[px + BZ * W]; y <= deckY; y++) g[idx(px, y, BZ)] = WOOD;
  for (let x = BX0; x <= BX1; x++) g[idx(x, deckY, BZ)] = WOOD;

  // Demo reservoir north of spawn: a stone basin raised on the hill, full of water,
  // with a wooden dam on its south wall and a stone staircase (spillway) leading down from it.
  const cx = W >> 1, cz = D >> 1;
  const LX0 = cx - 10, LX1 = cx + 10, LZ0 = cz - 32, LZ1 = cz - 20;         // water inside
  let top = 0;
  for (let z = LZ0 - 1; z <= LZ1 + 1; z++) for (let x = LX0 - 1; x <= LX1 + 1; x++) top = Math.max(top, heights[x + z * W]);
  const F = Math.min(top + 1, H - 8);                                        // lake floor (first water layer)
  const RIM = F + 5, WATER_TOP = F + 3;                                       // rim top, top water layer
  for (let z = LZ0 - 1; z <= LZ1 + 1; z++) for (let x = LX0 - 1; x <= LX1 + 1; x++) {
    const inside = x >= LX0 && x <= LX1 && z >= LZ0 && z <= LZ1;
    for (let y = 1; y < H; y++) {
      const i = idx(x, y, z);
      if (y < F) { if (!g[i]) g[i] = STONE; }
      else if (inside) { g[i] = AIR; if (y <= WATER_TOP) w[i] = WFULL; }
      else if (y <= RIM) g[i] = STONE;
    }
  }
  const DZ = LZ1 + 1;                                                        // dam: the middle of the south wall, in wood
  for (let x = cx - 6; x <= cx + 6; x++) for (let y = F; y <= RIM; y++) g[idx(x, y, DZ)] = WOOD;
  for (let k = 0; k < 30; k++) {                                             // apron at lake-floor level, then steps down
    const z = DZ + 1 + k, sy = k < 2 ? F - 1 : F - 1 - (k - 1);
    if (z >= D - 1) break;
    let any = false;
    for (let x = cx - 6; x <= cx + 6; x++) {
      if (sy < heights[x + z * W]) continue;
      any = true;
      for (let y = 1; y <= sy; y++) if (!g[idx(x, y, z)]) g[idx(x, y, z)] = STONE;
    }
    if (!any) break;
  }

  // Trees: trunks of wood with a leaf canopy — good for testing collapses.
  let placed = 0, tries = 0;
  const trunks = [];
  while (placed < 40 && tries < 3000) {
    tries++;
    const r = rnd(tries, placed, seed + 99);
    const x = 2 + (r % (W - 4)), z = 2 + ((r >>> 8) % (D - 4));
    if (UNIT_SPAWNS.some(([, ux, uz]) => Math.abs(ux - x) <= 2 && Math.abs(uz - z) <= 2)) continue;   // keep spawns clear
    if (BUILDING_SPOTS.some(([bx, bz]) => Math.abs(bx - x) <= 2 && Math.abs(bz - z) <= 2)) continue;   // keep buildings clear
    if (trunks.some(([tx, tz]) => Math.max(Math.abs(tx - x), Math.abs(tz - z)) < 4)) continue; // canopies must not touch
    if (Math.abs(z - BZ) <= 2 && x >= BX0 - 2 && x <= BX1 + 2) continue;                        // keep clear of the bridge
    if (x >= cx - 14 && x <= cx + 14 && z >= LZ0 - 4 && z <= cz - 2) continue;                   // keep clear of the reservoir
    trunks.push([x, z]);
    const base = heights[x + z * W];
    for (let t = 0; t < 3; t++) g[idx(x, base + t, z)] = WOOD;
    const leaf = (X, Y, Z) => { if (inGrid(X, Y, Z) && g[idx(X, Y, Z)] === AIR) g[idx(X, Y, Z)] = LEAVES; };
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      leaf(x + dx, base + 2, z + dz);
      leaf(x + dx, base + 3, z + dz);
    }
    leaf(x, base + 4, z); leaf(x + 1, base + 4, z); leaf(x - 1, base + 4, z);
    leaf(x, base + 4, z + 1); leaf(x, base + 4, z - 1);
    placed++;
  }
  return g;
}

/* ---------- Gold (rules 3): clusters of gold blocks underground, random per match but fair ----------
   Every cluster on Blue's half has a mirror image on Red's half (x → W-1-x), each block the same depth (3-7) under
   its own column's ground, so both sides dig exactly as far for the same gold. One pair sits near the middle. */
function placeGold(g, goldSeed, layout) {
  const cx = W >> 1;
  let n = 0;
  const next = () => rnd(n++, goldSeed, 7777);
  const top = (x, z) => terrainTop(x, z, SEED);
  const set = (x, y, z) => { if (y >= 2 && inGrid(x, y, z) && (g[idx(x, y, z)] === STONE || g[idx(x, y, z)] === DIRT)) g[idx(x, y, z)] = GOLD; };
  const put = (x, y, z) => {
    const depth = top(x, z) - y, mx = W - 1 - x;
    set(x, y, z);
    set(mx, top(mx, z) - depth, z);
  };
  // A cluster is a few neighbouring columns of gold, each running from 3 to 7 blocks under the ground,
  // so whichever of those layers you look at (the layer view), every cluster shows up in it.
  // Columns are never reused, so the total is exact: (6 x 4 + 4) columns x 5 blocks = 140 blocks = 10,500 gold a side.
  const used = new Set();
  const cluster = (x0, x1, columns, z0 = 6, z1 = D - 7) => {
    let x = x0 + next() % (x1 - x0 + 1), z = z0 + next() % (z1 - z0 + 1);
    for (let made = 0, tries = 0; made < columns && tries < 200; tries++) {
      if (!used.has(x + z * W)) {
        used.add(x + z * W);
        for (let depth = 3; depth <= 7; depth++) put(x, top(x, z) - depth, z);
        made++;
      }
      const d = next() % 4;                      // step to a neighbouring column
      x = Math.max(2, Math.min(cx - 1, x + (d === 0) - (d === 1)));
      z = Math.max(2, Math.min(D - 3, z + (d === 2) - (d === 3)));
    }
  };
  if (layout === 'grid') {                              // rules 6: a cluster somewhere in every ~15 x 15 square
    for (let x0 = 0; x0 < cx; x0 += 15) for (let z0 = 0; z0 < D; z0 += 15) {
      const x1 = Math.min(cx - 2, x0 + 14), z1 = Math.min(D - 3, z0 + 14);
      if (x1 - x0 >= 3 && z1 - z0 >= 3) cluster(Math.max(2, x0), x1, 4, Math.max(2, z0), z1);
    }
    return;
  }
  for (let k = 0; k < 6; k++) cluster(4, cx - 6, 4);   // six on each side, anywhere
  cluster(cx - 7, cx - 2, 4);                           // one pair close to the middle, to fight over                                        // one bigger pair close to the middle
}

const TEAM_NAMES = ['Blue', 'Red'];
const TEAM_COLORS = [0x3b82c4, 0xe0453a];
const MAX_HP = 10;

/* ---------- Unit types: one table, so they're easy to tune (and later, to mod) ---------- */
const TYPES = ['soldier', 'spearman', 'knight', 'archer', 'builder', 'screw'];   // new types go at the end (the hash uses the index)
const UNIT_TYPES = {
  soldier:  { label: 'Soldier',  move: 6, cost: 100, dig: 'soft', capture: true },
  spearman: { label: 'Spearman', move: 6, cost: 150, dig: 'soft', capture: true },
  knight:   { label: 'Knight',   move: 10, cost: 300, dig: 'none', capture: false, noClimb: true, tall: true },
  archer:   { label: 'Archer',   move: 6, cost: 200, dig: 'soft', capture: true, ranged: true },
  builder:  { label: 'Builder',  move: 6, cost: 150, dig: 'hard', capture: true },
  screw:    { label: 'Aerial Screw', move: 8, cost: 400, dig: 'none', capture: false, flies: true },   // rules 5+
};
// Base damage (out of 10 HP) by attacker row and defender column, before scaling by the attacker's health.
// Soldier beats spearman, spearman beats knight, knight beats soldier.
const DAMAGE = {
  //          soldier spearman knight archer builder
  soldier:  { soldier: 5, spearman: 7, knight: 3, archer: 6, builder: 7 },
  spearman: { soldier: 3, spearman: 5, knight: 7, archer: 6, builder: 7 },
  knight:   { soldier: 7, spearman: 3, knight: 5, archer: 8, builder: 8 },
  archer:   { soldier: 4, spearman: 4, knight: 3, archer: 5, builder: 6 },
  builder:  { soldier: 2, spearman: 2, knight: 1, archer: 2, builder: 3 },
};
// Rules versions. A match keeps the rules it started with, so stored games always replay exactly.
//  1: the original numbers above.
//  2: faster kills: same type vs same type dies in 2 hits from full health (base 6),
//     and the triangle's winner kills outright, even when hurt (soldier > spearman > knight > soldier).
const RULES = {
  1: { damage: DAMAGE, beats: {} },
  2: {
    damage: {
      //          soldier spearman knight archer builder
      soldier:  { soldier: 6, spearman: 10, knight: 3, archer: 6, builder: 7 },
      spearman: { soldier: 3, spearman: 6, knight: 10, archer: 6, builder: 7 },
      knight:   { soldier: 10, spearman: 3, knight: 6, archer: 8, builder: 8 },
      archer:   { soldier: 4, spearman: 4, knight: 3, archer: 6, builder: 6 },
      builder:  { soldier: 2, spearman: 2, knight: 1, archer: 2, builder: 6 },
    },
    beats: { soldier: 'spearman', spearman: 'knight', knight: 'soldier' },
  },
};
//  3: the gold economy: no villages; builders mine gold blocks (+75 each); bases pay 50 a turn;
//     the gold layout is random per match (a seed stored with it) but mirrored between the sides.
//     Only builders dig; every cell a builder digs gets ladders, which units (not knights) climb.
//     Knights can step up one block like everyone else.
RULES[3] = { ...RULES[2], villages: false, income: 50, goldValue: 75, goldMap: true, builderDigs: true, ladders: true, knightSteps: true };
//  4: each side also starts with a builder, and builders cost 500.
RULES[4] = { ...RULES[3], startBuilder: true, costs: { builder: 500 } };
//  5: the Aerial Screw, a flying unit with its own height: each move step goes one block across, up or down (1 move
//     each) through open air; it can't enter blocks, so it flies over (or under) terrain. It stays at its height.
//     Can't dig or capture. Drops stones on an enemy next to it (within 2 up/down) or anywhere straight below it.
//     Only archers (strongly), spearmen (reach 2 up) and other screws can hit it.
RULES[5] = {
  ...RULES[4], flyer: true,
  damage: {
    //          soldier spearman knight archer builder screw
    soldier:  { soldier: 6, spearman: 10, knight: 3, archer: 6, builder: 7, screw: 0 },
    spearman: { soldier: 3, spearman: 6, knight: 10, archer: 6, builder: 7, screw: 6 },
    knight:   { soldier: 10, spearman: 3, knight: 6, archer: 8, builder: 8, screw: 0 },
    archer:   { soldier: 4, spearman: 4, knight: 3, archer: 6, builder: 6, screw: 8 },
    builder:  { soldier: 2, spearman: 2, knight: 1, archer: 2, builder: 6, screw: 0 },
    screw:    { soldier: 5, spearman: 4, knight: 4, archer: 4, builder: 6, screw: 6 },
  },
};
//  6: much more gold, spread evenly but randomly: a 4-column cluster in every ~15 x 15 square of each half.
RULES[6] = { ...RULES[5], goldLayout: 'grid' };
//  7: no limit on units built per turn: as many as your gold allows; extra ones appear next to the base.
RULES[7] = { ...RULES[6], unlimitedBuild: true };
//  8: builders can place a stone block (25 gold) or a ladder (10 gold) in an empty cell within reach (3), as many as
//     they can pay for. Stone follows the usual support physics; a ladder needs a block next to it (sideways).
RULES[8] = { ...RULES[7], place: { stone: 25, ladder: 10 } };
const LATEST_RULES = 8;
// Flying (rules 5+): which units fly, which can hit a flyer, and how high a flyer hovers over a column.
const flies = (s, u) => !!UNIT_TYPES[u.type].flies && !!RULES[s.rules || 1].flyer;
const hitsFlyers = type => type === 'archer' || type === 'spearman' || type === 'screw';
const typesFor = s => TYPES.filter(t => !UNIT_TYPES[t].flies || RULES[s.rules || 1].flyer);
// What a unit costs under these rules.
const costOf = (s, type) => ((RULES[s.rules || 1].costs || {})[type]) ?? UNIT_TYPES[type].cost;
//                air grass dirt stone wood bedrock leaves gold
const SOFT = [     0,   1,    1,   0,    1,   0,      1,     0 ];   // grass, dirt, wood, leaves: infantry can dig these
const unitName = u => UNIT_TYPES[u.type].label + ' ' + (u.id + 1);

/* ---------- Buildings: villages give gold, each team's base builds units; capturing the enemy base wins ---------- */
const CAPTURE_PTS = 20, INCOME = 100, START_GOLD = 300;
const BASE_X = 20;                               // bases sit 20 tiles either side of the centre: 40 apart
const VILLAGE_OFFSETS = [[14, 4], [28, -20], [8, 28], [32, 24]];     // mirrored left/right: 8 villages
const BUILDING_SPOTS = (() => {                 // [x, z, kind, owner]
  const cx = W >> 1, cz = D >> 1, out = [[cx - BASE_X, cz, 'base', 0], [cx + BASE_X, cz, 'base', 1]];
  for (const [d, dz] of VILLAGE_OFFSETS) out.push([cx - d, cz + dz, 'village', -1], [cx + d, cz + dz, 'village', -1]);
  return out;
})();
const DROWN_LEVEL = 48, DROWN_DMG = 2;           // deep water: 3/4 of a block or more
const SPAWN_OFFSET = 16;                        // each army starts just in front of its base
// Starting soldiers: each army stands just in front of its own base (mirrored).
const UNIT_SPAWNS = (() => {
  const cx = W >> 1, cz = D >> 1, out = [];
  for (const d of [-2, 0, 2]) out.push([0, cx - SPAWN_OFFSET, cz + d]);
  for (const d of [-2, 0, 2]) out.push([1, cx + SPAWN_OFFSET, cz + d]);
  return out;
})();
function groundY(g, x, z) { let y = 0; while (y < H && g[idx(x, y, z)]) y++; return y; }

// Every block change goes through setCell, which keeps three things up to date:
// the incremental block hash, the list of changed cells (for redrawing), and the region to re-check for support.
const zob = (i, v) => v ? mix(Math.imul(i, 8) + v) : 0;
function blockHash(g) { let h = 0; for (let i = 0; i < N; i++) if (g[i]) h ^= zob(i, g[i]); return h; }
/* ---------- Water: finite, levels 0..WFULL per air cell. Falls first, then levels out sideways. ---------- */
const WFULL = 64;                               // levels per block: fine enough that frozen slopes are tiny
const TENSION = 8;                              // water must be 1/8 of a block deep to spread onto a dry tile
const zw = (i, v) => v ? mix(Math.imul(i, 16) + v + 1000003) : 0;
function waterHash(w) { let h = 0; for (let i = 0; i < N; i++) if (w[i]) h ^= zw(i, w[i]); return h; }
function wakeWater(s, i) {
  // Awake cells for the next tick: a flat list plus a mark per cell, so each cell is listed once.
  const m = s.wmark, gen = s.wgen, q = s.wnext;
  const wake = k => { if (m[k] !== gen) { m[k] = gen; q.push(k); } };
  wake(i);
  const x = i % W, z = ((i / W) | 0) % D, y = (i / WD) | 0;
  if (x > 0) wake(i - 1); if (x < W - 1) wake(i + 1);
  if (z > 0) wake(i - W); if (z < D - 1) wake(i + W);
  if (y > 0) wake(i - WD); if (y < H - 1) wake(i + WD);
}
function setWater(s, i, v) {
  const old = s.w[i];
  if (old === v) return;
  if (s.jr && s.jw[i] !== s.jstamp) { s.jw[i] = s.jstamp; s.jr.wi.push(i); s.jr.wo.push(old); }
  s.wh ^= zw(i, old) ^ zw(i, v);
  s.w[i] = v;
  s.wchanged.push(i);
  wakeWater(s, i);
}
// Search the same layer, up to DRAIN_R steps through cells that aren't full, for a "drop": an open cell with room
// below it. Returns the first neighbour on the shortest way there (fixed direction order, so it's deterministic), or -1.
const DRAIN_R = 6, DRW = 2 * DRAIN_R + 1;
const dSeen = new Int32Array(DRW * DRW), dFirst = new Int32Array(DRW * DRW), dQ = new Int32Array(DRW * DRW);
let dStamp = 0;
function drainStep(s, i) {
  const g = s.g, w = s.w, y = (i / WD) | 0;
  if (y === 0) return -1;
  const ix = i % W, iz = ((i / W) | 0) % D;
  const key = (x, z) => (x - ix + DRAIN_R) * DRW + (z - iz + DRAIN_R);
  dStamp++;
  dSeen[key(ix, iz)] = dStamp;
  let head = 0, tail = 0;
  dQ[tail++] = i;
  for (let r = 0; r < DRAIN_R && head < tail; r++) {
    const end = tail;
    for (; head < end; head++) {
      const c = dQ[head], x = c % W, z = ((c / W) | 0) % D;
      for (let d = 0; d < 4; d++) {
        const X = x + (d === 0 ? 1 : d === 2 ? -1 : 0), Z = z + (d === 1 ? 1 : d === 3 ? -1 : 0);
        if (X < 0 || X >= W || Z < 0 || Z >= D) continue;
        const k = key(X, Z);
        if (dSeen[k] === dStamp) continue;
        const j = X + Z * W + y * WD;
        if (g[j] || w[j] >= WFULL) continue;
        dSeen[k] = dStamp;
        const first = c === i ? j : dFirst[key(x, z)];
        if (!g[j - WD] && w[j - WD] < WFULL) return first;      // found a drop
        dFirst[k] = first;
        dQ[tail++] = j;
      }
    }
  }
  return -1;
}
// Pressure head of a water cell, in water units: a full cell under more water feels the whole column above it,
// so a hole at the bottom of a deep lake pushes hard. A cell open to the air feels only its own level.
function waterHead(s, i) {
  const w = s.w, g = s.g;
  let k = i, y = (i / WD) | 0;
  while (w[k] === WFULL && y < H - 1 && !g[k + WD] && w[k + WD]) { k += WD; y++; }
  return y * WFULL + w[k];
}
// One water tick. Every awake cell moves only the water it had at the start of the tick:
// down into the cell below if there's room, otherwise sideways toward lower pressure.
const DIR_X = [1, 0, -1, 0], DIR_Z = [0, 1, 0, -1];
function waterStep(s) {
  if (!s.wnext.length) return false;
  const list = Int32Array.from(s.wnext).sort();   // numeric, ascending: a fixed order keeps it deterministic
  s.wnext = [];
  s.wgen++;
  const g = s.g, w = s.w;
  const snap = new Uint8Array(list.length);
  for (let n = 0; n < list.length; n++) snap[n] = w[list[n]];
  const flip = (s.wtick++ & 1) ? 2 : 0;           // alternate the starting direction each tick, so there's no drift
  let changed = false;
  for (let n = 0; n < list.length; n++) {
    const i = list[n];
    if (g[i]) continue;
    let avail = Math.min(snap[n], w[i]);
    if (!avail) continue;
    const y = (i / WD) | 0;
    if (y > 0 && !g[i - WD] && w[i - WD] < WFULL) {
      const b = i - WD, d = Math.min(avail, WFULL - w[b]);
      setWater(s, b, w[b] + d); setWater(s, i, w[i] - d);
      avail -= d; changed = true;
      continue;                                  // falling water doesn't also spread this tick
    }
    const x = i % W, z = ((i / W) | 0) % D;
    let spread = false;
    let hi = waterHead(s, i);
    const open = w[i] < WFULL;                  // not under pressure: its head is just its own level
    for (let k = 0; k < 4 && avail; k++) {
      const dir = (k + flip) & 3, dx = DIR_X[dir], dz = DIR_Z[dir];
      const X = x + dx, Z = z + dz;
      if (X < 0 || X >= W || Z < 0 || Z >= D) continue;
      const j = i + dx + dz * W;
      if (g[j]) continue;
      const wj = w[j];
      if (!wj && w[i] < TENSION) continue;      // surface tension: shallow water doesn't wet dry ground
      if (open && wj + 1 >= w[i]) continue;     // cheap early out: can't be 2 levels lower
      // Move half the difference in pressure head (at least 2 apart), limited by what fits and what we have.
      const d = Math.min(avail, WFULL - wj, (hi - waterHead(s, j)) >> 1);
      if (d <= 0) continue;
      setWater(s, j, wj + d); setWater(s, i, w[i] - d);
      avail -= d; changed = true; spread = true;
      hi = waterHead(s, i);
    }
    // Stuck (thin film, nothing 2 levels lower next to it)? Trickle one unit toward the nearest drop, if one is close.
    if (!spread && avail && w[i] <= 16 && s.dfail[i] <= s.wtick) {   // only thin water; skip cells that just searched in vain
      const j = drainStep(s, i);
      if (j < 0) s.dfail[i] = s.wtick + 8;      // nothing within reach: don't search again for 8 ticks
      if (j >= 0 && w[j] < w[i]) { setWater(s, j, w[j] + 1); setWater(s, i, w[i] - 1); changed = true; spread = true; }
    }
  }
  return changed;
}

/* ---------- Ladders (rules 3): a set of air cells you can climb. A block filling the cell removes its ladder. ---------- */
const zl = i => mix(Math.imul(i, 32) + 77777);
function addLadder(s, i) { if (s.lad && !s.lad.has(i)) { s.lad.add(i); s.lh ^= zl(i); } }
function dropLadder(s, i) { if (s.lad && s.lad.has(i)) { s.lad.delete(i); s.lh ^= zl(i); } }
const hasLadder = (s, x, y, z) => !!s.lad && inGrid(x, y, z) && s.lad.has(idx(x, y, z));
const climbsLadders = u => u.type !== 'knight';
const onLadder = (s, u) => climbsLadders(u) && hasLadder(s, u.x, u.y, u.z);

function setCell(s, i, v) {
  const old = s.g[i];
  if (old === v) return;
  if (v !== AIR) dropLadder(s, i);
  if (s.jr && s.jg[i] !== s.jstamp) { s.jg[i] = s.jstamp; s.jr.gi.push(i); s.jr.go.push(old); }
  if (v !== AIR && s.w[i]) {                     // a block landing in water pushes the water up (overflow is lost)
    const a = i + WD;
    if ((i / WD | 0) < H - 1 && !s.g[a]) setWater(s, a, Math.min(WFULL, s.w[a] + s.w[i]));
    setWater(s, i, 0);
  }
  s.bh ^= zob(i, old) ^ zob(i, v);
  s.g[i] = v;
  s.changed.push(i);
  wakeWater(s, i);
  const x = i % W, z = ((i / W) | 0) % D, r = s.region;
  if (!r) s.region = { x0: x, x1: x, z0: z, z1: z };
  else { if (x < r.x0) r.x0 = x; if (x > r.x1) r.x1 = x; if (z < r.z0) r.z0 = z; if (z > r.z1) r.z1 = z; }
}

function newState(rules = LATEST_RULES, seed = 1) {
  const R = RULES[rules];
  if (!R) throw new Error('unknown rules version ' + rules);
  const w = new Uint8Array(N);
  const g = generate(SEED, w);
  if (R.goldMap) placeGold(g, seed, R.goldLayout);
  const cx = W >> 1, cz = D >> 1;
  const spots = [];
  spots.push(...UNIT_SPAWNS);
  if (R.startBuilder) spots.push([0, cx - SPAWN_OFFSET - 1, cz], [1, cx + SPAWN_OFFSET + 1, cz]);   // a builder behind each army
  const units = spots.map(([team, x, z], k) => ({ id: k, type: k >= UNIT_SPAWNS.length ? 'builder' : 'soldier', team, x, y: groundY(g, x, z), z, hp: MAX_HP, moved: false, acted: false, dead: false }));
  const buildings = BUILDING_SPOTS.filter(([, , kind]) => kind === 'base' || R.villages !== false)
    .map(([x, z, kind, owner]) => ({ kind, owner, x, y: groundY(g, x, z), z, cp: CAPTURE_PTS, capBy: -1 }));
  return { rules, seed, lad: R.ladders ? new Set() : undefined, lh: 0, g, units, buildings, gold: [START_GOLD, START_GOLD], built: false, winner: -1, team: 0, turn: 1, moves: 0, events: [], loot: [], nextLoot: 1, inv: [0, 0, 0, 0, 0, 0, 0],
           bh: blockHash(g), changed: [], region: null,
           w, wh: waterHash(w), wnext: [], wmark: new Int32Array(N), wgen: 1, dfail: new Int32Array(N),
           jr: null, jg: new Int32Array(N), jw: new Int32Array(N), jstamp: 0, history: [], cursor: 0, wchanged: [], wtick: 0 };
}

const solidAt = (s, x, y, z) => inGrid(x, y, z) && s.g[idx(x, y, z)] !== AIR;
function unitAt(s, x, y, z, except) {
  for (const u of s.units) if (u !== except && !u.dead && u.x === x && u.y === y && u.z === z) return u;
  return null;
}
// A cell a unit can occupy: inside the world's sides, not solid, not taken by another unit.
function freeCell(s, x, y, z, except) {
  return x >= 0 && x < W && z >= 0 && z < D && y >= 1 && y < H + 4 && !solidAt(s, x, y, z) && !unitAt(s, x, y, z, except);
}
// Commit a unit to a cell (the snapped result of walking).
function placeUnit(s, u, x, y, z) {
  if (!freeCell(s, x, y, z, u)) return false;
  if (u.x !== x || u.y !== y || u.z !== z) s.moves++;
  u.x = x; u.y = y; u.z = z;
  settleUnits(s);
  return true;
}
// Units are pushed up out of blocks and fall when nothing is under them (a unit below counts as ground).
// A flyer hovers in the first open cell above a column's top block and any water on it.
function flyY(s, x, z) {
  let y = H;
  while (y > 1 && !s.g[idx(x, y - 1, z)]) y--;
  while (y < H && s.w[idx(x, y, z)]) y++;
  return y;
}
function settleUnits(s) {
  for (const u of s.units) if (!u.dead) while (u.y < H + 3 && solidAt(s, u.x, u.y, u.z)) u.y++;
  let moved = true;
  while (moved) {
    moved = false;
    for (const u of s.units) {
      if (u.dead || flies(s, u)) continue;
      if (u.y > 1 && !solidAt(s, u.x, u.y - 1, u.z) && !unitAt(s, u.x, u.y - 1, u.z, u) && !onLadder(s, u)) { u.y--; moved = true; }
    }
  }
  collectLoot(s);
}

/* ---------- Movement range (Advance Wars style) ----------
   Every step to a neighbouring column costs 1: walking flat, stepping up 1, or dropping down any height.
   Blocks and other units block; units can't be climbed over. */
const cellKey = (x, y, z) => x + ',' + y + ',' + z;
// From a free cell, drop to where a unit would stand. -1 if the cell isn't free.
function standY(s, x, y, z, u) {
  if (!freeCell(s, x, y, z, u)) return -1;
  // Drop until something holds you: ground, a unit below, or (for climbers) a ladder.
  while (y > 1 && !solidAt(s, x, y - 1, z) && !unitAt(s, x, y - 1, z, u) && !(climbsLadders(u) && hasLadder(s, x, y, z))) y--;
  return y;
}
// One step from (x,y,z) toward a neighbouring column: walk flat, drop, or climb one. Returns the new y, or -1.
function stepTo(s, u, x, y, z, dx, dz) {
  const t = UNIT_TYPES[u.type], nx = x + dx, nz = z + dz;
  let ny = standY(s, nx, y, nz, u);
  if (ny < 0) {
    const noClimb = t.noClimb && !RULES[s.rules || 1].knightSteps;
    if (noClimb || !solidAt(s, nx, y, nz)) return -1;        // knights can't climb (before rules 3); units and edges block
    if (!freeCell(s, x, y + 1, z, u) || !freeCell(s, nx, y + 1, nz, u)) return -1;
    ny = y + 1;
  }
  if (t.tall && solidAt(s, nx, Math.max(y, ny) + 1, nz)) return -1;   // 2 tall: needs headroom, so no tunnels
  return ny;
}
const moveOf = u => UNIT_TYPES[u.type].move;
// Every cell one move away: the four neighbouring columns, plus up and down a ladder.
function stepsFrom(s, u, x, y, z) {
  const out = [];
  if (flies(s, u)) {                                  // fly one block across, up or down, through open air
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]])
      if (freeCell(s, x + dx, y + dy, z + dz, u)) out.push([x + dx, y + dy, z + dz]);
    return out;
  }
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const ny = stepTo(s, u, x, y, z, dx, dz);
    if (ny >= 0) out.push([x + dx, ny, z + dz]);
  }
  if (climbsLadders(u) && hasLadder(s, x, y, z)) {
    if (hasLadder(s, x, y + 1, z) && freeCell(s, x, y + 1, z, u)) out.push([x, y + 1, z]);   // climb up
    const dy = y > 1 ? standY(s, x, y - 1, z, u) : -1;                                          // climb (or drop) down
    if (dy >= 1) out.push([x, dy, z]);
  }
  return out;
}
function moveRange(s, u, steps) {
  const dist = new Map();
  const q = [[u.x, u.y, u.z]];
  dist.set(cellKey(u.x, u.y, u.z), 0);
  for (let h = 0; h < q.length; h++) {
    const [x, y, z] = q[h], d = dist.get(cellKey(x, y, z));
    if (d >= steps) continue;
    for (const c of stepsFrom(s, u, x, y, z)) {
      const k = cellKey(...c);
      if (!dist.has(k)) { dist.set(k, d + 1); q.push(c); }
    }
  }
  return dist;
}
// Confirm a move: the target must be in range and the unit not moved yet this turn.
function moveUnit(s, u, x, y, z) {
  if (u.dead || u.team !== s.team || u.moved) return false;
  if (!moveRange(s, u, moveOf(u)).has(cellKey(x, y, z))) return false;
  if (!placeUnit(s, u, x, y, z)) return false;
  u.moved = true;
  resetCaptures(s);
  record(s, { t: 'move', u: u.id, x, y, z });
  return true;
}
/* ---------- Digging: break any block within DIG_REACH of the unit (no limit per turn) ---------- */
const DIG_REACH = 3;
// What a unit can dig: 'none', 'soft' or 'hard'. Under rules 3 only builders dig.
const digTool = (s, u) => RULES[s.rules || 1].builderDigs && u.type !== 'builder' ? 'none' : UNIT_TYPES[u.type].dig;
function canDig(s, u, x, y, z) {
  if (u.dead || u.team !== s.team || !inGrid(x, y, z)) return false;
  const m = s.g[idx(x, y, z)];
  if (m === AIR || m === BEDROCK) return false;
  const tool = digTool(s, u);
  if (tool === 'none' || (tool === 'soft' && !SOFT[m])) return false;
  return Math.max(Math.abs(x - u.x), Math.abs(y - u.y), Math.abs(z - u.z)) <= DIG_REACH;
}
// Placing (rules 8): what a builder can put where, and what it costs.
const placeCost = (s, what) => ((RULES[s.rules || 1].place || {})[what]);
function canPlace(s, u, what, x, y, z) {
  const cost = placeCost(s, what);
  if (cost === undefined || u.dead || u.type !== 'builder' || u.team !== s.team || s.gold[s.team] < cost) return false;
  if (!inGrid(x, y, z) || y < 1 || s.g[idx(x, y, z)] !== AIR || unitAt(s, x, y, z)) return false;
  if (Math.max(Math.abs(x - u.x), Math.abs(y - u.y), Math.abs(z - u.z)) > DIG_REACH) return false;
  if (what === 'ladder') {
    if (hasLadder(s, x, y, z)) return false;
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => solidAt(s, x + dx, y, z + dz));
  }
  return true;
}
function place(s, u, what, x, y, z) {
  if (!canPlace(s, u, what, x, y, z)) return false;
  if (what === 'stone') setCell(s, idx(x, y, z), STONE);
  else addLadder(s, idx(x, y, z));
  s.gold[s.team] -= placeCost(s, what);
  s.moves++;
  record(s, { t: 'place', u: u.id, what, x, y, z });
  return true;
}
function dig(s, u, x, y, z) {
  if (!canDig(s, u, x, y, z)) return false;
  const m = s.g[idx(x, y, z)];
  setCell(s, idx(x, y, z), AIR);
  if (RULES[s.rules || 1].ladders && y < u.y) addLadder(s, idx(x, y, z));  // digging below your feet leaves a ladder
  // Digging the block under your own feet takes you down into the hole (you don't hang on its ladder).
  if (RULES[s.rules || 1].ladders && x === u.x && z === u.z && y === u.y - 1) { u.y = y; settleUnits(s); }
  if (m === GOLD) s.gold[s.team] += RULES[s.rules || 1].goldValue || 0;   // mining pays at once
  s.moves++;
  record(s, { t: 'dig', u: u.id, x, y, z });
  return true;
}
/* ---------- Attacking: an adjacent enemy (one tile, up to one block up or down), once per turn ---------- */
// Melee: an adjacent tile, at most one block up or down. Archers: 2-3 tiles away, +1 range from 2+ blocks higher.
const adjacent = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1 && Math.abs(a.y - b.y) <= 1;
function inReach(s, a, b) {
  if (flies(s, a) || flies(s, b)) {                    // flyers: next to each other within 2 up/down, or a flyer right above
    if (UNIT_TYPES[a.type].ranged) { const d = Math.abs(a.x - b.x) + Math.abs(a.z - b.z); return d >= 2 && d <= 3 + (a.y - b.y >= 2 ? 1 : 0); }
    const d = Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
    return (d === 1 && Math.abs(a.y - b.y) <= 2) || (flies(s, a) && d === 0 && b.y < a.y);
  }
  if (!UNIT_TYPES[a.type].ranged) return adjacent(a, b);
  const d = Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
  return d >= 2 && d <= 3 + (a.y - b.y >= 2 ? 1 : 0);
}
function canAttack(s, a, b) {
  if (a.dead || b.dead || a.team !== s.team || b.team === a.team || a.acted) return false;
  if (flies(s, b) && !hitsFlyers(a.type)) return false;
  return inReach(s, a, b);
}
// Damage scales with the attacker's health (a hurt unit hits softer), rounded, at least 1.
// Under rules 2 the triangle's winner kills outright.
function damageOf(s, a, b) {
  const r = RULES[s.rules || 1];
  if (r.beats[a.type] === b.type) return b.hp;
  return Math.max(1, Math.floor((r.damage[a.type][b.type] * a.hp + 5) / 10));
}
function hurt(s, u, d) {
  u.hp = Math.max(0, u.hp - d);
  if (!u.hp) { u.dead = true; resetCaptures(s); }
}
function attack(s, a, b) {
  if (!canAttack(s, a, b)) return false;
  hurt(s, b, damageOf(s, a, b));
  // Survivors strike back if they fight up close and the attacker is next to them (archers never do).
  if (!b.dead && !UNIT_TYPES[b.type].ranged && (flies(s, a) || flies(s, b) ? !(flies(s, a) && !hitsFlyers(b.type)) && inReach(s, b, a) : adjacent(a, b)))
    hurt(s, a, damageOf(s, b, a));
  a.acted = true; a.moved = true;              // attacking finishes the unit's turn
  s.moves++;
  record(s, { t: 'attack', u: a.id, v: b.id });
  return true;
}
// Hot-seat turns: control passes to the other team; a full round (Blue then Red) is one turn.
/* ---------- Capture and build ---------- */
const buildingAt = (s, x, y, z) => s.buildings.find(b => b.x === x && b.y === y && b.z === z) || null;
// A capture in progress is lost if the capturing unit leaves the tile or dies.
function resetCaptures(s) {
  for (const b of s.buildings) {
    if (b.capBy < 0) continue;
    const u = s.units[b.capBy];
    if (!u || u.dead || u.x !== b.x || u.y !== b.y || u.z !== b.z) { b.capBy = -1; b.cp = CAPTURE_PTS; }
  }
}
function canCapture(s, u) {
  if (s.winner >= 0 || u.dead || u.team !== s.team || u.acted || !UNIT_TYPES[u.type].capture) return null;
  const b = buildingAt(s, u.x, u.y, u.z);
  return b && b.owner !== u.team ? b : null;
}
function capture(s, u) {
  const b = canCapture(s, u);
  if (!b) return false;
  if (b.capBy !== u.id) { b.capBy = u.id; b.cp = CAPTURE_PTS; }
  b.cp -= u.hp;                                  // a healthy unit takes 2 turns, a hurt one longer
  if (b.cp <= 0) {
    b.owner = u.team; b.cp = CAPTURE_PTS; b.capBy = -1;
    if (b.kind === 'base') s.winner = u.team;    // taking the enemy base wins the match
  }
  u.acted = true; u.moved = true;
  s.moves++;
  record(s, { t: 'capture', u: u.id });
  return true;
}
const baseOf = (s, team) => s.buildings.find(b => b.kind === 'base' && b.owner === team) || null;
// Where a new unit appears: the base tile; under rules 7 (no limit per turn), if that's taken, the nearest free
// tile around the base (rings of 1-3 tiles, a fixed order). null if there's no room.
function buildSpot(s) {
  const b = baseOf(s, s.team);
  if (!b) return null;
  if (!unitAt(s, b.x, b.y, b.z) && !solidAt(s, b.x, b.y, b.z)) return [b.x, b.y, b.z];
  if (!RULES[s.rules || 1].unlimitedBuild) return null;
  for (let r = 1; r <= 3; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    const x = b.x + dx, z = b.z + dz;
    if (x < 0 || x >= W || z < 0 || z >= D) continue;
    let y = H; while (y > 1 && !s.g[idx(x, y - 1, z)]) y--;
    if (y < H && freeCell(s, x, y, z)) return [x, y, z];
  }
  return null;
}
function canBuild(s, type) {
  const b = baseOf(s, s.team), t = UNIT_TYPES[type];
  if (s.winner >= 0 || !b || !t || s.gold[s.team] < costOf(s, type)) return false;
  if (s.built && !RULES[s.rules || 1].unlimitedBuild) return false;      // one unit a turn (before rules 7)
  if (t.flies && !RULES[s.rules || 1].flyer) return false;
  return !!buildSpot(s);
}
function buildUnit(s, type) {
  if (!canBuild(s, type)) return null;
  const [x, y, z] = buildSpot(s);
  const u = { id: s.units.length, type, team: s.team, x, y, z, hp: MAX_HP, moved: true, acted: true, dead: false };
  s.units.push(u);                               // new units wait until next turn
  s.gold[s.team] -= costOf(s, type);
  s.built = true;
  s.moves++;
  settleUnits(s);
  record(s, { t: 'build', type });
  return u;
}
const incomeOf = (s, team) => (RULES[s.rules || 1].income || INCOME) * s.buildings.filter(b => b.owner === team).length;

/* ---------- Turns as data: what the client sends and the server replays ----------
   Every successful player action is recorded in the current journal entry, so a turn is simply the list of
   journal entries still in effect (undone ones drop out by themselves). Each entry is a "group": the actions
   that ran as one undoable step in the browser, e.g. [move, dig]. Replaying a group re-runs them the same way. */
function record(s, a) { if (s.jr) s.jr.acts.push(a); }
const turnGroups = s => s.history.slice(0, s.cursor).map(j => j.acts);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
// Run one recorded action. Input comes from the network, so check its shape before touching the state.
function runAct(s, a) {
  if (!a || typeof a !== 'object') return false;
  if (a.t === 'build') return TYPES.includes(a.type) && !!buildUnit(s, a.type);
  if (!isInt(a.u, 0, s.units.length - 1)) return false;
  const u = s.units[a.u];
  if (a.t === 'place') {
    if (a.what !== 'stone' && a.what !== 'ladder') return false;
    if (!isInt(a.x, 0, W - 1) || !isInt(a.y, 1, H - 1) || !isInt(a.z, 0, D - 1)) return false;
    return place(s, u, a.what, a.x, a.y, a.z);
  }
  if (a.t === 'move' || a.t === 'dig') {
    if (!isInt(a.x, -1, W) || !isInt(a.y, -1, H + 4) || !isInt(a.z, -1, D)) return false;
    return a.t === 'move' ? moveUnit(s, u, a.x, a.y, a.z) : dig(s, u, a.x, a.y, a.z);
  }
  if (a.t === 'attack') return isInt(a.v, 0, s.units.length - 1) && attack(s, u, s.units[a.v]);
  if (a.t === 'capture') return capture(s, u);
  return false;
}
// One group, exactly as the browser ran it: one journal entry; a dig's collapse and flood resolve inside it.
function runGroup(s, acts) {
  if (!Array.isArray(acts) || !acts.length || acts.length > 4) return false;
  beginAction(s);
  let ok = true, dug = false;
  for (const a of acts) { if (!runAct(s, a)) { ok = false; break; } if (a.t === 'dig' || (a.t === 'place' && a.what === 'stone')) dug = true; }
  if (ok && dug) resolve(s);
  endAction(s);
  return ok;
}
// A whole turn from the team to move: its groups, then the hash the sender saw before pressing End turn.
// Then End turn (unless someone won), with whatever water it wakes. Returns null if fine, else the reason.
// On failure the state is half-applied: the caller must throw it away.
const MAX_GROUPS = 400;
function replayTurn(s, turn) {
  if (s.winner >= 0) return 'match is over';
  if (!turn || !Array.isArray(turn.groups) || turn.groups.length > MAX_GROUPS) return 'bad turn';
  for (let k = 0; k < turn.groups.length; k++) if (!runGroup(s, turn.groups[k])) return 'illegal action in group ' + k;
  const h = stateHash(s);
  if (turn.hash !== h) return 'desync: sender had ' + turn.hash + ', replay gives ' + h;
  if (s.winner < 0) finishTurn(s);
  return null;
}
// End turn plus its water: the browser animates the same steps with settle().
function finishTurn(s) {
  endTurn(s);
  if (s.wnext.length) resolve(s);
}

/* ---------- Undo / redo: every action this turn is journaled and stays undoable until End turn ----------
   While an action runs (including its collapse and flood), the first change to each block or water cell is recorded
   with its old value; a small snapshot covers units, loot and counters. Undo writes old values back, redo the new ones. */
function smallSnap(s) {
  return JSON.parse(JSON.stringify({ units: s.units, loot: s.loot, nextLoot: s.nextLoot, inv: s.inv, team: s.team, turn: s.turn,
    moves: s.moves, bh: s.bh, wh: s.wh, wtick: s.wtick, wnext: s.wnext,
    buildings: s.buildings, gold: s.gold, built: s.built, winner: s.winner,
    lad: s.lad ? [...s.lad] : undefined, lh: s.lh }));
}
function applySmall(s, m) {
  s.units = JSON.parse(JSON.stringify(m.units));   // also undoes units that were built
  s.buildings = JSON.parse(JSON.stringify(m.buildings));
  s.gold = m.gold.slice();
  s.built = m.built; s.winner = m.winner;
  s.loot = JSON.parse(JSON.stringify(m.loot));
  s.inv = m.inv.slice();
  Object.assign(s, { nextLoot: m.nextLoot, team: m.team, turn: m.turn, moves: m.moves, bh: m.bh, wh: m.wh, wtick: m.wtick });
  if (m.lad) { s.lad = new Set(m.lad); s.lh = m.lh; }
  s.wgen++; s.wnext = [];                       // fresh wake list (normally empty between actions)
  for (const i of m.wnext) if (s.wmark[i] !== s.wgen) { s.wmark[i] = s.wgen; s.wnext.push(i); }
  s.region = null;
}
function beginAction(s) {
  if (s.jr) return;
  s.jstamp++;
  s.dfail.fill(0);                              // drain-search cache never carries over between actions
  s.jr = { gi: [], go: [], wi: [], wo: [], acts: [], before: smallSnap(s) };
}
function endAction(s) {
  const j = s.jr;
  if (!j) return false;
  s.jr = null;
  j.after = smallSnap(s);
  j.gn = j.gi.map(i => s.g[i]);
  j.wn = j.wi.map(i => s.w[i]);
  if (!j.gi.length && !j.wi.length && JSON.stringify(j.before) === JSON.stringify(j.after)) return false;   // nothing happened
  s.history.length = s.cursor;                  // a new action drops anything that was undone
  s.history.push(j);
  s.cursor++;
  return true;
}
function undo(s) {
  if (s.jr || !s.cursor) return false;
  const j = s.history[--s.cursor];
  for (let k = j.gi.length - 1; k >= 0; k--) { s.g[j.gi[k]] = j.go[k]; s.changed.push(j.gi[k]); }
  for (let k = j.wi.length - 1; k >= 0; k--) { s.w[j.wi[k]] = j.wo[k]; s.wchanged.push(j.wi[k]); }
  applySmall(s, j.before);
  return true;
}
function redo(s) {
  if (s.jr || s.cursor >= s.history.length) return false;
  const j = s.history[s.cursor++];
  for (let k = 0; k < j.gi.length; k++) { s.g[j.gi[k]] = j.gn[k]; s.changed.push(j.gi[k]); }
  for (let k = 0; k < j.wi.length; k++) { s.w[j.wi[k]] = j.wn[k]; s.wchanged.push(j.wi[k]); }
  applySmall(s, j.after);
  return true;
}
function endTurn(s) {
  s.history = []; s.cursor = 0;                 // End turn commits: nothing before this can be undone
  s.team = 1 - s.team;
  if (s.team === 0) s.turn++;
  for (const u of s.units) if (u.team === s.team) { u.moved = false; u.acted = false; }
  s.built = false;
  s.gold[s.team] += incomeOf(s, s.team);       // every village and base you own pays at the start of your turn
  // Soldiers starting their turn in deep water take damage.
  s.drowned = [];
  for (const u of s.units) {
    if (u.dead || u.team !== s.team || flies(s, u) || !inGrid(u.x, u.y, u.z) || s.w[idx(u.x, u.y, u.z)] < DROWN_LEVEL) continue;
    hurt(s, u, DROWN_DMG);
    s.drowned.push(u.id);
  }
  resetCaptures(s);                              // a capturer that fell or was washed off its tile loses progress
}

const nb = new Int32Array(6);
function neighbours(i) {
  const x = i % W, z = ((i / W) | 0) % D, y = (i / WD) | 0;
  let n = 0;
  if (x > 0) nb[n++] = i - 1;
  if (x < W - 1) nb[n++] = i + 1;
  if (z > 0) nb[n++] = i - W;
  if (z < D - 1) nb[n++] = i + W;
  if (y > 0) nb[n++] = i - WD;
  if (y < H - 1) nb[n++] = i + WD;
  return n;
}

/* ---------- Support: one rule for every material ----------
   A block is supported if it rests on a supported block (inherits its distance)
   or hangs sideways / below one (distance + 1). Each material has a max reach.
   Leaves only take support from wood or leaves; nothing takes support from leaves.

     #      ##      ###        distance 0, 1, 2 from the column
     #       #        #
*/
//                 air grass dirt stone wood bedrock leaves
//                 air grass dirt stone wood bedrock leaves gold
const REACH   = [  0,   1,    1,   2,    3,   0,      2,     2 ];
const FRAGILE = [  0,   1,    1,   0,    1,   0,      1,     0 ];  // fragile crumbles one block at a time and vanishes
const LOOT    = [  0,   0,    0,   0,    4,   0,      0,     0 ];  // what a crumbled block leaves behind (4 = wood)
const MAX_REACH = 3;
const UNSUP = 255;
const sdist = new Uint8Array(N);
const comp = new Int32Array(N), q = new Int32Array(N);

function canSupport(by, m) {
  if (m === LEAVES) return by === WOOD || by === LEAVES;
  return by !== LEAVES;
}

// 0-1 BFS with buckets, inside a box of columns: resting on top costs 0, hanging sideways or below costs 1.
// Results are only trustworthy MAX_REACH columns inside the box's edges.
function computeSupport(g, x0, x1, z0, z1) {
  for (let y = 0; y < H; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) sdist[idx(x, y, z)] = UNSUP;
  const B = [];
  for (let L = 0; L <= MAX_REACH; L++) B.push([]);
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) { const i = idx(x, 0, z); if (g[i]) { sdist[i] = 0; B[0].push(i); } }
  for (let L = 0; L <= MAX_REACH; L++) {
    const b = B[L];
    for (let h = 0; h < b.length; h++) {
      const i = b[h];
      if (sdist[i] !== L) continue;
      const m = g[i], x = i % W, z = ((i / W) | 0) % D, y = (i / WD) | 0;
      const relax = (j, d) => {
        const mj = g[j];
        if (!mj || d > REACH[mj] || d >= sdist[j] || !canSupport(m, mj)) return;
        sdist[j] = d; B[d].push(j);
      };
      if (y < H - 1) relax(i + WD, L);          // resting on top: inherits
      if (L < MAX_REACH) {
        if (x > x0) relax(i - 1, L + 1);
        if (x < x1) relax(i + 1, L + 1);
        if (z > z0) relax(i - W, L + 1);
        if (z < z1) relax(i + W, L + 1);
        if (y > 0) relax(i - WD, L + 1);        // hanging below
      }
    }
  }
}

// One gravity step. Returns true while something is still changing.
// Only the region around this collapse's changes is checked: support paths never reach more than
// MAX_REACH columns sideways, so nothing further away can have lost support.
// 1) Unsupported rigid clusters (stone) fall one cell and land intact.
// 2) Only when nothing rigid moved: one unsupported fragile block crumbles (wood first, then highest).
// Visual hints go to s.events and never feed back into the sim.
function gravityStep(s) {
  const g = s.g, r = s.region;
  if (!r) return false;
  const tx0 = Math.max(0, r.x0 - MAX_REACH), tx1 = Math.min(W - 1, r.x1 + MAX_REACH);
  const tz0 = Math.max(0, r.z0 - MAX_REACH), tz1 = Math.min(D - 1, r.z1 + MAX_REACH);
  computeSupport(g, Math.max(0, r.x0 - 2 * MAX_REACH), Math.min(W - 1, r.x1 + 2 * MAX_REACH),
                    Math.max(0, r.z0 - 2 * MAX_REACH), Math.min(D - 1, r.z1 + 2 * MAX_REACH));
  const inBox = i => { const x = i % W, z = ((i / W) | 0) % D; return x >= tx0 && x <= tx1 && z >= tz0 && z <= tz1; };
  const loose = i => { const v = g[i]; return v && v !== BEDROCK && !FRAGILE[v] && sdist[i] === UNSUP && inBox(i); };
  for (let y = 0; y < H; y++) for (let z = tz0; z <= tz1; z++) for (let x = tx0; x <= tx1; x++) comp[idx(x, y, z)] = -1;
  const clusters = [];
  for (let y = 0; y < H; y++) for (let z = tz0; z <= tz1; z++) for (let x = tx0; x <= tx1; x++) {
    const i = idx(x, y, z);
    if (!loose(i) || comp[i] >= 0) continue;
    const id = clusters.length, cells = [];
    let minY = H, qh = 0, qt = 0;
    q[qt++] = i; comp[i] = id;
    while (qh < qt) {
      const k0 = q[qh++]; cells.push(k0);
      const yy = (k0 / WD) | 0; if (yy < minY) minY = yy;
      const n = neighbours(k0);
      for (let k = 0; k < n; k++) { const j = nb[k]; if (loose(j) && comp[j] < 0) { comp[j] = id; q[qt++] = j; } }
    }
    clusters.push({ id, cells, minY, first: i });
  }
  clusters.sort((a, b) => a.minY - b.minY || a.first - b.first);
  let changed = false;
  for (const c of clusters) {
    let ok = true;
    for (const k of c.cells) {
      if (k < WD) { ok = false; break; }
      const b = k - WD;
      if (g[b] !== AIR && comp[b] !== c.id) { ok = false; break; }
    }
    if (!ok) continue;                          // resting on something: stays put
    const mats = c.cells.map(k => g[k]);
    for (const k of c.cells) setCell(s, k, AIR);
    for (let n = 0; n < c.cells.length; n++) setCell(s, c.cells[n] - WD, mats[n]);
    changed = true;
  }
  if (changed) { settleLoot(s); settleUnits(s); return true; }
  // Crumble one block: unsupported wood first (so a trunk goes before its leaves), then other fragile blocks.
  let pick = -1;
  for (let pass = 0; pass < 2 && pick < 0; pass++) {
    for (let y = H - 1; y >= 0 && pick < 0; y--) for (let z = tz1; z >= tz0 && pick < 0; z--) for (let x = tx1; x >= tx0; x--) {
      const i = idx(x, y, z), v = g[i];
      if (!v || sdist[i] !== UNSUP) continue;
      if (pass === 0 ? v === WOOD : FRAGILE[v]) { pick = i; break; }
    }
  }
  if (pick >= 0) {
    const m = g[pick];
    setCell(s, pick, AIR);
    const ev = { type: 'crumble', i: pick, m };
    if (LOOT[m]) ev.loot = dropLoot(s, pick, LOOT[m]);
    s.events.push(ev);
    settleLoot(s); settleUnits(s);
    return true;
  }
  s.region = null;                              // this collapse is over
  settleLoot(s); settleUnits(s);
  return false;
}

/* ---------- Loot: items lying in air cells, picked up by any unit ---------- */
function dropLoot(s, i, m) {
  const x = i % W, z = ((i / W) | 0) % D;
  let y = (i / WD) | 0;
  while (y > 0 && s.g[idx(x, y - 1, z)] === AIR) y--;
  for (const l of s.loot) if (l.x === x && l.y === y && l.z === z && l.m === m) { l.n++; return l.id; }
  const id = s.nextLoot++;
  s.loot.push({ id, x, y, z, m, n: 1 });
  return id;
}
// Loot never sits inside a block and always rests on something.
function settleLoot(s) {
  for (const l of s.loot) {
    while (l.y < H && solidAt(s, l.x, l.y, l.z)) l.y++;
    while (l.y > 0 && !solidAt(s, l.x, l.y - 1, l.z)) l.y--;
  }
  // Merge piles that ended up in the same cell (keep the oldest id).
  const seen = new Map();
  s.loot = s.loot.filter(l => {
    const key = l.x + ',' + l.y + ',' + l.z + ',' + l.m, first = seen.get(key);
    if (first) { first.n += l.n; return false; }
    seen.set(key, l); return true;
  });
  collectLoot(s);
}
function collectLoot(s) {
  let got = 0;
  s.loot = s.loot.filter(l => {
    if (unitAt(s, l.x, l.y, l.z)) { s.inv[l.m] += l.n; got += l.n; return false; }
    return true;
  });
  return got;
}

function stateHash(s) {
  let h = 0x811c9dc5;
  const g = s.g;
  h ^= s.bh; h = Math.imul(h, 0x01000193);    // blocks: incremental, updated by setCell
  h ^= s.wh; h = Math.imul(h, 0x01000193);    // water: incremental, updated by setWater
  for (const u of s.units) for (const v of [u.x, u.y, u.z, u.team, TYPES.indexOf(u.type), u.hp, u.moved ? 1 : 0, u.acted ? 1 : 0, u.dead ? 1 : 0]) { h ^= v; h = Math.imul(h, 0x01000193); }
  for (const b of s.buildings) for (const v of [b.owner + 1, b.cp, b.capBy + 1]) { h ^= v; h = Math.imul(h, 0x01000193); }
  for (const v of [s.gold[0], s.gold[1], s.built ? 1 : 0, s.winner + 1]) { h ^= v; h = Math.imul(h, 0x01000193); }
  h ^= s.team; h = Math.imul(h, 0x01000193);
  for (const l of s.loot) for (const v of [l.x, l.y, l.z, l.m, l.n]) { h ^= v; h = Math.imul(h, 0x01000193); }
  h ^= s.turn; h = Math.imul(h, 0x01000193);
  for (const v of s.inv) { h ^= v; h = Math.imul(h, 0x01000193); }
  if (s.lad) { h ^= s.lh; h = Math.imul(h, 0x01000193); }      // ladders (rules 3; older rules hash as before)
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Resolve a change completely: the same order of steps as the browser's animated settle(),
// all at once. Collapse first, then water until it's still (at most 20000 ticks).
const MAX_WATER_STEPS = 20000;
function resolve(s) {
  while (gravityStep(s));
  for (let n = 0; n < MAX_WATER_STEPS && waterStep(s); n++);
}

const BlockSim = {
  W, D, H, WD, N, AIR, GRASS, DIRT, STONE, WOOD, BEDROCK, LEAVES, GOLD, WFULL, MAX_HP, CAPTURE_PTS, INCOME, DIG_REACH, MAX_WATER_STEPS,
  TEAM_NAMES, TEAM_COLORS, TYPES, UNIT_TYPES, DAMAGE, RULES, LATEST_RULES, damageOf,
  idx, inGrid, mix, unitName, cellKey, newState, stateHash,
  solidAt, unitAt, stepTo, stepsFrom, moveOf, moveRange, moveUnit, canDig, digTool, dig, canAttack, attack, hasLadder, climbsLadders,
  canCapture, capture, canBuild, buildUnit, incomeOf, costOf, flies, flyY, typesFor, canPlace, place, placeCost,
  beginAction, endAction, undo, redo, endTurn, gravityStep, waterStep, resolve,
  turnGroups, runGroup, replayTurn, finishTurn, MAX_GROUPS,
};
if (typeof module === 'object' && module.exports) module.exports = BlockSim;
else root.BlockSim = BlockSim;
})(typeof globalThis !== 'undefined' ? globalThis : this);
