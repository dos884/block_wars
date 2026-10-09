# Block Wars (working name "awmc") — handoff notes

## Who you work for
- Solo indie dev, ~8 years making games, one itch release (failed: needed two mice).
- Rules for talking to him:
  - Ask clarifying questions and confirm understanding BEFORE coding any change.
  - Write short. Plain answers, no forced optimism, no flattery, don't auto-agree.
  - Tag every reply with a confidence level + source (fact / inference / guess).
  - Never mix Hebrew and English in one message. If any English word is needed, write the whole message in English.
- He doesn't care about programmer simplicity. He cares about "hassle-free × good" for players and for him.

## The game
- Mobile-first (Android focus), web app, turn-based. "Advance Wars × Minecraft", no redstone.
- Plan: one obvious, cute base game first; modders later.
- Base rules copied from Advance Wars: fixed bases build units (one unit per turn), villages give income, capture enemy base to win.
- Twist: voxel terrain. Digging, collapses (per-material support reach), finite water/floods, undo.

## Current code: `sim.html`
Single-file Three.js r128 (from cdnjs) app. Hot-seat 2 teams. Deterministic integer sim.
- Map `W=96, D=96, H=40`, hills, bridge with pillars, reservoir with wooden dam, 40 trees.
- Bases at x = center ± 20 (`BASE_X=20`), villages mirrored (`VILLAGE_OFFSETS`), units spawn next to own base (`SPAWN_OFFSET=16`).
- Units (`UNIT_TYPES`): soldier (move 6, cost 100, digs soft), spearman (6/150), knight (10/300, no dig, no capture, can't climb, tall), archer (6/200, ranged 2..3, +1 if ≥2 higher), builder (6/150, digs hard).
- Combat deterministic, no randomness: `damage = max(1, floor((DAMAGE[a][d]*a.hp+5)/10))`; counterattack if defender survives, is adjacent and not ranged. Triangle: soldier > spearman > knight > soldier.
- Capture 20 points, income 100/village, start gold 300.
- Terrain: per-material support reach (REACH/FRAGILE/LOOT tables), local region gravity.
- Water: 64 levels per block, pressure head, surface tension 8, drain search ≤6 tiles, awake list on typed arrays, per-frame 12 ms budget.
- Incremental hashes (`bh` blocks, `wh` water) for determinism checks.
- Undo/redo journal per action; "End turn" commits.
- Rendering: chunked InstancedMesh (16), layer cutaway (Auto + manual ▲▼), dither "ghost" shader for blocks hiding a unit.
- Input: tap-to-move with path animation, tap snaps to nearest visible reachable tile (44 px), long-press select, Next and Units buttons, free-fly camera, screenshot.

Known gaps: archers have no line-of-sight; digging is unlimited per turn; dam break costs ~1.6 s compute on the 96 map.

## Decided, don't relitigate without asking
- Deterministic combat. No moving/packing base in the base game.
- Server-authoritative (needed for fog of war). Validating server, not a dumb relay.
- In-turn actions stay local (undo/redo local). On End turn the client sends the turn's action list; the server replays it with the SAME sim code, validates, stores, forwards to the opponent.
- Monetization: donations/cosmetics, no ads in gameplay. Closed source for now, open source after the money phase.
- Modding later: sandboxed interpreter (QuickJS or Lua in WASM), API = primitives + action registry + events. Matchmaking-first with mod veto/preference overlap.

## Server plan (this machine: Linode VPS, shared CPU)
1. Split the sim out of `sim.html` into a shared module used by both client and server (pure, deterministic, no Three.js).
2. Node + SQLite. Endpoints: create match (share link), join, submit turn (replay + validate), fetch turns.
3. Caddy for HTTPS, nightly SQLite backups.
4. Then: accounts, matchmaking, approximate Elo, push notification "your turn".
5. Fog of war last.
