'use strict';

// ===== Constants =====
const MAX_LIVES = 3;
const MAX_CARDS = 3;
const DRAG_THRESHOLD_RATIO = 0.25; // fraction of wrapper width
const SPAWN_INTERVAL_BASE = 2000;  // ms between spawns at start
const SPAWN_INTERVAL_MIN  = 900;
const SPEED_BASE = 60;  // px/s
const SPEED_MAX  = 200;
const SPEED_RAMP = 8;   // px/s per correct answer

// ===== DOM refs =====
const wrapper      = document.getElementById('game-wrapper');
const startScreen  = document.getElementById('start-screen');
const gameScreen   = document.getElementById('game-screen');
const gameoverScreen = document.getElementById('gameover-screen');
const field        = document.getElementById('field');
const scoreEl      = document.getElementById('score');
const livesEl      = document.getElementById('lives');
const hiScoreValEl = document.getElementById('hi-score-val');
const finalScoreEl = document.getElementById('final-score');
const finalHiEl    = document.getElementById('final-hi');
const missFlash    = document.getElementById('miss-flash');
const correctFlash = document.getElementById('correct-flash');
const canvas       = document.getElementById('particle-canvas');
const ctx          = canvas.getContext('2d');

// ===== State =====
let score = 0;
let lives = MAX_LIVES;
let hiScore = parseInt(localStorage.getItem('hiScore') || '0', 10);
let correctCount = 0;
let cards = [];       // active card objects
let spawnTimer = null;
let animFrameId = null;
let lastTime = 0;
let gameRunning = false;

// ===== Audio =====
const sounds = {};

function tryLoadSound(key, src) {
  const audio = new Audio();
  audio.preload = 'auto';
  audio.src = src;
  audio.onerror = () => { /* silently ignore missing asset */ };
  sounds[key] = audio;
}

tryLoadSound('correct', 'assets/correct.mp3');
tryLoadSound('wrong',   'assets/wrong.mp3');
tryLoadSound('bgm',     'assets/bgm.mp3');

function playSound(key) {
  const snd = sounds[key];
  if (!snd) return;
  // Clone so overlapping plays work
  try {
    const clone = snd.cloneNode();
    clone.volume = key === 'bgm' ? 0.4 : 0.7;
    clone.play().catch(() => {});
  } catch (_) {}
}

function startBgm() {
  const bgm = sounds['bgm'];
  if (!bgm) return;
  bgm.loop = true;
  bgm.volume = 0.4;
  bgm.currentTime = 0;
  bgm.play().catch(() => {});
}

function stopBgm() {
  const bgm = sounds['bgm'];
  if (!bgm) return;
  bgm.pause();
  bgm.currentTime = 0;
}

// ===== Canvas resize =====
function resizeCanvas() {
  canvas.width  = wrapper.offsetWidth;
  canvas.height = wrapper.offsetHeight;
}
resizeCanvas();

// ===== Particles =====
let particles = [];

function spawnParticles(x, y, color) {
  const count = 18;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const speed = 120 + Math.random() * 140;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      alpha: 1,
      size: 5 + Math.random() * 6,
      color,
      life: 0,
      maxLife: 0.55 + Math.random() * 0.2,
    });
  }
}

