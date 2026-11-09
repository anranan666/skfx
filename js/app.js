/* ===========================================================
   app.js —— 应用装配层（v3 深空防线）
   职责：加载视觉引擎 → 申请摄像头 → 驱动「推理 / 渲染」双循环
        → 把手势事件翻译成游戏操作 → 刷新 HUD 与面板
   =========================================================== */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- DOM ---------------- */
  var canvas = $('game');
  var board = $('board');
  var video = $('cam');
  var previewCanvas = $('preview-canvas');
  var pctx = previewCanvas.getContext('2d');
  var startOverlay = $('start-overlay');
  var overOverlay = $('over-overlay');
  var gestureTag = $('gesture-tag');
  var previewBox = $('preview');
  var statusBox = $('status');
  var statusText = $('status-text');
  var toastBox = $('toast');

  var hud = {
    waveNo: $('hud-wave-no'),
    waveName: $('hud-wave-name'),
    waveTime: $('hud-wave-time'),
    waveBar: $('hud-wave-bar'),
    waveChip: document.querySelector('.wave-chip'),
    score: $('hud-score'),
    combo: $('hud-combo'),
    mult: $('hud-mult'),
    comboWrap: $('hud-combo-wrap'),
    shield: $('hud-shield'),
    shieldBar: $('hud-shield-bar'),
    shieldBox: $('vital-shield'),
    energy: $('hud-energy'),
    energyBar: $('hud-energy-bar'),
    energyBox: document.querySelector('.vital-energy'),
    nova: $('hud-nova'),
    contractCard: $('hud-contract'),
    contractName: $('hud-contract-name'),
    contractDesc: $('hud-contract-desc'),
    contractBonus: $('hud-contract-bonus'),
    contractFill: $('hud-contract-fill'),
    contractProgress: $('hud-contract-progress'),
    hint: $('hud-hint'),
    banner: $('wave-banner'),
    bannerKicker: $('banner-kicker'),
    bannerTitle: $('banner-title'),
    bannerDesc: $('banner-desc')
  };

  /* ---------------- 核心对象 ---------------- */
  var game = new DeepField(canvas);
  var detector = new GestureDetector(CONFIG);

  var mode = 'idle';          // idle | gesture | mouse
  var hands = null;
  var handsReady = false;
  var stream = null;

  var lastLandmarks = null;
  var visionSending = false;
  var visionRunning = false;
  var sendFailures = 0;
  var lastVisionTime = 0;

  var lastTs = performance.now();
  var prevPinch = false;
  var bannerTimer = null;
  var hintTimer = null;
  var bestScore = readBest();

  /* =========================================================
     0. 小工具
     ========================================================= */

  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error(message)); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); },
        function (e) { clearTimeout(timer); reject(e); });
    });
  }

  function readBest() {
    try { return parseInt(localStorage.getItem('deepfield.best.v1') || '0', 10) || 0; }
    catch (e) { return 0; }
  }

  function writeBest(v) {
    try { localStorage.setItem('deepfield.best.v1', String(v)); } catch (e) { /* 隐私模式忽略 */ }
  }

  function setStatus(text, type) {
    statusText.textContent = text;
    statusBox.className = 'status' + (type ? ' ' + type : '');
  }

  function showToast(text, ms) {
    toastBox.textContent = text;
    toastBox.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toastBox.classList.add('hidden'); }, ms || 5000);
  }

  /*
   * 摄像头失败的醒目提示：做成开始面板里的常驻条。
   * 之前只有一个角落 toast，几秒就消失，用户根本注意不到。
   */
  function showCamAlert(title, desc) {
    var box = document.getElementById('cam-alert');
    if (!box) return;
    document.getElementById('cam-alert-title').textContent = title;
    document.getElementById('cam-alert-desc').textContent = desc;
    box.classList.remove('hidden');
  }

  function hideCamAlert() {
    var box = document.getElementById('cam-alert');
    if (box) box.classList.add('hidden');
  }

  function showHint(html, ms) {
    hud.hint.innerHTML = html;
    hud.hint.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { hud.hint.classList.remove('show'); }, ms || 2600);
  }

  function showBanner(kicker, title, desc, ms) {
    hud.bannerKicker.textContent = kicker;
    hud.bannerTitle.textContent = title;
    hud.bannerDesc.textContent = desc || '';
    hud.banner.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () { hud.banner.classList.remove('show'); }, ms || 2400);
  }

  /* =========================================================
     1. 视觉引擎（本地优先 / CDN 兜底）
     ========================================================= */

  var activeBase = CONFIG.mediapipeBase;

  function buildSources() {
    var isHttp = /^https?:$/.test(location.protocol);
    var list = isHttp ? [CONFIG.mediapipeBase] : [];
    return list.concat(CONFIG.mediapipeCdns || []);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.crossOrigin = 'anonymous';
      script.onload = function () {
        window.Hands ? resolve() : reject(new Error('引擎未注册'));
      };
      script.onerror = function () {
        if (script.parentNode) script.parentNode.removeChild(script);
        reject(new Error('脚本加载失败'));
      };
      document.head.appendChild(script);
    });
  }

  function loadMediaPipe() {
    if (window.Hands) return Promise.resolve();
    var sources = buildSources();
    var index = 0;

    function tryNext() {
      if (index >= sources.length) return Promise.reject(new Error('视觉引擎全部加载失败'));
      var base = sources[index++];
      return loadScript(base + '/hands.js').then(function () {
        activeBase = base;
        return base;
      }, tryNext);
    }
    return tryNext();
  }

  /* =========================================================
     2. 摄像头与推理
     ========================================================= */

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error(
        '当前环境无法调用摄像头：浏览器只在 https 或 localhost 下开放摄像头权限。'
        + '可直接用「键鼠模式开局」体验完整玩法。'
      ));
    }

    return navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    }).then(function (s) {
      stream = s;
      video.srcObject = s;
      return video.play();
    });
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    video.srcObject = null;
    lastLandmarks = null;
    handsReady = false;
    prevPinch = false;
    previewBox.classList.add('off');
  }

  function initHands() {
    if (hands) return Promise.resolve();

    return new Promise(function (resolve, reject) {
      try {
        hands = new window.Hands({
          locateFile: function (file) { return activeBase + '/' + file; }
        });

        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: CONFIG.modelComplexity,
          minDetectionConfidence: CONFIG.minDetectionConfidence,
          minTrackingConfidence: CONFIG.minTrackingConfidence
        });

        hands.onResults(function (results) {
          var list = results.multiHandLandmarks;
          lastLandmarks = (list && list.length) ? list[0] : null;
        });

        var warm = hands.initialize ? hands.initialize() : Promise.resolve();
        warm.then(function () { handsReady = true; resolve(); }).catch(reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  // 推理与渲染解耦：推理按固定节拍送帧，渲染始终跑满 60fps
  function visionLoop(ts) {
    requestAnimationFrame(visionLoop);

    if (!handsReady || !stream) return;
    if (ts - lastVisionTime < CONFIG.inferenceIntervalMs) return;
    if (visionSending || video.readyState < 2) return;
    if (sendFailures >= 12) return;

    lastVisionTime = ts;
    visionSending = true;
    hands.send({ image: video })
      .then(function () { sendFailures = 0; })
      .catch(function () {
        sendFailures++;
        if (sendFailures === 10) {
          showToast('手势推理异常，可停止摄像头后切换到键鼠模式。', 9000);
        }
      })
      .then(function () { visionSending = false; });
  }

  /* =========================================================
     3. 主循环：手势 → 操作 → 更新 → 绘制
     ========================================================= */

  function tick(ts) {
    var dt = Math.min(0.05, (ts - lastTs) / 1000) || 0.016;
    lastTs = ts;

    if (mode === 'gesture') {
      var g = detector.update(lastLandmarks, dt);

      if (g.present) {
        game.setPointer(g.x, g.y);
        // 捏合按住 = 蓄能，松手才结算 —— 用边沿判断，避免每帧重复触发
        if (g.pinch && !prevPinch) game.press();
        if (!g.pinch && prevPinch) game.release();
        if (g.palmStart) game.nova();
        game.setGesture(g.gesture);
        prevPinch = g.pinch;
      } else {
        if (prevPinch) game.release();
        prevPinch = false;
        game.setGesture('未检测到手');
      }

      updateGestureTag(g);
      drawPreview(lastLandmarks, g);
    }

    game.update(dt);
    game.draw();

    requestAnimationFrame(tick);
  }

  /* =========================================================
     4. 预览窗与骨架
     ========================================================= */

  var HAND_LINKS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17]
  ];

  function drawPreview(landmarks, gesture) {
    var w = previewCanvas.width;
    var h = previewCanvas.height;

    pctx.clearRect(0, 0, w, h);

    pctx.save();
    pctx.translate(w, 0);
    pctx.scale(-1, 1);
    if (video.readyState >= 2) {
      pctx.drawImage(video, 0, 0, w, h);
    } else {
      pctx.fillStyle = '#10192a';
      pctx.fillRect(0, 0, w, h);
    }
    pctx.restore();

    if (landmarks && landmarks.length === 21) {
      pctx.save();
      pctx.translate(w, 0);
      pctx.scale(-1, 1);

      var pinching = gesture && gesture.pinch;
      pctx.lineWidth = 2;
      pctx.strokeStyle = pinching ? 'rgba(255,212,121,0.95)' : 'rgba(110,230,255,0.9)';
      pctx.beginPath();
      for (var i = 0; i < HAND_LINKS.length; i++) {
        var a = landmarks[HAND_LINKS[i][0]];
        var b = landmarks[HAND_LINKS[i][1]];
        pctx.moveTo(a.x * w, a.y * h);
        pctx.lineTo(b.x * w, b.y * h);
      }
      pctx.stroke();

      pctx.fillStyle = '#ffffff';
      for (var j = 0; j < landmarks.length; j++) {
        pctx.beginPath();
        pctx.arc(landmarks[j].x * w, landmarks[j].y * h, 1.8, 0, Math.PI * 2);
        pctx.fill();
      }
      pctx.restore();
    }
  }

  function updateGestureTag(g) {
    if (!g || !g.present) {
      gestureTag.textContent = '未检测到手';
      gestureTag.dataset.state = 'idle';
      return;
    }
    gestureTag.textContent = g.pinch ? '捏合 · 蓄能中' : g.gesture;
    gestureTag.dataset.state = g.pinch ? 'active' : 'ok';
  }

  /* =========================================================
     5. HUD 刷新（先比对再写 DOM）
     ========================================================= */

  var cache = {};

  function setText(el, key, value) {
    if (cache[key] === value) return false;
    cache[key] = value;
    el.textContent = value;
    return true;
  }

  function setWidth(el, key, pct) {
    var v = Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
    if (cache[key] === v) return;
    cache[key] = v;
    el.style.width = v;
  }

  function bump(el) {
    if (!el || typeof el.animate !== 'function') return;
    el.animate([
      { transform: 'translateY(0) scale(1)' },
      { transform: 'translateY(-2px) scale(1.1)', offset: 0.34 },
      { transform: 'translateY(0) scale(1)' }
    ], { duration: 320, easing: 'cubic-bezier(.16, 1, .3, 1)' });
  }

  game.onStats = function (s) {
    /* 波次 */
    setText(hud.waveNo, 'waveNo', String(s.wave).padStart(2, '0'));
    setText(hud.waveName, 'waveName', s.waveName);
    setText(hud.waveTime, 'waveTime', String(Math.ceil(s.waveTime)));
    setWidth(hud.waveBar, 'waveBar', s.waveProgress * 100);
    var lowTime = s.state === 'playing' && s.waveTime <= 6;
    if (cache.lowTime !== lowTime) {
      cache.lowTime = lowTime;
      hud.waveChip.classList.toggle('low', lowTime);
    }

    /* 分数与连击 */
    if (setText(hud.score, 'score', String(s.score))) {
      if (cache.score > 0) bump(hud.score);
    }
    setText(hud.combo, 'combo', String(s.combo));
    setText(hud.mult, 'mult', '×' + s.mult.toFixed(2));
    var hot = s.combo >= CONFIG.combo.step;
    if (cache.hot !== hot) {
      cache.hot = hot;
      hud.comboWrap.classList.toggle('hot', hot);
    }

    /* 护盾 */
    setText(hud.shield, 'shield', String(s.shield));
    setWidth(hud.shieldBar, 'shieldBar', (s.shield / s.maxShield) * 100);
    var warn = s.shield / s.maxShield < 0.34;
    if (cache.warn !== warn) {
      cache.warn = warn;
      hud.shieldBox.classList.toggle('warn', warn);
    }

    /* 能量 */
    setText(hud.energy, 'energy', String(s.energy));
    setWidth(hud.energyBar, 'energyBar', (s.energy / s.maxEnergy) * 100);
    var empty = s.energy < 10;
    if (cache.empty !== empty) {
      cache.empty = empty;
      hud.energyBox.classList.toggle('empty', empty);
    }

    /* 冲击波 */
    if (cache.nova !== s.nova) {
      cache.nova = s.nova;
      var pips = hud.nova.children;
      for (var i = 0; i < pips.length; i++) {
        pips[i].classList.toggle('spent', i >= s.nova);
      }
    }

    /* 合约 */
    if (s.contract) {
      setText(hud.contractName, 'cName', s.contract.name);
      setText(hud.contractDesc, 'cDesc', s.contract.desc);
      setText(hud.contractBonus, 'cBonus', '+' + s.contract.bonus);

      var hasTarget = s.contract.target > 0;
      var pct = hasTarget ? Math.min(100, (s.contract.progress / s.contract.target) * 100) : 0;
      setWidth(hud.contractFill, 'cFill', pct);
      setText(hud.contractProgress, 'cProg',
        hasTarget ? Math.round(s.contract.progress) + ' / ' + s.contract.target : '保持中');
    }
  };

  /* =========================================================
     6. 游戏事件 → 界面反馈
     ========================================================= */

  game.onEvent = function (e) {
    switch (e.type) {
      case 'waveStart':
        showBanner('WAVE ' + String(e.index + 1).padStart(2, '0') + ' / 0' + e.total,
          e.name, e.brief, 2600);
        if (e.index === 0) showHint('捏合 <b>击破</b>来袭目标，护住中间的星核', 5200);
        break;

      case 'waveClear':
        var parts = [];
        if (e.contract) {
          parts.push(e.contract.done
            ? '合约「' + e.contract.name + '」+ ' + e.contract.bonus
            : '合约「' + e.contract.name + '」未达成');
        }
        parts.push('护盾 +' + e.heal);
        showBanner('WAVE ' + String(e.index + 1).padStart(2, '0') + ' CLEAR',
          '波次清空', parts.join(' · '), 2300);
        break;

      case 'latched':
        showHint('<b>感染体攀附星核！</b>2.6 秒内打掉它，否则孵化', 3000);
        break;

      case 'noEnergy':
        showHint('能量不足 · 停火等回复，或去打<b>金色星屑</b>补能', 2200);
        break;

      case 'decoy':
        showHint('打中<b>诱饵</b>了 —— 灰色虚线圈的目标不要打', 2400);
        break;

      case 'nova':
        if (e.hit === 0) showHint('冲击波放空了 · 每波只有一次', 1900);
        break;

      case 'novaEmpty':
        showHint('冲击波已用尽 · 等波间补给，或改用蓄能炮', 2200);
        break;

      case 'pause':
        // 暂停时收起横幅与提示，把画面让给"已暂停"这句交代
        hud.banner.classList.remove('show');
        hud.hint.classList.remove('show');
        break;
    }
  };

  /* 结算数字滚动，比直接赋值更有"结算"的分量 */
  function countUp(el, to, duration) {
    if (!el || typeof window.requestAnimationFrame !== 'function') {
      if (el) el.textContent = to;
      return;
    }
    var start = 0;
    function step(ts) {
      if (!start) start = ts;
      var p = Math.min(1, (ts - start) / duration);
      el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    }
    el.textContent = '0';
    requestAnimationFrame(step);
  }

  game.onEnd = function (r) {
    var isBest = r.score > bestScore;
    if (isBest) { bestScore = r.score; writeBest(bestScore); }

    $('res-title').textContent = r.won ? '防线守住' : '星核失守';
    $('res-sub').textContent = r.won
      ? r.note + ' · 五波全部通过'
      : r.note + ' · 撑到了第 ' + r.waves + ' 波';
    countUp($('res-score'), r.score, 800);
    $('res-rank').textContent = r.rank;
    $('res-rank').className = 'rank-chip' + (r.won ? '' : ' rank-low');
    $('res-waves').textContent = r.waves + ' / ' + r.totalWaves;
    $('res-kills').textContent = String(r.kills);
    $('res-combo').textContent = String(r.maxCombo);
    $('res-contracts').textContent = r.contracts + ' / ' + r.totalWaves;
    $('res-shield').textContent = String(r.shield);
    $('res-best').textContent = String(bestScore);
    $('res-best-flag').classList.toggle('hidden', !isBest);
    $('res-badge').innerHTML = '<i></i>' + (r.won ? 'Mission Clear' : 'Core Lost');

    setTimeout(function () {
      overOverlay.classList.remove('hidden');
      hud.banner.classList.remove('show');
      hud.hint.classList.remove('show');
    }, r.won ? 1200 : 900);
  };

  /* =========================================================
     7. 开局 / 重开 / 收场
     ========================================================= */

  function beginRound() {
    startOverlay.classList.add('hidden');
    overOverlay.classList.add('hidden');
    cache = {};
    game.start();
    lastTs = performance.now();
    if (mode === 'mouse') {
      showHint('鼠标瞄准 · 左键点按开火 · 按住蓄能 · 空格冲击波', 4600);
    }
  }

  $('btn-camera').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    sendFailures = 0;
    hideCamAlert();
    setStatus('正在启动视觉引擎…', 'warn');

    loadMediaPipe()
      .then(function () {
        setStatus('正在请求摄像头…', 'warn');
        return withTimeout(startCamera(), 20000, '获取摄像头超时：请检查浏览器权限提示');
      })
      .then(function () {
        previewBox.classList.remove('off');
        setStatus('正在加载手势模型…', 'warn');
        return withTimeout(initHands(), 22000, '手势模型加载超时，请检查网络');
      })
      .then(function () {
        mode = 'gesture';
        detector.reset();
        prevPinch = false;
        if (!visionRunning) {
          visionRunning = true;
          requestAnimationFrame(visionLoop);
        }
        setStatus('手势识别中', 'ok');
        beginRound();
      })
      .catch(function (err) {
        setStatus('摄像头未就绪', 'err');
        var name = err && err.name ? err.name : '';
        var blocked = name === 'NotAllowedError' || name === 'SecurityError' ||
          name === ' ' || location.protocol === 'file:';

        if (blocked) {
          showCamAlert(
            '浏览器没有弹出摄像头授权',
            location.protocol === 'file:'
              ? '本地文件（file://）不允许调用摄像头，这是浏览器安全限制。点「键鼠模式开局」玩法完全一致；要演示手势，请用 Chrome 打开在线链接。'
              : '授权弹窗没有出现，多半是页面被嵌在预览窗里。点地址栏左侧的摄像头图标把权限改成「允许」，或直接用 Chrome 打开链接再试。'
          );
        } else {
          showCamAlert('摄像头没有启动', describeError(err));
        }

        showToast(describeError(err), 9000);
        stopCamera();
      })
      .then(function () { btn.disabled = false; });
  });

  $('btn-mouse').addEventListener('click', function () {
    mode = 'mouse';
    previewBox.classList.add('off');
    hideCamAlert();
    setStatus('键鼠模式', 'ok');
    beginRound();
  });

  $('btn-again').addEventListener('click', function () {
    if (mode === 'idle') return;
    if (mode === 'gesture' && !stream) mode = 'mouse';
    beginRound();
  });

  $('btn-stop').addEventListener('click', function () {
    stopCamera();
    mode = 'idle';
    detector.reset();
    overOverlay.classList.add('hidden');
    startOverlay.classList.remove('hidden');
    setStatus('已停止采集', '');
    game.state = 'idle';
    game.reset();
  });

  function describeError(err) {
    var name = err && err.name ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '摄像头权限被拒绝。允许访问后重试，或直接用键鼠模式体验完整玩法。';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '没有检测到可用的摄像头设备，可先用键鼠模式。';
    }
    if (name === 'NotReadableError') {
      return '摄像头被其他程序占用（如会议软件），关闭后再试。';
    }
    return (err && err.message ? err.message : '未知错误') + ' 可先用键鼠模式。';
  }

  /* =========================================================
     8. 键鼠输入
     ========================================================= */

  function pointerFromEvent(e) {
    var rect = board.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var nx = (e.clientX - rect.left) / rect.width;
    var ny = (e.clientY - rect.top) / rect.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
    return { x: nx, y: ny };
  }

  window.addEventListener('pointermove', function (e) {
    if (mode === 'gesture') return;
    var p = pointerFromEvent(e);
    if (p) game.setPointer(p.x, p.y);
  }, { passive: true });

  canvas.addEventListener('pointerdown', function (e) {
    if (mode === 'gesture') return;
    if (!game._isLive()) return;
    var p = pointerFromEvent(e);
    if (p) game.setPointer(p.x, p.y);
    game.press();
    e.preventDefault();
  });

  window.addEventListener('pointerup', function () {
    if (mode === 'gesture') return;
    game.release();
  });

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space') {
      e.preventDefault();
      if (mode !== 'gesture') game.nova();
    } else if (e.code === 'KeyP') {
      if (game.state === 'paused') game.resume();
      else game.pause();
    }
  });

  // 切到后台自动暂停，避免"离开一会儿就失守"
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) game.pause();
  });

  window.addEventListener('beforeunload', stopCamera);

  /* =========================================================
     9. 启动
     ========================================================= */

  function boot() {
    cache = {};
    setStatus('待部署', '');
    game.reset();

    // 关闭按钮
    var close = document.getElementById('cam-alert-close');
    if (close) close.addEventListener('click', hideCamAlert);

    // 本地文件打开时，提前说清楚摄像头为什么用不了
    if (location.protocol === 'file:') {
      setStatus('键鼠可用', 'warn');

      // 摄像头在这个环境下必然失败，把键鼠入口提到主位，否则用户会以为"没有开始的地方"
      var camBtn = $('btn-camera');
      var mouseBtn = $('btn-mouse');
      if (camBtn && mouseBtn) {
        camBtn.classList.remove('btn-primary');
        camBtn.classList.add('btn-ghost');
        camBtn.style.order = '1';
        var camSpan = camBtn.querySelector('span');
        if (camSpan) camSpan.textContent = '摄像头（需网页打开）';

        mouseBtn.classList.remove('btn-ghost');
        mouseBtn.classList.add('btn-primary');
        mouseBtn.style.order = '-1';
        mouseBtn.innerHTML = '<span>开始游戏 · 键鼠</span>' +
          '<svg class="btn-arrow" viewBox="0 0 20 20" fill="none" stroke="currentColor" ' +
          'stroke-width="1.6" aria-hidden="true">' +
          '<path d="M4 10h11M10.5 5.5L15 10l-4.5 4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      }

      showCamAlert(
        '本地文件模式：摄像头不可用',
        '浏览器不允许 file:// 页面调用摄像头。点「开始游戏 · 键鼠」即可玩完整玩法；要展示手势，请用在线链接或本地服务打开。'
      );
    }

    requestAnimationFrame(tick);
  }

  // 控制台调试用：可在 DevTools 里直接驱动一局，方便验收与调参
  window.__APP = { game: game, detector: detector };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
