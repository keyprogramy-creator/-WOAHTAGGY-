import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const AUTH_SECRET = process.env.AUTH_SECRET;
if (!AUTH_SECRET || AUTH_SECRET.length < 32) throw new Error("AUTH_SECRET must be set to a random value of at least 32 characters.");
const PROFILES_FILE = `${__dirname}profiles.json`;

const MAX_PLAYERS_PER_ROOM = 32;
const WORLD_LIMIT = 150;
const BASE_SPEED = 16;
const MAX_SPEED_MULT = 1.6;
const MAX_VERTICAL_SPEED = 36;
const MAX_MESSAGES_PER_SECOND = 90;
const REACH_DISTANCE = 3.5;
const REACH_COOLDOWN_MS = 900;
const REACH_ANGLE = Math.PI / 3;
const REACH_VERTICAL_ANGLE = Math.PI / 4;
const TAG_ROUND_MS = 20_000;
const COUNTDOWN_MS = 4000;
const QUEUE_FILL_DELAY_MS = 12_000;
const QUEUE_LOCK_MS = 5000;
const STATE_TICK_MS = 33;
const POWERUP_SPAWN_INTERVAL_MS = 6000;
const POWERUP_MAX = 3;
const DASH_COOLDOWN_MS = 1500;
const DASH_DISTANCE = 6;
const CHAT_COOLDOWN_MS = 1500;
const FREEZE_DURATION_MS = 2000;
const FREEZE_TAG_DURATION_MS = 5000;
const CROWN_ROUND_MS = 60_000;
const INFECTION_ROUND_MS = 90_000;
const FREEZE_ROUND_MS = 60_000;

const POWERUP_DEFS = {
  speed:     { label: "SPEED",       duration: 5000 },
  shield:    { label: "SHIELD",      duration: 5000 },
  shrink:    { label: "SHRINK",      duration: 5000 },
  freeze:    { label: "FREEZE",      duration: FREEZE_DURATION_MS },
  teleport:  { label: "TELEPORT",    duration: 0 },
  superjump: { label: "SUPER JUMP",  duration: 5000 },
  dash:      { label: "DASH REFILL", duration: 0 }
};

const GAME_MODES = {
  tag:       { label: "CLASSIC TAG",   min: 2, durationMs: TAG_ROUND_MS },
  infection: { label: "INFECTION",     min: 2, durationMs: INFECTION_ROUND_MS },
  freeze:    { label: "FREEZE TAG",    min: 2, durationMs: FREEZE_ROUND_MS },
  last:      { label: "LAST STANDING", min: 2, durationMs: 0 },
  crown:     { label: "CAPTURE CROWN", min: 2, durationMs: CROWN_ROUND_MS }
};

const ARENA_THEMES = [
  { id: "aurora", floor: [0.02, 0.22, 0.34], stripe: [0.05, 0.42, 0.55], pad: [0.05, 0.6, 0.75], fence: [0.03, 0.35, 0.6], obstacle: [0.16, 0.22, 0.28], accent: [0.05, 0.6, 0.75], roof: [0.02, 0.07, 0.12] },
  { id: "ember", floor: [0.3, 0.1, 0.08], stripe: [0.6, 0.2, 0.1], pad: [0.85, 0.35, 0.1], fence: [0.5, 0.12, 0.08], obstacle: [0.22, 0.16, 0.14], accent: [1.0, 0.5, 0.1], roof: [0.12, 0.05, 0.05] },
  { id: "frost", floor: [0.12, 0.3, 0.38], stripe: [0.2, 0.55, 0.68], pad: [0.45, 0.78, 0.9], fence: [0.2, 0.5, 0.65], obstacle: [0.18, 0.26, 0.32], accent: [0.55, 0.85, 1.0], roof: [0.06, 0.14, 0.18] },
  { id: "neon", floor: [0.08, 0.04, 0.2], stripe: [0.35, 0.1, 0.7], pad: [0.6, 0.15, 1.0], fence: [0.3, 0.08, 0.6], obstacle: [0.14, 0.1, 0.24], accent: [1.0, 0.2, 0.9], roof: [0.05, 0.02, 0.1] },
  { id: "jungle", floor: [0.1, 0.3, 0.12], stripe: [0.25, 0.5, 0.2], pad: [0.45, 0.7, 0.3], fence: [0.18, 0.42, 0.18], obstacle: [0.2, 0.25, 0.16], accent: [0.3, 0.85, 0.35], roof: [0.06, 0.18, 0.08] }
];

// Obstacle layout templates — each returns obstacles relative to arena center (x/z) with size args.
// Layouts are deterministic arrays; scale is applied from arena.size.
const ARENA_LAYOUTS = {
  classic: seed => {
    const rnd = seededRand(seed);
    const lane = 0.22;
    return [
      { x: -lane, z: -lane, sx: 0.16, sy: 2.6, sz: 0.12, cy: 1.3 },
      { x: lane, z: lane, sx: 0.16, sy: 2.6, sz: 0.12, cy: 1.3 },
      { x: -lane, z: lane, sx: 0.12, sy: 1.8, sz: 0.16, cy: 0.9 },
      { x: lane, z: -lane, sx: 0.12, sy: 1.8, sz: 0.16, cy: 0.9 },
      { x: 0, z: -0.28, sx: 0.3, sy: 0.25, sz: 0.25, cy: 2.8 },
      { x: -0.3, z: 0, sx: 0.25, sy: 0.25, sz: 0.28, cy: 2.1 },
      { x: 0.3, z: 0, sx: 0.25, sy: 0.25, sz: 0.2, cy: 1.1 }
    ];
  },
  spiral: seed => {
    const rnd = seededRand(seed);
    const out = [];
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const radius = 0.1 + i * 0.09;
      out.push({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius, sx: 0.62 - i * 0.07, sy: i % 2 === 0 ? 0.5 : 2.2, sz: 0.3, cy: i % 2 === 0 ? 0.25 : 1.1 });
    }
    out.push({ x: 0, z: 0, sx: 0.22, sy: 0.3, sz: 0.22, cy: 1.6 });
    return out;
  },
  cross: seed => {
    const rnd = seededRand(seed);
    return [
      { x: -0.18, z: 0, sx: 0.34, sy: 0.6, sz: 0.3, cy: 0.3 },
      { x: 0.18, z: 0, sx: 0.34, sy: 0.6, sz: 0.3, cy: 0.3 },
      { x: 0, z: -0.18, sx: 0.3, sy: 0.6, sz: 0.34, cy: 0.3 },
      { x: 0, z: 0.18, sx: 0.3, sy: 0.6, sz: 0.34, cy: 0.3 },
      { x: -0.32, z: -0.32, sx: 0.14, sy: 3.0, sz: 0.14, cy: 1.5 },
      { x: 0.32, z: 0.32, sx: 0.14, sy: 3.0, sz: 0.14, cy: 1.5 },
      { x: -0.32, z: 0.32, sx: 0.14, sy: 1.6, sz: 0.14, cy: 0.8 },
      { x: 0.32, z: -0.32, sx: 0.14, sy: 1.6, sz: 0.14, cy: 0.8 }
    ];
  },
  fort: seed => {
    const rnd = seededRand(seed);
    const out = [];
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      out.push({ x: Math.cos(angle) * 0.42, z: Math.sin(angle) * 0.42, sx: 1.3, sy: 0.5, sz: 0.4, cy: 0.25 });
    }
    out.push({ x: 0, z: 0, sx: 0.26, sy: 0.6, sz: 0.26, cy: 3.3 });
    out.push({ x: -0.25, z: -0.12, sx: 0.2, sy: 0.4, sz: 0.2, cy: 1.8 });
    out.push({ x: 0.25, z: 0.12, sx: 0.2, sy: 0.4, sz: 0.2, cy: 1.8 });
    return out;
  }
};

