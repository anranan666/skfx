/* ===========================================================
   config.js —— 全局配置（v2 深空防线）
   数值集中在此，改平衡不用动逻辑。
   =========================================================== */

var CONFIG = {

  /* ---------- 视觉引擎 ---------- */
  // 通过本地服务器打开时优先用内置模型（断网可用）
  mediapipeBase: 'lib/mediapipe',

  // file:// 直接打开时回退 CDN
  mediapipeCdns: [
    'https://unpkg.com/@mediapipe/hands@0.4.1675469240',
    'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240'
  ],

  inferenceIntervalMs: 45,
  modelComplexity: 0,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.5,

  /* ---------- 手势判定 ---------- */
  pointerSmoothing: 15,
  pointerSmoothingPinch: 9,   // 捏合时更稳，避免准星随拇指抖动
  aimPadding: 0.16,
  pinchStartRatio: 0.45,
  pinchReleaseRatio: 0.65,
  palmHoldSeconds: 0.55,

  /* ---------- 玩家资源 ---------- */
  shield: 120,
  energy: 100,
  energyRegen: 7.0,        // 每秒自然回能
  energyMax: 100,

  /* ---------- 攻击 ---------- */
  attack: {
    pulse: { cost: 6, damage: 1, radius: 26 },
    lance: { cost: 20, damage: 3, holdToCharge: 0.36, radius: 30, pierce: 3 },
    nova: { radius: 190, damage: 2, knock: 240, cost: 0 }
  },

  /* ---------- 连击 ---------- */
  combo: {
    window: 2.8,           // 超时归零（秒）
    step: 5,               // 每 5 连击提升一档
    multPerStep: 0.25,
    maxMult: 3
  },

  /* ---------- 敌人类别 ---------- */
  types: {
    shard:    { hp: 1, r: 15, speed: 54,  score: 10, dmg: 5,  color: '#7fd0ff' },
    armor:    { hp: 2, r: 21, speed: 42,  score: 25, dmg: 10, color: '#a48bff' },
    volatile: { hp: 1, r: 25, speed: 32,  score: 20, dmg: 14, color: '#ff7b6e' },
    seeker:   { hp: 1, r: 17, speed: 64,  score: 30, dmg: 0,  color: '#7fe3c4' },
    stardust: { hp: 1, r: 14, speed: 84,  score: 35, dmg: 0,  color: '#ffc857' },
    decoy:    { hp: 1, r: 16, speed: 48,  score: -25, dmg: 0, color: '#9aa7bd' }
  },

  /* ---------- 波次 ---------- */
  waves: [
    {
      name: '接触',
      time: 22,
      spawn: 1.24,
      speedScale: 0.95,
      maxAlive: 8,
      pool: [['shard', 1]],
      brief: '碎片群正在接近。捏合击破它们，别让它们碰到星核。'
    },
    {
      name: '装甲',
      time: 24,
      spawn: 1.06,
      speedScale: 1.0,
      maxAlive: 10,
      pool: [['shard', 0.62], ['armor', 0.38]],
      brief: '装甲目标出现。单发脉冲打不穿，按住捏合蓄能再松手。'
    },
    {
      name: '寄生',
      time: 26,
      spawn: 0.92,
      speedScale: 1.06,
      maxAlive: 11,
      pool: [['shard', 0.44], ['armor', 0.24], ['seeker', 0.2], ['stardust', 0.12]],
      brief: '感染体会攀附星核并持续抽能。看到绿色，先处理它。'
    },
    {
      name: '临界',
      time: 28,
      spawn: 0.78,
      speedScale: 1.12,
      maxAlive: 14,
      pool: [['shard', 0.34], ['armor', 0.24], ['seeker', 0.16], ['volatile', 0.16], ['stardust', 0.1]],
      brief: '爆裂体进入射程。贴脸引爆会重创星核，拉开距离再开火。'
    },
    {
      name: '超载',
      time: 30,
      spawn: 0.6,
      speedScale: 1.2,
      maxAlive: 17,
      pool: [['shard', 0.28], ['armor', 0.22], ['seeker', 0.18], ['volatile', 0.16], ['stardust', 0.09], ['decoy', 0.07]],
      brief: '全部型号压上。灰色诱饵是无害的，打它只会断连击。'
    }
  ],

  /* ---------- 波次结算奖励 ---------- */
  waveBonus: { shield: 14, energy: 100, nova: 1 },

  /* ---------- 合约（每波一个附加目标） ---------- */
  contracts: [
    {
      id: 'noDecoy',
      name: '零误伤',
      desc: '本波不击破任何诱饵',
      bonus: 150,
      check: (s) => s.wave.decoyKilled === 0
    },
    {
      id: 'cleaner',
      name: '清道夫',
      desc: '本波击破 14 个目标',
      bonus: 130,
      target: 14,
      progress: (s) => Math.min(14, s.wave.kills),
      check: (s) => s.wave.kills >= 14
    },
    {
      id: 'ironwall',
      name: '铁壁',
      desc: '结束时星核护盾不低于 80%',
      bonus: 180,
      progress: (s) => Math.min(100, Math.round(s.shield / s.maxShield * 100)),
      target: 80,
      check: (s) => s.shield >= s.maxShield * 0.8
    },
    {
      id: 'hunter',
      name: '猎手',
      desc: '击破本波出现的全部星屑',
      bonus: 200,
      progress: (s) => s.wave.stardustKilled,
      target: (s) => Math.max(1, s.wave.stardustSpawned),
      check: (s) => s.wave.stardustSpawned > 0 && s.wave.stardustKilled >= s.wave.stardustSpawned
    },
    {
      id: 'surgery',
      name: '外科手术',
      desc: '所有爆裂体都在安全距离外击破',
      bonus: 160,
      progress: (s) => s.wave.volatileSafe,
      target: (s) => Math.max(1, s.wave.volatileSpawned),
      check: (s) => s.wave.volatileSpawned > 0 && s.wave.volatileSafe === s.wave.volatileSpawned
    },
    {
      id: 'burst',
      name: '急袭',
      desc: '本波最后 10 秒击破 6 个目标',
      bonus: 140,
      progress: (s) => Math.min(6, s.wave.lateKills),
      target: 6,
      check: (s) => s.wave.lateKills >= 6
    }
  ],

  /* ---------- 判定阈值 ---------- */
  safeDistanceR: 3.6,     // 爆裂体安全引爆圈 = 星核半径 × 该倍数
  seekerLatchTime: 3.2,   // 感染体附着后多久孵化
  seekerDrain: 2.6,       // 附着后每秒扣护盾

  /* ---------- 评级 ---------- */
  ranks: [
    { min: 4200, rank: 'S', note: '深空防线零失误' },
    { min: 3000, rank: 'A', note: '指挥级反应' },
    { min: 1900, rank: 'B', note: '合格哨戒官' },
    { min: 1000, rank: 'C', note: '守住了，但还不稳' },
    { min: 0,    rank: 'D', note: '星核失守' }
  ]
};

window.CONFIG = CONFIG;