function updateParticles(dt) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  particles = particles.filter(p => p.life < p.maxLife);
  for (const p of particles) {
    p.life += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 200 * dt; // gravity
    p.alpha = 1 - p.life / p.maxLife;
    ctx.save();
    ctx.globalAlpha = p.alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (1 - p.life / p.maxLife * 0.5), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ===== Screen helpers =====
function showScreen(screen) {
  [startScreen, gameScreen, gameoverScreen].forEach(s => s.classList.remove('active'));
  screen.classList.add('active');
}

// ===== HUD =====
function updateLivesDisplay() {
  livesEl.textContent = '❤️'.repeat(Math.max(0, lives)) + '🖤'.repeat(Math.max(0, MAX_LIVES - lives));
}

function updateScore() {
  scoreEl.textContent = score;
}

// ===== Card object =====
function createCard() {
  const texts  = ['左', '右'];
  const colors = ['black', 'red'];
  const text  = texts[Math.floor(Math.random() * 2)];
  const color = colors[Math.floor(Math.random() * 2)];

  // Correct drag direction
  // black: drag matches text; red: drag is opposite
  let correctDir;
  if (color === 'black') {
    correctDir = text === '左' ? 'left' : 'right';
  } else {
    correctDir = text === '左' ? 'right' : 'left';
  }

  const fieldWidth  = field.offsetWidth;
  const cardSize = 110;
  const margin = 20;
  const x = margin + Math.random() * (fieldWidth - cardSize - margin * 2);
  const y = -cardSize;

  // Speed increases with correct answers
  const speed = Math.min(SPEED_BASE + correctCount * SPEED_RAMP, SPEED_MAX);

  // DOM element
  const el = document.createElement('div');
  el.className = `card color-${color}`;
  el.style.left = x + 'px';
  el.style.top  = y + 'px';
  el.innerHTML  = `<span class="card-text">${text}</span>`;
  field.appendChild(el);

  const card = { el, x, y, text, color, correctDir, speed, resolved: false };
  attachDrag(card);
  return card;
}

// ===== Drag logic =====
function attachDrag(card) {
  const el = card.el;
  let startX = 0, startY = 0;
  let originLeft = 0, originTop = 0;
  let dragging = false;

  const THRESHOLD = wrapper.offsetWidth * DRAG_THRESHOLD_RATIO;

  function onDragStart(clientX, clientY) {
    if (card.resolved) return;
    dragging = true;
    startX = clientX;
    startY = clientY;
    originLeft = card.x;
    originTop  = card.y;
    el.classList.add('dragging');
  }

  function onDragMove(clientX, clientY) {
    if (!dragging || card.resolved) return;
    const dx = clientX - startX;
    const dy = clientY - startY;
    el.style.left = (originLeft + dx) + 'px';
    el.style.top  = (originTop  + dy) + 'px';
  }

  function onDragEnd(clientX) {
    if (!dragging || card.resolved) return;
    dragging = false;
    el.classList.remove('dragging');
    const dx = clientX - startX;

    if (Math.abs(dx) >= THRESHOLD) {
      const dir = dx < 0 ? 'left' : 'right';
      resolveCard(card, dir, originLeft, originTop);
    } else {
      // snap back
      el.style.left = card.x + 'px';
      el.style.top  = card.y + 'px';
    }
  }

  // Mouse
  el.addEventListener('mousedown', e => {
    e.preventDefault();
    onDragStart(e.clientX, e.clientY);
    const onMove = e2 => onDragMove(e2.clientX, e2.clientY);
    const onUp   = e2 => { onDragEnd(e2.clientX); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  });

  // Touch
  el.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.touches[0];
    onDragStart(t.clientX, t.clientY);
  }, { passive: false });

  el.addEventListener('touchmove', e => {
    e.preventDefault();
    const t = e.touches[0];
    onDragMove(t.clientX, t.clientY);
  }, { passive: false });

  el.addEventListener('touchend', e => {
    e.preventDefault();
    const t = e.changedTouches[0];
    onDragEnd(t.clientX);
  }, { passive: false });
}

