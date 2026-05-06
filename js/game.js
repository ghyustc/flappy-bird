// ============================================================
// Flappy Bird — 完整游戏逻辑（含音效、暂停、侧面板联动）
// ============================================================

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const W = canvas.width;   // 400
const H = canvas.height;  // 700

// ---- 游戏配置 ----
const CONFIG = {
  gravity: 0.38,
  flapStrength: -7.0,
  birdX: 100,
  birdRadius: 18,
  pipeWidth: 58,
  pipeGap: 175,
  pipeSpeed: 1.7,
  pipeInterval: 125,
  groundHeight: 80,
  ceilingHeight: 0,
  maxRotation: Math.PI / 4,
  speedIncrement: 0.1,
  minPipeGap: 105,
  gapDecrement: 1.5,
  cloudCount: 5,
};

// ---- 游戏状态 ----
const STATE = { START: 'start', PLAYING: 'playing', GAMEOVER: 'gameover' };
let gameState = STATE.START;
let score = 0;
let highScore = parseInt(localStorage.getItem('flappyHighScore') || '0', 10);
let frameCount = 0;
let shakeTimer = 0;
let currentGap = CONFIG.pipeGap;
let currentSpeed = CONFIG.pipeSpeed;
let paused = false;
let timeScale = 1.0;
let soundOn = true;

// ---- Firebase REST API ----
const DB_URL = 'https://flappy-bird-1bf2e-default-rtdb.firebaseio.com';

// ---- 排行榜 ----
let leaderboardData = [];
let leaderboardLoading = false;
let inputName = '';
let isEnteringName = false;
const MAX_NAME_LEN = 3;
const LEADERBOARD_SIZE = 10;
let playerName = localStorage.getItem('flappyPlayerName') || '';

function savePlayerName(n) {
  playerName = n;
  localStorage.setItem('flappyPlayerName', n);
  updateLeaderboardDOM();
}

async function loadLeaderboard() {
  leaderboardLoading = true;
  try {
    const resp = await fetch(
      `${DB_URL}/leaderboard.json?orderBy=%22score%22&limitToLast=${LEADERBOARD_SIZE}`
    );
    const data = await resp.json();
    leaderboardData = data
      ? Object.values(data).sort((a, b) => b.score - a.score)
      : [];
  } catch (_) {
    // 网络错误则静默，保留缓存数据
  }
  leaderboardLoading = false;
  updateLeaderboardDOM();
}

function updateLeaderboardDOM() {
  const listEl = document.getElementById('leaderboard-list');
  const idEl = document.getElementById('player-id-value');
  if (!listEl) return;

  if (leaderboardData.length === 0) {
    listEl.innerHTML = '<div class="lb-placeholder">暂无数据</div>';
  } else {
    const maxShow = Math.min(LEADERBOARD_SIZE, leaderboardData.length);
    let html = '';
    for (let i = 0; i < maxShow; i++) {
      const e = leaderboardData[i];
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
      html += `<div class="lb-entry top-${i < 3 ? i : ''}">
        <span class="lb-rank">${medal}</span>
        <span class="lb-name">${e.name}</span>
        <span class="lb-score">${e.score}</span>
      </div>`;
    }
    listEl.innerHTML = html;
  }

  if (idEl) {
    idEl.textContent = playerName || '未设置';
  }
}

function isTopScore(s) {
  if (leaderboardData.length < LEADERBOARD_SIZE) return s > 0;
  return s > leaderboardData[leaderboardData.length - 1].score;
}

