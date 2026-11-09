/* ===========================================================
   game.js —— 深空防线 / Deep Field（v2）
   与输入方式解耦：外部只调用 setPointer / press / release / nova，
   摄像头手势与键鼠走同一条接口。

   玩法骨架：
     星核在画面中心，敌人从椭圆边缘压向中心。
     玩家要守住星核，同时管理两种稀缺资源（护盾 / 能量）与
     每波一次的冲击波，并完成当波合约。
   =========================================================== */

function withAlpha(color, a) {
  if (!color) return color;

  if (color.charAt(0) === '#') {
    var h = color.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  if (color.indexOf('hsl(') === 0) return 'hsla(' + color.slice(4, -1) + ',' + a + ')';
  if (color.indexOf('rgba(') === 0) return color;
  if (color.indexOf('rgb(') === 0) return color.replace('rgb(', 'rgba(').replace(')', ',' + a + ')');
  return color;
}

const TAU = Math.PI * 2;

class DeepField {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.stars = [];

    this.onStats = null;   // 约 12 次/秒，刷新 HUD
    this.onEvent = null;   // 离散事件，给 HUD/横幅用
    this.onEnd = null;     // 结算回调

    this.time = 0;
    this.state = 'idle';   // idle | playing | break | won | lost | paused

    this.resize();
    this.reset();

    if (window.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
    window.addEventListener('resize', () => this.resize());
  }

  /* ===================== 尺寸与派生量 ===================== */

  get cx() { return this.w * 0.5; }
  get cy() { return this.h * 0.5; }
  get coreR() { return Math.max(30, Math.min(52, Math.min(this.w, this.h) * 0.085)); }
  get safeR() { return this.coreR * (CONFIG.safeDistanceR || 3.2); }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    // 1.5 倍已足够锐利，比 2 倍少渲染 44% 的像素，弱显卡上帧率差别明显
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const pxW = Math.round(rect.width * dpr);
    const pxH = Math.round(rect.height * dpr);

    if (this.canvas.width === pxW && this.canvas.height === pxH && this.dpr === dpr) return;

    const prevW = this.w;
    const prevH = this.h;

    this.dpr = dpr;
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 拉伸窗口时按比例搬动实体，避免敌人瞬间跑到画面外面
    if (prevW > 0 && prevH > 0 && this.enemies) {
      const sx = this.w / prevW;
      const sy = this.h / prevH;
      for (const e of this.enemies) { e.x *= sx; e.y *= sy; }
      if (this.aim) { this.aim.x *= sx; this.aim.y *= sy; }
    }

    this.stars = [];
    const count = Math.round((this.w * this.h) / 11000);
    for (let i = 0; i < count; i++) {
      this.stars.push({
        x: Math.random() * this.w,
        y: Math.random() * this.h,
        r: Math.random() * 1.3 + 0.35,
        a: Math.random() * 0.45 + 0.12,
        sp: 0.5 + Math.random() * 1.5
      });
    }
  }

  /* ===================== 生命周期 ===================== */

  reset() {
    this.enemies = [];
    this.particles = [];
    this.texts = [];
    this.rings = [];

    this.score = 0;
    this.shield = CONFIG.shield;
    this.maxShield = CONFIG.shield;
    this.energy = CONFIG.energy;
    this.maxEnergy = CONFIG.energyMax;
    this.novaCharges = 1;

    this.combo = 0;
    this.maxCombo = 0;
    this.comboTimer = 0;
    this.kills = 0;

    this.waveIndex = -1;
    this.waveTimer = 0;
    this.waveDuration = 0;
    this.spawnTimer = 0.6;
    this.breakTimer = 0;
    this.contract = null;
    this.contractsDone = 0;
    this.wave = this._blankWaveStats();

    this.running = false;
    this.pressing = false;
    this.pressTime = 0;
    this.charging = 0;
    this.pinching = false;
    this.pinchFlash = 0;
    this.fireFlash = 0;
    this.novaFlash = 0;
    this.shake = 0;
    this.hitStop = 0;
    this.damageFlash = 0;
    this.noEnergyFlash = 0;
    this.hoverIndex = -1;

    this.pointerNorm = { x: 0.5, y: 0.5 };
    this.aim = { x: this.w ? this.w * 0.5 : 400, y: this.h ? this.h * 0.5 : 260 };
    this.gesture = '指向';
    this._statTimer = 0;
    this._lastWaveAnnounce = -1;
  }

  _blankWaveStats() {
    return {
      kills: 0,
      decoyKilled: 0,
      stardustSpawned: 0,
      stardustKilled: 0,
      volatileSpawned: 0,
      volatileSafe: 0,
      lateKills: 0,
      score: 0
    };
  }

  start() {
    this.reset();
    this.running = true;
    this.state = 'playing';
    this._beginWave(0);
    this.emitStats();
  }

  pause() {
    if (this.state === 'playing' || this.state === 'break') {
      this._resumeState = this.state;
      this.state = 'paused';
      this.pressing = false;
      this.charging = 0;
      this._emit({ type: 'pause' });
    }
  }

  resume() {
    if (this.state === 'paused') {
      this.state = this._resumeState || 'playing';
      this.pressing = false;
      this.charging = 0;
    }
  }

  /* ===================== 输入接口 ===================== */

  setPointer(nx, ny) {
    this.pointerNorm.x = Math.min(1, Math.max(0, nx));
    this.pointerNorm.y = Math.min(1, Math.max(0, ny));
  }

  setGesture(label) {
    this.gesture = label || '指向';
  }

  press() {
    if (!this._isLive() || this.pressing) return;
    this.pressing = true;
    this.pressTime = 0;
    this.charging = 0;
    this.pinching = true;
    this.pinchFlash = 1;
  }

  release() {
    if (!this.pressing) return;
    this.pressing = false;
    this.pinching = false;

    const hold = this.pressTime;
    this.charging = 0;

    if (!this._isLive()) return;

    if (hold >= CONFIG.attack.lance.holdToCharge) this._fireLance();
    else this._firePulse();
  }

  nova() {
    if (!this._isLive()) return false;
    if (this.novaCharges <= 0) {
      this._emit({ type: 'novaEmpty' });
      this.addText(this.aim.x, this.aim.y - 34, '冲击波已用尽', '#ff9d92');
      return false;
    }
    this.novaCharges--;

    const x = this.aim.x;
    const y = this.aim.y;
    this.rings.push({ x, y, r: 12, max: CONFIG.attack.nova.radius, w: 1.4, color: '#7fe3c4' });
    this.rings.push({ x, y, r: 4, max: CONFIG.attack.nova.radius * 0.72, w: 3.2, color: '#d9fff4' });
    this.shake = Math.max(this.shake, 0.4);
    this.novaFlash = 1;

    let hit = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      const d = Math.hypot(e.x - x, e.y - y);
      if (d > CONFIG.attack.nova.radius + e.r) continue;

      // 冲击波把目标推离星核：对爆裂体这是"救援"手段，而不是杀伤手段
      const ang = Math.atan2(e.y - this.cy, e.x - this.cx);
      e.x += Math.cos(ang) * CONFIG.attack.nova.knock * 0.55;
      e.y += Math.sin(ang) * CONFIG.attack.nova.knock * 0.55;
      e.dirAngle = null;
      e.pushed = 0.5;
      hit++;
      if (e.type !== 'volatile') this._damage(e, CONFIG.attack.nova.damage, 'nova');
      else this.addText(e.x, e.y - e.r - 12, '推开', '#7fe3c4');
    }

    this.addText(x, y - 40, '冲击波', '#b9ffef');
    this._emit({ type: 'nova', hit });
    this.emitStats();
    return true;
  }

  _isLive() {
    return this.state === 'playing' || this.state === 'break';
  }

  /* ===================== 攻击 ===================== */

  _firePulse() {
    const a = CONFIG.attack.pulse;
    if (this.energy < 3) { this._noEnergy(); return; }

    this.fireFlash = 1;
    const target = this._nearestTarget(this.aim.x, this.aim.y, a.radius + 16);

    if (!target) {
      this.energy = Math.max(0, this.energy - 3);   // 空挥也有代价，逼玩家瞄准
      this.rings.push({ x: this.aim.x, y: this.aim.y, r: 2, max: 26, w: 1, color: '#7f9fd0' });
      this.emitStats();
      return;
    }

    if (this.energy < a.cost) { this._noEnergy(); return; }
    this.energy -= a.cost;

    this.burst(target.x, target.y, CONFIG.types[target.type].color, 9, 150);
    this.rings.push({ x: target.x, y: target.y, r: 4, max: 40, w: 1.6, color: '#cfe4ff' });
    this._damage(target, a.damage, 'pulse');
    this.emitStats();
  }

  _fireLance() {
    const l = CONFIG.attack.lance;
    if (this.energy < l.cost) { this._noEnergy(); return; }

    const x = this.aim.x;
    const y = this.aim.y;
    this.energy -= l.cost;
    this.fireFlash = 1;
    this.shake = Math.max(this.shake, 0.16);
    this.rings.push({ x, y, r: 8, max: 62, w: 3, color: '#ffd489' });

    const targets = [];
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < l.radius + 34 + e.r) targets.push({ e, d });
    }
    targets.sort((p, q) => p.d - q.d);

    if (!targets.length) {
      this.burst(x, y, '#ffd489', 12, 130);
      this.emitStats();
      return;
    }

    // 主目标吃全额，溅射范围内的其余目标吃一半 —— 所以蓄能炮用来处理"扎堆"
    targets.forEach((t, idx) => {
      const dmg = idx === 0 ? l.damage + 1 : Math.max(1, Math.round(l.damage / 2));
      this.burst(t.e.x, t.e.y, '#ffd489', idx === 0 ? 14 : 6, 170);
      this._damage(t.e, dmg, 'lance');
    });

    if (targets.length > 1) {
      this.addText(x, y - 46, `穿透 ×${targets.length}`, '#ffd489');
    }
    this.emitStats();
  }

  _noEnergy() {
    this.noEnergyFlash = 1;
    this.addText(this.aim.x, this.aim.y - 30, '能量不足', '#ff9d92');
    this._emit({ type: 'noEnergy' });
  }

  _nearestTarget(x, y, pad) {
    let best = null;
    let bestD = Infinity;
    for (const e of this.enemies) {
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < e.r + pad && d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /* ===================== 伤害与死亡 ===================== */

  _damage(e, dmg, kind) {
    if (e.dead) return;
    e.hp -= dmg;
    e.hitFlash = 1;
    if (kind === 'lance') e.hitPulse = 1;

    if (e.hp <= 0) this._destroy(e, kind);
    else this.addText(e.x, e.y - e.r - 6, `-${dmg}`, '#e6f2ff');
  }

  _destroy(e, kind) {
    if (e.dead) return;
    e.dead = true;

    const idx = this.enemies.indexOf(e);
    if (idx >= 0) this.enemies.splice(idx, 1);

    const cfg = CONFIG.types[e.type];
    const mult = this.multiplier();
    const distCore = Math.hypot(e.x - this.cx, e.y - this.cy);

    /* ---- 诱饵：打错了要付代价 ---- */
    if (e.type === 'decoy') {
      this.score = Math.max(0, this.score + cfg.score);
      this.energy = Math.max(0, this.energy - 15);
      this.breakCombo();
      this.burst(e.x, e.y, '#8e9bb0', 12, 120);
      this.addText(e.x, e.y - e.r - 8, '诱饵！', '#ff9d92');
      this.addText(e.x, e.y - e.r + 14, `${cfg.score}`, '#ff9d92');
      this.wave.decoyKilled++;
      this._emit({ type: 'decoy' });
      this.emitStats();
      return;
    }

    /* ---- 爆裂体：距离决定这一枪是战果还是灾难 ---- */
    if (e.type === 'volatile') {
      const safe = distCore >= this.safeR;

      if (safe) {
        this.wave.volatileSafe++;
        this.score += 15;
        this.addText(e.x, e.y - e.r - 20, '安全引爆 +15', '#7fe3c4');
        this.burst(e.x, e.y, '#ff7b6e', 34, 300);
        this.rings.push({ x: e.x, y: e.y, r: 6, max: 120, w: 3, color: '#ff7b6e' });
        this.shake = Math.max(this.shake, 0.55);
        this.hitStop = Math.max(this.hitStop, 0.07);
      } else {
        // 贴脸引爆：不给分、不给连击，只给一次重击 —— 这是"打错"而不是"打赢"
        this._damageCore(CONFIG.types.volatile.dmg, e.x, e.y);
        this.addText(e.x, e.y - e.r - 20, '贴脸引爆！', '#ff7b6e');
        this.burst(e.x, e.y, '#ff7b6e', 40, 340);
        this.rings.push({ x: e.x, y: e.y, r: 6, max: 150, w: 3.4, color: '#ff7b6e' });
        this.shake = Math.max(this.shake, 0.7);
        this.hitStop = Math.max(this.hitStop, 0.08);
        this._emit({ type: 'kill', enemyType: e.type });
        this.emitStats();
        return;
      }
    } else {
      this.burst(e.x, e.y, cfg.color, e.type === 'armor' ? 22 : 16, 200);
    }

    /* ---- 星屑：分数 / 能量 / 护盾三补 ---- */
    if (e.type === 'stardust') {
      this.energy = Math.min(this.maxEnergy, this.energy + 20);
      this.shield = Math.min(this.maxShield, this.shield + 5);
      this.wave.stardustKilled++;
      this.addText(e.x, e.y + e.r + 16, '能量 +20', '#ffd479');
    }

    /* ---- 感染体 ---- */
    if (e.type === 'seeker' && e.latched) {
      this.burst(this.cx, this.cy, '#7fe3c4', 16, 180);
      this.addText(this.cx, this.cy - this.coreR - 24, '已清除', '#7fe3c4');
    }

    /* ---- 计分 ---- */
    this.kills++;
    this.wave.kills++;
    if (this.waveTimer <= 10) this.wave.lateKills++;

    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.comboTimer = CONFIG.combo.window;

    const gain = Math.round(cfg.score * mult);
    this.score += gain;
    this.wave.score += gain;

    this.addText(e.x, e.y - e.r - 6, `+${gain}`, e.type === 'stardust' ? '#ffd479' : '#9fe8ff');
    if (this.combo > 0 && this.combo % CONFIG.combo.step === 0) {
      this.addText(this.aim.x, this.aim.y + 40, `${this.combo} 连击`, '#ffd489');
      this._emit({ type: 'combo', combo: this.combo });
    }
    this.hitStop = Math.max(this.hitStop, 0.035);
    this._emit({ type: 'kill', enemyType: e.type });
    this.emitStats();
  }

  _damageCore(amount, x, y) {
    if (this.state === 'won' || this.state === 'lost') return;
    this.shield = Math.max(0, this.shield - amount);
    this.damageFlash = 1;
    this.shake = Math.max(this.shake, 0.5);
    this.breakCombo();
    this.burst(x, y, '#ff6b6b', 18, 200);
    this.rings.push({ x: this.cx, y: this.cy, r: this.coreR, max: this.coreR * 2.6, w: 2.4, color: '#ff6b6b' });
    this._emit({ type: 'coreHit', amount });
    this.emitStats();

    if (this.shield <= 0) this._end(false);
  }

  breakCombo() {
    this.combo = 0;
    this.comboTimer = 0;
  }

  multiplier() {
    if (this.combo <= 0) return 1;
    const step = Math.floor(this.combo / CONFIG.combo.step);
    return Math.min(CONFIG.combo.maxMult, 1 + step * CONFIG.combo.multPerStep);
  }

  /* ===================== 波次 ===================== */

  _beginWave(index) {
    const cfg = CONFIG.waves[index];
    this.waveIndex = index;
    this.waveDuration = cfg.time;
    this.waveTimer = cfg.time;
    this.spawnTimer = 0.9;
    this.wave = this._blankWaveStats();
    this.contract = this._pickContract(cfg);
    this.novaCharges = Math.min(2, this.novaCharges + 1);
    this.state = 'playing';

    this._emit({
      type: 'waveStart',
      index,
      total: CONFIG.waves.length,
      name: cfg.name,
      brief: cfg.brief,
      contract: this.contract ? { name: this.contract.name, desc: this.contract.desc, bonus: this.contract.bonus, target: this._contractTarget(this.contract) } : null
    });
    this.emitStats();
  }

  _contractTarget(c) {
    if (!c) return 0;
    if (typeof c.target === 'number') return c.target;
    if (typeof c.target === 'function') return c.target(this);
    return 0;
  }

  _pickContract(cfg) {
    const has = (t) => cfg.pool.some((p) => p[0] === t);
    const pool = CONFIG.contracts.filter((c) => {
      if (c.id === 'noDecoy') return has('decoy');
      if (c.id === 'hunter') return has('stardust');
      if (c.id === 'surgery') return has('volatile');
      return true;
    });
    // 第一波固定用"清道夫"，给一个明确、易达成的目标做教学
    if (this.waveIndex === 0) {
      const c = pool.find((x) => x.id === 'cleaner');
      if (c) return c;
    }
    return pool[Math.floor(Math.random() * pool.length)] || pool[0];
  }

  _completeWave() {
    const c = this.contract;
    let contractDone = false;
    let bonus = 0;

    if (c) {
      try { contractDone = !!c.check(this); } catch (err) { contractDone = false; }
      if (contractDone) {
        bonus = c.bonus;
        this.score += bonus;
        this.contractsDone++;
      }
    }

    // 波间补给：护盾回一点、能量回满、冲击波 +1 —— 让"过关"真的像喘了口气
    const heal = CONFIG.waveBonus.shield;
    this.shield = Math.min(this.maxShield, this.shield + heal);
    this.energy = this.maxEnergy;
    this.novaCharges = Math.min(2, this.novaCharges + CONFIG.waveBonus.nova);

    this.state = 'break';
    this.breakTimer = 2.4;

    this.rings.push({ x: this.cx, y: this.cy, r: this.coreR * 0.6, max: this.coreR * 4, w: 2, color: '#7fe3c4' });

    this._emit({
      type: 'waveClear',
      index: this.waveIndex,
      waves: CONFIG.waves.length,
      contract: c ? { name: c.name, done: contractDone, bonus } : null,
      heal
    });
    this.emitStats();
  }

  _advanceWave() {
    if (this.waveIndex >= CONFIG.waves.length - 1) {
      this._end(true);
      return;
    }
    this._beginWave(this.waveIndex + 1);
  }

  _end(won) {
    if (this.state === 'won' || this.state === 'lost') return;
    this.state = won ? 'won' : 'lost';
    this.running = false;
    this.pressing = false;
    this.charging = 0;

    if (!won) {
      this.shake = 0.9;
      for (let i = 0; i < 3; i++) {
        this.rings.push({ x: this.cx, y: this.cy, r: this.coreR, max: this.coreR * (3 + i), w: 3 - i * 0.6, color: '#ff6b6b' });
      }
      this.burst(this.cx, this.cy, '#ff8a7a', 50, 340);
    }

    let rank = CONFIG.ranks[CONFIG.ranks.length - 1];
    if (won) {
      rank = CONFIG.ranks.find((r) => this.score >= r.min) || rank;
    } else {
      rank = { rank: '—', note: '星核失守' };
    }

    this._emit({ type: won ? 'win' : 'lose' });
    this.emitStats();

    if (typeof this.onEnd === 'function') {
      this.onEnd({
        won,
        score: this.score,
        kills: this.kills,
        maxCombo: this.maxCombo,
        waves: this.waveIndex + 1,
        totalWaves: CONFIG.waves.length,
        shield: Math.round(this.shield),
        contracts: this.contractsDone,
        rank: rank.rank,
        note: rank.note
      });
    }
  }

  /* ===================== 生成 ===================== */

  _spawnInterval() {
    const cfg = CONFIG.waves[this.waveIndex] || CONFIG.waves[0];
    const prog = 1 - this.waveTimer / this.waveDuration;   // 0 → 1
    // 波内也做一次加速：后半段比开头更密，节奏有起伏
    return Math.max(0.24, cfg.spawn * (1 - prog * 0.28));
  }

  _rollType(pool) {
    let total = 0;
    for (const p of pool) total += p[1];
    let r = Math.random() * total;
    for (const p of pool) {
      r -= p[1];
      if (r <= 0) return p[0];
    }
    return pool[0][0];
  }

  _spawnOne() {
    const cfg = CONFIG.waves[this.waveIndex];
    if (!cfg) return;

    const type = this._rollType(cfg.pool);
    const t = CONFIG.types[type];
    const scale = Math.max(0.85, Math.min(this.w, this.h) / 680);

    const rx = this.w * 0.5 + 34;
    const ry = this.h * 0.5 + 34;
    const ang = Math.random() * TAU;

    const e = {
      type,
      x: this.cx + Math.cos(ang) * rx,
      y: this.cy + Math.sin(ang) * ry,
      r: t.r * Math.max(0.85, Math.min(1.25, scale)),
      hp: t.hp,
      maxHp: t.hp,
      speed: t.speed * cfg.speedScale * scale * (0.92 + Math.random() * 0.16),
      baseAngle: 0,
      dirAngle: null,
      phase: Math.random() * TAU,
      wobble: type === 'shard' || type === 'seeker' ? 0.34 : 0.16,
      born: this.time,
      hitFlash: 0,
      hitPulse: 0,
      latched: false,
      latchTimer: 0,
      latchAngle: ang,
      pushed: 0,
      life: type === 'decoy' ? 3.2 : (type === 'stardust' ? 4.6 : 999)
    };

    // 星屑与诱饵不冲核心：前者横穿画面，后者绕圈飘
    if (type === 'stardust' || type === 'decoy') {
      e.baseAngle = ang + Math.PI * (0.75 + Math.random() * 0.5);
    } else {
      e.baseAngle = Math.atan2(this.cy - e.y, this.cx - e.x);
    }

    if (type === 'stardust') this.wave.stardustSpawned++;
    if (type === 'volatile') this.wave.volatileSpawned++;

    this.enemies.push(e);
  }

  /* ===================== 每帧更新 ===================== */

  update(dt) {
    this.time += dt;

    const pausable = this.state !== 'paused';
    const step = this.state === 'paused' ? 0 : dt;

    // 准星跟随：两次平滑，指尖抖动不会直接传成画面抖动
    if (pausable) {
      const tx = this.pointerNorm.x * this.w;
      const ty = this.pointerNorm.y * this.h;
      const k = 1 - Math.exp(-22 * dt);
      this.aim.x += (tx - this.aim.x) * k;
      this.aim.y += (ty - this.aim.y) * k;
    }

    // 锁定提示
    this.hoverIndex = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      const d = Math.hypot(e.x - this.aim.x, e.y - this.aim.y);
      if (d < e.r + 20 && d < bestD) { bestD = d; this.hoverIndex = i; }
    }

    // 蓄能进度
    if (this.pressing && this.state !== 'paused') {
      this.pressTime += step;
      const need = CONFIG.attack.lance.holdToCharge;
      this.charging = Math.min(1, this.pressTime / need);
      if (this.pressTime >= need && !this._chargeReady) {
        this._chargeReady = true;
        this.rings.push({ x: this.aim.x, y: this.aim.y, r: 10, max: 34, w: 1.4, color: '#ffd489' });
      }
    } else {
      this.pressTime = 0;
      this.charging = 0;
      this._chargeReady = false;
    }

    if (this.energy < this.maxEnergy && this._isLive()) {
      this.energy = Math.min(this.maxEnergy, this.energy + CONFIG.energyRegen * step);
    }

    if (this.combo > 0) {
      this.comboTimer -= step;
      if (this.comboTimer <= 0) this.breakCombo();
    }

    /* ---- 状态机 ---- */
    if (this.state === 'playing') {
      this.waveTimer -= dt;
      this.spawnTimer -= dt;

      const maxAlive = CONFIG.waves[this.waveIndex].maxAlive;
      if (this.spawnTimer <= 0 && this.enemies.length < maxAlive) {
        this._spawnOne();
        this.spawnTimer = this._spawnInterval();
      }
      this._updateEnemies(dt);
      if (this.waveTimer <= 0) this._completeWave();
    } else if (this.state === 'break') {
      // 波间的 2.4 秒：敌人冻结在原地，玩家可以清场，但不会再有新敌人
      this.breakTimer -= dt;
      if (this.breakTimer <= 0) this._advanceWave();
    } else if (this.state === 'won' || this.state === 'lost') {
      // 结算后敌人不再推进，只播放余下的特效
    }

    /* ---- 特效层 ---- */
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.955;
      p.vy *= 0.955;
      p.vy += p.g || 0;
      p.life -= dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.y -= 44 * dt;
      t.life -= dt;
      if (t.life <= 0) this.texts.splice(i, 1);
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.r += (r.max - r.r) * Math.min(1, dt * 7);
      if (r.r > r.max - 0.5) this.rings.splice(i, 1);
    }

    this.pinchFlash = Math.max(0, this.pinchFlash - dt * 3.4);
    this.fireFlash = Math.max(0, this.fireFlash - dt * 5);
    this.novaFlash = Math.max(0, this.novaFlash - dt * 1.8);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.5);
    this.noEnergyFlash = Math.max(0, this.noEnergyFlash - dt * 2.4);
    this.shake = Math.max(0, this.shake - dt * 1.9);
    this.hitStop = Math.max(0, this.hitStop - dt);

    this._statTimer += dt;
    if (this._statTimer >= 0.08) {
      this._statTimer = 0;
      this.emitStats();
    }
  }

  _updateEnemies(dt) {
    const coreR = this.coreR;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.dead) continue;

      e.hitFlash = Math.max(0, e.hitFlash - dt * 4);
      e.hitPulse = Math.max(0, e.hitPulse - dt * 3);
      e.pushed = Math.max(0, e.pushed - dt);

      /* --- 已附着的感染体：贴在星核表面抽能，倒计时结束就孵化 --- */
      if (e.latched) {
        e.latchTimer += dt;
        e.latchAngle += dt * 0.6;
        e.x = this.cx + Math.cos(e.latchAngle) * (coreR + e.r * 0.55);
        e.y = this.cy + Math.sin(e.latchAngle) * (coreR + e.r * 0.55);

        const drain = CONFIG.seekerDrain * dt;
        this.shield = Math.max(0, this.shield - drain);
        this.damageFlash = Math.max(this.damageFlash, 0.35);
        if (this.shield <= 0) { this._end(false); return; }

        if (e.latchTimer >= CONFIG.seekerLatchTime) {
          // 孵化：本体消失，分裂出两个碎片，同时给一次穿透伤害
          this.enemies.splice(i, 1);
          e.dead = true;
          this.burst(e.x, e.y, '#7fe3c4', 18, 170);
          this.addText(e.x, e.y - e.r - 14, '孵化！', '#7fe3c4');
          this._damageCore(10, e.x, e.y);
          for (let s = 0; s < 2; s++) {
            const a = e.latchAngle + (s ? 0.9 : -0.9);
            this.enemies.push({
              type: 'shard',
              x: this.cx + Math.cos(a) * (this.coreR + 70),
              y: this.cy + Math.sin(a) * (this.coreR + 70),
              r: CONFIG.types.shard.r * 0.9,
              hp: 1, maxHp: 1,
              speed: CONFIG.types.shard.speed * 1.2,
              baseAngle: a, dirAngle: null,
              phase: Math.random() * TAU, wobble: 0.3,
              born: this.time, hitFlash: 0, hitPulse: 0,
              latched: false, latchTimer: 0, latchAngle: 0, pushed: 0,
              life: 999
            });
          }
          continue;
        }
        continue;
      }

      /* --- 普通移动：朝核心，带正弦蛇形，需要预判 --- */
      const ang = Math.atan2(this.cy - e.y, this.cx - e.x);
      let moveAng;

      if (e.type === 'stardust' || e.type === 'decoy') {
        moveAng = e.baseAngle + Math.sin(this.time * 1.3 + e.phase) * 0.22;
        if (e.type === 'decoy') moveAng += 0.9;   // 绕圈而不是穿心
      } else {
        const wob = Math.sin(this.time * 2.1 + e.phase) * e.wobble;
        moveAng = ang + wob * (e.type === 'armor' ? 0.6 : 1);
      }

      const sp = e.speed * (e.pushed > 0 ? 1.7 : 1);
      e.x += Math.cos(moveAng) * sp * dt;
      e.y += Math.sin(moveAng) * sp * dt;

      /* --- 星屑 / 诱饵有存活时间，到点自己离开 --- */
      if (e.type === 'stardust' || e.type === 'decoy') {
        e.life -= dt;
        if (e.life <= 0) {
          this.burst(e.x, e.y, withAlpha(CONFIG.types[e.type].color, 0.5), 5, 60);
          this.enemies.splice(i, 1);
          continue;
        }
        // 飘出画面就删掉，避免僵尸实体
        if (e.x < -80 || e.x > this.w + 80 || e.y < -80 || e.y > this.h + 80) {
          this.enemies.splice(i, 1);
          continue;
        }
        continue;
      }

      /* --- 抵达星核 --- */
      const dist = Math.hypot(e.x - this.cx, e.y - this.cy);
      if (dist <= coreR + e.r * 0.7) {
        if (e.type === 'seeker') {
          e.latched = true;
          e.latchTimer = 0;
          e.latchAngle = Math.atan2(e.y - this.cy, e.x - this.cx);
          this.breakCombo();
          this.addText(this.cx, this.cy - coreR - 26, '被感染体攀附', '#7fe3c4');
          this._emit({ type: 'latched' });
          continue;
        }

        // 其它敌人撞核即毁
        const dmg = CONFIG.types[e.type].dmg;
        this.enemies.splice(i, 1);
        e.dead = true;
        this.burst(e.x, e.y, CONFIG.types[e.type].color, 14, 160);
        this._damageCore(dmg, e.x, e.y);
        if (this.state === 'lost') return;
      }
    }
  }

  /* ===================== HUD 数据 ===================== */

  emitStats() {
    if (typeof this.onStats !== 'function') return;

    const cfg = CONFIG.waves[Math.max(0, this.waveIndex)] || CONFIG.waves[0];
    const c = this.contract;
    let progress = 0;
    let target = 0;
    if (c) {
      target = this._contractTarget(c);
      progress = typeof c.progress === 'function' ? c.progress(this) : 0;
    }

    this.onStats({
      state: this.state,
      score: Math.round(this.score),
      shield: Math.max(0, Math.round(this.shield)),
      maxShield: this.maxShield,
      energy: Math.round(this.energy),
      maxEnergy: this.maxEnergy,
      nova: this.novaCharges,
      combo: this.combo,
      mult: this.multiplier(),
      kills: this.kills,
      wave: Math.max(0, this.waveIndex) + 1,
      waveTotal: CONFIG.waves.length,
      waveName: cfg.name,
      waveTime: Math.max(0, this.waveTimer),
      waveProgress: this.waveDuration ? Math.min(1, 1 - this.waveTimer / this.waveDuration) : 0,
      charging: this.charging,
      gesture: this.gesture,
      contract: c ? { name: c.name, desc: c.desc, bonus: c.bonus, progress, target } : null,
      enemies: this.enemies.length
    });
  }

  _emit(evt) {
    if (typeof this.onEvent === 'function') this.onEvent(evt);
  }

  /* ===================== 特效基础件 ===================== */

  burst(x, y, color, count, speed) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const v = speed * (0.3 + Math.random() * 0.9);
      this.particles.push({
        x, y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        r: 1.2 + Math.random() * 3,
        color,
        life: 0.35 + Math.random() * 0.5,
        maxLife: 0.85
      });
    }
  }

  addText(x, y, text, color) {
    this.texts.push({ x, y, text, color, life: 0.95, maxLife: 0.95 });
  }

  /* ===================== 渲染 ===================== */

  draw() {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    if (!w || !h) return;

    // 背景改由 CSS 承担后，画布必须自己清屏（否则会留下上一帧的残影）
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();

    ctx.save();
    if (this.shake > 0) {
      const s = this.shake * 7;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    this._drawBackdrop();
    this._drawRadar();
    this._drawCore();
    this._drawDangerZone();
    this._drawEnemies();

    // 加色混合画粒子与光环，才有"发光"的感觉
    ctx.globalCompositeOperation = 'lighter';
    this._drawRings();
    this._drawParticles();
    ctx.globalCompositeOperation = 'source-over';

    this._drawTexts();
    this._drawAim();
    this._drawOverlay();

    ctx.restore();
  }

  /*
   * 性能：背景渐变、星点、暗角全部搬到了 .board 的 CSS 层（GPU 合成，零重绘）。
   * 这里不再每帧重建 2 个大面积径向渐变 + 逐颗画星点，画布只负责动态实体。
   */
  _drawBackdrop() {
    /* 留空：背景由 CSS 提供 */
  }

  // 以星核为中心的战术网格：给"防区"一个可读的空间刻度
  _drawRadar() {
    const ctx = this.ctx;
    const cx = this.cx;
    const cy = this.cy;
    const maxR = Math.hypot(this.w, this.h) * 0.5;

    ctx.save();
    ctx.strokeStyle = 'rgba(120, 165, 230, 0.075)';
    ctx.lineWidth = 1;

    for (let ring = 1; ring <= 4; ring++) {
      const r = this.coreR * 1.6 * ring + this.coreR * 0.4 * (ring - 1);
      if (r > maxR) break;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(120, 165, 230, 0.05)';
    for (let i = 0; i < 12; i++) {
      const a = (TAU / 12) * i + this.time * 0.04;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * this.coreR, cy + Math.sin(a) * this.coreR);
      ctx.lineTo(cx + Math.cos(a) * maxR, cy + Math.sin(a) * maxR);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawCore() {
    const ctx = this.ctx;
    const cx = this.cx;
    const cy = this.cy;
    const R = this.coreR;
    const pct = this.shield / this.maxShield;
    const hurt = this.damageFlash;
    const pulse = 1 + Math.sin(this.time * 2.2) * 0.02;
    const danger = pct < 0.34;

    const base = danger ? '#ff8f7f' : (hurt > 0.2 ? '#ffb3a4' : '#a9c7ff');

    ctx.save();

    // 外层柔光
    const glow = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, R * 2.9);
    glow.addColorStop(0, withAlpha(base, 0.3 + hurt * 0.3));
    glow.addColorStop(0.55, withAlpha(base, 0.06));
    glow.addColorStop(1, withAlpha(base, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 2.9, 0, TAU);
    ctx.fill();

    // 核体
    const body = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R);
    body.addColorStop(0, withAlpha(base, 0.55));
    body.addColorStop(0.62, withAlpha(base, 0.16));
    body.addColorStop(1, withAlpha(base, 0.04));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, R * pulse, 0, TAU);
    ctx.fill();

    // 护盾弧：从正上方顺时针，缺口就是失血
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.34, -Math.PI / 2, -Math.PI / 2 + TAU * pct);
    ctx.strokeStyle = withAlpha(base, 0.9);
    ctx.lineWidth = 3.4;
    ctx.lineCap = 'round';
    ctx.stroke();

    // 底衬（显示总长度）
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.34, 0, TAU);
    ctx.strokeStyle = 'rgba(160, 190, 240, 0.10)';
    ctx.lineWidth = 3.4;
    ctx.stroke();

    // 内核齿轮
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.56, this.time * 0.7, this.time * 0.7 + Math.PI * 1.35);
    ctx.strokeStyle = withAlpha(base, 0.85);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.56, this.time * 0.7 + Math.PI, this.time * 0.7 + Math.PI * 2.35);
    ctx.strokeStyle = withAlpha(base, 0.45);
    ctx.lineWidth = 2;
    ctx.stroke();

    // 中心瞳
    const pupil = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.3);
    pupil.addColorStop(0, 'rgba(255,255,255,0.92)');
    pupil.addColorStop(0.5, withAlpha(base, 0.6));
    pupil.addColorStop(1, withAlpha(base, 0));
    ctx.fillStyle = pupil;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.3, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  // 爆裂体安全线：只在场上真有爆裂体时点亮，避免常驻噪音
  _drawDangerZone() {
    let volatile = false;
    for (const e of this.enemies) {
      if (e.type === 'volatile' && !e.latched) { volatile = true; break; }
    }
    if (!volatile) return;

    const ctx = this.ctx;
    const R = this.safeR;
    const a = 0.22 + Math.sin(this.time * 3.4) * 0.06;

    ctx.save();
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, R, 0, TAU);
    ctx.strokeStyle = 'rgba(255, 123, 110, ' + a.toFixed(3) + ')';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([7, 9]);
    ctx.stroke();
    ctx.setLineDash([]);

    const fill = ctx.createRadialGradient(this.cx, this.cy, R * 0.6, this.cx, this.cy, R);
    fill.addColorStop(0, 'rgba(255,123,110,0)');
    fill.addColorStop(1, 'rgba(255,80,66,0.055)');
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, R, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  _drawEnemies() {
    for (let i = 0; i < this.enemies.length; i++) {
      this._drawEnemy(this.enemies[i]);
    }
  }

  _drawEnemy(e) {
    const ctx = this.ctx;
    const cfg = CONFIG.types[e.type];
    const color = cfg.color;
    const age = this.time - e.born;
    const pop = age < 0.3 ? 0.6 + 0.4 * (1 - Math.pow(1 - Math.min(1, age / 0.3), 3)) : 1;
    const r = e.r * pop;
    const locked = this.hoverIndex >= 0 && this.enemies[this.hoverIndex] === e;
    const flashing = e.hitFlash;

    // 临近核心时闪烁加速 —— 用"紧迫感"代替数字提示
    const dist = Math.hypot(e.x - this.cx, e.y - this.cy);
    const imminent = e.type !== 'stardust' && e.type !== 'decoy' && dist < this.coreR * 2.6;
    const flash = imminent ? 0.5 + 0.5 * Math.sin(this.time * 12) : 0;
    const alpha = e.type === 'decoy' ? 0.55 : 1;

    ctx.save();
    ctx.globalAlpha = alpha;

    // 光晕
    const glow = ctx.createRadialGradient(e.x, e.y, r * 0.4, e.x, e.y, r * 2.1);
    glow.addColorStop(0, withAlpha(color, 0.3 + flashing * 0.3 + flash * 0.2));
    glow.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(e.x, e.y, r * 2.1, 0, TAU);
    ctx.fill();

    switch (e.type) {
      case 'shard': this._shapeShard(e, r, color, locked); break;
      case 'armor': this._shapeArmor(e, r, color, locked); break;
      case 'volatile': this._shapeVolatile(e, r, color, locked); break;
      case 'seeker': this._shapeSeeker(e, r, color, locked); break;
      case 'stardust': this._shapeStardust(e, r, color, locked); break;
      default: this._shapeDecoy(e, r, color, locked); break;
    }

    ctx.restore();
  }

  _shapeShard(e, r, color, locked) {
    const ctx = this.ctx;
    const spin = this.time * 1.4 + e.phase;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(spin);
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (TAU / 4) * i;
      const rr = i % 2 === 0 ? r * 1.15 : r * 0.72;
      const px = Math.cos(a) * rr;
      const py = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = withAlpha(color, 0.24);
    ctx.fill();
    ctx.strokeStyle = withAlpha(color, locked ? 1 : 0.9);
    ctx.lineWidth = locked ? 2.2 : 1.6;
    ctx.stroke();
    ctx.restore();
  }

  _shapeArmor(e, r, color, locked) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(e.x, e.y);

    // 六边形装甲板
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (TAU / 6) * i - Math.PI / 2;
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = withAlpha(color, 0.22);
    ctx.fill();
    ctx.strokeStyle = withAlpha(color, locked ? 1 : 0.88);
    ctx.lineWidth = locked ? 2.4 : 1.8;
    ctx.stroke();

    // 内层反向六边形：视觉上"双层护甲"
    ctx.rotate(-this.time * 0.5);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (TAU / 6) * i;
      const px = Math.cos(a) * r * 0.52;
      const py = Math.sin(a) * r * 0.52;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.strokeStyle = withAlpha(color, 0.5);
    ctx.lineWidth = 1;
    ctx.stroke();

    // 剩余 HP 弧：一眼看出还要打几下
    for (let i = 0; i < e.maxHp; i++) {
      const a0 = -Math.PI / 2 + (TAU / e.maxHp) * i + 0.12;
      const a1 = -Math.PI / 2 + (TAU / e.maxHp) * (i + 1) - 0.12;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.42, a0, a1);
      ctx.strokeStyle = i < e.hp ? withAlpha(color, 0.95) : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 2.6;
      ctx.stroke();
    }
    ctx.restore();
  }

  _shapeVolatile(e, r, color, locked) {
    const ctx = this.ctx;
    const beat = 1 + Math.sin(this.time * 6 + e.phase) * 0.07;

    ctx.save();
    ctx.translate(e.x, e.y);

    ctx.beginPath();
    ctx.arc(0, 0, r * beat, 0, TAU);
    ctx.fillStyle = withAlpha(color, 0.26);
    ctx.fill();
    ctx.strokeStyle = withAlpha(color, locked ? 1 : 0.9);
    ctx.lineWidth = locked ? 2.6 : 2;
    ctx.stroke();

    // 警示三角
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.5);
    ctx.lineTo(r * 0.46, r * 0.36);
    ctx.lineTo(-r * 0.46, r * 0.36);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.86)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, -r * 0.06, r * 0.09, 0, TAU);
    ctx.fillStyle = '#2a0a08';
    ctx.fill();
    ctx.restore();
  }

  _shapeSeeker(e, r, color, locked) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(e.x, e.y);

    // 触须：朝着星核伸出去，明确"它是来抽能的"
    const toCore = Math.atan2(this.cy - e.y, this.cx - e.x);
    ctx.strokeStyle = withAlpha(color, 0.55);
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 4; i++) {
      const a = toCore + (i - 1.5) * 0.42;
      const len = r * (1.5 + 0.35 * Math.sin(this.time * 5 + i));
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7);
      ctx.quadraticCurveTo(
        Math.cos(a) * len * 0.7, Math.sin(a) * len * 0.7 + Math.sin(this.time * 4 + i) * r * 0.2,
        Math.cos(a) * len, Math.sin(a) * len
      );
      ctx.stroke();
    }

    // 刺球
    ctx.beginPath();
    const spikes = 9;
    for (let i = 0; i < spikes * 2; i++) {
      const a = (TAU / (spikes * 2)) * i + this.time * 0.8;
      const rr = i % 2 === 0 ? r : r * 0.66;
      const px = Math.cos(a) * rr;
      const py = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = withAlpha(color, 0.3);
    ctx.fill();
    ctx.strokeStyle = withAlpha(color, locked ? 1 : 0.92);
    ctx.lineWidth = locked ? 2.2 : 1.6;
    ctx.stroke();

    // 已附着：外圈倒计时
    if (e.latched) {
      const p = Math.min(1, e.latchTimer / CONFIG.seekerLatchTime);
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.7, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p));
      ctx.strokeStyle = 'rgba(255, 120, 105, 0.95)';
      ctx.lineWidth = 2.8;
      ctx.stroke();
    }
    ctx.restore();
  }

  _shapeStardust(e, r, color, locked) {
    const ctx = this.ctx;
    const tw = 0.75 + 0.25 * Math.sin(this.time * 9 + e.phase);
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(this.time * 0.9);

    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI / 4) * i - Math.PI / 2;
      const rr = i % 2 === 0 ? r * 1.35 * tw : r * 0.55;
      const px = Math.cos(a) * rr;
      const py = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = withAlpha(color, 0.9);
    ctx.fill();
    ctx.strokeStyle = withAlpha(color, locked ? 1 : 0.7);
    ctx.lineWidth = locked ? 2 : 1;
    ctx.stroke();
    ctx.restore();
  }

  _shapeDecoy(e, r, color, locked) {
    const ctx = this.ctx;
    const fade = Math.min(1, e.life * 1.4);
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.globalAlpha *= fade;

    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.strokeStyle = withAlpha(color, 0.7);
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 6]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 一条斜杠：强烈暗示"不要打"
    ctx.beginPath();
    ctx.moveTo(-r * 0.5, r * 0.5);
    ctx.lineTo(r * 0.5, -r * 0.5);
    ctx.strokeStyle = withAlpha(color, 0.55);
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  }

  _drawRings() {
    const ctx = this.ctx;
    for (const r of this.rings) {
      const t = r.r / r.max;
      const a = Math.max(0, 1 - t);
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, TAU);
      ctx.strokeStyle = withAlpha(r.color, a * 0.9);
      ctx.lineWidth = Math.max(0.6, r.w * a);
      ctx.stroke();
    }
  }

  _drawParticles() {
    const ctx = this.ctx;
    for (const p of this.particles) {
      const life = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = life * 0.9;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.35 + life * 0.65), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  _drawTexts() {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 16px "Inter", "PingFang SC", "Microsoft YaHei", sans-serif';

    for (const t of this.texts) {
      const life = Math.max(0, t.life / t.maxLife);
      ctx.globalAlpha = life < 0.4 ? life / 0.4 : 1;
      ctx.shadowColor = 'rgba(0,0,0,0.65)';
      ctx.shadowBlur = 10;
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic';
  }

  _drawAim() {
    const ctx = this.ctx;
    const x = this.aim.x;
    const y = this.aim.y;
    const target = this.hoverIndex >= 0 ? this.enemies[this.hoverIndex] : null;
    const charging = this.charging > 0;
    const ready = this.charging >= 1;

    const accent = this.noEnergyFlash > 0.1 ? '#ff8d80'
      : ready ? '#ffd489'
        : charging ? '#f3c87e'
          : target ? '#9fefd8' : '#cfe4ff';

    const ringR = target ? Math.max(18, target.r + 8) : 18;

    // 蓄能圈：从 12 点方向顺时针填满，满了准星变宽变亮
    if (charging) {
      ctx.beginPath();
      ctx.arc(x, y, ringR + 9, -Math.PI / 2, -Math.PI / 2 + TAU * this.charging);
      ctx.strokeStyle = withAlpha(accent, 0.95);
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.stroke();
      if (ready) {
        const g = ctx.createRadialGradient(x, y, ringR * 0.4, x, y, ringR * 2.2);
        g.addColorStop(0, 'rgba(255,212,137,0.28)');
        g.addColorStop(1, 'rgba(255,212,137,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, ringR * 2.2, 0, TAU);
        ctx.fill();
      }
    }

    // 开火余晖
    if (this.fireFlash > 0) {
      ctx.beginPath();
      ctx.arc(x, y, 10 + (1 - this.fireFlash) * 46, 0, TAU);
      ctx.strokeStyle = withAlpha(accent, this.fireFlash * 0.55);
      ctx.lineWidth = 2 * this.fireFlash + 0.4;
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.lineCap = 'round';

    ctx.strokeStyle = withAlpha(accent, 0.95);
    ctx.lineWidth = target || ready ? 2.2 : 1.6;
    for (let i = 0; i < 4; i++) {
      const a0 = i * Math.PI / 2 + 0.34;
      const a1 = (i + 1) * Math.PI / 2 - 0.34;
      ctx.beginPath();
      ctx.arc(0, 0, ringR, a0, a1);
      ctx.stroke();
    }

    ctx.strokeStyle = withAlpha(accent, target ? 0.6 : 0.42);
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 4; i++) {
      const a = (Math.PI / 2) * i;
      const c = Math.cos(a);
      const s = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(c * (ringR + 4), s * (ringR + 4));
      ctx.lineTo(c * (ringR + 10), s * (ringR + 10));
      ctx.stroke();
    }

    // 锁定环
    if (target) {
      ctx.beginPath();
      ctx.arc(0, 0, ringR + 4 + Math.sin(this.time * 8) * 1.8, 0, TAU);
      ctx.strokeStyle = withAlpha('#9fefd8', 0.3);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    ctx.arc(0, 0, this.pinching ? 3.4 : 2, 0, TAU);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.restore();
  }

  // 缓存全屏渐变对象：每帧 createRadialGradient 会持续产生垃圾并拖慢填充
  _overlayGrad(kind, w, h) {
    if (!this._grads) this._grads = {};
    const sig = Math.round(w) + 'x' + Math.round(h);
    const slot = this._grads[kind];
    if (slot && slot.sig === sig) return slot.g;

    const dmg = kind === 'dmg';
    const inner = (dmg ? 0.3 : 0.2) * Math.min(w, h);
    const outer = (dmg ? 0.72 : 0.7) * Math.max(w, h);
    const rgb = dmg ? '255,64,52' : '127,227,196';

    const g = this.ctx.createRadialGradient(w / 2, h / 2, inner, w / 2, h / 2, outer);
    g.addColorStop(0, 'rgba(' + rgb + ',0)');
    g.addColorStop(1, 'rgba(' + rgb + ',1)');
    this._grads[kind] = { sig: sig, g: g };
    return g;
  }

  // 屏幕级提示：受击红边、低血呼吸、冲击波余晖
  _drawOverlay() {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const pct = this.shield / this.maxShield;
    const lowHp = pct < 0.32 && this._isLive();

    let a = 0;
    if (this.damageFlash > 0) a = this.damageFlash * 0.55;
    if (lowHp) a = Math.max(a, 0.16 + 0.1 * Math.sin(this.time * 3.4));
    if (this.novaFlash > 0) a = Math.max(a, 0);

    if (a > 0.01) {
      ctx.globalAlpha = Math.min(1, a);
      ctx.fillStyle = this._overlayGrad('dmg', w, h);
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    if (this.novaFlash > 0.01) {
      ctx.globalAlpha = Math.min(1, this.novaFlash * 0.16);
      ctx.fillStyle = this._overlayGrad('nova', w, h);
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }

    // 暂停遮罩：键鼠按 P、或切到别的标签页时给一个明确交代
    if (this.state === 'paused') {
      ctx.fillStyle = 'rgba(4, 6, 12, 0.64)';
      ctx.fillRect(0, 0, w, h);

      // 放在星核上方的空档里，避免和护盾弧、内核瞳叠在一起
      const ty = h * 0.34;

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      ctx.shadowBlur = 18;

      ctx.fillStyle = '#eef3fb';
      ctx.font = '600 28px "Inter", "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillText('已暂停', w / 2, ty - 14);

      ctx.font = '400 13px "Inter", "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#b6c3d7';
      ctx.fillText('按 P 继续 · 星核与能量都已冻结', w / 2, ty + 22);

      ctx.shadowBlur = 0;
      ctx.textBaseline = 'alphabetic';
    }
  }
}

window.DeepField = DeepField;