const BOT_NAMES = ["BOT-ACE", "BOT-NOVA", "BOT-BOLT", "BOT-PIXEL", "BOT-JUICE", "BOT-RAID", "BOT-TURBO", "BOT-KO", "BOT-ZIP", "BOT-FLUX"];
const PLAYER_COLORS = ["#ff4d6d", "#ffd166", "#06d6a0", "#4cc9f0", "#b388ff", "#ff8e3c", "#2ec4b6", "#e71d36"];
const BEANIE_COLORS = ["#1a1a1a", "#ffd166", "#4cc9f0", "#b388ff", "#ffffff", "#ff8e3c", "#06d6a0", "#e71d36"];

const MATCHMAKING = {
  duel: { capacity: 2, size: 30, center: { x: -200, z: 0 }, beacon: { x: -12, z: 0, radius: 6.5 } },
  squad: { capacity: 4, size: 60, center: { x: 200, z: 0 }, beacon: { x: 12, z: 0, radius: 6.5 } }
};

const rooms = new Map();
let profiles = {};
try { profiles = JSON.parse(readFileSync(PROFILES_FILE, "utf8")); } catch {}

function saveProfiles() {
  try { writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2)); } catch {}
}
setInterval(saveProfiles, 30_000);

function seededRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function createSessionToken(player) {
  const payload = `${player.id}.${player.roomCode}.${Date.now()}`;
  const signature = createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

function parseToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [id, roomCode, issuedAt, signature] = parts;
  if (!/^\d+$/.test(issuedAt)) return null;
  if (Date.now() - Number(issuedAt) > 24 * 60 * 60 * 1000) return null;
  const payload = `${id}.${roomCode}.${issuedAt}`;
  const expected = createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  const providedBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) return null;
  return { id, roomCode };
}

function send(socket, message) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
}

function broadcast(room, message, except = null) {
  for (const player of room.players.values()) {
    if (player.socket && player.socket !== except) send(player.socket, message);
  }
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validName(value) {
  return typeof value === "string" && /^[a-zA-Z0-9 _-]{1,12}$/.test(value.trim());
}

function validRoom(value) {
  return typeof value === "string" && /^[A-Z0-9]{3,12}$/.test(value);
}

function getProfile(username) {
  if (!profiles[username]) {
    profiles[username] = {
      elo: 1000,
      xp: 0,
      level: 1,
      color: PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)],
      beanieColor: BEANIE_COLORS[Math.floor(Math.random() * BEANIE_COLORS.length)],
      trail: "none",
      wins: 0,
      games: 0,
      tags: 0,
      tagged: 0,
      crownWins: 0
    };
  }
  return profiles[username];
}

function levelFromXp(xp) {
  return Math.floor(Math.sqrt(xp / 100)) + 1;
}

function addXp(player, amount) {
  const profile = player.profile;
  profile.xp += amount;
  const newLevel = levelFromXp(profile.xp);
  const leveledUp = newLevel > profile.level;
  profile.level = newLevel;
  if (leveledUp) send(player.socket, { type: "level_up", level: newLevel });
  return { xp: profile.xp, level: newLevel, leveledUp };
}

function addElo(player, delta) {
  if (player.isBot) return;
  player.profile.elo = Math.max(100, player.profile.elo + delta);
}

function arenaObstacles(arena) {
  return arena.obstacles.map(o => ({
    x: o.x * arena.size,
    z: o.z * arena.size,
    sizeX: o.sx * arena.size,
    sizeY: o.sy * arena.size,
    sizeZ: o.sz * arena.size,
    centerY: o.cy * arena.size
  }));
}

function buildArena(type, mode, size) {
  const layoutNames = Object.keys(ARENA_LAYOUTS);
  const layoutName = layoutNames[Math.floor(Math.random() * layoutNames.length)];
  const seed = Math.floor(Math.random() * 0xffffffff);
  const theme = ARENA_THEMES[Math.floor(Math.random() * ARENA_THEMES.length)];
  return {
    type,
    mode,
    size,
    center: MATCHMAKING[type].center,
    obstacles: ARENA_LAYOUTS[layoutName](seed),
    layout: layoutName,
    theme,
    asHost: layoutName,
    score: 0
  };
}

function publicPlayer(player) {
  const profile = player.profile || {};
  return {
    id: player.id,
    username: player.username,
    x: player.x,
    y: player.y,
    z: player.z,
    rotY: player.rotY,
    isBot: !!player.isBot,
    color: profile.color || "#ff4d6d",
    beanieColor: profile.beanieColor || "#1a1a1a",
    trail: profile.trail || "none",
    isTagger: player.arena ? player.arena.taggerId === player.id : false,
    isFrozen: !!player.isFrozen,
    isShield: player.shieldUntil > Date.now(),
    isShrink: player.shrinkUntil > Date.now(),
    eliminated: !!player.eliminated,
    level: profile.level || 1,
    elo: profile.elo || 1000,
    score: player.arena?.score || 0,
    arena: player.arena?.type || null
  };
}

function removePlayer(player) {
  const room = rooms.get(player.roomCode);
  if (!room) return;
  for (const queue of Object.values(room.queues)) queue.players.delete(player.id);
  player.queueBeacon = null;
  room.players.delete(player.id);
  broadcast(room, { type: "chat", system: true, message: `${player.username} left the room.` });
  broadcast(room, { type: "player_left", id: player.id });
  broadcastQueueStatus(room);
  if ([...room.players.values()].some(p => !p.isBot)) { /* keep room alive */ }
  if (room.players.size === 0) {
    rooms.delete(player.roomCode);
    broadcastQueueStatus(room);
  }
}

function broadcastQueueStatus(room) {
  broadcast(room, {
    type: "queue_update",
    queues: Object.fromEntries(Object.entries(room.queues).map(([name, queue]) => [name, queue.players.size])),
    locked: room.pendingMatches,
    modes: Object.fromEntries(Object.entries(room.queues).map(([name, queue]) => [name, queue.mode]))
  });
}

