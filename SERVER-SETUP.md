# TAGGY — Authoritative multiplayer server

`woah.html` is the full game client (WebGL 3D world, HUD, settings). It connects to the WebSocket server (`server.js`) for real-time multiplayer, matchmaking, profiles, and match logic.

---

## Quick Start (local)

1. Install Node.js 18 or newer.
2. Open PowerShell in this folder.
3. Install dependencies: `npm install`.
4. Set a private HMAC secret:
   ```
   $env:AUTH_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
   ```
5. Run `npm start`.
6. Open `http://localhost:8080` in each browser window (or share the host's IP: `http://<your-ip>:8080`).

---

## What changed — Full Feature List

### 🎮 Game Modes (queue-based)
- **DUEL: CLASSIC TAG** (2 players) — first tagger to 10 wins.
- **SQUAD: INFECTION** (4 players) — tagged players join the infected team; last survivor wins.
- Mode chips in the menu select the mode; the host/queued player's selection applies.

### ⚡ Power-ups (spawn in arenas every ~6s)
`SPEED`, `SHIELD`, `SHRINK`, `FREEZE` (freezes the tagger), `TELEPORT`, `SUPER JUMP`, `DASH REFILL` — colored orbs with bob animation, 25s lifetime, collected by walking close.

### 🏃 Movement & Abilities
- **Q — Dash** (6 units in look direction, 1.5s cooldown, obstacle-aware).
- **B / C — Reach** (tagger lunge, 900ms server cooldown, angle + pitch validated).
- **Space — Jump** (higher when shrunk).
- **Shift — Sprint** (+ wind & footsteps; different footstep sound on arena floor).
- Server-authoritative position validation (bounds, obstacle overlap, speed limits, vertical clamp).

### 🧠 Bots & Matchmaking
- Queues auto-fill with **AI bots** after `~12s + 5s lock` if not enough players — no more empty lobbies.
- Bots hunt runners, flee the tagger, and wander intelligently; difficulty scales with ELO.
- `queue_update` broadcasts queue counts, lock state, and selected modes.
- 3-2-1-GO countdown before every match.

### 🏆 Progression & Profiles (server-side `profiles.json`)
- Every username gets a persistent profile: **ELO**, **XP**, **Level**, wins/games, tags landed/taken, player color, beanie color, trail effect.
- Win = +50 XP / +25 ELO; loss = +10 XP / -10 ELO. Level-ups raise a toast + fanfare.
- Stats saved to disk every 30s.

### 👤 Cosmetics
- Settings menu: player shirt color, beanie color, trail (NONE / SPARKLE).
- All colors/trails broadcast to other players (rendered on every humanoid).

### 💬 Social
- **In-game chat** (T to open, Enter to send) with per-player colors & system messages.
- **Emotes** (keys 1–5 or the emote bar) shown as floating balloons above players.
- **Invite links** (`?room=CODE`) auto-fill the room code; copy/share button on host.
- **Join/leave system messages** in chat.

### 🔐 Security & Anti-cheat
- HMAC-SHA256 session tokens (24h expiry). All `move`, `reach`, `dash`, and `powerup_collect` messages require a valid token.
- Message rate limiting (90/msg per second), max payload 8KB, room/name validation, finite-number checks.
- Position proposals validated against max speed per tick, world bounds, queue radius, arena bounds, and obstacle overlap.

### 🔁 Reconnect
- Session persisted to `localStorage`; on socket drop the client retries every 3s with the saved token and resumes the same player in the room.

### 🗺️ HUD & UI
- **Minimap** (beacons, arena bounds, players, tagger, power-ups, crown).
- **Tagger arrow** pointing at the `IT` player when off-screen.
- **Round timer bar**, queue status, FPS, **PING**.
- **Kill-feed** ("X tagged Y!"), toasts, match result screen (score, tags, distance, time-as-tagger, XP, ELO), confetti on victory.
- **Settings**: sensitivity, FOV, master/music volume, graphics quality (Low/Med/High), colorblind mode, screen shake toggle, subtitles toggle.
- **Pause menu** with Settings — no more browser `alert()` popups during matches.

### 🎵 Audio (fully procedural, no files)
- Menu / match / danger (tagger) chiptune soundtracks via Web Audio.
- Footsteps (grass vs arena), sprint wind, reach whoosh, dash, power-up jingles, freeze, elimination, win fanfare.
- Optional **speech synthesis** announcements with subtitle toggle.

### 🌍 World & Atmosphere
- Trees & rocks populate the field (performance-culled, quality-tier dependent).
- Day/night cycle with sun/moon, clouds, rain + splashes, and occasional rainbow.
- **5 arena color themes** (aurora, ember, frost, neon, jungle) + **4 obstacle layouts** (classic, spiral, cross, fort) randomized per match.
- Crown mode reuses the arena with a golden crown that must be held to win.

### ▶️ Mobile
- Touch joystick (left), jump / reach / dash buttons (right), auto-shown on touch devices.

---

## Deployment

**Render (recommended):** create a Blueprint from this repo using `render.yaml`.
It runs `npm install --include=prod --no-audit --no-fund`, starts `npm start`, and generates `AUTH_SECRET` privately. The same service serves the page and accepts WebSockets (`wss://`), so no URL swapping needed. Free tier may sleep when idle.

**Vercel (static only):** host `woah.html` and set `window.GAME_SERVER_URL` to your Render `wss://` URL.

> ⚠️ Security notes
> - Never put `AUTH_SECRET` in browser code or commit it.
> - Always use `wss://` + HTTPS in production.
> - `profiles.json` contains ELO/XP/cosmetics — back it up if you care about persistence.

---

## Controls

| Key | Action |
|-----|--------|
| WASD | Move |
| SHIFT | Sprint |
| SPACE | Jump |
| Q | Dash |
| B / C | Reach (right / left) — tagger only |
| E | Interact (queue / exit queue / leave arena) |
| T | Open chat |
| 1–5 | Emotes |
| ESC | Pause / Settings |