async function submitScore(name, s) {
  try {
    await fetch(`${DB_URL}/leaderboard.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, score: s, createdAt: Date.now() }),
    });
  } catch (_) {
    // 提交失败静默
  }
}

function resetNameInput() {
  inputName = playerName || '';
  isEnteringName = false;
}

// ---- 面板 DOM 缓存 ----
let lastPanelScore = -1;
let lastPanelBest = -1;

// ---- 游戏对象 ----
let bird;
let pipes;
let clouds;

// ============================================================
// SoundManager — Web Audio API 合成音效
// ============================================================
class SoundManager {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (_) {
      // 不支持 Web Audio API 则静默
    }
  }

  _play(oscType, freqStart, freqEnd, duration, gainLevel) {
    if (!soundOn || !this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = oscType;
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    const t = this.ctx.currentTime;
    osc.frequency.setValueAtTime(freqStart, t);
    osc.frequency.linearRampToValueAtTime(freqEnd, t + duration);
    gain.gain.setValueAtTime(gainLevel, t);
    gain.gain.linearRampToValueAtTime(0, t + duration);
    osc.start(t);
    osc.stop(t + duration);
  }

  flap() {
    this._play('sine', 300, 600, 0.08, 0.25);
  }

  score() {
    if (!soundOn || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc1.type = 'square';
    osc2.type = 'square';
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(this.ctx.destination);
    osc1.frequency.setValueAtTime(523, t);
    osc2.frequency.setValueAtTime(659, t + 0.1);
    gain.gain.setValueAtTime(0.2, t);
    gain.gain.setValueAtTime(0.2, t + 0.1);
    gain.gain.linearRampToValueAtTime(0, t + 0.25);
    osc1.start(t);
    osc1.stop(t + 0.12);
    osc2.start(t + 0.1);
    osc2.stop(t + 0.25);
  }

  hit() {
    this._play('sawtooth', 150, 50, 0.3, 0.35);
  }
}

const sound = new SoundManager();

// ============================================================
// Bird 类
// ============================================================
class Bird {
  constructor() {
    this.reset();
  }

  reset() {
    this.x = CONFIG.birdX;
    this.y = H / 2;
    this.velocity = 0;
    this.rotation = 0;
    this.wingPhase = 0;
    this.alive = true;
  }

  flap() {
    if (!this.alive) return;
    this.velocity = CONFIG.flapStrength;
    this.wingPhase = 0;
  }

  update() {
    if (!this.alive) {
      this.velocity += CONFIG.gravity * timeScale;
      this.y += this.velocity * timeScale;
      this.rotation = Math.min(this.rotation + 0.08 * timeScale, Math.PI / 2);
      return;
    }

    this.velocity += CONFIG.gravity * timeScale;
    this.y += this.velocity * timeScale;

    const targetRotation = this.velocity * 0.08;
    this.rotation += (targetRotation - this.rotation) * 0.12 * timeScale;

    this.wingPhase += 0.25 * timeScale;

    if (this.y - CONFIG.birdRadius <= CONFIG.ceilingHeight ||
        this.y + CONFIG.birdRadius >= H - CONFIG.groundHeight) {
      this.die();
    }
  }

  die() {
    if (!this.alive) return;
    this.alive = false;
    this.velocity = -5;
    shakeTimer = 15;
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);

    const r = CONFIG.birdRadius;

    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.beginPath();
    ctx.arc(1, 2, r, 0, Math.PI * 2);
    ctx.fill();

    const bodyGrad = ctx.createLinearGradient(0, -r, 0, r);
    bodyGrad.addColorStop(0, '#ffd700');
    bodyGrad.addColorStop(0.5, '#ffb800');
    bodyGrad.addColorStop(1, '#ff8c00');
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#cc7000';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const wingFlap = Math.sin(this.wingPhase) * 6;
    ctx.fillStyle = '#ffe066';
    ctx.beginPath();
    ctx.ellipse(-3, wingFlap, r * 0.7, r * 0.4, 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ddaa00';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(6, -5, r * 0.42, r * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(8, -5, r * 0.18, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(9, -6, r * 0.07, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.moveTo(r * 0.7, -3);
    ctx.lineTo(r * 1.4, 2);
    ctx.lineTo(r * 0.7, 5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#cc0000';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
  }
}

// ============================================================
// Pipe 类
// ============================================================
class Pipe {
  constructor(x, topHeight, gap) {
    this.x = x;
    this.topHeight = topHeight;
    this.gap = gap;
    this.passed = false;
    this.width = CONFIG.pipeWidth;
    this.speed = CONFIG.pipeSpeed;
  }

  update(speed) {
    this.x -= speed * timeScale;
  }

  isOffScreen() {
    return this.x + this.width < 0;
  }

  draw(ctx) {
    const bottomPipeY = this.topHeight + this.gap;
    const w = this.width;
    const capHeight = 25;
    const capOverhang = 5;

    this.drawPipeBody(ctx, this.x, 0, w, this.topHeight);
    this.drawPipeCap(ctx, this.x - capOverhang, this.topHeight - capHeight, w + capOverhang * 2, capHeight);
    ctx.fillStyle = '#2d8a2d';
    ctx.fillRect(this.x - 1, this.topHeight - 3, w + 2, 4);

    this.drawPipeBody(ctx, this.x, bottomPipeY, w, H - CONFIG.groundHeight - bottomPipeY);
    this.drawPipeCap(ctx, this.x - capOverhang, bottomPipeY, w + capOverhang * 2, capHeight);
    ctx.fillStyle = '#2d8a2d';
    ctx.fillRect(this.x - 1, bottomPipeY - 1, w + 2, 4);
  }

  drawPipeBody(ctx, x, y, w, h) {
    if (h <= 0) return;
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, '#3cb043');
    grad.addColorStop(0.3, '#5edc5e');
    grad.addColorStop(0.7, '#3cb043');
    grad.addColorStop(1, '#2a8a2a');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 8, y);
    ctx.lineTo(x + 8, y + h);
    ctx.stroke();
  }

  drawPipeCap(ctx, x, y, w, h) {
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, '#48c048');
    grad.addColorStop(0.3, '#6ee86e');
    grad.addColorStop(0.7, '#48c048');
    grad.addColorStop(1, '#2d8a2d');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);

    ctx.strokeStyle = '#1a601a';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);
  }
}

// ============================================================
// PipeManager
// ============================================================
class PipeManager {
  constructor() {
    this.pipes = [];
    this.spawnTimer = 0;
  }

  reset() {
    this.pipes = [];
    this.spawnTimer = 0;
  }

  update(speed) {
    this.spawnTimer += timeScale;
    if (this.spawnTimer >= CONFIG.pipeInterval) {
      this.spawnTimer = 0;
      this.spawnPipe();
    }

    for (let i = this.pipes.length - 1; i >= 0; i--) {
      this.pipes[i].update(speed);
      if (this.pipes[i].isOffScreen()) {
        this.pipes.splice(i, 1);
      }
    }
  }

  spawnPipe() {
    const minTop = 60;
    const maxTop = H - CONFIG.groundHeight - currentGap - 60;
    const topHeight = minTop + Math.random() * (maxTop - minTop);
    this.pipes.push(new Pipe(W, topHeight, currentGap));
  }

  checkCollision(bird) {
    const br = CONFIG.birdRadius;
    for (const pipe of this.pipes) {
      if (this.circleRectCollision(
        bird.x, bird.y, br,
        pipe.x, 0, pipe.width, pipe.topHeight
      )) return true;

      const bottomY = pipe.topHeight + pipe.gap;
      if (this.circleRectCollision(
        bird.x, bird.y, br,
        pipe.x, bottomY, pipe.width, H - CONFIG.groundHeight - bottomY
      )) return true;
    }
    return false;
  }

  circleRectCollision(cx, cy, r, rx, ry, rw, rh) {
    const closestX = Math.max(rx, Math.min(cx, rx + rw));
    const closestY = Math.max(ry, Math.min(cy, ry + rh));
    const dx = cx - closestX;
    const dy = cy - closestY;
    return dx * dx + dy * dy < r * r;
  }

  checkScore(birdX) {
    for (const pipe of this.pipes) {
      if (!pipe.passed && pipe.x + pipe.width < birdX) {
        pipe.passed = true;
        return true;
      }
    }
    return false;
  }

  draw(ctx) {
    for (const pipe of this.pipes) {
      pipe.draw(ctx);
    }
  }
}

// ============================================================
// Cloud — 装饰背景云
// ============================================================
class Cloud {
  constructor() {
    this.reset(true);
  }

  reset(initial) {
    this.x = initial ? Math.random() * W : W + 40;
    this.y = 30 + Math.random() * 200;
    this.speed = 0.3 + Math.random() * 0.5;
    this.scale = 0.6 + Math.random() * 0.8;
    this.opacity = 0.3 + Math.random() * 0.4;
  }

  update() {
    this.x -= this.speed * timeScale;
    if (this.x < -80) this.reset(false);
  }

  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.fillStyle = '#fff';
    const s = this.scale;
    ctx.beginPath();
    ctx.arc(this.x, this.y, 22 * s, 0, Math.PI * 2);
    ctx.arc(this.x + 22 * s, this.y - 5 * s, 16 * s, 0, Math.PI * 2);
    ctx.arc(this.x + 40 * s, this.y, 20 * s, 0, Math.PI * 2);
    ctx.arc(this.x + 18 * s, this.y + 6 * s, 14 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// ============================================================
// 初始化 / 重置
// ============================================================
function init() {
  bird = new Bird();
  pipes = new PipeManager();
  clouds = [];
  for (let i = 0; i < CONFIG.cloudCount; i++) {
    clouds.push(new Cloud());
  }
  score = 0;
  frameCount = 0;
  currentGap = CONFIG.pipeGap;
  currentSpeed = CONFIG.pipeSpeed;
  paused = false;
  lastPanelScore = -1;
}

function resetGame() {
  resetNameInput();
  init();
  gameState = STATE.PLAYING;
}

function enterGameOverCheck() {
  if (isEnteringName || leaderboardLoading) return;
  if (!isTopScore(score)) return;
  if (playerName) {
    submitScore(playerName, score);
    loadLeaderboard();
  } else {
    isEnteringName = true;
    inputName = '';
  }
}

// ============================================================
// 坐标转换（CSS 缩放 → Canvas 内部坐标）
// ============================================================
function getCanvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = W / rect.width;
  const scaleY = H / rect.height;
  const cx = e.touches ? e.touches[0].clientX : e.clientX;
  const cy = e.touches ? e.touches[0].clientY : e.clientY;
  return {
    x: (cx - rect.left) * scaleX,
    y: (cy - rect.top) * scaleY,
  };
}

// ---- UI 按钮区域常量 ----
const BTN_SOUND = { x: 310, y: 8, w: 34, h: 34 };
const BTN_PAUSE = { x: 354, y: 8, w: 34, h: 34 };

function rectContains(btn, px, py) {
  return px >= btn.x && px <= btn.x + btn.w && py >= btn.y && py <= btn.y + btn.h;
}

// ============================================================
// UI 按钮绘制（Canvas 上）
// ============================================================
function fillRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawSoundBtn(ctx) {
  const { x, y, w, h } = BTN_SOUND;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1.5;
  fillRoundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.stroke();

  // 喇叭主体
  ctx.fillStyle = '#fff';
  ctx.fillRect(x + 7, y + 10, 6, h - 20);
  // 喇叭锥形
  ctx.beginPath();
  ctx.moveTo(x + 13, y + 10);
  ctx.lineTo(x + 21, y + 5);
  ctx.lineTo(x + 21, y + h - 5);
  ctx.lineTo(x + 13, y + h - 10);
  ctx.closePath();
  ctx.fill();

  if (soundOn) {
    // 声波弧线
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x + 24, y + h / 2, 5, -0.6, 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 24, y + h / 2, 9, -0.5, 0.5);
    ctx.stroke();
  } else {
    // X 标记
    ctx.strokeStyle = '#ff6666';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 23, y + 9);
    ctx.lineTo(x + 31, y + h - 9);
    ctx.moveTo(x + 31, y + 9);
    ctx.lineTo(x + 23, y + h - 9);
    ctx.stroke();
  }
}

function drawPauseBtn(ctx) {
  const { x, y, w, h } = BTN_PAUSE;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1.5;
  fillRoundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#fff';
  if (paused) {
    // 播放三角
    ctx.beginPath();
    ctx.moveTo(x + 12, y + 8);
    ctx.lineTo(x + 12, y + h - 8);
    ctx.lineTo(x + w - 10, y + h / 2);
    ctx.closePath();
    ctx.fill();
  } else {
    // 暂停双竖线
    ctx.fillRect(x + 10, y + 9, 5, h - 18);
    ctx.fillRect(x + 19, y + 9, 5, h - 18);
  }
}

function drawPauseOverlay(ctx) {
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 36px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('已暂停', W / 2, H / 2 - 10);

  ctx.font = '14px Arial';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText('按 P 或点击暂停键继续', W / 2, H / 2 + 20);
}

// ============================================================
// 面板 DOM 更新
// ============================================================
function updatePanelDOM() {
  const scoreEl = document.getElementById('panel-score');
  const bestEl = document.getElementById('panel-best');
  if (!scoreEl || !bestEl) return;

  if (lastPanelScore !== score) {
    scoreEl.textContent = score;
    scoreEl.classList.add('pop');
    setTimeout(() => scoreEl.classList.remove('pop'), 150);
    lastPanelScore = score;
  }
  if (lastPanelBest !== highScore) {
    bestEl.textContent = highScore;
    lastPanelBest = highScore;
  }
}

function updateSoundBtnDOM() {
  const btn = document.getElementById('sound-btn');
  if (!btn) return;
  const icon = btn.querySelector('.sound-icon');
  const label = btn.querySelector('.sound-label');
  if (soundOn) {
    btn.classList.remove('muted');
    icon.textContent = '🔊';
    label.textContent = '音效已开启';
  } else {
    btn.classList.add('muted');
    icon.textContent = '🔇';
    label.textContent = '音效已关闭';
  }
}

// ============================================================
// 音效开关
// ============================================================
function toggleSound() {
  soundOn = !soundOn;
  updateSoundBtnDOM();
}

function togglePause() {
  if (gameState !== STATE.PLAYING) return;
  paused = !paused;
}

// ============================================================
// 输入处理（统一路由：先检查 UI 按钮，再走游戏逻辑）
// ============================================================
function onCanvasInput(e) {
  e.preventDefault();
  sound.init();

  const { x, y } = getCanvasCoords(e);

  // 音效按钮（全局可用）
  if (rectContains(BTN_SOUND, x, y)) {
    toggleSound();
    return;
  }

  // 暂停按钮（仅 PLAYING 状态可用）
  if (gameState === STATE.PLAYING && rectContains(BTN_PAUSE, x, y)) {
    togglePause();
    return;
  }

  // 名字输入模式下，点击不做游戏操作
  if (isEnteringName) return;

  // 游戏输入
  switch (gameState) {
    case STATE.START:
      loadLeaderboard();
      resetGame();
      break;
    case STATE.PLAYING:
      if (!paused) {
        bird.flap();
        sound.flap();
      }
      break;
    case STATE.GAMEOVER:
      loadLeaderboard();
      init();
      gameState = STATE.START;
      break;
  }
}

canvas.addEventListener('click', onCanvasInput);
canvas.addEventListener('touchstart', onCanvasInput, { passive: false });

document.addEventListener('keydown', (e) => {
  // 名字输入模式下，拦截键盘输入
  if (isEnteringName) {
    e.preventDefault();
    if (e.code === 'Enter') {
      if (inputName.length > 0) {
        savePlayerName(inputName);
        submitScore(inputName, score);
        loadLeaderboard();
        resetNameInput();
        gameState = STATE.START;
      }
      return;
    }
    if (e.code === 'Backspace') {
      inputName = inputName.slice(0, -1);
      return;
    }
    if (inputName.length < MAX_NAME_LEN && /^Key[A-Z]$/.test(e.code)) {
      inputName += e.code.slice(-1);
      return;
    }
    if (inputName.length < MAX_NAME_LEN && /^Digit[0-9]$/.test(e.code)) {
      inputName += e.code.slice(-1);
      return;
    }
    return;
  }

  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
    e.preventDefault();
    sound.init();
    switch (gameState) {
      case STATE.START:
        loadLeaderboard();
        resetGame();
        break;
      case STATE.PLAYING:
        if (!paused) {
          bird.flap();
          sound.flap();
        }
        break;
      case STATE.GAMEOVER:
        loadLeaderboard();
        init();
        gameState = STATE.START;
        break;
    }
  }

  if (e.code === 'KeyM' && gameState === STATE.START) {
    e.preventDefault();
    sound.init();
    playerName = '';
    localStorage.removeItem('flappyPlayerName');
    inputName = '';
    updateLeaderboardDOM();
    return;
  }

  if (e.code === 'KeyP') {
    e.preventDefault();
    togglePause();
  }

  if (e.code === 'KeyM') {
    e.preventDefault();
    toggleSound();
  }
});

// 侧面板音效按钮点击
document.getElementById('sound-btn').addEventListener('click', (e) => {
  e.preventDefault();
  sound.init();
  toggleSound();
});

// ============================================================
// 背景绘制
// ============================================================
function drawSky() {
  const grad = ctx.createLinearGradient(0, 0, 0, H - CONFIG.groundHeight);
  grad.addColorStop(0, '#87CEEB');
  grad.addColorStop(0.6, '#b8e4f0');
  grad.addColorStop(1, '#e0f0e0');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H - CONFIG.groundHeight);
}

function drawGround() {
  const groundY = H - CONFIG.groundHeight;

  const grad = ctx.createLinearGradient(0, groundY, 0, H);
  grad.addColorStop(0, '#d4a853');
  grad.addColorStop(0.15, '#c4963e');
  grad.addColorStop(1, '#8b6914');
  ctx.fillStyle = grad;
  ctx.fillRect(0, groundY, W, CONFIG.groundHeight);

  ctx.fillStyle = '#6dbd3a';
  ctx.fillRect(0, groundY, W, 8);

  const grassGrad = ctx.createLinearGradient(0, groundY, 0, groundY + 8);
  grassGrad.addColorStop(0, '#7dcd4a');
  grassGrad.addColorStop(1, '#4d9d1a');
  ctx.fillStyle = grassGrad;
  ctx.fillRect(0, groundY, W, 8);

  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 1;
  for (let y = groundY + 15; y < H; y += 15) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
}

function drawStartScreen() {
  ctx.fillStyle = 'rgba(0,0,0,0.1)';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 4;
  ctx.font = 'bold 42px Arial';
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 8;
  ctx.strokeText('Flappy Bird', W / 2, 200);
  ctx.fillText('Flappy Bird', W / 2, 200);
  ctx.restore();

  bird.draw(ctx);

  ctx.fillStyle = '#fff';
  ctx.font = '18px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('点击 / 空格键 开始', W / 2, 320);

  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '14px Arial';
  ctx.fillText(`最高分: ${highScore}`, W / 2, 350);

  drawLeaderboardOnStart();
}

function drawGameOverScreen() {
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, 0, W, H);

  const panelW = 240;
  const panelH = 200;
  const panelX = (W - panelW) / 2;
  const panelY = 200;

  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  const r = 12;
  ctx.beginPath();
  ctx.moveTo(panelX + r, panelY);
  ctx.lineTo(panelX + panelW - r, panelY);
  ctx.quadraticCurveTo(panelX + panelW, panelY, panelX + panelW, panelY + r);
  ctx.lineTo(panelX + panelW, panelY + panelH - r);
  ctx.quadraticCurveTo(panelX + panelW, panelY + panelH, panelX + panelW - r, panelY + panelH);
  ctx.lineTo(panelX + r, panelY + panelH);
  ctx.quadraticCurveTo(panelX, panelY + panelH, panelX, panelY + panelH - r);
  ctx.lineTo(panelX, panelY + r);
  ctx.quadraticCurveTo(panelX, panelY, panelX + r, panelY);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ff6666';
  ctx.font = 'bold 28px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('Game Over', W / 2, panelY + 40);

  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold 22px Arial';
  ctx.fillText(`得分: ${score}`, W / 2, panelY + 80);

  ctx.fillStyle = '#fff';
  ctx.font = '16px Arial';
  ctx.fillText(`最高分: ${highScore}`, W / 2, panelY + 110);

  if (playerName && isTopScore(score)) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '12px Arial';
    ctx.fillText('分数已自动上传', W / 2, panelY + 130);
  }

  ctx.fillStyle = '#fff';
  ctx.font = '15px Arial';
  ctx.fillText('点击返回主界面', W / 2, panelY + 155);
}

function drawNameInputScreen() {
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(0, 0, W, H);

  const panelW = 260;
  const panelH = 230;
  const panelX = (W - panelW) / 2;
  const panelY = 180;

  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.strokeStyle = '#ffd700';
  ctx.lineWidth = 2;
  const r = 12;
  ctx.beginPath();
  ctx.moveTo(panelX + r, panelY);
  ctx.lineTo(panelX + panelW - r, panelY);
  ctx.quadraticCurveTo(panelX + panelW, panelY, panelX + panelW, panelY + r);
  ctx.lineTo(panelX + panelW, panelY + panelH - r);
  ctx.quadraticCurveTo(panelX + panelW, panelY + panelH, panelX + panelW - r, panelY + panelH);
  ctx.lineTo(panelX + r, panelY + panelH);
  ctx.quadraticCurveTo(panelX, panelY + panelH, panelX, panelY + panelH - r);
  ctx.lineTo(panelX, panelY + r);
  ctx.quadraticCurveTo(panelX, panelY, panelX + r, panelY);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold 22px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('🏆 进入排行榜!', W / 2, panelY + 35);

  ctx.fillStyle = '#fff';
  ctx.font = '16px Arial';
  ctx.fillText(`得分: ${score}`, W / 2, panelY + 65);

  ctx.fillStyle = '#aaa';
  ctx.font = '13px Arial';
  ctx.fillText('输入你的名字 (3个字符)', W / 2, panelY + 95);

  // 输入框
  const inputW = 110;
  const inputH = 38;
  const inputX = (W - inputW) / 2;
  const inputY = panelY + 110;
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  fillRoundRect(ctx, inputX, inputY, inputW, inputH, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 24px Arial';
  ctx.textAlign = 'center';
  const displayName = inputName + '_'.repeat(MAX_NAME_LEN - inputName.length);
  ctx.fillText(displayName, W / 2, inputY + 28);

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '12px Arial';
  ctx.fillText('按 Enter 确认', W / 2, inputY + 58);
}

function drawLeaderboardOnStart() {
  if (leaderboardLoading) {
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('加载排行榜...', W / 2, 395);
    return;
  }
  if (leaderboardData.length === 0) return;

  const startY = 380;
  ctx.fillStyle = '#ffd700';
  ctx.font = 'bold 13px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('— 排行榜 TOP 5 —', W / 2, startY);

  ctx.font = '12px Arial';
  const maxShow = Math.min(5, leaderboardData.length);
  for (let i = 0; i < maxShow; i++) {
    const entry = leaderboardData[i];
    const y = startY + 20 + i * 20;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
    ctx.fillStyle = i < 3 ? '#ffd700' : 'rgba(255,255,255,0.6)';
    ctx.textAlign = 'left';
    ctx.fillText(`${medal}  ${entry.name}`, W / 2 - 50, y);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.textAlign = 'right';
    ctx.fillText(`${entry.score}`, W / 2 + 50, y);
  }

  // 玩家 ID 显示
  ctx.textAlign = 'center';
  if (playerName) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '11px Arial';
    ctx.fillText(`你的 ID: ${playerName}  (按 M 修改)`, W / 2, startY + 20 + maxShow * 20 + 18);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '11px Arial';
    ctx.fillText('首次进榜时设置你的 ID', W / 2, startY + 20 + maxShow * 20 + 14);
  }
}

function drawScore() {
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.font = 'bold 52px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(score, W / 2 + 2, 72);

  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 3;
  ctx.strokeText(score, W / 2, 70);
  ctx.fillText(score, W / 2, 70);
}

function drawShake() {
  if (shakeTimer > 0) {
    shakeTimer -= timeScale;
    const dx = (Math.random() - 0.5) * shakeTimer * 0.8;
    const dy = (Math.random() - 0.5) * shakeTimer * 0.8;
    ctx.translate(dx, dy);
  }
}

// ============================================================
// 主游戏循环
// ============================================================
let lastTimestamp = 0;

function gameLoop(timestamp) {
  if (lastTimestamp) {
    const dt = Math.min(timestamp - lastTimestamp, 50); // cap to prevent spiral
    timeScale = dt / (1000 / 60); // normalize to 60fps
  }
  lastTimestamp = timestamp;

  ctx.save();
  ctx.clearRect(0, 0, W, H);

  drawSky();

  // 云（暂停时也冻结动画）
  const shouldUpdate = !(gameState === STATE.PLAYING && paused);
  for (const cloud of clouds) {
    if (shouldUpdate) cloud.update();
    cloud.draw(ctx);
  }

  drawGround();
  drawShake();

  switch (gameState) {
    case STATE.START:
      pipes.draw(ctx);
      bird.update();
      bird.y = H / 2 + Math.sin(frameCount * 0.04) * 12;
      bird.rotation = Math.sin(frameCount * 0.04) * 0.15;
      bird.draw(ctx);
      drawScore();
      drawStartScreen();
      break;

    case STATE.PLAYING: {
      if (!paused) {
        currentSpeed = CONFIG.pipeSpeed + score * CONFIG.speedIncrement;

        pipes.update(currentSpeed);
        bird.update();

        if (pipes.checkCollision(bird)) {
          bird.die();
          sound.hit();
          gameState = STATE.GAMEOVER;
          if (score > highScore) {
            highScore = score;
            localStorage.setItem('flappyHighScore', highScore);
          }
          enterGameOverCheck();
        }

        if (!bird.alive && gameState === STATE.PLAYING) {
          sound.hit();
          gameState = STATE.GAMEOVER;
          if (score > highScore) {
            highScore = score;
            localStorage.setItem('flappyHighScore', highScore);
          }
          enterGameOverCheck();
        }

        if (bird.alive && pipes.checkScore(bird.x)) {
          score++;
          sound.score();
          currentGap = Math.max(CONFIG.minPipeGap, currentGap - CONFIG.gapDecrement);
        }
      }

      pipes.draw(ctx);
      bird.draw(ctx);
      drawScore();
      break;
    }

    case STATE.GAMEOVER:
      pipes.update(0);
      bird.update();

      pipes.draw(ctx);
      bird.draw(ctx);
      drawScore();
      if (isEnteringName) {
        drawNameInputScreen();
      } else {
        drawGameOverScreen();
      }
      break;
  }

  ctx.restore();

  // UI 按钮（不受震屏影响，始终在最上层）
  drawSoundBtn(ctx);
  if (gameState === STATE.PLAYING) {
    drawPauseBtn(ctx);
    if (paused) drawPauseOverlay(ctx);
  }

  updatePanelDOM();

  frameCount += timeScale;
  requestAnimationFrame(gameLoop);
}

// ============================================================
// 启动
// ============================================================
init();
updateSoundBtnDOM();
loadLeaderboard();
gameLoop();