function getSpawnOffsets(count, size, rnd) {
  const halfSize = size * 0.35;
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor((rnd ? rnd() : Math.random()) * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.map(index => {
    const angle = (index / Math.max(count, 1)) * Math.PI * 2 + (rnd ? rnd() * 0.5 : Math.random() * 0.5);
    const radius = halfSize * (0.4 + (rnd ? rnd() * 0.5 : Math.random() * 0.5));
    return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
  });
}

function getCurrentArenaPlayers(room, arenaType) {
  return Array.from(room.players.values()).filter(player => player.arena?.type === arenaType && !player.eliminated);
}

function resetArenaPositions(room, arenaType) {
  const players = Array.from(room.players.values()).filter(player => player.arena?.type === arenaType);
  const arena = players[0]?.arena;
  if (!arena) return;
  const rnd = seededRand(Math.floor(Math.random() * 0xffffffff));
  const spawns = getSpawnOffsets(players.length, arena.size, rnd);
  players.forEach((player, index) => {
    const spawn = spawns[index];
    player.x = arena.center.x + spawn.x;
    player.y = 0;
    player.z = arena.center.z + spawn.z;
    player.isFrozen = false;
    player.lastMoveAt = Date.now();
  });
  players.forEach(player => send(player.socket, { type: "tag_reset", id: player.id, x: player.x, y: player.y, z: player.z }));
}

function spawnPowerups(room, arena) {
  if (arena.powerupTimer) clearTimeout(arena.powerupTimer);
  const spawnOne = () => {
    if (!arena || !arena.powerups) return;
    if (arena.powerups.size >= POWERUP_MAX) return;
    const rnd = seededRand(Math.floor(Math.random() * 0xffffffff));
    const kinds = Object.keys(POWERUP_DEFS);
    const kind = kinds[Math.floor(rnd() * kinds.length)];
    const half = arena.size / 2 - 2;
    let x = 0, z = 0, attempts = 0;
    do {
      x = arena.center.x + (rnd() * 2 - 1) * half;
      z = arena.center.z + (rnd() * 2 - 1) * half;
      attempts++;
    } while (attempts < 12 && arenaObstacles(arena).some(o => {
      return x >= arena.center.x + o.x - o.sizeX / 2 && x <= arena.center.x + o.x + o.sizeX / 2 &&
             z >= arena.center.z + o.z - o.sizeZ / 2 && z <= arena.center.z + o.z + o.sizeZ / 2;
    }));
    const id = randomUUID();
    arena.powerups.set(id, { kind, x, y: 1.2, z, expiresAt: Date.now() + 25_000 });
    broadcast(room, { type: "powerup_spawn", arena: arena.type, id, kind, x, y: 1.2, z });
    arena.powerupTimer = setTimeout(spawnOne, POWERUP_SPAWN_INTERVAL_MS);
  };
  arena.powerupTimer = setTimeout(spawnOne, 5000);
}

function applyPowerup(room, player, powerup) {
  const now = Date.now();
  const def = POWERUP_DEFS[powerup.kind];
  if (!def) return;
  switch (powerup.kind) {
    case "speed":
      player.speedUntil = now + def.duration;
      broadcast(room, { type: "powerup_effect", id: player.id, effect: "speed", until: player.speedUntil });
      break;
    case "shield":
      player.shieldUntil = now + def.duration;
      broadcast(room, { type: "powerup_effect", id: player.id, effect: "shield", until: player.shieldUntil });
      break;
    case "shrink":
      player.shrinkUntil = now + def.duration;
      broadcast(room, { type: "powerup_effect", id: player.id, effect: "shrink", until: player.shrinkUntil });
      break;
    case "freeze": {
      const tagger = Array.from(room.players.values()).find(p => p.arena?.type === player.arena.type && p.arena.taggerId === p.id);
      if (tagger && tagger.id !== player.id) {
        tagger.isFrozen = true;
        tagger.frozenUntil = now + def.duration;
        broadcast(room, { type: "player_frozen", id: tagger.id, until: tagger.frozenUntil, by: player.username });
      }
      break;
    }
    case "teleport": {
      const arena = player.arena;
      const rnd = seededRand(Math.floor(Math.random() * 0xffffffff));
      const spawn = getSpawnOffsets(1, arena.size, rnd)[0];
      player.x = arena.center.x + spawn.x;
      player.z = arena.center.z + spawn.z;
      player.lastMoveAt = now;
      broadcast(room, { type: "teleported", id: player.id, x: player.x, z: player.z });
      break;
    }
    case "superjump":
      player.superJumpUntil = now + def.duration;
      broadcast(room, { type: "powerup_effect", id: player.id, effect: "superjump", until: player.superJumpUntil });
      break;
    case "dash":
      player.dashCooldownUntil = 0;
      send(player.socket, { type: "dash_refilled" });
      break;
  }
}

function startMatch(room, beaconId) {
  const matchConfig = MATCHMAKING[beaconId];
  const queue = room.queues[beaconId];
  if (!matchConfig || queue.players.size < 1 || room.pendingMatches[beaconId]) return;

  room.pendingMatches[beaconId] = true;
  const mode = queue.mode || "tag";
  const needed = Math.max(0, matchConfig.capacity - queue.players.size);

  for (const playerId of queue.players) {
    const player = room.players.get(playerId);
    if (player) send(player.socket, { type: "queue_locked", beacon: beaconId, seconds: QUEUE_LOCK_MS / 1000, mode });
  }
  broadcastQueueStatus(room);

  const fillTimer = setTimeout(() => {
    for (let i = 0; i < needed; i++) {
      if (queue.players.size >= matchConfig.capacity) break;
      const bot = createBot(room, mode === "squad" ? 3 : 1);
      room.players.set(bot.id, bot);
      queue.players.add(bot.id);
    }
    broadcastQueueStatus(room);
    finishMatch(room, beaconId);
  }, QUEUE_FILL_DELAY_MS + QUEUE_LOCK_MS);

  // Safety: if queue becomes empty, abort.
  const check = setInterval(() => {
    if (!room.pendingMatches[beaconId]) { clearTimeout(fillTimer); clearInterval(check); }
  }, 1000);
}

function createBot(room, rank = 1) {
  const eloBase = rank === 1 ? 900 : rank === 2 ? 1100 : 1300;
  const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
  const profile = getProfile(name);
  profile.elo = eloBase + Math.floor(Math.random() * 150);
  profile.color = PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
  profile.beanieColor = BEANIE_COLORS[Math.floor(Math.random() * BEANIE_COLORS.length)];
  return {
    socket: null,
    id: randomUUID(),
    roomCode: room.roomCode ?? "",
    username: name,
    profile,
    isBot: true,
    x: 0, y: 0, z: 0, rotY: 0,
    speedUntil: 0, shieldUntil: 0, shrinkUntil: 0, superJumpUntil: 0,
    dashCooldownUntil: 0, isFrozen: false, frozenUntil: 0, eliminated: false,
    arena: null, queueBeacon: null,
    botTarget: null, nextBotThinkAt: 0, botWanderAt: 0,
    lastMoveAt: Date.now(),
    messageWindowStartedAt: Date.now(), messagesInWindow: 0
  };
}

function finishMatch(room, beaconId) {
  const matchConfig = MATCHMAKING[beaconId];
  const queue = room.queues[beaconId];
  room.pendingMatches[beaconId] = false;
  if (!matchConfig) {
    broadcastQueueStatus(room);
    return;
  }

  const players = Array.from(queue.players).slice(0, matchConfig.capacity)
    .map(playerId => room.players.get(playerId)).filter(Boolean);
  if (!players.length) return;

  const mode = queue.mode || "tag";
  const arenaType = beaconId;
  players.forEach(player => {
    player.arena = buildArena(arenaType, mode, matchConfig.size);
    player.arena.score = 0;
    player.arena.taggerId = null;
    player.arena.roundEndsAt = 0;
    player.arena.roundTimer = null;
    player.arena.powerups = new Map();
    player.arena.powerupTimer = null;
    player.arena.eliminatedIds = new Set();
    player.arena.matchStats = { tagsLanded: 0, tagsTaken: 0, distanceRun: 0, timeAsTagger: 0, lastPosX: player.x, lastPosZ: player.z };
    player.queueBeacon = null;
    player.eliminated = false;
    player.isFrozen = false;
    queue.players.delete(player.id);
  });

  players.forEach(player => {
    if (player.socket) {
      player.arenaPowerups = player.arena;
      send(player.socket, {
        type: "arena_started",
        arena: { ...player.arena, powerups: undefined, powerupTimer: undefined },
        x: player.x, y: player.y, z: player.z,
        modeLabel: GAME_MODES[mode]?.label || mode
      });
    }
  });

  resetArenaPositions(room, arenaType);
  players.forEach(player => {
    if (player.socket) send(player.socket, { type: "countdown_start", seconds: COUNTDOWN_MS / 1000 });
  });
  broadcast(room, { type: "arena_broadcast", arena: arenaType, mode });
  spawnPowerups(room, players[0].arena);

  setTimeout(() => {
    if (!players.every(player => player.arena?.type === arenaType)) return;
    startTagRound(room, arenaType);
  }, COUNTDOWN_MS);

  broadcastArenaScores(room, arenaType);
  broadcastQueueStatus(room);
}

function broadcastArenaScores(room, arenaType) {
  const scores = Array.from(room.players.values())
    .filter(player => player.arena?.type === arenaType && !player.isBot)
    .map(player => ({ id: player.id, username: player.username, score: player.arena.score }));
  for (const player of room.players.values()) {
    if (player.arena?.type !== arenaType) continue;
    send(player.socket, { type: "score_update", arena: arenaType, scores });
  }
}

function startTagRound(room, arenaType, taggerId) {
  const players = getCurrentArenaPlayers(room, arenaType);
  if (!players.length) return;
  const arena = players[0].arena;

  if (arena.mode === "last") {
    // In LAST mode, new tagger rotates; tag target gets eliminated.
    const tagger = players.find(p => p.id === taggerId) || players.find(p => p.id === arena.taggerId) || players[Math.floor(Math.random() * players.length)];
    if (!tagger) return;
    clearTimeout(arena.roundTimer);
    arena.taggerId = tagger.id;
    arena.roundEndsAt = 0; // no round timer in last mode; round = until elimination
    broadcast(room, { type: "tagger_assigned", taggerId: tagger.id, username: tagger.username });
    return;
  }

  const tagger = players.find(player => player.id === taggerId) || players[Math.floor(Math.random() * players.length)];
  if (!tagger) return;
  clearTimeout(arena.roundTimer);
  arena.taggerId = tagger.id;
  const roundMs = arena.mode === "crown" ? CROWN_ROUND_MS : arena.mode === "infection" ? INFECTION_ROUND_MS : arena.mode === "freeze" ? FREEZE_ROUND_MS : TAG_ROUND_MS;
  arena.roundEndsAt = Date.now() + roundMs;
  players.forEach(player => { player.arena.roundEndsAt = arena.roundEndsAt; player.isFrozen = false; });
  broadcast(room, { type: "tagger_assigned", taggerId: tagger.id, username: tagger.username });
  broadcast(room, { type: "round_started", seconds: roundMs / 1000, mode: arena.mode });

  arena.roundTimer = setTimeout(() => {
    if (!arena || arena.type !== arenaType) return;
    if (!arena || !arena.taggerId) return;
    if (arena.mode === "crown") {
      const carrier = Array.from(room.players.values()).find(p => p.arena?.type === arenaType && p.id === arena.crownCarrierId);
      if (carrier) {
        endArena(room, arenaType, `${carrier.username.toUpperCase()} HELD THE CROWN — WINS!`, carrier.id);
        return;
      }
    }
    // Round over: rotate tagger
    const nextTagger = players.find(p => p.id !== arena.taggerId);
    resetArenaPositions(room, arenaType);
    broadcast(room, { type: "round_over", message: "ROUND OVER — NEW TAGGER!" });
    startTagRound(room, arenaType, nextTagger ? nextTagger.id : arena.taggerId);
  }, roundMs);
}

function endArena(room, arenaType, message = "MATCH ENDED", winnerId = null) {
  const players = Array.from(room.players.values()).filter(player => player.arena?.type === arenaType);
  const realPlayers = players.filter(player => !player.isBot && player.socket);
  const winner = players.find(player => player.id === winnerId) || (realPlayers[0] && [...players].sort((a, b) => b.arena.score - a.arena.score)[0]);

  // Stats + rewards
  const stats = players.map(player => ({
    id: player.id,
    username: player.username,
    isBot: !!player.isBot,
    score: player.arena.score,
    tagsLanded: player.arena.matchStats?.tagsLanded || player.arena.score,
    tagsTaken: player.arena.matchStats?.tagsTaken || 0,
    distanceRun: Math.round(player.arena.matchStats?.distanceRun || 0),
    timeAsTagger: Math.round((player.arena.matchStats?.timeAsTagger || 0) / 1000)
  }));

  realPlayers.forEach(player => {
    const profile = player.profile;
    profile.games++;
    let xpGain = 10;
    let eloDelta = -10;
    if (winner && winner.id === player.id) {
      profile.wins++;
      xpGain += 50;
      eloDelta = 25;
    }
    if (player.arena.mode === "infection" && player.arena.matchStats) xpGain += 10;
    profile.tags += player.arena.matchStats?.tagsLanded || 0;
    profile.tagged += player.arena.matchStats?.tagsTaken || 0;
    addElo(player, eloDelta);
    const result = addXp(player, xpGain);
    send(player.socket, {
      type: "match_result",
      winner: winner ? { id: winner.id, username: winner.username, isBot: !!winner.isBot } : null,
      message,
      scores: stats.filter(s => s.id === player.id ? true : true).map(s => ({ ...s })),
      stats: stats.find(s => s.id === player.id),
      xpGained: xpGain,
      eloDelta,
      xp: profile.xp,
      level: profile.level,
      leveledUp: result.leveledUp
    });
  });

  // Notify everyone who was in the arena
  players.forEach(player => {
    if (!player.socket) return;
    if (player.arena.mode !== "last" || player !== winner) {
      send(player.socket, { type: "match_ended", x: 0, y: 0, z: 26, message });
    }
  });

  players.forEach(player => {
    clearTimeout(player.arena.roundTimer);
    clearTimeout(player.arena.powerupTimer);
    player.arena = null;
    player.eliminated = false;
    player.isFrozen = false;
    player.x = 0;
    player.y = 0;
    player.z = 26;
    player.lastMoveAt = Date.now();
  });
}

function checkTag(room, player) {
  if (!player.arena || player.isFrozen || player.eliminated) return;
  if (player.arena.taggerId !== player.id) return;
  const arena = player.arena;
  const now = Date.now();
  if (now - arena.lastReachAt < REACH_COOLDOWN_MS) return;
  arena.lastReachAt = now;

  const opponents = Array.from(room.players.values()).filter(other => other !== player && other.arena?.type === arena.type && !other.eliminated);
  const target = opponents.find(other => {
    const hitboxScale = other.shrinkUntil > now ? 0.72 : 1;
    const reachDistance = REACH_DISTANCE * (player.shrinkUntil > now ? 0.85 : 1);
    const deltaX = other.x - player.x;
    const deltaZ = other.z - player.z;
    const distance = Math.hypot(deltaX, deltaZ);
    const targetAngle = Math.atan2(-deltaX, -deltaZ);
    const angleDifference = Math.abs(Math.atan2(Math.sin(targetAngle - player.rotY), Math.cos(targetAngle - player.rotY)));
    const targetVerticalAngle = Math.atan2((other.y + hitboxScale) - (player.y + 1.7), Math.max(distance, 0.01));
    const pitchDifference = Math.abs(targetVerticalAngle - player.reachPitch);
    return distance <= reachDistance && angleDifference <= REACH_ANGLE && pitchDifference <= REACH_VERTICAL_ANGLE;
  });

  broadcast(room, { type: "reach", id: player.id, hand: player.lastReachHand || "right" });
  if (!target) return;

  if (target.shieldUntil > now) {
    send(player.socket, { type: "chat", system: true, message: `${target.username}'s SHIELD blocked your tag!` });
    broadcast(room, { type: "shield_blocked", id: target.id, taggerId: player.id });
    return;
  }

  // Mode-specific behavior
  if (arena.mode === "last") {
    target.eliminated = true;
    arena.eliminatedIds.add(target.id);
    player.arena.score++;
    broadcast(room, { type: "eliminated", id: target.id, taggerId: player.id, message: `${player.username} ELIMINATED ${target.username}!` });
    const remaining = getCurrentArenaPlayers(room, arena.type).filter(p => p.id !== arena.taggerId);
    if (remaining.length <= 1) {
      const champion = remaining[0];
      endArena(room, arena.type, champion ? `${champion.username.toUpperCase()} IS THE LAST ONE STANDING!` : `${player.username.toUpperCase()} WINS!`, champion ? champion.id : player.id);
    } else {
      startTagRound(room, arena.type, player.id);
    }
    resetArenaPositions(room, arena.type);
    broadcastArenaScores(room, arena.type);
    return;
  }

  if (arena.mode === "infection") {
    target.eliminated = false;
    target.isFrozen = false;
    player.arena.score++;
    broadcast(room, { type: "tag_landed", tagger: player.username, target: target.username, infected: true });
    broadcast(room, { type: "infected", id: target.id, taggerId: player.id });
    const allTaggers = getCurrentArenaPlayers(room, arena.type).every(p => p.id === arena.taggerId || p.eliminated);
    if (allTaggers) {
      const survivors = getCurrentArenaPlayers(room, arena.type).filter(p => p.id !== arena.taggerId && !p.eliminated);
      const lastSurvivor = survivors[0];
      endArena(room, arena.type, lastSurvivor ? `${lastSurvivor.username.toUpperCase()} SURVIVED THE INFECTION!` : "EVERYONE INFECTED!", lastSurvivor?.id || null);
      return;
    }
    // keep same tagger; don't reset positions fully, instead just respawn target (target becomes tagger)
    target.arena.taggerId = target.id; // infected joins taggers — actually infected also becomes a tagger
    // Short-circuit: mark target as tagger also by adding to an infected set; taggerId stays original.
    // Store infected list on arena so tagger set is represented:
    if (!arena.infectedIds) arena.infectedIds = new Set();
    arena.infectedIds.add(target.id);
    broadcast(room, { type: "tagger_assigned", taggerId: player.id, username: player.username, infected: Array.from(arena.infectedIds || []) });
    resetArenaPositions(room, arena.type);
    broadcastArenaScores(room, arena.type);
    return;
  }

  if (arena.mode === "freeze") {
    target.isFrozen = true;
    target.frozenUntil = now + FREEZE_TAG_DURATION_MS;
    player.arena.score++;
    broadcast(room, { type: "tag_landed", tagger: player.username, target: target.username, frozen: true, until: target.frozenUntil });
    const frozenRunners = getCurrentArenaPlayers(room, arena.type).filter(p => p !== player && p.isFrozen);
    if (frozenRunners.length === getCurrentArenaPlayers(room, arena.type).length - 1) {
      endArena(room, arena.type, `${player.username.toUpperCase()} FROZE EVERYONE!`, player.id);
      return;
    }
    resetArenaPositions(room, arena.type);
    broadcastArenaScores(room, arena.type);
    return;
  }

  if (arena.mode === "crown") {
    if (arena.crownCarrierId === target.id) {
      arena.crownCarrierId = null;
      broadcast(room, { type: "crown_dropped", at: { x: target.x, z: target.z } });
    }
    player.arena.score++;
  }

  player.arena.score++;
  player.arena.matchStats.tagsLanded++;
  target.arena.matchStats.tagsTaken++;
  broadcast(room, { type: "tag_landed", tagger: player.username, target: target.username });
  resetArenaPositions(room, arena.type);
  broadcastArenaScores(room, arena.type);
  if (arena.mode === "tag" && player.arena.score >= 10) {
    endArena(room, arena.type, `${player.username.toUpperCase()} WINS THE GAME!`, player.id);
    return;
  }
  startTagRound(room, arena.type, target.id);
}

function tagPlayer(room, player, hand, pitch) {
  if (!player.arena || !["left", "right"].includes(hand)) return;
  const now = Date.now();
  if (now - player.arena.lastReachAt < REACH_COOLDOWN_MS) return;
  player.arena.lastReachAt = now;
  player.reachPitch = finiteNumber(pitch) ? pitch : 0;
  player.lastReachHand = hand;
  checkTag(room, player);
}

function playerOverlapsArenaObstacle(arena, x, z) {
  return arenaObstacles(arena).some(obstacle => {
    const minX = arena.center.x + obstacle.x - obstacle.sizeX / 2;
    const maxX = arena.center.x + obstacle.x + obstacle.sizeX / 2;
    const minZ = arena.center.z + obstacle.z - obstacle.sizeZ / 2;
    const maxZ = arena.center.z + obstacle.z + obstacle.sizeZ / 2;
    return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
  });
}

// ---- Bot AI ----
function botAxisSpeed(bot) {
  const now = Date.now();
  let speed = 9 + (bot.profile.elo - 900) / 200;
  if (bot.speedUntil > now) speed *= 1.45;
  if (bot.isFrozen) speed = 0;
  return speed;
}

function botThink(bot) {
  if (bot.isFrozen || bot.eliminated) return;
  const room = rooms.get(bot.roomCode);
  if (!room) return;
  const now = Date.now();
  if (now < bot.nextBotThinkAt) return;
  bot.nextBotThinkAt = now + 260;
  const arena = bot.arena;
  let targetX = bot.x, targetZ = bot.z, moving = false;

  if (arena) {
    const others = Array.from(room.players.values()).filter(p => p.arena?.type === arena.type && p !== bot && !p.eliminated);
    if (arena.taggerId === bot.id || (arena.infectedIds && arena.infectedIds.has(bot.id))) {
      // Chase nearest runner
      const runner = others.find(p => p.arena.taggerId !== p.id && !(arena.infectedIds && arena.infectedIds.has(p.id)));
      if (runner) { targetX = runner.x; targetZ = runner.z; moving = true; }
      else if (others.length) { targetX = others[0].x; targetZ = others[0].z; moving = true; }
    } else {
      const tagger = others.find(p => p.id === arena.taggerId || (arena.infectedIds && arena.infectedIds.has(p.id)));
      if (arena.mode === "crown" && arena.crownCarrierId !== bot.id) {
        // go to crown
        targetX = arena.center.x;
        targetZ = arena.center.z;
        moving = true;
      } else if (tagger) {
        const dx = bot.x - tagger.x;
        const dz = bot.z - tagger.z;
        const dist = Math.hypot(dx, dz) || 1;
        if (dist < 14) {
          targetX = bot.x + (dx / dist) * 10;
          targetZ = bot.z + (dz / dist) * 10;
          moving = true;
        }
      }
      if (!moving) {
        // Wander
        if (now > bot.botWanderAt) {
          const rnd = Math.random();
          const radius = arena.size * 0.32;
          targetX = arena.center.x + (rnd * 2 - 1) * radius;
          targetZ = arena.center.z + (Math.random() * 2 - 1) * radius;
          bot.botWanderAt = now + 1800 + Math.random() * 2000;
          moving = true;
        }
      }
    }
  } else if (bot.queueBeacon) {
    const beacon = MATCHMAKING[bot.queueBeacon].beacon;
    targetX = beacon.x;
    targetZ = beacon.z;
    moving = true;
  } else {
    if (now > bot.botWanderAt) {
      targetX = (Math.random() * 2 - 1) * 40;
      targetZ = 20 + (Math.random() * 2 - 1) * 40;
      bot.botWanderAt = now + 2500 + Math.random() * 2500;
      moving = true;
    }
  }

  if (moving) {
    const dx = targetX - bot.x;
    const dz = targetZ - bot.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.6) {
      const step = botAxisSpeed(bot) * (STATE_TICK_MS / 1000);
      let nx = bot.x + (dx / dist) * step;
      let nz = bot.z + (dz / dist) * step;
      if (arena) {
        const half = arena.size / 2 - 0.7;
        nx = Math.max(arena.center.x - half, Math.min(arena.center.x + half, nx));
        nz = Math.max(arena.center.z - half, Math.min(arena.center.z + half, nz));
        if (playerOverlapsArenaObstacle(arena, nx, nz)) {
          nx = bot.x;
          if (playerOverlapsArenaObstacle(arena, nx, nz)) nz = bot.z;
        }
      }
      bot.x = nx;
      bot.z = nz;
      bot.rotY = Math.atan2(nx - bot.x, nz - bot.z);
      bot.rotY = Math.atan2(dx, dz);
    }
  }
}

