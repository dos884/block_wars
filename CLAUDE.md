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
- Shown to players as "Cube Wars" (domain cubewars.io; `GAME_NAME` in sim.html, manifest, sw.js). Repo/working name: Block Wars.
- Quality bar (2026-10-09): ship a solid 6-7/10 product that can grow to 8. Polish matters, scope creep doesn't.
- Mobile-first (Android focus), web app, turn-based. "Advance Wars × Minecraft", no redstone.
- Plan: one obvious, cute base game first; modders later.
- Base rules copied from Advance Wars: fixed bases build units (one unit per turn), villages give income, capture enemy base to win.
- Twist: voxel terrain. Digging, collapses (per-material support reach), finite water/floods, undo.

## Current code
- `sim-core.js`: the deterministic sim (pure, no Three.js/DOM). Loads as a browser script (`window.BlockSim`) or a Node module. Also: action recording into the undo journal, `turnGroups`, `replayTurn` (shared by server and client).
- `sim.html`: the view/UI (Three.js r128 from cdnjs). Hot-seat by default; online when opened as `/?m=<match id>`.
- `server/server.js`: `node:http` + `node:sqlite` + `node:crypto` (Node 22, no npm deps). Guest players (per-device sessions), optional Google link, invite + quick-play matches, Web Push (VAPID, payload-less), replays and hash-checks every turn.
- `sw.js` (notifications only, deliberately no offline cache), `manifest.webmanifest`, icons from `icon.svg` via `tools/make-icons.js`.
- `test/`: `npm test` = determinism vs golden hashes (Node + Chromium), server API checks, and a two-browser online match.
  `golden.json` was recorded from the ORIGINAL pre-split game (`make-golden.js`); a sim change that should alter results needs a deliberate re-record.
- `ops/` + `deploy.sh`: Caddyfile, systemd units (server, nightly backup). Run `./deploy.sh` as root to ship.

Sim details:
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

## Server plan (this machine: Linode VPS 172.236.247.113, shared CPU, 4 cores, 8 GB)
1. DONE: sim split into `sim-core.js`.
2. DONE: Node + SQLite server. `POST /api/matches` (create → Blue token), `POST /api/matches/:id/join` (Red), `GET /api/matches/:id?since=n&rev=r` (long-poll ≤25 s), `POST /api/matches/:id/turns` (replay + validate + hash check).
3. DONE: Caddy serves https://cubewars.io (static from `/var/www/block_wars`, `/api/*` → 127.0.0.1:8787). Server runs as systemd `block-wars` (user `blockwars`, DB `/var/lib/block_wars/bw.sqlite`). Nightly backup 04:00 to `/var/backups/block_wars`, 14 days kept (same disk only).
4. DONE (changed by the user): no Elo. Guest accounts by default (random friendly name, editable), optional "Continue with Google" to carry games across devices. Lobby: Quick play (persistent 24 h queue, pairs with whoever waits, coin flip for Blue), Play a friend (invite link), Pass & play (hot-seat), Your games list. "Your turn" Web Push notifications. Installable PWA.
   Google sign-in needs `GOOGLE_CLIENT_ID=...` in `/etc/block-wars.env` (then `systemctl restart block-wars`); the button is hidden until then.
5. Fog of war last.

How online works: in-turn actions stay local with undo/redo. Each successful action is recorded in its journal entry; a turn = the journal entries still in effect ("groups", e.g. [move, dig]). End turn sends `{n, groups, hash}`; the server replays the groups (a dig's collapse/flood resolved inside its group, same as the browser's settle), compares the hash, then End turn + water. The opponent's browser replays the same way.

Known gaps (online): no forfeit/timeout for abandoned games yet (an opponent who never returns blocks the game forever); an unsent turn is lost on reload; the opponent's turn appears instantly (no replay animation); a guest who clears browser data loses their player (Google link fixes this); no cleanup of old matches; a dam-break turn costs ~1.7 s of server CPU and blocks the server meanwhile (fine now; worker thread if it matters).
