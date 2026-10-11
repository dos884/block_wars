# Block Wars (shown as "Cube Wars") — handoff notes

## Who you work for
- Solo indie dev, ~8 years making games, one itch release (failed: needed two mice).
- Rules for talking to him:
  - Write short. Plain answers, no forced optimism, no flattery, don't auto-agree.
  - Tag every reply with a confidence level + source (fact / inference / guess).
  - Never mix Hebrew and English in one message. If any English word is needed, write the whole message in English.
- He doesn't care about programmer simplicity. He cares about "hassle-free × good" for players and for him.

## How we work (agreed 2026-10-10)
1. He asks. 2. You restate what you understood in a few lines and wait. 3. On "ok", code until it works — no new automated tests unless he asks; a quick one-tab check is fine. 4. He decides when to run tests; remind him when too much is untested. 5. Show a preview before anything goes live or to git; push only when he says so.
- Preview: copy `sim.html` → `/var/www/block_wars/preview/index.html` (+ `sim-core.js`) → https://cubewars.io/preview/. All redirects keep the current path, so the preview stays in the preview. The preview shares the live server and logins (deleting your player there is real). Remove the folder after going live.
- Never run browser tests against https://cubewars.io that create players (it filled the real DB with bots once). Test locally: `npm test` starts its own server.
- Don't work on the "verified" (premium) server mode now (see Decisions). Its code stays untouched and untested.
- Test commands run without approval prompts: `npm test`, `node test/...` (allowed in `/root/.claude/settings.json`). Run them as plain commands; extra pipes/redirects make them prompt again.
- If he denies a command, stop and ask; don't retry it in another form.
- The live database (`/var/lib/block_wars/bw.sqlite`): look at it ONLY read-only (`sqlite3 -readonly … "SELECT …"`). WAL mode lets that run beside the server without blocking. Never write to it without his OK; if a write is needed, back up first and keep it to one quick statement.