function movePlayer(room, player, message, now) {
  if (player.isFrozen) {
    send(player.socket, { type: "state_rejected", reason: "Frozen.", player: publicPlayer(player) });
    return;
  }
  const values = [message.x, message.y, message.z, message.rotY];
  if (!values.every(finiteNumber)) return;
  if (message.y < -20 || message.y > 60) return;

  if (player.queueBeacon) {
    const beacon = MATCHMAKING[player.queueBeacon].beacon;
    const distanceFromCenter = Math.hypot(message.x - beacon.x, message.z - beacon.z);
    const doorZ = beacon.z - beacon.radius;
    const nearDoor = Math.hypot(message.x - beacon.x, message.z - doorZ) < 2.5;
    if (distanceFromCenter > beacon.radius && !nearDoor) return;
  } else if (player.arena && !player.eliminated) {
    const halfSize = player.arena.size / 2 - 0.7;
    if (Math.abs(message.x - player.arena.center.x) > halfSize || Math.abs(message.z - player.arena.center.z) > halfSize) return;
    if (playerOverlapsArenaObstacle(player.arena, message.x, message.z)) return;
  } else if (player.eliminated) {
    // Spectators can move freely in a ghost mode but stay within world bounds for sanity
    if (Math.abs(message.x) > WORLD_LIMIT || Math.abs(message.z) > WORLD_LIMIT) return;
  } else if (Math.abs(message.x) > WORLD_LIMIT || Math.abs(message.z) > WORLD_LIMIT) return;

  const elapsed = Math.max((now - player.lastMoveAt) / 1000, 1 / 60);
  const horizontalDistance = Math.hypot(message.x - player.x, message.z - player.z);
  const verticalDistance = Math.abs(message.y - player.y);
  const effectiveMax = BASE_SPEED * (player.speedUntil > now ? MAX_SPEED_MULT : 1);
  if (horizontalDistance > effectiveMax * elapsed + 1 || verticalDistance > MAX_VERTICAL_SPEED * elapsed + 2) {
    send(player.socket, { type: "state_rejected", reason: "Movement exceeded server limits.", player: publicPlayer(player) });
    return;
  }

  if (player.arena?.matchStats) {
    player.arena.matchStats.distanceRun += Math.hypot(message.x - player.x, message.z - player.z);
  }

  player.x = message.x;
  player.y = message.y;
  player.z = message.z;
  player.rotY = message.rotY;
  player.lastMoveAt = now;

  // Freeze-tag unfreeze proximity check
  if (player.arena?.mode === "freeze") {
    const frozenTeammates = Array.from(room.players.values()).filter(p => p.arena?.type === player.arena.type && p !== player && p.isFrozen && p.id !== player.arena.taggerId);
    for (const frozen of frozenTeammates) {
      if (Math.hypot(player.x - frozen.x, player.z - frozen.z) < 1.4) {
        frozen.isFrozen = false;
        broadcast(room, { type: "unfrozen", id: frozen.id, by: player.username });
      }
    }
  }

  // Crown pickup
  if (player.arena && player.arena.mode === "crown" && player.arena.taggerId !== player.id && player.arena.crownCarrierId == null) {
    if (Math.hypot(player.x - player.arena.center.x, player.z - player.arena.center.z) < 1.6) {
      player.arena.crownCarrierId = player.id;
      broadcast(room, { type: "crown_picked", id: player.id, username: player.username });
    }
  }
}