// ===== Resolve card (correct / wrong) =====
function resolveCard(card, dir, fromLeft, fromTop) {
  if (card.resolved) return;
  card.resolved = true;

  const correct = dir === card.correctDir;
  const el = card.el;
  const flyX = dir === 'left' ? -500 : 500;

  el.classList.add('fly-out');
  el.style.transition = 'transform 0.35s cubic-bezier(0.25,0.46,0.45,0.94), opacity 0.35s ease';
  el.style.transform  = `translateX(${flyX}px) rotate(${dir === 'left' ? -30 : 30}deg)`;
  el.style.opacity    = '0';

  if (correct) {
    score++;
    correctCount++;
    updateScore();
    playSound('correct');

    // Particle burst at card center (relative to wrapper)
    const fieldRect   = field.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const cx = fieldRect.left - wrapperRect.left + parseFloat(el.style.left) + 55;
    const cy = fieldRect.top  - wrapperRect.top  + parseFloat(el.style.top)  + 55;
    const pColor = card.color === 'red' ? '#ff6666' : '#88ddff';
    spawnParticles(cx, cy, pColor);

    correctFlash.classList.remove('active');
    void correctFlash.offsetWidth;
    correctFlash.classList.add('active');
  } else {
    playSound('wrong');
    loseLife();
  }

  setTimeout(() => {
    if (el.parentNode) el.parentNode.removeChild(el);
    cards = cards.filter(c => c !== card);
  }, 400);
}

// ===== Miss (card fell off bottom) =====
function cardFell(card) {
  if (card.resolved) return;
  card.resolved = true;

  const el = card.el;
  el.classList.add('fall-out');

  playSound('wrong');
  loseLife();

  setTimeout(() => {
    if (el.parentNode) el.parentNode.removeChild(el);
    cards = cards.filter(c => c !== card);
  }, 500);
}

// ===== Lose a life =====
function loseLife() {
  lives--;
  updateLivesDisplay();

  // Flash + shake
  missFlash.classList.remove('active');
  void missFlash.offsetWidth;
  missFlash.classList.add('active');

  wrapper.classList.remove('shake');
  void wrapper.offsetWidth;
  wrapper.classList.add('shake');

  if (lives <= 0) {
    setTimeout(endGame, 350);
  }
}

// ===== Spawn scheduler =====
function scheduleSpawn() {
  if (!gameRunning) return;
  // Interval shrinks as correctCount grows
  const interval = Math.max(SPAWN_INTERVAL_MIN, SPAWN_INTERVAL_BASE - correctCount * 40);
  spawnTimer = setTimeout(() => {
    if (!gameRunning) return;
    if (cards.length < MAX_CARDS) {
      cards.push(createCard());
    }
    scheduleSpawn();
  }, interval);
}

// ===== Main game loop =====
function gameLoop(timestamp) {
  if (!gameRunning) return;
  const dt = Math.min((timestamp - lastTime) / 1000, 0.1);
  lastTime = timestamp;

  const fieldHeight = field.offsetHeight;

  for (const card of cards) {
    if (card.resolved) continue;
    card.y += card.speed * dt;
    card.el.style.top = card.y + 'px';

    if (card.y > fieldHeight) {
      cardFell(card);
    }
  }

  updateParticles(dt);
  animFrameId = requestAnimationFrame(gameLoop);
}

// ===== Start Game =====
function startGame() {
  score = 0;
  lives = MAX_LIVES;
  correctCount = 0;
  cards = [];
  particles = [];
  field.innerHTML = '';

  updateScore();
  updateLivesDisplay();
  hiScoreValEl.textContent = hiScore;

  gameRunning = true;
  showScreen(gameScreen);
  startBgm();

  lastTime = performance.now();
  animFrameId = requestAnimationFrame(gameLoop);

  // First card immediately
  cards.push(createCard());
  scheduleSpawn();
}

// ===== End Game =====
function endGame() {
  gameRunning = false;
  clearTimeout(spawnTimer);
  cancelAnimationFrame(animFrameId);
  stopBgm();

  if (score > hiScore) {
    hiScore = score;
    localStorage.setItem('hiScore', hiScore);
  }

  finalScoreEl.textContent = score;
  finalHiEl.textContent    = hiScore;
  showScreen(gameoverScreen);
}

// ===== Button wiring =====
document.getElementById('start-btn').addEventListener('click', () => {
  startGame();
});

document.getElementById('retry-btn').addEventListener('click', () => {
  startGame();
});

// ===== Init =====
hiScoreValEl.textContent = hiScore;
showScreen(startScreen);