## The game
- Mobile-first (Android), web app, turn-based. "Advance Wars × Minecraft", no redstone. One obvious, cute base game first; modders later.
- Quality bar: a solid 6-7/10 product that can grow to 8. Polish matters, scope creep doesn't.
- Fixed bases build units (one per turn); capture the enemy base to win. Voxel terrain: digging, collapses, finite water/floods, undo.
- Rules are VERSIONED (`RULES` in sim-core.js). A match stores the version (and map seed) it started with, so stored games always replay exactly. New games use `LATEST_RULES`.
  - 1: original (villages, 100/turn each, original damage).
  - 2: faster kills: same type vs same type dies in 2 hits from full health (base 6); the triangle's winner (soldier > spearman > knight > soldier) kills outright even when hurt.
  - 3: rules 2 plus the gold economy: no villages; 140 gold blocks per side (10,500 gold) underground in columns 3-7 deep, random per match (seed) but mirrored so both sides dig the same; builders mine them for +75 at once; bases pay 50/turn. Only builders dig. Digging below your feet leaves a ladder in that cell and takes the builder down into the hole. Units (not knights) climb ladders; knights can step up one block. Gold shows in the layer view (▲▼).
  - 4: rules 3 plus each side starts with a builder (behind its 3 soldiers), and builders cost 500 (`costOf`; per-rules `costs`).
  - 5 (current): adds the Aerial Screw (`screw`, 400, move 8): flies with its own height, one block across/up/down per move through open air (can't enter blocks), stays at its height, no dig/capture, drops stones on enemies next to it (±2 up/down) or anywhere straight below. Only archers (8), spearmen (6) and screws (6) can hit it. Damage table in `RULES[5].damage`. New unit types are appended to `TYPES` (the hash uses the index).

## Current code
- `sim-core.js`: the deterministic sim (pure, no Three.js/DOM), browser script (`window.BlockSim`) or Node module. Action recording into the undo journal, `turnGroups`, `replayTurn`, `stepsFrom` (moves incl. ladders), `digTool`, ladders (`s.lad` set + `s.lh` hash, journaled via the undo snapshot).
- `sim.html`: view/UI (Three.js r128 from cdnjs). Lobby at `/`; a match at `/?m=<id>`; Pass & play from the lobby.
  - Lobby: name (editable), Quick play, Play a friend (invite link; opening it asks "Join as Red / Just watch" — never auto-joins), Pass & play (random gold layout), Your games, notifications button, "Delete my player" (red, confirms; running games count as a quit).
  - Match: joystick bottom-left (walks inside the blue tiles, settles on a tile when released; on a ladder, stick up/down climbs); buttons in two equal rows of four (Attack, Dig, Capture, Build / Undo, Redo, Confirm, End turn); Units + Next above the joystick; ☰ Menu (Back to lobby, Quit game online / Restart in pass & play). Online, your view stays on your own army.
  - Notifications: the first time you wait for your opponent online, a dialog explains why to allow them ("Yes, notify me" / "Not now", asks again after 3 days; a blocked variant says how to unblock). Websites can't pick the notification sound.
  - Messages (`flash`) also show as a popup at the top while the lobby is open.
  - Only relevant buttons show (`updateButtons`, every frame): Up/Down (screw), Dig (builders), Attack (enemy in reach), Capture (on a capturable building), Confirm (a move is planned), Redo (something to redo); Build, Undo, End turn always. A flyer's range shows as the layer at its planned height, with a marker on the ground tile below it; keys R/F = up/down.
  - First-game tutorial (first "Play vs bot", once per browser, `bw:tutorialDone`): 6 hints that finish when you do the thing (move, Confirm, select the builder, Dig, End turn, the goal), the button meant pulses; "Skip tutorial". Events `tutorial` {step} / {done|skipped} show where new players stop. Code: `TUT`, `tutTick`.
  - Blood: any health drop sprays droplets; a death adds a ground splat that fades over ~20 s (`bleed`, `tintUnits` watches health).
  - Aerial Screw sprite: 36×72 px (`SCREW`), generated from a 3D helix; drawn 1.5×3 blocks, hovering 0.35 above its cell.
  - Debug (file:// or `?debug`): state hash, Commander free camera, `window.BW_DEBUG` (state, selected unit, `digBelow()`) for tests.
  - The knight is a 28×40 mounted sprite, two cubes tall.
  - Terrain rendering: one mesh per 16×16 chunk made of only the faces bordering open space (full-size cubes, no gaps), textured from a generated atlas (32×32 per material, faint darker border = lines between blocks). Taps find the block from hit point − normal/2. Layer cut-away (Auto + ▲▼) and the "ghost" dither around the selected unit still apply.
  - Underground vision: when the selected unit is in a hole or under ground, a black fog sphere (radius `sphereFog.uFogR`, 18) hides everything farther away (blocks, water, ladders via `withSphereFog`; units and flags are hidden), and the sky fades to black.
- `server/server.js`: `node:http` + `node:sqlite` + `node:crypto`, no npm deps. Guest players (one session per device, token in localStorage), optional Google link (needs a client ID, see below), invite + quick-play matches, quit, delete player, Web Push (VAPID, payload-less), relay of turns.
- `sw.js` (notifications only, no offline cache), `manifest.webmanifest`, icons from `icon.svg` via `tools/make-icons.js`.
- `test/`: `npm test` = determinism (golden hashes from the ORIGINAL game under rules 1; latest rules replayed and compared Node vs Chromium), server API (relay mode), and real browsers playing a friend match + quick play + quit. `scenario.js` is the scripted match (under rules 3 it builds a builder that digs down and climbs out). `golden.json` must only be re-recorded deliberately (`make-golden.js`).
- `ops/` + `deploy.sh`: Caddyfile, systemd units (server, nightly backup). `./deploy.sh` (root) ships everything.

Sim details:
- Map `W=96, D=96, H=40`, hills, bridge with pillars, reservoir with wooden dam, 40 trees. Bases at x = center ± 20, units spawn 16 from centre.
- Units: soldier (move 6, 100), spearman (6/150), knight (10/300, no capture, tall), archer (6/200, ranged 2..3, +1 if ≥2 higher), builder (6/150). Digging per rules version (rules 3: builders only).
- Combat: `damage = max(1, floor((D[a][d]*a.hp+5)/10))`, rules 2+: triangle winner kills outright. Counterattack if the defender survives, is adjacent and not ranged. Capture 20 points, start gold 300.
- Terrain: per-material support reach (REACH/FRAGILE/LOOT, gold behaves like stone), local region gravity. Water: 64 levels, pressure head, surface tension 8, drain search ≤6 tiles.
- Incremental hashes (`bh` blocks, `wh` water, `lh` ladders). Undo/redo journal per action; End turn commits.

## Decided, don't relitigate without asking
- Deterministic combat. No moving/packing base in the base game.
- CHANGED 2026-10-10: the server is a RELAY by default. It stores and forwards turns; the opponent's browser replays each turn and compares hashes; a mismatch is reported (`POST /api/matches/:id/desync`) and ends the game as "Out of sync". Server-side replay is kept behind `matches.verified` (off for all matches) as a future PREMIUM feature (blocks cheating, makes real fog of war possible). Free games can be cheated; he accepts that (like engine use on chess.com).
- In-turn actions stay local (undo/redo). End turn sends the turn's action groups + hash (+ whether it won).
- Logins stay on the device (recovery codes were tried and dropped 2026-10-10). Google link is the way to move devices once set up.
- No Elo. Monetization: donations/cosmetics, no ads in gameplay. Closed source for now.
- Donations: Ko-fi (https://ko-fi.com/shmooti): a button in the lobby, and a big one in the panel that replaces the controls while you wait for the opponent's turn.
- itch.io is back in use (2026-10-11), at https://dos884.itch.io/cube-wars (it was briefly dropped because friend invites failed from inside itch). Rebuild the upload with `node tools/build-itch.js` → `itch/cube-wars-itch.zip` (index.html + sim-core.js + three.min.js, talks to cubewars.io; the server allows itch's domains via CORS) and push it; he uploads the zip to itch himself.
- Quick play is switched off for now (`QUICK_PLAY = false` in sim.html; server code kept). Lobby buttons: Play a friend, Play vs bot, Play yourself.
- Bot ("Play vs bot", local in the browser, you are Blue): builders (up to 2) walk to the bot's nearest gold columns, dig down and mine; fighters in a fixed mix hold a line in front of its base and engage anything within 10 tiles; ANY unit capturing its base is attacked first by every fighter that can reach; every 3 bot turns a wave worth ~10 × sqrt(total fighter cost) marches on your base, attacking on the way and capturing it. One difficulty. Code: the "Bot" section in sim.html (`botTurn`).
- Modding later: sandboxed interpreter (QuickJS or Lua in WASM), API = primitives + action registry + events.

## Server & hosting (this machine: Linode VPS 172.236.247.113, 4 cores, 8 GB)
- https://cubewars.io via Caddy (static from `/var/www/block_wars`, `/api/*` → 127.0.0.1:8787). systemd `block-wars` (user `blockwars`, DB `/var/lib/block_wars/bw.sqlite`, VAPID key `vapid.json` next to it). Nightly backup 04:00 → `/var/backups/block_wars` (14 days, same disk only).
- API: `POST /api/players`, `GET/POST/DELETE /api/me`, `POST /api/me/google`, `POST /api/me/push`, `POST|GET|DELETE /api/quick`, `POST /api/matches`, `POST /api/matches/:id/join|turns|quit|desync`, `GET /api/matches/:id?since=n&rev=r` (long-poll ≤25 s).
- Matches table carries `rules`, `seed`, `verified`, `desync`, `quit`.
- Analytics: `POST /api/events` stores small events from the page in the `events` table (at, player, type, data): `open` (page, mobile), `friend`, `hotseat_start`, `hotseat_turn`, `hotseat_win`, `hotseat_acts` (counts of move/dig/attack/build/capture/undo/redo, one summary per 10 s when something happened), `kofi` (lobby/waiting), `tutorial` (step reached, done/skipped). Not sent from the itch build. Batched every 10 s and when the page hides. No time tracking (he only wants counts). Read it with `sqlite3 -readonly`; answer pokes short.
- Dev players: `players.dev = 1` are ours (his phone "Tiny Digger", his PC "Bold Llama", old test bots) and are left out of every count; pokes show real numbers with "(+N dev)". A browser gets tagged by opening `/?dev=<secret>` (secret = `DEV_KEY` in `/etc/block-wars.env`; never put it in git).
- Google sign-in: needs `GOOGLE_CLIENT_ID=...` in `/etc/block-wars.env`, then `systemctl restart block-wars`; the button stays hidden until then. Not set up yet.
- GitHub: pushes go through a repo-only deploy key (`~/.ssh/block_wars_deploy`).

## Plan
1-4 DONE (sim split, server, hosting/backups, accounts + quick play + notifications, then the gold/ladder redesign and the relay).
5. Fog of war last (only real in verified/premium matches).

## Known gaps
- No turn timer/forfeit: an opponent who never returns blocks the game forever (proposed: claim the win after ~3 days).
- The scripted test match doesn't mine gold mid-match (the separate gold check covers +75 and undo).
- An unsent turn is lost on reload; the opponent's turn appears instantly (no replay animation); a guest who clears browser data loses their player; no cleanup of old matches.
- Archers have no line-of-sight; digging is unlimited per turn; a dam break costs ~1.7 s of compute in the browser that replays it.