const app = express();
app.use(express.static(__dirname));
app.get("/", (_request, response) => response.sendFile(`${__dirname}/woah.html`));

const httpServer = createServer(app);
const websocketServer = new WebSocketServer({ server: httpServer, maxPayload: 8192 });

function createPlayer(socket, roomCode) {
  return {
    socket,
    id: randomUUID(),
    roomCode,
    username: null,
    profile: null,
    x: 0, y: 0, z: 0, rotY: 0,
    speedUntil: 0, shieldUntil: 0, shrinkUntil: 0, superJumpUntil: 0,
    dashCooldownUntil: 0, isFrozen: false, frozenUntil: 0, eliminated: false,
    arena: null, queueBeacon: null,
    reachPitch: 0, lastReachHand: "right",
    lastMoveAt: Date.now(),
    messageWindowStartedAt: Date.now(), messagesInWindow: 0,
    lastChatAt: 0, lastEmoteAt: 0
  };
}

function bindSocket(player, socket) {
  player.socket = socket;
  player.messageWindowStartedAt = Date.now();
  player.messagesInWindow = 0;
}

function handleConnection(socket) {
  const player = createPlayer(socket, null);

  socket.on("message", raw => {
    const now = Date.now();
    if (now - player.messageWindowStartedAt >= 1000) {
      player.messageWindowStartedAt = now;
      player.messagesInWindow = 0;
    }
    player.messagesInWindow++;
    if (player.messagesInWindow > MAX_MESSAGES_PER_SECOND) return;

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return send(socket, { type: "error", message: "Invalid message format." });
    }

    if (message.type === "join") {
      // Reconnect support
      if (message.sessionToken) {
        const token = parseToken(message.sessionToken);
        if (token) {
          const room = rooms.get(token.roomCode);
          const existing = room?.players.get(token.id);
          if (existing && !existing.isBot) {
            bindSocket(existing, socket);
            send(socket, {
              type: "joined",
              id: existing.id,
              sessionToken: message.sessionToken,
              reconnect: true,
              players: Array.from(room.players.values()).filter(item => item.id !== existing.id).map(publicPlayer)
            });
            broadcastQueueStatus(room);
            return;
          }
        }
        return send(socket, { type: "error", message: "Session expired — rejoin with a room code." });
      }

      const roomCode = String(message.room || "").toUpperCase();
      const username = typeof message.username === "string" ? message.username.trim() : "";
      if (!validRoom(roomCode) || !validName(username)) return send(socket, { type: "error", message: "Invalid room or username." });
      if (player.roomCode) return send(socket, { type: "error", message: "Already joined." });
      player.username = username;
      player.profile = getProfile(username);
      player.roomCode = roomCode;

      const room = rooms.get(roomCode) || {
        roomCode,
        players: new Map(),
        queues: {
          duel: { players: new Set(), mode: "tag" },
          squad: { players: new Set(), mode: "infection" }
        },
        pendingMatches: { duel: false, squad: false }
      };
      if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
        player.roomCode = null;
        return send(socket, { type: "error", message: "Room is full." });
      }
      rooms.set(roomCode, room);
      player.sessionToken = createSessionToken(player);
      room.players.set(player.id, player);

      send(socket, {
        type: "joined",
        id: player.id,
        sessionToken: player.sessionToken,
        profile: { ...player.profile },
        players: Array.from(room.players.values()).filter(item => item.id !== player.id).map(publicPlayer)
      });
      broadcast(room, { type: "chat", system: true, message: `${username} joined the room.` });
      broadcast(room, { type: "player_joined", player: publicPlayer(player) }, socket);
      broadcastQueueStatus(room);
      return;
    }

    if (message.type === "set_mode") {
      const room = rooms.get(player.roomCode);
      const beaconId = message.beacon;
      const mode = GAME_MODES[message.mode] ? message.mode : null;
      if (!room || !beaconId || !room.queues[beaconId] || !mode) return;
      if (room.pendingMatches[beaconId]) return send(socket, { type: "error", message: "Match already starting." });
      room.queues[beaconId].mode = mode;
      broadcastQueueStatus(room);
      return;
    }

    if (message.type === "queue_join") {
      const room = rooms.get(player.roomCode);
      const beaconId = message.beacon;
      const matchConfig = MATCHMAKING[beaconId];
      if (!room || !matchConfig || player.arena) return;
      if (Object.entries(room.pendingMatches).some(([id, pending]) => pending && room.queues[id].players.has(player.id))) return;

      for (const queue of Object.values(room.queues)) queue.players.delete(player.id);
      room.queues[beaconId].players.add(player.id);
      player.queueBeacon = beaconId;
      player.x = matchConfig.beacon.x;
      player.y = 0;
      player.z = matchConfig.beacon.z;
      player.lastMoveAt = Date.now();
      send(socket, { type: "queue_joined", beacon: beaconId, x: player.x, y: player.y, z: player.z, mode: room.queues[beaconId].mode });
      broadcastQueueStatus(room);
      startMatch(room, beaconId);
      return;
    }

    if (message.type === "queue_exit") {
      const room = rooms.get(player.roomCode);
      const beaconId = player.queueBeacon;
      const matchConfig = MATCHMAKING[beaconId];
      if (!room || !beaconId || !matchConfig || room.pendingMatches[beaconId]) return;
      const doorZ = matchConfig.beacon.z - matchConfig.beacon.radius;
      if (Math.hypot(player.x - matchConfig.beacon.x, player.z - doorZ) > 2.5) return;
      room.queues[beaconId].players.delete(player.id);
      player.queueBeacon = null;
      player.x = matchConfig.beacon.x;
      player.z = matchConfig.beacon.z - matchConfig.beacon.radius - 2;
      player.lastMoveAt = Date.now();
      send(socket, { type: "queue_exited", x: player.x, y: player.y, z: player.z });
      broadcastQueueStatus(room);
      return;
    }

    if (message.type === "arena_exit") {
      const room = rooms.get(player.roomCode);
      if (!room || !player.arena) return;
      const halfSize = player.arena.size / 2;
      const doorZ = player.arena.center.z - halfSize;
      if (Math.hypot(player.x - player.arena.center.x, player.z - doorZ) > 3) return;
      endArena(room, player.arena.type, "MATCH ABANDONED");
      return;
    }

    if (message.type === "reach") {
      const room = rooms.get(player.roomCode);
      if (!room || !isValidSessionToken18(player, message.sessionToken)) return;
      tagPlayer(room, player, message.hand, message.pitch);
      return;
    }

    if (message.type === "dash") {
      const room = rooms.get(player.roomCode);
      if (!room || !isValidSessionToken18(player, message.sessionToken)) return;
      if (!player.arena || player.isFrozen || player.eliminated) return;
      const now = Date.now();
      if (now < player.dashCooldownUntil) return;
      player.dashCooldownUntil = now + DASH_COOLDOWN_MS;
      const dirX = finiteNumber(message.dirX) ? message.dirX : 0;
      const dirZ = finiteNumber(message.dirZ) ? message.dirZ : 0;
      const len = Math.hypot(dirX, dirZ);
      if (len < 0.01) return;
      const nx = player.x + (dirX / len) * DASH_DISTANCE;
      const nz = player.z + (dirZ / len) * DASH_DISTANCE;
      const half = player.arena.size / 2 - 0.7;
      let px = Math.max(player.arena.center.x - half, Math.min(player.arena.center.x + half, nx));
      let pz = Math.max(player.arena.center.z - half, Math.min(player.arena.center.z + half, nz));
      if (playerOverlapsArenaObstacle(player.arena, px, pz)) {
        px = player.x;
        if (playerOverlapsArenaObstacle(player.arena, px, pz)) pz = player.z;
      }
      player.x = px;
      player.z = pz;
      player.lastMoveAt = now;
      broadcast(room, { type: "dash", id: player.id, x: px, z: pz });
      return;
    }

    if (message.type === "powerup_collect") {
      const room = rooms.get(player.roomCode);
      if (!room || !player.arena) return;
      const powerup = player.arena.powerups?.get(message.id);
      if (!powerup) return;
      if (Date.now() > powerup.expiresAt) {
        player.arena.powerups.delete(message.id);
        return;
      }
      if (Math.hypot(player.x - powerup.x, player.z - powerup.z) > 2.2) return;
      player.arena.powerups.delete(message.id);
      applyPowerup(room, player, powerup);
      broadcast(room, { type: "powerup_collected", id: message.id, playerId: player.id, kind: powerup.kind });
      return;
    }

    if (message.type === "chat") {
      const room = rooms.get(player.roomCode);
      if (!room) return;
      if (now - player.lastChatAt < CHAT_COOLDOWN_MS) return;
      player.lastChatAt = now;
      const text = typeof message.message === "string" ? message.message.trim().slice(0, 120) : "";
      if (!text) return;
      broadcast(room, { type: "chat", username: player.username, color: player.profile?.color || "#ffffff", message: text });
      return;
    }

    if (message.type === "emote") {
      const room = rooms.get(player.roomCode);
      if (!room) return;
      if (now - player.lastEmoteAt < 1200) return;
      player.lastEmoteAt = now;
      const emote = typeof message.emote === "string" ? message.emote.slice(0, 24) : "";
      if (!/^[a-zA-Z0-9_ !-]{1,24}$/.test(emote)) return;
      broadcast(room, { type: "emote", id: player.id, emote });
      return;
    }

    if (message.type === "ping") {
      send(socket, { type: "pong", t: finiteNumber(message.t) ? message.t : Date.now() });
      return;
    }

    if (message.type === "move") {
      const room = rooms.get(player.roomCode);
      if (!room) return;
      if (!isValidSessionToken18(player, message.sessionToken)) return send(socket, { type: "error", message: "Invalid or expired session." });
      movePlayer(room, player, message, now);
      return;
    }
  });

  socket.on("close", () => removePlayer(player));
  socket.on("error", () => removePlayer(player));
}

