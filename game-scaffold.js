'use strict'

/**
 * Game Project Scaffolder
 * ───────────────────────
 * Generates a multi-file vanilla JS game project structure.
 * Used by the game-dev agent role when creating new games from scratch.
 *
 * The scaffold produces files under 200 lines each — optimized for
 * local LLM editing (full file fits in context, precise edits).
 *
 * Usage:
 *   const { generateGameScaffold } = require('./game-scaffold')
 *   const files = generateGameScaffold({ name: 'my-game', type: 'platformer' })
 *   // files is an array of { path, content } objects
 */

const path = require('node:path')

// ── Game type templates ───────────────────────────────────────────────────────

const GAME_TYPES = {
  platformer: {
    description: 'Side-scrolling platformer with gravity, jumping, and tile-based levels',
    entities: ['Player', 'Enemy', 'Coin', 'Platform'],
    physics: ['gravity', 'jump', 'collision'],
  },
  'top-down': {
    description: 'Top-down adventure/RPG with 8-directional movement',
    entities: ['Player', 'NPC', 'Enemy', 'Item'],
    physics: ['movement', 'collision'],
  },
  shooter: {
    description: 'Space shooter or bullet-hell with projectiles and waves',
    entities: ['Player', 'Enemy', 'Bullet', 'PowerUp'],
    physics: ['movement', 'collision', 'wrapping'],
  },
  puzzle: {
    description: 'Grid-based puzzle game (match-3, sokoban, etc.)',
    entities: ['Tile', 'Block', 'Goal'],
    physics: ['grid-snap', 'matching'],
  },
  arcade: {
    description: 'Simple arcade game (breakout, pong, snake, etc.)',
    entities: ['Player', 'Ball', 'Brick'],
    physics: ['bounce', 'collision'],
  },
}

/**
 * Generate the scaffold file list for a new game project.
 *
 * @param {object} opts
 * @param {string} opts.name - Project/folder name (default: 'game')
 * @param {string} [opts.type] - Game type: platformer, top-down, shooter, puzzle, arcade
 * @param {number} [opts.width] - Canvas width (default: 800)
 * @param {number} [opts.height] - Canvas height (default: 600)
 * @param {string} [opts.title] - Game title for the HTML page
 * @param {boolean} [opts.includeAudio] - Include audio.js (default: true)
 * @param {string[]} [opts.extraFiles] - Additional file names to scaffold
 * @returns {Array<{path: string, content: string, description: string}>}
 */
