/* ===========================================================
   gesture-detector.js —— 手势识别层
   输入：MediaPipe Hands 输出的 21 个归一化关键点
   输出：{ present, x, y, pinch, pinchStart, palm, palmStart, gesture }

   设计要点：
   1) 所有判定用"比例"而不是像素值 —— 玩家远近、身高不同都能用；
   2) 捏合使用滞回区间（0.45 进入 / 0.65 退出），避免临界抖动；
   3) 张掌需要持续 0.6 秒才触发，避免挥手时误触；
   4) 指尖坐标做指数平滑，准星不抖。
   =========================================================== */

(function (global) {
  'use strict';

  // MediaPipe 手部关键点索引
  var LM = {
    WRIST: 0,
    THUMB_MCP: 2,
    THUMB_TIP: 4,
    INDEX_PIP: 6,
    INDEX_TIP: 8,
    MIDDLE_MCP: 9,
    MIDDLE_PIP: 10,
    MIDDLE_TIP: 12,
    RING_PIP: 14,
    RING_TIP: 16,
    PINKY_PIP: 18,
    PINKY_TIP: 20
  };

  function dist(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
  }

  function GestureDetector(cfg) {
    this.cfg = cfg;

    this.pinching = false;     // 当前是否处于捏合状态
    this.palmHold = 0;         // 张掌持续时间
    this.palmFired = false;    // 本次张掌是否已经触发过
    this.smooth = null;        // 平滑后的指尖坐标

    this.state = {
      present: false,
      x: 0.5,
      y: 0.5,
      pinch: false,
      pinchStart: false,
      palm: false,
      palmStart: false,
      gesture: 'none',
      ratio: 0
    };
  }

  GestureDetector.prototype.reset = function () {
    this.pinching = false;
    this.palmHold = 0;
    this.palmFired = false;
    this.smooth = null;
    this.state.present = false;
    this.state.gesture = 'none';
  };

  /**
   * 每帧调用一次
   * @param {Array|null} landmarks 21 个关键点，未检测到手时为 null
   * @param {number} dt 距离上一帧的秒数
   */
  GestureDetector.prototype.update = function (landmarks, dt) {
    var s = this.state;
    var cfg = this.cfg;

    // 离散事件（边沿触发）每帧先清零，只在真正发生时置 true
    s.pinchStart = false;
    s.palmStart = false;

    if (!landmarks || landmarks.length < 21) {
      s.present = false;
      s.pinch = false;
      s.palm = false;
      s.gesture = 'none';
      this.pinching = false;
      this.palmHold = 0;
      this.palmFired = false;
      return s;
    }

    var wrist = landmarks[LM.WRIST];
    var middleMcp = landmarks[LM.MIDDLE_MCP];
    var thumbTip = landmarks[LM.THUMB_TIP];
    var indexTip = landmarks[LM.INDEX_TIP];

    // 手掌尺寸：手腕 → 中指根部，作为一切距离判定的基准
    var handSize = dist(wrist, middleMcp);
    if (handSize < 1e-4) handSize = 1e-4;

    s.present = true;

    /* ---------- 1. 准星位置：食指指尖 ---------- */
    // 摄像头画面是"镜像"的，取 1 - x 让手的移动方向与屏幕一致
    var mirroredX = 1 - indexTip.x;
    var pad = cfg.aimPadding;
    var span = 1 - pad * 2;
    var nx = clamp((mirroredX - pad) / span, 0, 1);
    var ny = clamp((indexTip.y - pad) / span, 0, 1);

    // 捏合判定要先算出来，因为平滑强度依赖它（捏合时手指靠拢，准星更容易抖）
    var ratio = dist(thumbTip, indexTip) / handSize;
    s.ratio = ratio;
    var wantPinch = this.pinching ? (ratio < cfg.pinchReleaseRatio) : (ratio < cfg.pinchStartRatio);

    if (!this.smooth) {
      this.smooth = { x: nx, y: ny };
    } else {
      // 指数平滑：k = 1 - e^(-speed * dt)，与帧率无关
      var smoothRate = wantPinch
        ? (cfg.pointerSmoothingPinch || cfg.pointerSmoothing)
        : cfg.pointerSmoothing;
      var k = 1 - Math.exp(-smoothRate * Math.max(dt, 0.001));
      this.smooth.x += (nx - this.smooth.x) * k;
      this.smooth.y += (ny - this.smooth.y) * k;
    }
    s.x = this.smooth.x;
    s.y = this.smooth.y;

    /* ---------- 2. 捏合：拇指尖与食指尖的距离（ratio 上面已算好） ---------- */
    if (!this.pinching && ratio < cfg.pinchStartRatio) {
      this.pinching = true;
      s.pinchStart = true;
    } else if (this.pinching && ratio > cfg.pinchReleaseRatio) {
      this.pinching = false;
    }
    s.pinch = this.pinching;

    /* ---------- 3. 张掌：四指（食/中/无名/小指）是否伸展 ---------- */
    // 用"指尖离手腕更远"判断伸展，与手的朝向无关
    var extended = 0;
    var fingers = [
      [LM.INDEX_TIP, LM.INDEX_PIP],
      [LM.MIDDLE_TIP, LM.MIDDLE_PIP],
      [LM.RING_TIP, LM.RING_PIP],
      [LM.PINKY_TIP, LM.PINKY_PIP]
    ];
    for (var i = 0; i < fingers.length; i++) {
      var tipD = dist(landmarks[fingers[i][0]], wrist);
      var pipD = dist(landmarks[fingers[i][1]], wrist);
      if (tipD > pipD * 1.2) extended++;
    }

    var openPalm = extended === 4 && !this.pinching;

    if (openPalm) {
      this.palmHold += dt;
      if (this.palmHold >= cfg.palmHoldSeconds && !this.palmFired) {
        this.palmFired = true;
        s.palmStart = true;
      }
    } else {
      this.palmHold = 0;
      this.palmFired = false;
    }
    s.palm = this.palmHold > 0.15;

    /* ---------- 4. 给界面用的手势标签 ---------- */
    if (this.pinching) {
      s.gesture = '捏合';
    } else if (openPalm) {
      s.gesture = '张开手掌';
    } else if (extended <= 1) {
      s.gesture = '握拳';
    } else {
      s.gesture = '指向';
    }

    return s;
  };

  GestureDetector.LM = LM;
  global.GestureDetector = GestureDetector;

})(window);