// Keep a helper to avoid duplicate logic; refactor token validation to accept socket param.
function isValidSessionToken18(player, token) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 4) return false;
  const [id, roomCode, issuedAt] = parts;
  if (id !== player.id || roomCode !== player.roomCode || !/^\d+$/.test(issuedAt)) return false;
  if (Date.now() - Number(issuedAt) > 24 * 60 * 60 * 1000) return false;
  const payload = `${id}.${roomCode}.${issuedAt}`;
  const expected = createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  const providedBuffer = Buffer.from(parts[3], "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

websocketServer.on("connection", handleConnection);

// ---- Authoritative state loop (30Hz) ----
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    // Bot thinking & motion
    for (const player of room.players.values()) {
      if (player.isBot) botThink(player);
      if (player.isFrozen && now >= player.frozenUntil) player.isFrozen = false;
    }

    // Power-up expiry broadcast
    for (const player of room.players.values()) {
      if (!player.arena?.powerups) continue;
      for (const [id, powerup] of player.arena.powerups) {
        if (now > powerup.expiresAt) {
          player.arena.powerups.delete(id);
          broadcast(room, { type: "powerup_expired", arena: player.arena.type, id });
        }
      }
    }

    // Crown position broadcast
    for (const player of room.players.values()) {
      if (!player.arena || player.arena.mode !== "crown") continue;
      const carrier = room.players.get(player.arena.crownCarrierId);
      if (carrier) {
        broadcast(room, { type: "crown_state", arena: player.arena.type, x: carrier.x, z: carrier.z, carrierId: carrier.id });
      } else {
        broadcast(room, { type: "crown_state", arena: player.arena.type, x: player.arena.center.x, z: player.arena.center.z, carrierId: null });
      }
    }

    // Batch state broadcast (deltas omitted; full states are small at these player counts)
    const states = [];
    for (const player of room.players.values()) {
      if (!player.username) continue;
      states.push(publicPlayer(player));
    }
    if (!states.length) continue;
    for (const player of room.players.values()) {
      if (!player.socket) continue;
      const mine = states.filter(s => s.id !== player.id);
      if (mine.length) send(player.socket, { type: "states", players: mine });
      // Local info (server-confirmed)
      const me = states.find(s => s.id === player.id);
      if (me && player.isFrozen) {
        // Let frozen players know they are frozen each tick to reinforce state
      }
    }
  }
}, STATE_TICK_MS);

// Periodic queue fill safety: clean up stale empty rooms
setInterval(() => {
  for (const [code, room] of rooms) {
    const realCount = [...room.players.values()].filter(p => !p.isBot).length;
    if (realCount === 0) {
      for (const player of [...room.players.values()]) {
        if (player.isBot) removePlayer(player);
      }
    }
  }
}, 60_000);

httpServer.listen(PORT, () => console.log(`Authoritative server running at http://localhost:${PORT}`));