function generateGameScaffold(opts = {}) {
  const {
    name = 'game',
    type = 'platformer',
    width = 800,
    height = 600,
    title = 'Game',
    includeAudio = true,
    extraFiles = [],
  } = opts

  const gameType = GAME_TYPES[type] || GAME_TYPES.platformer
  const files = []

  // ── index.html ──────────────────────────────────────────────────────────
  const scriptTags = [
    'config.js', 'utils.js', 'input.js', 'entities.js',
    'physics.js', 'levels.js', 'renderer.js',
    ...(includeAudio ? ['audio.js'] : []),
    ...extraFiles,
    'main.js',
  ].map(f => `    <script src="${f}"></script>`).join('\n')

  files.push({
    path: path.join(name, 'index.html'),
    description: 'Entry point — canvas + script loading',
    content:
`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #111; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
        canvas { border: 2px solid #333; image-rendering: pixelated; }
    </style>
</head>
<body>
    <canvas id="game" width="${width}" height="${height}"></canvas>
${scriptTags}
</body>
</html>
`,
  })

  // ── config.js ───────────────────────────────────────────────────────────
  files.push({
    path: path.join(name, 'config.js'),
    description: 'Constants and tuning values — single source of truth',
    content:
`// config.js — Game constants and tuning values
// Change values here to adjust game feel without touching logic.

const CONFIG = {
  // Canvas
  WIDTH: ${width},
  HEIGHT: ${height},
  FPS: 60,

  // Player
  PLAYER_SPEED: 4,
  PLAYER_JUMP: -12,
  PLAYER_SIZE: 32,

  // Physics
  GRAVITY: 0.6,
  FRICTION: 0.85,
  MAX_FALL_SPEED: 15,

  // Game
  TILE_SIZE: 32,
  STARTING_LIVES: 3,

  // Colors
  BG_COLOR: '#1a1a2e',
  PLAYER_COLOR: '#4ecdc4',
  ENEMY_COLOR: '#ff6b6b',
  COIN_COLOR: '#ffd93d',
  GROUND_COLOR: '#6c5ce7',
}
`,
  })

  // ── utils.js ────────────────────────────────────────────────────────────
  files.push({
    path: path.join(name, 'utils.js'),
    description: 'Shared helper functions',
    content:
`// utils.js — Shared helper functions

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val))
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

function randomRange(min, max) {
  return Math.random() * (max - min) + min
}

function randomInt(min, max) {
  return Math.floor(randomRange(min, max + 1))
}

// Axis-Aligned Bounding Box collision
function aabb(a, b) {
  return a.x < b.x + b.w &&
         a.x + a.w > b.x &&
         a.y < b.y + b.h &&
         a.y + a.h > b.y
}

// Distance between two points
function dist(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
}
`,
  })

  // ── input.js ────────────────────────────────────────────────────────────
  files.push({
    path: path.join(name, 'input.js'),
    description: 'Keyboard and mouse input state',
    content:
`// input.js — Input state tracking
// Single listeners — extend the switch cases, don't add new listeners.

const keys = {}
const mouse = { x: 0, y: 0, down: false }

window.addEventListener('keydown', (e) => {
  keys[e.code] = true
  // Prevent scrolling with arrow keys / space
  if (['ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) e.preventDefault()
})

window.addEventListener('keyup', (e) => {
  keys[e.code] = false
})

const canvas = document.getElementById('game')
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect()
  mouse.x = e.clientX - rect.left
  mouse.y = e.clientY - rect.top
})

canvas.addEventListener('mousedown', () => { mouse.down = true })
canvas.addEventListener('mouseup', () => { mouse.down = false })

// Helper: check if a key is currently held
function isKeyDown(code) { return !!keys[code] }
function isLeft() { return keys['ArrowLeft'] || keys['KeyA'] }
function isRight() { return keys['ArrowRight'] || keys['KeyD'] }
function isUp() { return keys['ArrowUp'] || keys['KeyW'] || keys['Space'] }
function isDown() { return keys['ArrowDown'] || keys['KeyS'] }
`,
  })

  // ── entities.js ─────────────────────────────────────────────────────────
  const entityList = gameType.entities.join(', ')
  files.push({
    path: path.join(name, 'entities.js'),
    description: `Entity factories: ${entityList}`,
    content:
`// entities.js — Entity creation and management
// Entities: ${entityList}

function createPlayer(x, y) {
  return {
    x, y,
    w: CONFIG.PLAYER_SIZE,
    h: CONFIG.PLAYER_SIZE,
    vx: 0, vy: 0,
    onGround: false,
    lives: CONFIG.STARTING_LIVES,
    score: 0,
    facing: 1, // 1 = right, -1 = left
  }
}

function createEnemy(x, y, type) {
  return {
    x, y,
    w: CONFIG.TILE_SIZE,
    h: CONFIG.TILE_SIZE,
    vx: type === 'patrol' ? 1 : 0,
    vy: 0,
    type: type || 'patrol',
    alive: true,
    direction: 1,
  }
}

function createCoin(x, y) {
  return {
    x, y,
    w: 16, h: 16,
    collected: false,
    bobOffset: Math.random() * Math.PI * 2,
  }
}

function createParticle(x, y, color) {
  return {
    x, y,
    vx: randomRange(-3, 3),
    vy: randomRange(-5, -1),
    life: 1.0,
    decay: randomRange(0.02, 0.05),
    size: randomRange(2, 6),
    color: color || CONFIG.COIN_COLOR,
  }
}
`,
  })

  // ── physics.js ──────────────────────────────────────────────────────────
  files.push({
    path: path.join(name, 'physics.js'),
    description: 'Movement, gravity, and collision resolution',
    content:
`// physics.js — Movement and collision

function applyGravity(entity) {
  entity.vy += CONFIG.GRAVITY
  entity.vy = clamp(entity.vy, -20, CONFIG.MAX_FALL_SPEED)
}

function applyMovement(entity) {
  entity.x += entity.vx
  entity.y += entity.vy
}

function resolveCollisions(entity, tiles) {
  entity.onGround = false

  // Horizontal collision
  for (const tile of tiles) {
    if (aabb(entity, tile)) {
      if (entity.vx > 0) {
        entity.x = tile.x - entity.w
      } else if (entity.vx < 0) {
        entity.x = tile.x + tile.w
      }
      entity.vx = 0
    }
  }

  // Vertical collision
  for (const tile of tiles) {
    if (aabb(entity, tile)) {
      if (entity.vy > 0) {
        entity.y = tile.y - entity.h
        entity.vy = 0
        entity.onGround = true
      } else if (entity.vy < 0) {
        entity.y = tile.y + tile.h
        entity.vy = 0
      }
    }
  }
}

function checkEntityCollision(a, b) {
  return aabb(a, b)
}
`,
  })

  // ── levels.js ───────────────────────────────────────────────────────────
  files.push({
    path: path.join(name, 'levels.js'),
    description: 'Level data and loading',
    content:
`// levels.js — Level data and tile map loading
// Legend: 0=air, 1=ground, 2=platform, C=coin, E=enemy, P=player start

const LEVELS = [
  {
    name: 'Level 1',
    map: [
      '................................',
      '................................',
      '................................',
      '................................',
      '..........CCC...................',
      '.........22222..................',
      '................................',
      '....C.................C.........',
      '...222...........E...222........',
      '................................',
      '.P.........E....................',
      '11111111111111111111111111111111',
    ],
  },
]

function loadLevel(levelIndex) {
  const level = LEVELS[levelIndex] || LEVELS[0]
  const tiles = []
  const coins = []
  const enemies = []
  let playerStart = { x: 0, y: 0 }

  for (let row = 0; row < level.map.length; row++) {
    for (let col = 0; col < level.map[row].length; col++) {
      const char = level.map[row][col]
      const x = col * CONFIG.TILE_SIZE
      const y = row * CONFIG.TILE_SIZE

      switch (char) {
        case '1':
        case '2':
          tiles.push({ x, y, w: CONFIG.TILE_SIZE, h: CONFIG.TILE_SIZE, type: char })
          break
        case 'C':
          coins.push(createCoin(x + 8, y + 8))
          break
        case 'E':
          enemies.push(createEnemy(x, y, 'patrol'))
          break
        case 'P':
          playerStart = { x, y }
          break
      }
    }
  }

  return { tiles, coins, enemies, playerStart, name: level.name }
}
`,
  })

  // ── renderer.js ─────────────────────────────────────────────────────────
  files.push({
    path: path.join(name, 'renderer.js'),
    description: 'All draw/render functions',
    content:
`// renderer.js — Drawing functions
// All draw calls go here. Each function handles one visual layer.

const canvas = document.getElementById('game')
const ctx = canvas.getContext('2d')

function clearCanvas() {
  ctx.fillStyle = CONFIG.BG_COLOR
  ctx.fillRect(0, 0, CONFIG.WIDTH, CONFIG.HEIGHT)
}

function drawTiles(tiles, camera) {
  ctx.fillStyle = CONFIG.GROUND_COLOR
  for (const tile of tiles) {
    const sx = tile.x - camera.x
    const sy = tile.y - camera.y
    if (sx > -CONFIG.TILE_SIZE && sx < CONFIG.WIDTH) {
      ctx.fillRect(sx, sy, tile.w, tile.h)
    }
  }
}

function drawPlayer(player, camera) {
  ctx.fillStyle = CONFIG.PLAYER_COLOR
  ctx.fillRect(player.x - camera.x, player.y - camera.y, player.w, player.h)
}

function drawEnemies(enemies, camera) {
  ctx.fillStyle = CONFIG.ENEMY_COLOR
  for (const e of enemies) {
    if (!e.alive) continue
    ctx.fillRect(e.x - camera.x, e.y - camera.y, e.w, e.h)
  }
}

function drawCoins(coins, camera, time) {
  ctx.fillStyle = CONFIG.COIN_COLOR
  for (const c of coins) {
    if (c.collected) continue
    const bob = Math.sin(time * 0.003 + c.bobOffset) * 3
    ctx.beginPath()
    ctx.arc(c.x - camera.x, c.y - camera.y + bob, 8, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawParticles(particles, camera) {
  for (const p of particles) {
    ctx.globalAlpha = p.life
    ctx.fillStyle = p.color
    ctx.fillRect(p.x - camera.x, p.y - camera.y, p.size, p.size)
  }
  ctx.globalAlpha = 1
}

function drawUI(player) {
  ctx.fillStyle = '#fff'
  ctx.font = '16px monospace'
  ctx.fillText('Score: ' + player.score, 10, 24)
  ctx.fillText('Lives: ' + player.lives, 10, 44)
}
`,
  })

  // ── audio.js (optional) ─────────────────────────────────────────────────
  if (includeAudio) {
    files.push({
      path: path.join(name, 'audio.js'),
      description: 'Sound effects using Web Audio API',
      content:
`// audio.js — Sound effects (Web Audio API)
// Generates simple synth sounds — no external files needed.

let audioCtx = null

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  }
}

function playSound(type) {
  if (!audioCtx) initAudio()
  const osc = audioCtx.createOscillator()
  const gain = audioCtx.createGain()
  osc.connect(gain)
  gain.connect(audioCtx.destination)

  switch (type) {
    case 'jump':
      osc.frequency.setValueAtTime(300, audioCtx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(600, audioCtx.currentTime + 0.1)
      gain.gain.setValueAtTime(0.3, audioCtx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15)
      osc.start(); osc.stop(audioCtx.currentTime + 0.15)
      break
    case 'coin':
      osc.frequency.setValueAtTime(800, audioCtx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(1200, audioCtx.currentTime + 0.08)
      gain.gain.setValueAtTime(0.2, audioCtx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1)
      osc.start(); osc.stop(audioCtx.currentTime + 0.1)
      break
    case 'hit':
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(200, audioCtx.currentTime)
      osc.frequency.exponentialRampToValueAtTime(50, audioCtx.currentTime + 0.2)
      gain.gain.setValueAtTime(0.4, audioCtx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.25)
      osc.start(); osc.stop(audioCtx.currentTime + 0.25)
      break
  }
}
`,
    })
  }

  // ── main.js ─────────────────────────────────────────────────────────────
  files.push({
    path: path.join(name, 'main.js'),
    description: 'Game loop, state machine, initialization',
    content:
`// main.js — Game loop and state machine
// This file owns the loop. Other files provide functions called from here.

// ── Game State ────────────────────────────────────────────────────────────
let gameState = 'playing' // 'menu' | 'playing' | 'paused' | 'gameover'
let player = null
let tiles = []
let coins = []
let enemies = []
let particles = []
let camera = { x: 0, y: 0 }
let currentLevel = 0
let time = 0

// ── Init ──────────────────────────────────────────────────────────────────
function init() {
  const level = loadLevel(currentLevel)
  tiles = level.tiles
  coins = level.coins
  enemies = level.enemies
  player = createPlayer(level.playerStart.x, level.playerStart.y)
  camera = { x: 0, y: 0 }
  particles = []
  gameState = 'playing'
}

// ── Update ────────────────────────────────────────────────────────────────
function update() {
  if (gameState !== 'playing') return
  time++

  // Player input
  if (isLeft()) { player.vx = -CONFIG.PLAYER_SPEED; player.facing = -1 }
  else if (isRight()) { player.vx = CONFIG.PLAYER_SPEED; player.facing = 1 }
  else { player.vx *= CONFIG.FRICTION }

  if (isUp() && player.onGround) {
    player.vy = CONFIG.PLAYER_JUMP
    player.onGround = false
    playSound('jump')
  }

  // Physics
  applyGravity(player)
  applyMovement(player)
  resolveCollisions(player, tiles)

  // Enemies
  for (const e of enemies) {
    if (!e.alive) continue
    e.x += e.vx * e.direction
    // Patrol: reverse at edges (simple)
    if (e.x < 0 || e.x > CONFIG.WIDTH * 2) e.direction *= -1

    // Player collision
    if (checkEntityCollision(player, e)) {
      if (player.vy > 0 && player.y + player.h - 10 < e.y) {
        // Stomp
        e.alive = false
        player.vy = CONFIG.PLAYER_JUMP * 0.6
        player.score += 100
      } else {
        // Hit
        player.lives--
        playSound('hit')
        if (player.lives <= 0) gameState = 'gameover'
        else init() // respawn
      }
    }
  }

  // Coins
  for (const c of coins) {
    if (c.collected) continue
    if (checkEntityCollision(player, { x: c.x - 8, y: c.y - 8, w: 16, h: 16 })) {
      c.collected = true
      player.score += 10
      playSound('coin')
      // Spawn particles
      for (let i = 0; i < 5; i++) particles.push(createParticle(c.x, c.y))
    }
  }

  // Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]
    p.x += p.vx; p.y += p.vy; p.vy += 0.2; p.life -= p.decay
    if (p.life <= 0) particles.splice(i, 1)
  }

  // Camera follow
  camera.x = lerp(camera.x, player.x - CONFIG.WIDTH / 2 + player.w / 2, 0.1)
  camera.y = lerp(camera.y, player.y - CONFIG.HEIGHT / 2 + player.h / 2, 0.05)
  camera.x = clamp(camera.x, 0, Infinity)
}

// ── Draw ──────────────────────────────────────────────────────────────────
function draw() {
  clearCanvas()
  drawTiles(tiles, camera)
  drawCoins(coins, camera, time)
  drawEnemies(enemies, camera)
  drawPlayer(player, camera)
  drawParticles(particles, camera)
  drawUI(player)

  if (gameState === 'gameover') {
    ctx.fillStyle = 'rgba(0,0,0,0.7)'
    ctx.fillRect(0, 0, CONFIG.WIDTH, CONFIG.HEIGHT)
    ctx.fillStyle = '#fff'
    ctx.font = '32px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('GAME OVER', CONFIG.WIDTH / 2, CONFIG.HEIGHT / 2)
    ctx.font = '16px monospace'
    ctx.fillText('Press R to restart', CONFIG.WIDTH / 2, CONFIG.HEIGHT / 2 + 40)
    ctx.textAlign = 'left'
  }
}

// ── Game Loop ─────────────────────────────────────────────────────────────
function gameLoop() {
  update()
  draw()
  requestAnimationFrame(gameLoop)
}

// ── Start ─────────────────────────────────────────────────────────────────
// Init audio on first interaction
document.addEventListener('click', initAudio, { once: true })
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && gameState === 'gameover') init()
  initAudio()
}, { once: false })

init()
gameLoop()
`,
  })

  return files
}

/**
 * Get available game types and their descriptions.
 */
function getGameTypes() {
  return Object.entries(GAME_TYPES).map(([key, val]) => ({
    type: key,
    description: val.description,
    entities: val.entities,
  }))
}

module.exports = { generateGameScaffold, getGameTypes, GAME_TYPES }
