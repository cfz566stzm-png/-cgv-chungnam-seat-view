/* ===== CGV 3D 시야 뷰어 — 의존성 없는 Canvas 2D 원근 렌더러 =====
   iPhone Safari에서도 부드럽게 돌도록 WebGL·CDN 없이 순수 2D 캔버스로
   실제 상영관을 원근 투영해 그립니다.

   실제 CGV 상영관 사진(2026-11-17 촬영분)에 맞춘 조명·재질:
   · 벽·천장은 거의 검정에 가까운 차콜 음향패널 (패널 이음매만 희미하게 보임)
   · 천장 다운라이트 → 벽면·스크린 상단 모서리에 따뜻한 빛 번짐
   · 좌우 벽 비상구 초록 표시등(EXIT)과 그 번짐
   · 앞열 앞 크롬 난간, 통로 계단 손잡이, 좌석 등받이는 검은 실루엣 + 상단 림라이트
   · 스크린은 영사 빛을 받은 느낌만 살짝 얹고, 화면 그림 자체는 선명하게 유지

   사용:
     var v = Viewer3D.mount(rootEl, {
       p: hall.params, seat: {x, y, key}, rows: hall.rows, tags: hall.tags,
       aspect: 2.39
     });
     v.setAspect(1.9); v.reset(); v.destroy();
*/
(function (global) {
  'use strict';

  var D2R = Math.PI / 180;
  var NEAR = 0.16;
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  /* 색 밝기 조절 — 같은 재질이라도 화면 빛을 받는 정도(행 거리)에 따라 밝기를 달리한다.
     (2026-11-21 좌석 재질감 작업: 색을 하나하나 손으로 만들지 않고 기준색×밝기로 쓴다) */
  function shade(hex, k) {
    var n = parseInt(String(hex).slice(1), 16);
    var r = Math.round(((n >> 16) & 255) * k), g2 = Math.round(((n >> 8) & 255) * k), b2 = Math.round((n & 255) * k);
    return 'rgb(' + (r > 255 ? 255 : r) + ',' + (g2 > 255 ? 255 : g2) + ',' + (b2 > 255 ? 255 : b2) + ')';
  }

  /* 좌우·상하로 아무리 드래그해도 스크린 일부가 항상 시야에 남도록 좁게 잡는다.
     (-115~115도까지 열어 두면 벽만 보이는 빈 화면이 됐다)
     다만 기본 시선·'정면 리셋'은 어느 좌석에서든 스크린 정중앙을 향해야 하므로,
     가장 옆·앞 좌석에서 필요한 각(전국 좌석 기준 yaw ≈ 61°, pitch ≈ 62°)까지는 열어 둔다.
     이보다 좁히면 사이드 좌석의 리셋 각이 잘려 화면 중앙이 아니라 옆벽을 보게 된다. */
  var YAW_MIN = -70, YAW_MAX = 70;
  var PITCH_MIN = -30, PITCH_MAX = 70;

  /* ---------------------------------------------------------------
     0. 관 유형별 좌석 단차(stepM, m) — screens.json _risers와 같은 표
     지점별 도면이 없을 때 쓰는 기본값이다. 근거는 work/cgv/RISER-RESEARCH.md:
     · 국내 「극장 시설 설계 기준」(한국영사예술인협회 기술교서) 앞뒤 슬로프 15~30 cm, 시선 간격 120 mm
     · UNIC 영화관 설계 지침: 시선 여유 150~200 mm, 계단 1단 최대 200 mm 내외(한 행 2~3단)
     · CGV 리클라이너 시공사례(Usit): 단 최대 460 mm까지 대응
     · 법정 기준(영화법 시행규칙 별표1)은 단차를 규정하지 않음
     --------------------------------------------------------------- */
  var RISER_STEP = {
    '일반관': 0.25,
    '아트하우스관': 0.24,
    'SCREENX관': 0.28,
    '4DX관': 0.30,
    '리클라이너관': 0.40,
    '씨네앤포레': 0.20,
    'IMAX관': 0.40
  };
  function typeKey(name, tags) {
    var t = ' ' + (tags || []).join(' ') + ' ';
    if (/IMAX/i.test(t)) return 'IMAX관';
    if (/4DX/.test(t)) return '4DX관';
    if (/SCREENX/.test(t)) return 'SCREENX관';
    if (/리클라이너|PRIVATE BOX/.test(t) || /리클라이너/.test(name || '')) return '리클라이너관';
    if (/씨네앤포레|빈백|카바나/.test(t)) return '씨네앤포레';
    if (/아트하우스/.test(t)) return '아트하우스관';
    return '일반관';
  }

  /* ---------------------------------------------------------------
     1. 스크린에 투사되는 화면(텍스처)
     --------------------------------------------------------------- */
  var frameCache = {};
  function movieFrame(aspect) {
    var key = aspect.toFixed(2);
    if (frameCache[key]) return frameCache[key];
    var W = 720, H = Math.max(220, Math.round(W / aspect));
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var x = c.getContext('2d');
    var horizon = Math.round(H * 0.615);

    /* 하늘 */
    var sky = x.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0.00, '#060A18');
    sky.addColorStop(0.30, '#1A224C');
    sky.addColorStop(0.55, '#4E3462');
    sky.addColorStop(0.74, '#A9534C');
    sky.addColorStop(0.89, '#E28E4F');
    sky.addColorStop(1.00, '#F4C57D');
    x.fillStyle = sky; x.fillRect(0, 0, W, horizon);

    var seed = 20261117;
    function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }

    /* 별 */
    for (var i = 0; i < 110; i++) {
      var sx = rnd() * W, sy = rnd() * horizon * 0.62, r = 0.3 + rnd() * 1.3;
      x.fillStyle = 'rgba(255,255,255,' + (0.12 + rnd() * 0.55).toFixed(2) + ')';
      x.beginPath(); x.arc(sx, sy, r, 0, Math.PI * 2); x.fill();
    }

    /* 해 */
    var sunX = W * 0.635, sunY = horizon * 0.88, sunR = H * 0.045;
    var sg = x.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR * 9);
    sg.addColorStop(0.00, 'rgba(255,244,208,0.95)');
    sg.addColorStop(0.10, 'rgba(255,218,155,0.80)');
    sg.addColorStop(0.34, 'rgba(255,150,92,0.26)');
    sg.addColorStop(1.00, 'rgba(255,120,60,0)');
    x.fillStyle = sg; x.beginPath(); x.arc(sunX, sunY, sunR * 9, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#FFF6D8'; x.beginPath(); x.arc(sunX, sunY, sunR, 0, Math.PI * 2); x.fill();

    /* 먼 능선 */
    function ridge(baseY, amp, step, fill, alpha) {
      x.globalAlpha = alpha;
      x.fillStyle = fill;
      x.beginPath(); x.moveTo(0, horizon + 2);
      var ph = rnd() * 6.28;
      for (var px = 0; px <= W; px += step) {
        var t = px / W * 6.283;
        var yv = baseY - Math.sin(t * 1.7 + ph) * amp - Math.sin(t * 4.3 + ph * 2) * amp * 0.35;
        x.lineTo(px, yv);
      }
      x.lineTo(W, horizon + 2); x.closePath(); x.fill();
      x.globalAlpha = 1;
    }
    ridge(horizon - H * 0.055, H * 0.030, 6, '#3A2A44', 0.85);
    ridge(horizon - H * 0.020, H * 0.022, 5, '#241A2E', 0.95);

    /* 앞쪽 땅 + 물빛 반사 */
    var fg = x.createLinearGradient(0, horizon, 0, H);
    fg.addColorStop(0.00, '#2A1D26');
    fg.addColorStop(0.35, '#140E16');
    fg.addColorStop(1.00, '#05050A');
    x.fillStyle = fg; x.fillRect(0, horizon, W, H - horizon);

    x.globalAlpha = 0.20;
    for (var k = 0; k < 26; k++) {
      var ry = horizon + (H - horizon) * Math.pow(rnd(), 1.5);
      var rw = (30 + rnd() * 150) * (1 - (ry - horizon) / (H - horizon) * 0.5);
      x.fillStyle = 'rgba(255,186,120,' + (0.10 + rnd() * 0.30).toFixed(2) + ')';
      x.fillRect(sunX - rw / 2 + (rnd() - 0.5) * 18, ry, rw, Math.max(1, H * 0.004));
    }
    x.globalAlpha = 1;

    /* 외로운 실루엣 (원경 인물) */
    var pX = sunX - W * 0.085, pY = horizon + H * 0.012, pH = H * 0.085;
    x.fillStyle = 'rgba(9,7,12,0.9)';
    x.beginPath();
    x.arc(pX, pY - pH * 0.86, pH * 0.11, 0, Math.PI * 2); x.fill();
    x.beginPath();
    x.moveTo(pX - pH * 0.20, pY);
    x.lineTo(pX - pH * 0.13, pY - pH * 0.70);
    x.lineTo(pX + pH * 0.13, pY - pH * 0.70);
    x.lineTo(pX + pH * 0.20, pY);
    x.closePath(); x.fill();

    /* 화면 가장자리 살짝 어둡게 (프로젝터 감광) */
    var vig = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.30, W / 2, H / 2, Math.max(W, H) * 0.72);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.32)');
    x.fillStyle = vig; x.fillRect(0, 0, W, H);

    frameCache[key] = c;
    return c;
  }

  /* ---------------------------------------------------------------
     2. 장면(상영관) 기하
     --------------------------------------------------------------- */
  function buildScene(opts) {
    var p = opts.p;
    var seat = opts.seat;
    var rows = opts.rows || [];
    var tags = opts.tags || [];

    /* 단차가 비어 있으면 관 유형 표준값으로 채운다(원본 데이터는 건드리지 않고 복사본 사용) */
    if (!(p.riser > 0.05)) {
      var copy = {}, kk;
      for (kk in p) copy[kk] = p[kk];
      copy.riser = RISER_STEP[typeKey(opts.name, tags)] || 0.25;
      p = copy;
    }

    var cols = p.maxx - p.minx + 1;
    var centerX = (p.minx + p.maxx) / 2;
    var pitch = p.pitch;
    var bankHalf = cols * pitch / 2;
    /* SCREENX는 좌우 윙 스크린이 정면 스크린 모서리에서 뒤쪽으로 벌어지므로 관 폭이 더 넓다.
       (사용자 실사 사진 IMG_7228: 윙이 90° 직각이 아니라 108~112° 둔각으로 벌어져 있다) */
    var isUltraTag = /ULTRA 4DX/i.test(tags.join(' '));
    var isSX = /SCREENX/i.test(tags.join(' ')) || isUltraTag;
    var wingFlare = isSX ? (isUltraTag ? 4.6 : 4.0) : 0;
    var wallX = Math.max(bankHalf + 1.2, p.screenW / 2 + 1.6 + wingFlare);
    /* PRIVATE BOX — 상영관 맨 뒤·위쪽 2층 독립 발코니 박스 안에서 유리창 너머로 아래 객석과
       스크린을 내려다보는 구조(사진 IMG_7229~7233, CGV 압구정 IMAX·영등포/용산 SCREENX 박스).
       박스 전용 관은 석수로 구분하고, 모관에 합친 박스석은 좌석마다 붙은 박스 정보(seat.box)로 판단한다. */
    var bx = (seat && seat.box) ? seat.box : null;
    var isPB = (/PRIVATE BOX/i.test(tags.join(' ')) && (opts.total ? opts.total <= 30 : p.rows <= 3))
      || !!bx || !!(p.boxRows && seat && p.boxRows.indexOf(seat.row) >= 0);
    var pbD = (bx && bx.d != null) ? bx.d : (p.boxD || 0);
    var pbEye = (bx && bx.eye != null) ? bx.eye : (p.boxEye || 0);
    var pbFloor = bx ? (bx.floor || 0) : (p.boxFloor || 0);
    var ceilY = Math.max(p.screenBottom + p.screenH + 2.0, isPB ? 9.0 : 5.6);
    var rearD = p.firstRow + (p.rows - 1) * p.rowGap + ((p._extra && p._extra[p.rows - 1]) || 0) + 2.2;
    /* 발코니·벽면 박스는 관 뒤·밖에 있어 카메라가 관 체적보다 뒤에 있다 → 벽을 카메라 뒤까지 늘린다
       (그러지 않으면 박스에서 보이는 관이 17 m 앞의 작은 상자처럼 보였다) */
    if (isPB && pbD > rearD - 1) rearD = pbD + 2.4;
    /* 발코니 높이·거리 — 줄마다 다른 박스 높이(7층·8층·지하1층…)를 그 줄의 값으로 쓴다 */
    var eyeY = isPB ? ((pbEye || (p.eye + seat.y * p.riser + 2.4)) + pbFloor + (p.eyeDelta || 0)) : (p.eye + seat.y * p.riser);
    var dCam = isPB ? (pbD || (rearD - 0.8)) : (p.firstRow + seat.y * p.rowGap + ((p._extra && p._extra[seat.y]) || 0));

    return {
      p: p, seat: seat, rows: rows,
      cols: cols, centerX: centerX, pitch: pitch,
      bankHalf: bankHalf, wallX: wallX, ceilY: ceilY, rearD: rearD, dCam: dCam,
      wingFlare: wingFlare, isSX: isSX, isPB: isPB, glass: bx ? (bx.glass !== false) : (p.glass !== false),
      cam: { x: (seat.ox != null ? seat.ox : (seat.x - centerX) * pitch), y: eyeY, z: -dCam },
      /* 리클라이너·리클라이너 관 파라미터(params.recliner)면 등받이 높은 좌석으로 그린다 —
         이름이 '8관'이라 태그에 리클라이너가 없는 관도 있다(2026-11-21). */
      recliner: /리클라이너|PRIVATE BOX|릴렉스/.test(tags.join(' ')) || !!(p && p.recliner),
      /* 템퍼 시네마·모션베드 — 침대형 좌석으로 그린다(2026-11-21 "용산 템퍼 시네마 B는 모션베드") */
      isBed: /템퍼|모션베드|TEMPUR|MOTION ?BED/i.test(tags.join(' ') + ' ' + (opts.name || '') + ' ' + (opts.seatName || '')),
      eye: (p.eye > 0.5 ? p.eye : 1.05),
      headDelta: (p.headDelta > 0.1 ? p.headDelta : 0.28)
    };
  }

  /* ---------------------------------------------------------------
     3. 뷰어
     --------------------------------------------------------------- */
  /* 화면 밖에 두는 <video> 한 개를 모든 뷰어가 함께 쓴다.
     (좌석을 바꿀 때마다 새로 만들면 매번 다시 받아 재생이 끊긴다)
     iOS Safari 자동재생 규칙 때문에 muted + playsInline 으로 시작한다. */
  var RECLINE_UP = 110, RECLINE_BACK = 160;   /* 등받이 각도(°) — 정자세 110°, 젖힘 160° */
  var recState = { key: null, v: 0 };

  var sharedVideo = null;
  /* 흐릿한 확장 스크린(윙·천장)은 96×54 로 한 번 줄여 그린 캔버스를 확대 투사한다.
     매 프레임 ctx.filter='blur()' 를 쓰면 모바일에서 프레임이 크게 떨어진다.
     좌우 윙은 '정면 화면 가장자리 조각'을 늘려 그려서, 화면이 벽으로 이어지는 것처럼 보이게 한다. */
  var WING_W = 96, WING_H = 54, wingCv = null, wingL = null, wingR = null;
  /* 아이폰 Safari에서는 <video>를 drawImage로 그릴 때마다 텍스처 업로드가 일어난다.
     24개 타일마다 비디오를 직접 그리면 프레임이 끊기므로, 프레임당 딱 한 번만
     640×360 버퍼에 복사하고 타일은 그 버퍼에서 잘라 쓴다. */
  var VID_W = 512, VID_H = 288, vidBuf = null;
  /* 영상 텍스처가 실제로 캔버스에 올라왔는지 확인하는 계측값.
     iOS Safari에서는 <video>가 재생 중이어도 drawImage 결과가 완전히 비어(알파 0) 있을 때가 있다.
     그때는 검은 화면 대신 정지 화면(그라데이션 배경)을 그대로 보여 준다. */
  var vprobe = { at: 0, bad: 0, broken: false };
  var activeViewer = null;

  /* 버퍼에 실제 프레임이 올라왔는지 알파값으로 확인한다(0.5초에 한 번만 readback)
     iOS Safari·저전력 모드에서는 재생 직후 몇 프레임이 비어 있을 수 있어, 연속 5회(약 2.5초)까지
     기다린 뒤에만 정지 화면으로 넘긴다(예전에는 2회에서 포기해 "영상이 안 나온다"로 보였다). */
  function videoFrameReady(vb) {
    var now = (global.performance && performance.now) ? performance.now() : Date.now();
    if (now - vprobe.at < 500) return !vprobe.broken;
    vprobe.at = now;
    try {
      var c = vb.getContext('2d');
      var pts = [[VID_W * 0.5, VID_H * 0.5], [VID_W * 0.25, VID_H * 0.3], [VID_W * 0.75, VID_H * 0.7]];
      var ok = false;
      for (var i = 0; i < pts.length; i++) {
        var d = c.getImageData(pts[i][0] | 0, pts[i][1] | 0, 1, 1).data;
        if (d[3] > 8) { ok = true; break; }
      }
      if (ok) { vprobe.bad = 0; vprobe.broken = false; }
      else { vprobe.bad += 1; if (vprobe.bad >= 5) vprobe.broken = true; }
    } catch (e) { vprobe.bad = 0; }
    return !vprobe.broken;
  }

  function videoBuffer() {
    if (!vidBuf) {
      vidBuf = document.createElement('canvas');
      vidBuf.width = VID_W; vidBuf.height = VID_H;
    }
    return vidBuf;
  }

  function wingTexture() {
    if (!wingCv) {
      wingCv = document.createElement('canvas');
      wingCv.width = WING_W; wingCv.height = WING_H;
    }
    return wingCv;
  }
  /* 윙 전용 텍스처 — 정면 화면의 가장자리 22%만 떠서 윙 전체로 늘린다.
     (예전에는 화면 전체를 조각내 붙여 윙이 '다른 그림'처럼 보였고 이음매가 눈에 띄었다) */
  function wingEdge(side) {
    var cv = side < 0 ? wingL : wingR;
    if (!cv) {
      cv = document.createElement('canvas');
      cv.width = WING_W; cv.height = WING_H;
      if (side < 0) wingL = cv; else wingR = cv;
    }
    return cv;
  }
  function getVideo(src) {
    if (!sharedVideo) {
      var vd = document.createElement('video');
      vd.muted = true;
      vd.loop = true;
      vd.defaultMuted = true;
      vd.setAttribute('muted', '');
      vd.playsInline = true;
      vd.setAttribute('playsinline', '');
      vd.setAttribute('webkit-playsinline', '');
      vd.preload = 'metadata';
      /* iOS Safari: opacity:0 이거나 display:none 이면 디코딩을 멈추는 경우가 있어
         화면 밖으로 밀지 않고 1px·거의 투명으로 화면 안에 둔다. */
      vd.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:.01;pointer-events:none;z-index:-1;';
      vd.setAttribute('disablepictureinpicture', '');
      vd.addEventListener('error', function () {
        global.__VIDEO_ERROR__ = (vd.error && vd.error.code) || -1;
        var btn = document.querySelector('[data-vid]');
        if (btn) { btn.setAttribute('aria-pressed', 'false'); btn.textContent = '▶ 영상'; }
      });
      document.body.appendChild(vd);
      /* 재생이 실제로 시작되면 탐지값을 초기화하고 화면을 다시 그린다.
         (다른 관/좌석에서 실패했던 탐지값이 남아 영상이 '정지 화면'으로 보이던 문제) */
      vd.addEventListener('playing', function () {
        vprobe.bad = 0; vprobe.broken = false; vprobe.at = 0;
        if (activeViewer && activeViewer.video === vd) {
          activeViewer._vidButton(true);
          if (!activeViewer.raf) activeViewer._loop();
        }
      });
      vd.addEventListener('seeked', function () { vprobe.bad = 0; vprobe.broken = false; });
      sharedVideo = vd;
    }
    var want = src || 'media/preview.mp4';
    if (sharedVideo.getAttribute('data-src') !== want) {
      sharedVideo.setAttribute('data-src', want);
      sharedVideo.setAttribute('src', want);
      try { sharedVideo.load(); } catch (e) {}
    }
    return sharedVideo;
  }

  function Viewer(cv, opts) {
    this.cv = cv;
    this.ctx = cv.getContext('2d');
    this.o = opts;
    this.scene = buildScene(opts);
    this.fov1x = 76;                       // 사람 눈(1배율) 가로 화각 — 실제 체감(넓게 보임)에 맞춤
    this.zoom = '1x';
    this.startPitch = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.vyaw = 0;
    this.vpitch = 0;
    this.drag = null;
    this.raf = 0;
    this.destroyed = false;                 /* destroy() 뒤에 늦게 도착한 프레임이 그리지 않게 */
    this._loopErr = 0;                      /* 연속으로 실패한 프레임 수 — 루프 예외 방어용 */
    this.hallKey = (opts && opts.hallKey) || null;
    this.rot = (opts && opts.rot) || 0;      /* 90이면 캔버스가 가로로 회전된 상태 */
    this.allowRecline = !(opts && opts.allowRecline === false);
    this._rec = (recState.key && recState.key === this.hallKey) ? recState.v : 0;
    this._recTween = null;
    this.videoSrc = (opts && opts.videoSrc) || 'media/preview.mp4';
    this.video = getVideo(this.videoSrc);
    this._bindControls();
    this.resize();
    this.reset(true);
    this.render();
  }

  /* 조작 버튼의 탐색 범위 — 캔버스를 감싸는 .v3d 와, 그 바로 뒤에 붙는 .v3d-bar 를
     함께 본다. 예전에는 .v3d 안에서만 찾아서 '화면 아래 컨트롤 바'의 버튼이
     전부 이벤트를 받지 못했다(영상·화각·리셋·젖히기 모두 무반응). */
  Viewer.prototype._sel = function (sel) {
    var sc = this.scopes || (this.root ? [this.root] : []);
    var out = [];
    for (var i = 0; i < sc.length; i++) {
      if (!sc[i]) continue;
      var list = sc[i].querySelectorAll(sel);
      for (var j = 0; j < list.length; j++) if (out.indexOf(list[j]) < 0) out.push(list[j]);
    }
    return out;
  };
  Viewer.prototype._one = function (sel) {
    var a = this._sel(sel);
    return a.length ? a[0] : null;
  };

  Viewer.prototype._vidButton = function (on) {
    var btn = this._one('[data-vid]');
    if (btn) {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.textContent = on ? '⏸ 영상' : '▶ 영상';
    }
    var mb = this._one('[data-mute]');
    if (mb) {
      mb.style.display = on ? '' : 'none';
      mb.textContent = this.video && this.video.muted ? '🔇' : '🔊';
    }
  };

  Viewer.prototype._paintRecBtn = function () {
    var btn = this._one('[data-recline]');
    var rd = this._one('[data-rec-read]');
    var rec = this._rec || 0;
    this._emitRec();
    if (rd) {
      /* 젖힐수록 눈높이 −12 cm — 내 눈높이 기준으로 숫자만 보여 준다 */
      var eye = this.scene.cam.y - 0.12 * rec;
      rd.textContent = '내 눈높이 ' + eye.toFixed(2) + ' m';
    }
    if (!btn) return;
    var deg = Math.round(RECLINE_UP + (RECLINE_BACK - RECLINE_UP) * rec);
    var ang = btn.querySelector('.v3d-ang');
    if (ang) ang.textContent = deg + '\u00b0';
    btn.setAttribute('aria-pressed', rec > 0.5 ? 'true' : 'false');
    btn.title = rec > 0.5 ? '\ub4f1\ubc1b\uc774 ' + deg + '\u00b0 \u00b7 \ub2e4\uc2dc \ub204\ub974\uba74 \uc815\uc790\uc138' : '\ub4f1\ubc1b\uc774 ' + deg + '\u00b0 \u00b7 \ub4a4\ub85c \uc816\ud600\ubcf4\uae30';
  };

  /* 등받이 각도 변화를 화면 밖(단면도)에도 알린다 — 3D 안에서 젖히면 단면도의 사람·등받이도
     같이 움직이도록 app_v2.js가 'v3d:recline' 이벤트를 받아 단면도를 다시 그린다.
     프레임마다 보내면 캔버스를 너무 자주 그리므로 60ms에 한 번만 보낸다. */
  var _recEvtAt = 0;
  Viewer.prototype._emitRec = function () {
    var now = (global.performance && performance.now) ? performance.now() : Date.now();
    if (now - _recEvtAt < 60) return;
    _recEvtAt = now;
    var rec = this._rec || 0;
    try {
      document.dispatchEvent(new CustomEvent('v3d:recline', {
        detail: { hallKey: this.hallKey, rec: rec, deg: Math.round(RECLINE_UP + (RECLINE_BACK - RECLINE_UP) * rec) }
      }));
    } catch (e) {}
  };

  /* 전체 젖히기/세우기 — 전동 리클라이너처럼 '일정한 속도'로 4초 동안(초당 12.5°) 움직인다.
     가속 곡선(easeInOutCubic)을 쓰면 중간에 확 빨라져 모터가 튀는 느낌이 났다. */
  Viewer.prototype.toggleRecline = function () {
    if (!this.allowRecline) return;
    var target = (this._rec || 0) > 0.5 ? 0 : 1;
    this._recTween = { t0: performance.now(), dur: 4000, from: this._rec || 0, to: target };
    recState.key = this.hallKey; recState.v = target;
    if (!this.raf) this._loop();
    this._paintRecBtn();
  };

  /* 10°씩 미세 조절 — 110°~160° 범위 안에서 0.7초 등속으로 스르륵 */
  Viewer.prototype.nudgeRecline = function (dir) {
    if (!this.allowRecline) return;
    var deg = RECLINE_UP + (RECLINE_BACK - RECLINE_UP) * (this._rec || 0);
    /* 진행 중인 트윈이 있으면 그 도착점을 기준으로 한 칸 더 */
    if (this._recTween) deg = RECLINE_UP + (RECLINE_BACK - RECLINE_UP) * this._recTween.to;
    var next = Math.max(RECLINE_UP, Math.min(RECLINE_BACK, Math.round(deg / 10) * 10 + dir * 10));
    if (Math.abs(next - deg) < 0.5 && this._recTween) return;   /* 이미 그 각도로 가는 중 */
    var to = (next - RECLINE_UP) / (RECLINE_BACK - RECLINE_UP);
    this._recTween = { t0: performance.now(), dur: 700, from: this._rec || 0, to: to };
    recState.key = this.hallKey; recState.v = to;
    if (!this.raf) this._loop();
    this._paintRecBtn();
  };

  Viewer.prototype.toggleVideo = function () {
    var self = this, v = this.video;
    if (!v) return;
    /* 다시 누르면 한 번 더 기회를 준다(재생 재시도 후 프레임이 올라올 수 있다) */
    if (v.paused) { vprobe.bad = 0; vprobe.broken = false; vprobe.at = 0; }
    if (v.paused) {
      try { v.muted = true; } catch (e) {}
      /* 앞선 요청이 끊겨 오류 상태로 남은 <video>는 재생이 되지 않는다 — 소스를 다시 물린다 */
      if (v.error) {
        try { v.removeAttribute('src'); } catch (e) {}
        try { v.load(); } catch (e) {}
        var want = this.videoSrc || 'media/preview.mp4';
        v.setAttribute('data-src', want);
        v.setAttribute('src', want);
        try { v.load(); } catch (e) {}
      }
      /* 메타데이터만 받아 둔 상태에서 재생을 누르면 iOS는 한 번 더 load()가 필요하다 */
      if (v.readyState === 0) { try { v.load(); } catch (e) {} }
      try { v.preload = 'auto'; } catch (e) {}
      var pr = v.play();
      this._vidButton(true);
      this._loop();
      if (pr && pr.then) {
        pr.then(function () { self._vidButton(true); self._loop(); })
          .catch(function () { self._vidButton(false); self.render(); });
      }
    } else {
      try { v.pause(); } catch (e) {}
      this._vidButton(false);
      this.render();
    }
  };

  Viewer.prototype.toggleMute = function () {
    var v = this.video;
    if (!v) return;
    v.muted = !v.muted;
    var mb = this._one('[data-mute]');
    if (mb) { mb.textContent = v.muted ? '🔇' : '🔊'; mb.setAttribute('aria-pressed', v.muted ? 'true' : 'false'); }
  };

  Viewer.prototype.setAspect = function (a) {
    this.o.aspect = a;
    this.render();
  };

  /* 이 좌석에서 스크린 정중앙이 보이는 방향(도) — 기본 시선과 '정면 리셋'이 함께 쓴다.
     상영관 정면 축(yaw 0)이 아니라 스크린 중앙 좌표 (0, 화면 세로 중앙, 스크린 평면 z=0)를
     카메라에서 바라본 각을 계산하므로, 사이드 열은 yaw가, 앞줄은 pitch가 그만큼 커진다.
     등받이를 젖힌 상태(눈 12cm 아래·시선 15° 위)도 반영해 실제 시선이 중앙에 오게 한다. */
  Viewer.prototype.centerGaze = function () {
    var s = this.scene;
    var rec = this._rec || 0;
    var camY = s.cam.y - 0.12 * rec;
    var dx = -s.cam.x, dz = -s.cam.z;              /* 카메라 → 스크린 중앙 */
    var dist = Math.sqrt(dx * dx + dz * dz);
    var cy = s.p.screenBottom + s.p.screenH / 2;
    return {
      yaw: Math.atan2(dx, dz) / D2R,
      pitch: Math.atan2(cy - camY, dist) / D2R - 15 * rec
    };
  };

  /* 스크린 중앙 응시 위치로 */
  Viewer.prototype.reset = function (instant) {
    var g = this.centerGaze();
    var y1 = clamp(g.yaw, YAW_MIN, YAW_MAX);
    var p1 = clamp(g.pitch, PITCH_MIN, PITCH_MAX);
    if (instant) { this.yaw = y1; this.pitch = p1; this.vyaw = this.vpitch = 0; this._tween = null; return; }
    this._tween = { t0: performance.now(), y0: this.yaw, p0: this.pitch, y1: y1, p1: p1 };
    if (!this.raf) this._loop();
  };

  /* 애니메이션 루프 — 여기서 지켜야 할 두 가지 (2026-11-21 코드 검수 반영)
     ① 프레임 안에서 무슨 일이 나도 다음 프레임은 반드시 다시 걸린다.
        예전에는 requestAnimationFrame 약속을 잡은 뒤 그 안에서 트윈 계산·버튼 갱신 같은 코드가
        한 번 터지면 다음 프레임을 거는 줄에 닿지 못해 루프가 영영 멈췄다(영상은 흐르는데 화면만
        멈춘 정지 그림 — 사용자 제보: ▶ 영상이 재생되지 않음).
     ② 한 번의 일시 오류(영상 첫 프레임 미도착·캔버스 상태 변화 등)로 바로 포기하지 않는다.
        몇 프레임은 이어서 그려 회복을 기다리고, 연속 LOOP_MAX_ERR 프레임(약 0.5초) 동안 계속
        터지면 그때만 안전하게 멈춘 뒤 콘솔에 한 줄 남긴다. 멈춘 뒤에도 드래그·영상·리셋 같은
        다음 조작이 루프를 다시 걸면 그때 새로 시도한다. */
  var LOOP_MAX_ERR = 30;

  Viewer.prototype._loop = function () {
    var self = this;
    if (this.raf || this.destroyed) return;      /* 이미 돌고 있으면 새로 걸지 않는다 */
    this.raf = requestAnimationFrame(function () { self._tick(); });
  };

  /* 프레임 한 장 — 예외는 모두 여기서 받아 내고, 다음 프레임 스케줄은 이 함수가 책임진다 */
  Viewer.prototype._tick = function () {
    var self = this;
    self.raf = 0;
    if (self.destroyed) return;
    var again = false;
    try {
      again = self._frame();
      self._loopErr = 0;                  /* 끝까지 그렸으면 연속 오류 횟수 초기화 */
    } catch (err) {
      again = self._frameErr(err);
    } finally {
      self._inVid = false;
      self._lastPaint = performance.now();
    }
    if (again && !self.destroyed) self._loop();
  };

  /* 프레임이 터졌을 때 — 계속 이어 그릴지(true) 멈출지(false)를 정한다 */
  Viewer.prototype._frameErr = function (err) {
    var n = (this._loopErr = (this._loopErr || 0) + 1);
    if (n === 1) {
      console.warn('[영시미 3D] 프레임을 그리지 못했어요 — 다음 프레임에서 다시 시도합니다.', err);
    } else if (n === LOOP_MAX_ERR) {
      console.warn('[영시미 3D] 그리기 오류가 ' + n + '프레임 이어져 애니메이션을 잠시 멈춥니다. 화면을 다시 만지면 새로 시작합니다.', err);
    }
    return n < LOOP_MAX_ERR;
  };

  /* 한 프레임의 계산과 그리기 — 다음 프레임이 필요하면 true */
  Viewer.prototype._frame = function () {
    var self = this;
    /* 비교창(light)처럼 여러 화면을 동시에 띄울 때는 드래그 중 프레임을 30fps 선으로 묶어
       끊김을 줄인다. 손을 떼면 바로 전체 프레임으로 돌아간다. */
    if (self.drag && self.o && self.o.light) {
      var now0 = performance.now();
      if (self._lastPaint && now0 - self._lastPaint < 28) return true;
    }
    var moved = false;
    if (self._tween) {
      var k = (performance.now() - self._tween.t0) / 320;
      if (k >= 1) { k = 1; }
      var e = 1 - Math.pow(1 - k, 3);
      self.yaw = self._tween.y0 + (self._tween.y1 - self._tween.y0) * e;
      self.pitch = self._tween.p0 + (self._tween.p1 - self._tween.p0) * e;
      moved = true;
      if (k === 1) self._tween = null;
    } else {
      self.yaw += self.vyaw; self.pitch += self.vpitch;
      self.vyaw *= 0.90; self.vpitch *= 0.90;
      if (Math.abs(self.vyaw) < 0.02 && Math.abs(self.vpitch) < 0.02) { self.vyaw = self.vpitch = 0; }
      else moved = true;
    }
    if (self._recTween) {
      var rk = (performance.now() - self._recTween.t0) / self._recTween.dur;
      if (rk > 1) rk = 1;
      /* 선형(등속) — 중간에 가속하지 않고 전동 모터처럼 일정한 속도로 */
      var re = rk;
      self._rec = self._recTween.from + (self._recTween.to - self._recTween.from) * re;
      self._paintRecBtn();
      moved = true;
      if (rk === 1) { self._rec = self._recTween.to; self._recTween = null; self._paintRecBtn(); }
    }
    /* 드래그 중이거나 영상이 재생 중이면 매 프레임 계속 그린다 */
    if (self.drag) moved = true;
    if (self.video && !self.video.paused) moved = true;
    self.yaw = clamp(self.yaw, YAW_MIN, YAW_MAX);
    self.pitch = clamp(self.pitch, PITCH_MIN, PITCH_MAX);
    self.dirty = false;
    self._inVid = true;
    try { self.render(); }
    finally { self._inVid = false; }
    return moved;
  };

  Viewer.prototype._bindControls = function () {
    var self = this, cv = this.cv;
    this.pointers = this.pointers || {};
    this._onDown = function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      self.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(self.pointers);
      if (ids.length >= 2) {
        var a = self.pointers[ids[0]], b = self.pointers[ids[1]];
        self.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), fov: self.fov1x };
        self.drag = null;
      } else {
        self.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
        self.vyaw = self.vpitch = 0; self._tween = null;
      }
      try { cv.setPointerCapture(e.pointerId); } catch (err) {}
      var hint = self.root && self.root.querySelector('.v3d-hint');
      if (hint) hint.classList.add('off');
      e.preventDefault();
    };
    this._onMove = function (e) {
      if (!self.pointers[e.pointerId]) return;
      self.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(self.pointers);
      if (ids.length >= 2 && self.pinch) {
        var a = self.pointers[ids[0]], b = self.pointers[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        self.fov1x = clamp(self.pinch.fov * self.pinch.d / d, 36, 96);
        self.render();
        e.preventDefault();
        return;
      }
      if (!self.drag || e.pointerId !== self.drag.id) return;
      /* 마우스는 DPI·감도가 기기마다 달라 같은 계수를 쓰면 너무 빨리 돌아간다.
         터치(0.20)는 그대로 두고 마우스만 절반 이하로 낮춰 정밀하게 조작되게 한다. */
      var sens = (e.pointerType === 'mouse') ? 0.085 : 0.20;
      var dx = e.clientX - self.drag.x, dy = e.clientY - self.drag.y;
      self.drag.x = e.clientX; self.drag.y = e.clientY;
      if (self.rot === 90) { var tdx = dy, tdy = -dx; dx = tdx; dy = tdy; }   /* 회전 보정 */
      self.yaw = clamp(self.yaw + dx * sens, YAW_MIN, YAW_MAX);
      self.pitch = clamp(self.pitch - dy * sens, PITCH_MIN, PITCH_MAX);
      self.vyaw = dx * sens * 0.45;
      self.vpitch = -dy * sens * 0.45;
      self.dirty = true;                  /* 그리기는 rAF 루프 한 곳에서만 */
      if (!self.raf) self._loop();
      e.preventDefault();
    };
    this._onUp = function (e) {
      delete self.pointers[e.pointerId];
      if (Object.keys(self.pointers).length < 2) self.pinch = null;
      if (!self.drag || e.pointerId !== self.drag.id) return;
      self.drag = null;
      if ((Math.abs(self.vyaw) > 0.02 || Math.abs(self.vpitch) > 0.02) && !self.raf) self._loop();
    };
    cv.addEventListener('pointerdown', this._onDown, { passive: false });
    cv.addEventListener('pointermove', this._onMove, { passive: false });
    cv.addEventListener('pointerup', this._onUp);
    cv.addEventListener('pointercancel', this._onUp);
    cv.addEventListener('touchstart', function (e) { if (e.touches.length > 1) return; }, { passive: true });
  };

  Viewer.prototype.resize = function () {
    var cv = this.cv;
    /* 회전(라이트박스 가로모드)된 요소는 getBoundingClientRect가 회전된 바깥 상자를
       돌려주므로 레이아웃 크기(offsetWidth/Height)를 쓴다. */
    var cssW = Math.round(cv.offsetWidth || 0);
    var cssH = Math.round(cv.offsetHeight || 0);
    if (!cssW) { cssW = 320; cssH = 200; }
    if (!cssH) cssH = Math.round(cssW * 0.62);
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    /* light — 비교창의 작은 3D 4개를 동시에 돌리기 위한 저해상도 모드.
       화면에 보이는 크기가 작아 육안 차이가 없고, 그리는 픽셀 수가 1/3로 줄어 끊김이 사라진다. */
    var maxW = 1080, maxH = 760;
    if (this.o && this.o.light) { dpr = 1; maxW = 640; maxH = 480; }
    var w = Math.min(maxW, Math.round(cssW * dpr));
    var h = Math.min(maxH, Math.round(cssH * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    this.W = cv.width; this.H = cv.height;
    this.render();
  };

  /* ---- 렌더 ---- */
  Viewer.prototype.render = function () {
    var cv = this.cv, ctx = this.ctx, s = this.scene, o = this.o;
    var W = cv.width, H = cv.height;
    if (!W || !H) return;
    var self = this;
    var fovH = this.zoom === 'wide'
      ? 2 * Math.atan(2 * Math.tan(this.fov1x / 2 * D2R)) / D2R
      : this.fov1x;
    var f = (W / 2) / Math.tan(fovH * D2R / 2);
    var cam = s.cam;
    var cyaw = Math.cos(this.yaw * D2R), syaw = Math.sin(this.yaw * D2R);
    /* 등받이를 젖히면(recline 0→1) 눈높이가 12cm 내려가고 시선이 15도 위로 넘어간다 */
    var rec = this._rec || 0;
    var pitchEff = this.pitch + 15 * rec;
    var cpit = Math.cos(pitchEff * D2R), spit = Math.sin(pitchEff * D2R);
    var camY = cam.y - 0.12 * rec;

    function toCam(x, y, z) {
      var dx = x - cam.x, dy = y - camY, dz = z - cam.z;
      var xc = dx * cyaw - dz * syaw;
      var z0 = dx * syaw + dz * cyaw;
      var yc = dy * cpit - z0 * spit;
      var zc = dy * spit + z0 * cpit;
      return [xc, yc, zc];
    }
    function sx(t) { return W / 2 + f * t[0] / t[2]; }
    function sy(t) { return H / 2 - f * t[1] / t[2]; }

    function clipNear(poly) {
      var out = [], n = poly.length;
      for (var i = 0; i < n; i++) {
        var a = poly[i], b = poly[(i + 1) % n];
        var ain = a[2] >= NEAR, bin = b[2] >= NEAR;
        if (ain) out.push(a);
        if (ain !== bin) {
          var t = (NEAR - a[2]) / (b[2] - a[2]);
          out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
        }
      }
      return out;
    }

    /* 카메라 좌표 폴리곤을 텍스처 근평면(NEAR_C)에서 자른다 */
    function clipNearC(poly) {
      var out = [], n = poly.length, EPS = 1e-6;
      for (var i = 0; i < n; i++) {
        var a = poly[i], b = poly[(i + 1) % n];
        var ain = a[2] >= NEAR_C, bin = b[2] >= NEAR_C;
        if (ain) out.push(a);
        if (ain !== bin) {
          var dz = b[2] - a[2];
          var t = Math.abs(dz) < EPS ? 0 : (NEAR_C - a[2]) / dz;
          out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR_C]);
        }
      }
      return out;
    }

    function path(poly) {
      var p = clipNear(poly);
      if (p.length < 3) return false;
      ctx.beginPath();
      var q = p[0];
      ctx.moveTo(sx(q), sy(q));
      for (var i = 1; i < p.length; i++) { q = p[i]; ctx.lineTo(sx(q), sy(q)); }
      ctx.closePath();
      return true;
    }
    function face(pts, fill, stroke, lw) {
      if (!path(pts)) return;
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1; ctx.stroke(); }
    }
    /* 여러 폴리곤을 한 경로로 묶어 한 번에 채운다 — 좌석 부품(등받이·머리받침·좌판·팔걸이)을
       좌석마다 따로 채우면 프레임당 수천 번이 되어 끊긴다. 한 줄에서 같은 부품은 같은 색이므로 묶어도 같다. */
    function fillBatch(list, style) {
      if (!list || !list.length) return;
      ctx.beginPath();
      var any = false;
      for (var q = 0; q < list.length; q++) {
        var pl = clipNear(list[q]);
        if (pl.length < 3) continue;
        ctx.moveTo(sx(pl[0]), sy(pl[0]));
        for (var v = 1; v < pl.length; v++) ctx.lineTo(sx(pl[v]), sy(pl[v]));
        ctx.closePath();
        any = true;
      }
      if (!any) return;
      ctx.fillStyle = style;
      ctx.fill();
    }
    /* 원근이 살아 있는 선(난간·이음매·유도선) — 카메라 뒤로 넘어가는 부분은 잘라서 긋는다 */
    function seg(a, b, color, lw) {
      if (a[2] < NEAR && b[2] < NEAR) return;
      var p1 = a, p2 = b;
      if (p1[2] < NEAR) {
        var t1 = (NEAR - a[2]) / (b[2] - a[2]);
        p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1, NEAR];
      }
      if (p2[2] < NEAR) {
        var t2 = (NEAR - b[2]) / (a[2] - b[2]);
        p2 = [b[0] + (a[0] - b[0]) * t2, b[1] + (a[1] - b[1]) * t2, NEAR];
      }
      ctx.strokeStyle = color; ctx.lineWidth = lw || 1; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(sx(p1), sy(p1)); ctx.lineTo(sx(p2), sy(p2)); ctx.stroke();
    }
    /* 벽·천장에 떨어지는 빛 번짐 — additive로 얹어 어두운 패널 위에서만 은은하게 보이게.
       maxPx를 주면 화면상 지름에 상한을 둔다(가까운 벽의 표시등이 시야를 덮지 않게). */
    function pool(c, radius, rgb, alpha, squash, maxPx) {
      if (c[2] < NEAR) return;
      var px = sx(c), py = sy(c);
      var r = Math.max(4, f * radius / c[2]);
      if (maxPx) r = Math.min(r, maxPx);
      if (r < 1) return;
      var g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, 'rgba(' + rgb + ',' + alpha.toFixed(3) + ')');
      g.addColorStop(0.38, 'rgba(' + rgb + ',' + (alpha * 0.45).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + rgb + ',0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(px, py);
      if (squash) ctx.scale(1, squash);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    /* 이미지 셀 매핑 — 사각형을 삼각형 2개로 나눠 각각 정확한 아핀 변환으로 그린다.
       (사각형 하나를 아핀으로 그리면 네 번째 꼭짓점이 어긋나 이웃 셀 사이에 틈이 생겼음) */
    /* readyState 2(HAVE_CURRENT_DATA) 미만이면 첫 프레임이 아직 없어 검게 그려진다.
       그래서 영상이 준비되지 않았으면 영상 대신 그라데이션 정지 화면을 쓴다. */
    var vplay = !!(this.video && !this.video.paused && this.video.readyState >= 2
      && this.video.videoWidth > 0 && !vprobe.broken);
    var still = movieFrame(o.aspect || s.p.aspect);
    var img = vplay ? this.video : still;
    if (vplay && !this._inVid && !this.raf) this._loop();
    function affTri(P0, P1, P2, S0, S1, S2) {
      var dux = S1[0] - S0[0], duy = S1[1] - S0[1];
      var dvx = S2[0] - S0[0], dvy = S2[1] - S0[1];
      var det = dux * dvy - duy * dvx;
      if (!det || Math.abs(det) < 1e-9) return null;
      var e1x = P1[0] - P0[0], e1y = P1[1] - P0[1];
      var e2x = P2[0] - P0[0], e2y = P2[1] - P0[1];
      var a = (e1x * dvy - e2x * duy) / det;
      var b = (e1y * dvy - e2y * duy) / det;
      var c = (-e1x * dvx + e2x * dux) / det;
      var d = (-e1y * dvx + e2y * dux) / det;
      return [a, b, c, d, P0[0] - a * S0[0] - c * S0[1], P0[1] - b * S0[0] - d * S0[1]];
    }
    function triTex(P0, P1, P2, S0, S1, S2, img, alpha, rect) {
      var M = affTri(P0, P1, P2, S0, S1, S2);
      if (!M) return;
      if (alpha != null) ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = true;
      ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      ctx.drawImage(img, rect[0], rect[1], rect[2], rect[3], rect[0], rect[1], rect[2], rect[3]);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }
    /* ---- 근평면(z>=0.4) 클리핑 + 삼각형 클립 아핀 텍스처 ----
       윙·천장처럼 카메라 가까이/옆으로 뻗는 판은 네 꼭짓점 중 일부가 카메라 뒤로
       넘어가 투영이 폭발해 초록 조각으로 찢어졌다. 판을 세그먼트로 나누고,
       각 조각을 근평면에서 잘라낸 뒤 삼각형마다 클립해 그리면 겹침·튐이 없다. */
    var NEAR_C = 0.15;
    /* 클립 경로를 바깥으로 d px 넉넉하게 밀어낸 다각형.
       Canvas 2D의 clip은 경계에서 안티앨리어싱으로 알파가 반쯤 깎여, 이웃한 칸/삼각형이
       딱 맞물리면 그 선이 검은 실선(hairline)으로 비쳤다. 가장자리를 d만큼 겹쳐 그리면
       양쪽 모두 경계 안쪽에서 불투명하게 칠해져 실선이 사라진다. */
    function offsetPoly(pts, d) {
      var n = pts.length, cx = 0, cy = 0, i;
      for (i = 0; i < n; i++) { cx += pts[i][0]; cy += pts[i][1]; }
      cx /= n; cy /= n;
      var area = 0;
      for (i = 0; i < n; i++) {
        var q = pts[(i + 1) % n];
        area += pts[i][0] * q[1] - q[0] * pts[i][1];
      }
      if (Math.abs(area * 0.5) < 1.5) return pts.slice();   /* 거의 0면적: 그대로 */
      var out = [];
      for (i = 0; i < n; i++) {
        var prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
        var n1 = edgeNormal(prev, cur, cx, cy), n2 = edgeNormal(cur, next, cx, cy);
        var bx = n1[0] + n2[0], by = n1[1] + n2[1], bl = Math.sqrt(bx * bx + by * by);
        if (bl < 1e-6) { out.push([cur[0], cur[1]]); continue; }
        bx /= bl; by /= bl;
        var cosHalf = bx * n1[0] + by * n1[1];
        var s = d / Math.max(0.35, cosHalf);
        out.push([cur[0] + bx * s, cur[1] + by * s]);
      }
      return out;
    }
    function edgeNormal(a, b, cx, cy) {
      var ex = b[0] - a[0], ey = b[1] - a[1], L = Math.sqrt(ex * ex + ey * ey) || 1;
      var nx = ey / L, ny = -ex / L;
      var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
      return [nx, ny];
    }
    function triClip(P0, P1, P2, S0, S1, S2, img, alpha, rect) {
      var M = affTri(P0, P1, P2, S0, S1, S2);
      if (!M) return;
      var e = offsetPoly([P0, P1, P2], 2.0);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(e[0][0], e[0][1]); ctx.lineTo(e[1][0], e[1][1]); ctx.lineTo(e[2][0], e[2][1]);
      ctx.closePath(); ctx.clip();
      if (alpha != null) ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = true;
      ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      ctx.drawImage(img, rect[0], rect[1], rect[2], rect[3], rect[0], rect[1], rect[2], rect[3]);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    /* 사각형(카메라좌표 4점 + 텍스처 uv 4점)을 근평면에서 자른 뒤 삼각분할 */
    function quadTex(cam4, uv4, img, alpha, full) {
      var poly = [], n = 4, i;
      for (i = 0; i < n; i++) poly.push({ p: cam4[i], uv: uv4[i] });
      var out = [];
      for (i = 0; i < n; i++) {
        var a = poly[i], b = poly[(i + 1) % n];
        var ain = a.p[2] >= NEAR_C, bin = b.p[2] >= NEAR_C;
        if (ain) out.push(a);
        if (ain !== bin) {
          var t = (NEAR_C - a.p[2]) / (b.p[2] - a.p[2]);
          out.push({
            p: [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t, NEAR_C],
            uv: [a.uv[0] + (b.uv[0] - a.uv[0]) * t, a.uv[1] + (b.uv[1] - a.uv[1]) * t]
          });
        }
      }
      if (out.length < 3) return;
      var sc = out.map(function (q) { return [sx(q.p), sy(q.p)]; });
      for (i = 1; i + 1 < out.length; i++) {
        triClip(sc[0], sc[i], sc[i + 1], out[0].uv, out[i].uv, out[i + 1].uv, img, alpha, full);
      }
    }

    function texCell(uv, img, alpha) {
      var pts = uv.pts;
      /* 타일을 잘게 나눌수록 원근 근사 오차(기울기 불연속)가 줄어 이음매가 옅어진다.
         서브픽셀 겹침은 타일 사이 안티앨리어싱 틈만 메운다. */
      /* 인접 조각과 1px 남짓 겹쳐 그린다 — 스트립 경계에 생기던 세로 이음새 제거 */
      var pad = 1.1;
      var sx0 = uv.sx0 - pad, sy0 = uv.sy0 - pad, sw = uv.sw + pad * 2, sh = uv.sh + pad * 2;
      var s00 = [sx0, sy0], s10 = [sx0 + sw, sy0], s11 = [sx0 + sw, sy0 + sh], s01 = [sx0, sy0 + sh];
      var rc = [sx0, sy0, sw, sh];
      /* 네 점이 모두 근평면 앞이면 빠른 두 삼각형 경로 */
      if (pts[0][2] >= NEAR_C && pts[1][2] >= NEAR_C && pts[2][2] >= NEAR_C && pts[3][2] >= NEAR_C) {
        var p0 = [sx(pts[0]), sy(pts[0])], p1 = [sx(pts[1]), sy(pts[1])];
        var p2 = [sx(pts[2]), sy(pts[2])], p3 = [sx(pts[3]), sy(pts[3])];
        triTex(p0, p1, p2, s00, s10, s11, img, alpha, rc);
        triTex(p0, p2, p3, s00, s11, s01, img, alpha, rc);
        return;
      }
      /* 일부만 근평면을 걸치면 타일을 통째로 버리지 않고 근평면에서 잘라 그린다.
         (좌우로 끝까지 돌리면 앞줄·측면 좌석에서 스크린이 사라지던 원인) */
      quadTex(pts, [s00, s10, s11, s01], img, alpha, rc);
    }

    var p = s.p, wallX = s.wallX, ceilY = s.ceilY, rearD = s.rearD;
    var isImax = /IMAX/i.test((o.tags || []).join(' '));
    /* IMAX는 정중앙 1배율에서 실측보다 크게 느껴진다 — 그리는 크기만 살짝 줄인다(실측값은 데이터에 그대로) */
    var rScale = (p.renderScale > 0.5 && p.renderScale < 1.2) ? p.renderScale : 1;
    var scrW = p.screenW * rScale, scrH = p.screenH * rScale, scrB = p.screenBottom;
    /* IMAX는 곡면 스크린의 휘어짐을 조금 더 살려 압도감을 준다(각도·거리 계산은 그대로) */
    var curve = (p.curve || 0) * (isImax ? 1.18 : 1);
    function scrZ(u) { var r = 2 * u / scrW; return -(curve * r * r); }

    /* ---- 바탕: 상영관 안쪽은 거의 검정 ---- */
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#050607');
    bg.addColorStop(0.62, '#070809');
    bg.addColorStop(1, '#040505');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    /* ---- 천장 ---- */
    face([toCam(-wallX, ceilY, 0), toCam(wallX, ceilY, 0), toCam(wallX, ceilY, -rearD), toCam(-wallX, ceilY, -rearD)], '#0B0C0D');
    for (var cz = -2.0; cz > -rearD; cz -= 3.0) {
      seg(toCam(-wallX, ceilY, cz), toCam(wallX, ceilY, cz), 'rgba(150,158,162,0.045)', 1);
    }

    /* ---- 옆벽: 차콜 음향 패널 + 이음매 ---- */
    [-1, 1].forEach(function (sgn) {
      var xw = sgn * wallX;
      /* 벽면 기본 톤은 위쪽이 아주 약간 밝다(천장 반사) */
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#15171A');
      g.addColorStop(0.45, '#0F1113');
      g.addColorStop(1, '#0B0C0E');
      face([toCam(xw, 0, 0), toCam(xw, 0, -rearD), toCam(xw, ceilY, -rearD), toCam(xw, ceilY, 0)], null);
      if (path([toCam(xw, 0, 0), toCam(xw, 0, -rearD), toCam(xw, ceilY, -rearD), toCam(xw, ceilY, 0)])) {
        ctx.fillStyle = g; ctx.fill();
      }
      /* 음향 패널 세로 리브 — 0.55 m 간격의 아주 옅은 세로선이 벽을 조용한 건축면으로 만든다
         (2026-11-21 «클린 미니멀 3D»: 벽은 깨끗한 다크 패널 + 세로 리브만) */
      for (var z = -0.55; z > -rearD; z -= 0.55) {
        seg(toCam(xw * 0.998, 0.0, z), toCam(xw * 0.998, ceilY, z), 'rgba(158,172,186,0.022)', 1);
      }
      /* 패널 이음매 — 세로 2.0 m마다 한 줄만 살짝 진하게 */
      for (var z2 = -2.0; z2 > -rearD; z2 -= 2.0) {
        seg(toCam(xw * 0.998, 0.0, z2), toCam(xw * 0.998, ceilY, z2), 'rgba(168,180,194,0.040)', 1);
      }
      [2.55].forEach(function (yy) {
        if (yy < ceilY) seg(toCam(xw * 0.998, yy, 0), toCam(xw * 0.998, yy, -rearD), 'rgba(168,176,180,0.026)', 1);
      });
      /* 벽 하단 어두운 몰딩 */
      face([toCam(xw * 0.998, 0, 0), toCam(xw * 0.998, 0, -rearD),
            toCam(xw * 0.998, 0.16, -rearD), toCam(xw * 0.998, 0.16, 0)], 'rgba(0,0,0,0.55)');
    });

    /* ---- 뒷벽 + 출입문 ---- */
    face([toCam(-wallX, 0, -rearD), toCam(wallX, 0, -rearD), toCam(wallX, ceilY, -rearD), toCam(-wallX, ceilY, -rearD)], '#0C0D0F');
    face([toCam(-1.15, 0, -rearD + 0.02), toCam(1.15, 0, -rearD + 0.02),
          toCam(1.15, 2.35, -rearD + 0.02), toCam(-1.15, 2.35, -rearD + 0.02)], '#050607');

    /* ---- 앞벽 (스크린 둘레) ---- */
    face([toCam(-wallX, 0, 0), toCam(wallX, 0, 0), toCam(wallX, ceilY, 0), toCam(-wallX, ceilY, 0)], '#0B0D0F');
    /* 앞벽도 세로 패널 이음매 — 스크린 뒤(검은 마스킹)는 매끈하게 둔다 */
    for (var wx = -wallX + 0.55; wx < wallX - 0.5; wx += 0.55) {
      if (Math.abs(wx) < scrW / 2 + 0.5) continue;
      seg(toCam(wx, 0, 0.01), toCam(wx, ceilY, 0.01), 'rgba(168,180,194,0.026)', 1);
    }

    /* ---- 스크린 마스크(검은 면) — 한 장의 다각형으로 그려 조각 경계선이 생기지 않게 ---- */
    var NS = 18;
    var maskPts = [];
    for (var mi = 0; mi <= NS; mi++) {
      var mu = -scrW / 2 + scrW * mi / NS;
      maskPts.push(toCam(mu, scrB + scrH, scrZ(mu)));
    }
    for (var mj = NS; mj >= 0; mj--) {
      var mu2 = -scrW / 2 + scrW * mj / NS;
      maskPts.push(toCam(mu2, scrB, scrZ(mu2)));
    }
    face(maskPts, '#060708');
    /* 스크린 둘레 검은 프레임(마스킹) — 사진처럼 화면 밖으로 12cm 정도 검정 띠 */
    var fr = 0.12;
    [[scrB + scrH, scrB + scrH + fr], [scrB - fr, scrB]].forEach(function (band) {
      for (var ci2 = 0; ci2 < NS; ci2++) {
        var u0 = -scrW / 2 + scrW * ci2 / NS, u1 = -scrW / 2 + scrW * (ci2 + 1) / NS;
        face([toCam(u0, band[1], scrZ(u0)), toCam(u1, band[1], scrZ(u1)),
              toCam(u1, band[0], scrZ(u1)), toCam(u0, band[0], scrZ(u0))], '#07080A');
      }
    });
    /* 좌우 마스킹 띠 — 실제 상영관처럼 스크린 양옆으로도 검은 천이 덮인다 */
    [-1, 1].forEach(function (sgn) {
      var xa = sgn * (scrW / 2), xb = sgn * (scrW / 2 + fr);
      face([toCam(xa, scrB - fr, 0), toCam(xb, scrB - fr, 0),
            toCam(xb, scrB + scrH + fr, 0), toCam(xa, scrB + scrH + fr, 0)], '#050607');
    });
    /* 마스킹 안쪽 모서리 — 사진에서 보이는 얇은 고정 프레임 */
    [-1, 1].forEach(function (sgn) {
      seg(toCam(sgn * (scrW / 2), scrB - fr, 0), toCam(sgn * (scrW / 2), scrB + scrH + fr, 0), 'rgba(150,160,166,0.10)', 1);
    });
    /* 스크린 테두리 */
    face([toCam(-scrW / 2, scrB, 0), toCam(scrW / 2, scrB, 0),
          toCam(scrW / 2, scrB + scrH, 0), toCam(-scrW / 2, scrB + scrH, 0)],
         null, 'rgba(206,214,218,0.14)', 1.2);

    /* ---- 영화 화면 ---- */
    var asp = o.aspect || p.aspect;
    var iw = scrW, ih = scrW / asp;
    if (ih > scrH) { ih = scrH; iw = scrH * asp; }
    var iImgW = vplay ? this.video.videoWidth : img.width;
    var iImgH = vplay ? this.video.videoHeight : img.height;
    /* 원본(영상) 비율이 화면과 다르면 가운데를 화면 비율로 잘라 쓴다(cover).
       세로로 찍은 영상을 넣어도 스크린이 검은 여백으로 비지 않고 꽉 찬다. */
    var srcX = 0, srcY = 0, srcW = iImgW, srcH = iImgH;
    if (iImgW && iImgH) {
      var va = iImgW / iImgH, aa2 = iw / ih;
      if (va > aa2) { srcW = iImgH * aa2; srcX = (iImgW - srcW) / 2; }
      else if (va < aa2) { srcH = iImgW / aa2; srcY = (iImgH - srcH) / 2; }
    }
    /* 스크린 타일이 그릴 텍스처 — 영상은 프레임당 한 번만 버퍼로 복사한다 */
    var tex = img, tX = srcX, tY = srcY, tW = srcW, tH = srcH;
    if (vplay) {
      var vb = videoBuffer();
      var vctx = vb.getContext('2d');
      try {
        vctx.clearRect(0, 0, VID_W, VID_H);      /* 이전 프레임이 남아 '빈 프레임'을 가리지 않게 */
        vctx.imageSmoothingEnabled = true;
        vctx.drawImage(this.video, srcX, srcY, srcW, srcH, 0, 0, VID_W, VID_H);
        tex = vb; tX = 0; tY = 0; tW = VID_W; tH = VID_H;
      } catch (e) { tex = img; }
      /* iOS: 재생 중인데도 캔버스로 복사된 프레임이 비어 있을 때가 있다(알파 0).
         0.5초에 한 번만 확인해, 두 번 연속 비어 있으면 그 판에서는 영상을 포기하고
         정지 화면을 계속 그린다(검은 스크린 방지). */
      if (tex === vb && !videoFrameReady(vb)) {
        tex = still; tX = 0; tY = 0; tW = still.width; tH = still.height;
        img = still; srcX = 0; srcY = 0; srcW = still.width; srcH = still.height;
        vplay = false;
      }
    }
    var yB0 = scrB + (scrH - ih) / 2, yT0 = yB0 + ih;
    /* 화면 영역 밖으로 넘치지 않게 한 번만 클립 (타일마다 클립하면 그 경계가 격자로 보임) */
    ctx.save();
    /* 화면 테두리를 근평면에서 먼저 잘라 클립 영역을 만든다.
       카메라 뒤로 넘어간 점을 그대로 투영하면 클립 영역이 화면 전체를 덮어
       스크린이 통째로 사라지거나 엉뚱한 곳이 잘렸다. */
    var outline = [];
    for (var ci = 0; ci <= 24; ci++) {
      var cu = -iw / 2 + iw * ci / 24;
      outline.push(toCam(cu, yT0, scrZ(cu)));
    }
    for (var cj = 24; cj >= 0; cj--) {
      var cu2 = -iw / 2 + iw * cj / 24;
      outline.push(toCam(cu2, yB0, scrZ(cu2)));
    }
    var vis = clipNearC(outline);
    /* 클립 경로가 만들어지지 않거나(점이 3개 미만·NaN) 넓이가 없으면 클립을 걸지 않는다.
       빈 클립을 걸면 스크린 타일이 전부 잘려 화면이 통째로 검게 남는다. */
    var visOk = vis.length >= 3;
    if (visOk) {
      var vxs = [], vys = [];
      for (var vk = 0; vk < vis.length; vk++) {
        var vpx = sx(vis[vk]), vpy = sy(vis[vk]);
        if (!isFinite(vpx) || !isFinite(vpy)) { visOk = false; break; }
        vxs.push(vpx); vys.push(vpy);
      }
      if (visOk) {
        var vx0 = Math.min.apply(null, vxs), vx1 = Math.max.apply(null, vxs);
        var vy0 = Math.min.apply(null, vys), vy1 = Math.max.apply(null, vys);
        if (vx1 - vx0 < 1 || vy1 - vy0 < 1) visOk = false;
      }
    }
    if (visOk) {
      ctx.beginPath();
      ctx.moveTo(sx(vis[0]), sy(vis[0]));
      for (var vi = 1; vi < vis.length; vi++) ctx.lineTo(sx(vis[vi]), sy(vis[vi]));
      ctx.closePath();
      ctx.clip();
    }
    /* ---- 스크린 원근 메쉬(삼각분할) ----
       예전에는 세로 스트립(24열 × 1~4행)만 나눠 그려서, 앞줄·측면(B14 등)처럼 대각선
       원근이 큰 자리에서 지평선이 계단처럼 어긋나고 세로 줄무늬가 보였다.
       지금은 칸 가장자리·중심의 실제 투영 위치와 아핀 근사의 차이를 px로 재어
       오차 0.6px 이하가 될 때까지 칸을 재귀적으로 쪼갠 뒤, 칸마다 클립한
       아핀 삼각형 2개로 그린다. 칸 경계는 0.6px 겹쳐 이음매를 지운다. */
    var MESH_MAX = 40, meshCells = 0;
    function drawScreenCell(s0, s1, t0, t1, A, B, C, D) {
      var tx0 = tX + tW * s0, tx1 = tX + tW * s1;
      var ty0 = tY + tH * (1 - t1), ty1 = tY + tH * (1 - t0);
      var rw = Math.max(0.001, tx1 - tx0), rh = Math.max(0.001, ty1 - ty0);
      /* 칸 둘레로 텍스처를 1.5px 더 떠서 그린다 — drawImage가 칸 경계에서 텍셀을
         클램프해 이웃 칸과 색이 어긋나던 1px 이음매를 없앤다. */
      var pt = 1.5;
      var rc = [tx0 - pt, ty0 - pt, rw + pt * 2, rh + pt * 2];
      var SA = [tx0, ty1], SB = [tx1, ty1], SC = [tx1, ty0], SD = [tx0, ty0];
      if (!(A[2] >= NEAR_C && B[2] >= NEAR_C && C[2] >= NEAR_C && D[2] >= NEAR_C)) {
        /* 근평면을 걸치는 칸(카메라 바로 옆 판)은 근평면 클립 경로로 그린다 */
        quadTex([A, B, C, D], [SA, SB, SC, SD], tex, null, rc);
        return;
      }
      var pA = [sx(A), sy(A)], pB = [sx(B), sy(B)], pC = [sx(C), sy(C)], pD = [sx(D), sy(D)];
      /* 삼각형 단위로 1.2px 겹쳐 그린다 — 클립 경계 안티앨리어싱으로 생기던 검은 실선을
         없애면서, 칸 사각형을 넘어 그려지던 이웃 겹침(회색 접힘)도 생기지 않는다. */
      triClip(pA, pB, pC, SA, SB, SC, tex, null, rc);
      triClip(pA, pC, pD, SA, SC, SD, tex, null, rc);
    }
    function meshCell(s0, s1, t0, t1, depth) {
      var uA = -iw / 2 + iw * s0, uB = -iw / 2 + iw * s1;
      var yA = yB0 + ih * t0, yBt = yB0 + ih * t1;
      var A = toCam(uA, yA, scrZ(uA)), B = toCam(uB, yA, scrZ(uB));
      var C = toCam(uB, yBt, scrZ(uB)), D = toCam(uA, yBt, scrZ(uA));
      var front = (A[2] >= NEAR_C && B[2] >= NEAR_C && C[2] >= NEAR_C && D[2] >= NEAR_C);
      /* 네 꼭짓점이 모두 카메라 뒤면 그릴 것이 없다 — 쪼개지 않고 바로 끝낸다
         (반쯤 걸친 칸만 아래에서 더 쪼개 조각을 살린다) */
      var anyFront = (A[2] >= NEAR_C || B[2] >= NEAR_C || C[2] >= NEAR_C || D[2] >= NEAR_C);
      if (!anyFront) return;
      /* 칸을 더 쪼갭니다. 다만 아이폰 사파리에서 프레임이 끓지 않도록
         칸 수 상한(MESH_MAX)과 깊이 2까지만 — 대부분 4~8열 × 2행에서 끝난다. */
      /* 근평면을 걸친 칸(카메라 바로 옆)은 상한과 상관없이 더 쪼개 그 조각을 살린다.
         예전에는 상한·깊이에 걸린 칸을 그냥 건너뛰어, 시야를 돌리면 화면 일부가 통째로 사라졌다. */
      var maxDepth = front ? 2 : 4;
      if (depth < maxDepth && (meshCells + 4 <= MESH_MAX || !front) && meshCells < MESH_MAX * 8) {
        var split = !front;
        if (front) {
          var um = (uA + uB) / 2, ym = (yA + yBt) / 2;
          var mid = toCam(um, ym, scrZ(um));
          if (mid[2] < NEAR_C) {
            split = true;
          } else {
            var ex = sx(mid) - (sx(A) + sx(B) + sx(C) + sx(D)) / 4;
            var ey = sy(mid) - (sy(A) + sy(B) + sy(C) + sy(D)) / 4;
            var err = Math.sqrt(ex * ex + ey * ey);
            if (err > 1.6) split = true;
          }
        }
        if (split) {
          var sm = (s0 + s1) / 2, tm = (t0 + t1) / 2;
          meshCell(s0, sm, t0, tm, depth + 1); meshCell(sm, s1, t0, tm, depth + 1);
          meshCell(s0, sm, tm, t1, depth + 1); meshCell(sm, s1, tm, t1, depth + 1);
          return;
        }
      }
      meshCells++;
      drawScreenCell(s0, s1, t0, t1, A, B, C, D);
    }
    /* ---- 바탕 정지 화면 - 영상 재생 중일 때만 화면 전체에 한 번 깔아 둔다 ----
       iOS에서 영상 프레임이 검게/비어 들어와도 검은 스크린이 아니라 이 정지 화면이 남는다.
       실제 그림은 아래 타일 메쉬가 덮으므로 이 바탕은 '보험'일 뿐이다. */
    if (vplay) (function () {
      var UX = 3, UY = 2;
      for (var ux = 0; ux < UX; ux++) {
        for (var uy = 0; uy < UY; uy++) {
          var s0 = ux / UX, s1 = (ux + 1) / UX, q0 = uy / UY, q1 = (uy + 1) / UY;
          var uA2 = -iw / 2 + iw * s0, uB2 = -iw / 2 + iw * s1;
          var yA2 = yB0 + ih * q0, yB2 = yB0 + ih * q1;
          quadTex(
            [toCam(uA2, yA2, scrZ(uA2)), toCam(uB2, yA2, scrZ(uB2)),
             toCam(uB2, yB2, scrZ(uB2)), toCam(uA2, yB2, scrZ(uA2))],
            [[still.width * s0, still.height * (1 - q1)], [still.width * s1, still.height * (1 - q1)],
             [still.width * s1, still.height * (1 - q0)], [still.width * s0, still.height * (1 - q0)]],
            still, null, [0, 0, still.width, still.height]);
        }
      }
    })();
    /* 기본 격자: 평면 4×2, 곡면(IMAX·SCREENX) 6×2 — 곡률이 있을 때만 열을 늘린다 */
    var NX0 = Math.abs(curve) > 0.08 ? 6 : 4, NY0 = 2;
    for (var mi = 0; mi < NX0; mi++) {
      for (var mj = 0; mj < NY0; mj++) {
        meshCell(mi / NX0, (mi + 1) / NX0, mj / NY0, (mj + 1) / NY0, 0);
      }
    }
    ctx.restore();

    /* 영사된 빛의 느낌 — 화면 위에 아주 옅게만 얹어 그림은 그대로 선명하게 둔다 */
    var scrMid = toCam(0, scrB + scrH * 0.5, 0);
    if (scrMid[2] > NEAR) {
      var mx = sx(scrMid), my = sy(scrMid);
      var halfW = Math.abs(f * (iw / 2) / scrMid[2]) + 4;
      var halfH = Math.abs(f * (ih / 2) / scrMid[2]) + 4;
      /* 빛은 화면(그림) 안에만 앉는다 — 마스킹 띠가 회색으로 뜨지 않게 */
      ctx.save();
      ctx.beginPath();
      for (var bi = 0; bi <= 18; bi++) {
        var bu = -iw / 2 + iw * bi / 18, bp = toCam(bu, yT0, scrZ(bu));
        if (bi === 0) ctx.moveTo(sx(bp), sy(bp)); else ctx.lineTo(sx(bp), sy(bp));
      }
      for (var bj = 18; bj >= 0; bj--) {
        var bu2 = -iw / 2 + iw * bj / 18, bp2 = toCam(bu2, yB0, scrZ(bu2));
        ctx.lineTo(sx(bp2), sy(bp2));
      }
      ctx.closePath();
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      /* 중앙 영사 핫스팟 */
      var rg = ctx.createRadialGradient(mx, my, halfW * 0.1, mx, my, Math.max(halfW, halfH) * 0.9);
      rg.addColorStop(0, 'rgba(255,238,214,0.055)');
      rg.addColorStop(0.55, 'rgba(255,226,190,0.022)');
      rg.addColorStop(1, 'rgba(255,210,170,0)');
      ctx.fillStyle = rg; ctx.fillRect(mx - halfW, my - halfH, halfW * 2, halfH * 2);
      /* 스크린 위쪽 두 모서리에 떨어지는 다운라이트 (사진에서 보이는 두 빛 웅덩이) */
      [-1, 1].forEach(function (sgn) {
        var pu = sgn * iw * 0.30;
        var pc = toCam(pu, yT0 - ih * 0.08, scrZ(pu));
        if (pc[2] < NEAR) return;
        var pxx = sx(pc), pyy = sy(pc);
        var rr = Math.max(10, f * (iw * 0.26) / pc[2]);
        ctx.save();
        ctx.translate(pxx, pyy);
        ctx.scale(1, 0.62);
        var pg = ctx.createRadialGradient(0, 0, 0, 0, 0, rr);
        pg.addColorStop(0, 'rgba(255,242,224,0.095)');
        pg.addColorStop(0.5, 'rgba(255,232,205,0.038)');
        pg.addColorStop(1, 'rgba(255,226,196,0)');
        ctx.fillStyle = pg;
        ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      });
      ctx.restore();
    }

  /* ---- SCREENX 좌우 윙 스크린 ----
     사용자 실사(photo-2a151b6c…, 2026-11-18): 윙은 정면 스크린 양옆에서 시작해 관객 쪽으로
     넓어지는 사다리꼴이고, 위·아래 가장자리도 관객 쪽으로 갈수록 벌어진다. 정면 화면의
     가장자리 화소를 이어 받아 벽으로 확장되므로 이음매 없이 같은 그림이 흐른다. */
    var tagsStr = (o.tags || []).join(' ');
    var isUltra = /ULTRA 4DX/i.test(tagsStr);
    var wingLc = null, wingRc = null;
    if (/SCREENX/i.test(tagsStr) || isUltra || o.fourSide) {
      var edgeFrac = 0.30;
      try {
        if (tW && tH) {
          [[-1, tX], [1, tX + tW * (1 - edgeFrac)]].forEach(function (cfg) {
            var cv = wingEdge(cfg[0]);
            var cx2 = cv.getContext('2d');
            cx2.clearRect(0, 0, WING_W, WING_H);
            cx2.imageSmoothingEnabled = true;
            try { cx2.imageSmoothingQuality = 'high'; } catch (e) {}
            cx2.drawImage(tex, cfg[1], tY, tW * edgeFrac, tH, 0, 0, WING_W, WING_H);
            if (cfg[0] < 0) wingLc = cv; else wingRc = cv;
          });
        }
      } catch (e) { wingLc = wingRc = null; }
      if (!wingLc) { wingLc = wingRc = wingTexture(); }
      ctx.imageSmoothingEnabled = true;
    }
    function drawWingScreens() {
      var halfW2 = scrW / 2;
      var wz0 = -0.10;
      var wz1 = -Math.min(7.6, Math.max(5.6, s.rearD - 1.2));
      var flare = s.wingFlare || 4.0;
      if (isUltra) flare = Math.max(flare, 4.6);
      var wyT0 = scrB + scrH, wyB0 = scrB;
      /* 관객 쪽 끝에서 위는 더 올라가고 아래는 내려간다 — 사다리꼴로 벌어지는 느낌 */
      var wyT1 = Math.min(ceilY - 0.35, scrB + scrH + Math.max(0.55, scrH * 0.16));
      var wyB1 = Math.max(0.30, scrB - Math.max(0.35, scrH * 0.10));
      var wingX = function (z) {
        var u = (wz0 - z) / (wz0 - wz1);
        return halfW2 + 0.32 + flare * Math.max(0, u);
      };
      /* 조각 사이에 1px 틈이 생기면 어두운 실선으로 보인다 — 불투명하게 그리고 조각을 조금씩
         겹쳐(0.8%) 이음매를 지운 뒤, 윙 전체에 옅은 어둠을 한 장 덮어 '벽에 투사된 화면' 톤을 준다. */
      var wingAlpha = 1;
      var WSEG = 5;
      [-1, 1].forEach(function (sgn) {
        var img = sgn < 0 ? wingLc : wingRc;
        for (var k = 0; k < WSEG; k++) {
          var t0 = k / WSEG, t1 = (k + 1) / WSEG;
          if (k > 0) t0 -= 0.008;
          if (k < WSEG - 1) t1 += 0.008;
          var z0 = wz0 + (wz1 - wz0) * t0, z1 = wz0 + (wz1 - wz0) * t1;
          var yt0 = wyT0 + (wyT1 - wyT0) * t0, yt1 = wyT0 + (wyT1 - wyT0) * t1;
          var yb0 = wyB0 + (wyB1 - wyB0) * t0, yb1 = wyB0 + (wyB1 - wyB0) * t1;
          var x0 = sgn * wingX(z0), x1 = sgn * wingX(z1);
          /* 조각마다 투명도를 달리하면 경계가 띠로 보인다 — 모든 조각을 같은 밝기로 깔고
             사라짐은 아래 그라데이션 한 장으로 준다. */
          /* 왼쪽 윙은 화면 가장자리(오른쪽 끝)에서 시작하므로 텍스처를 좌우 반전해 잇는다 */
          var u0 = sgn < 0 ? WING_W * (1 - t0) : WING_W * t0;
          var u1 = sgn < 0 ? WING_W * (1 - t1) : WING_W * t1;
          quadTex(
            [toCam(x0, yt0, z0), toCam(x1, yt1, z1), toCam(x1, yb1, z1), toCam(x0, yb0, z0)],
            [[u0, 0], [u1, 0], [u1, WING_H], [u0, WING_H]],
            img, wingAlpha, [0, 0, WING_W, WING_H]);
        }
      });
      [-1, 1].forEach(function (sgn) {
        var xa = sgn * wingX(wz0), xb = sgn * wingX(wz1);
        /* 벽으로 스며들며 어두워지는 한 장의 그라데이션 */
        if (path([toCam(xa, wyB0, wz0), toCam(xb, wyB1, wz1), toCam(xb, wyT1, wz1), toCam(xa, wyT0, wz0)])) {
          ctx.fillStyle = 'rgba(4,6,7,0.24)'; ctx.fill();
          var cA = toCam(xa, (wyT0 + wyB0) / 2, wz0), cB = toCam(xb, (wyT1 + wyB1) / 2, wz1);
          var wg;
          if (cA[2] > NEAR && cB[2] > NEAR) {
            wg = ctx.createLinearGradient(sx(cA), sy(cA), sx(cB), sy(cB));
          } else {
            wg = ctx.createLinearGradient(W / 2, H / 2, sgn > 0 ? W : 0, H / 2);
          }
          wg.addColorStop(0, 'rgba(4,6,7,0.04)');
          wg.addColorStop(0.55, 'rgba(4,6,7,0.22)');
          wg.addColorStop(1, 'rgba(4,6,7,0.46)');
          ctx.fillStyle = wg; ctx.fill();
        }
        face([toCam(xa, wyB0, wz0), toCam(xb, wyB1, wz1), toCam(xb, wyT1, wz1), toCam(xa, wyT0, wz0)],
             null, 'rgba(255,255,255,0.10)', 2);
      });
    }

    /* ---- 용산 SCREENX 4면 스크린: 앞쪽 천장에도 확장 화면이 투사된다 ----
       (정면·좌우 윙에 이어 천장까지 이어지는 실제 4면 구조. 젖히면 시선이 위로 넘어가며 보인다) */
    if (o.fourSide) {
      /* 천장 스크린은 관객 쪽 앞모서리가 낮고 뒤로 갈수록 천장에 붙는 기울어진 판 */
      var cw = wallX * 0.64, cz0 = -1.15, cz1 = -7.6;
      var cyFront = ceilY - 1.55, cyBack = ceilY - 0.06;
      function cyAt(zz) { var kk = (zz - cz0) / (cz1 - cz0); return cyFront + (cyBack - cyFront) * kk; }
      var ceilTex = wingLc || img;
      var CSEG = 4;
      for (var ck = 0; ck < CSEG; ck++) {
        var za = cz0 + (cz1 - cz0) * ck / CSEG, zb = cz0 + (cz1 - cz0) * (ck + 1) / CSEG;
        var ya = cyAt(za), yb = cyAt(zb);
        var cfade = 1 - 0.55 * (ck / (CSEG - 1));
        quadTex(
          [toCam(-cw, ya, za), toCam(cw, ya, za), toCam(cw, yb, zb), toCam(-cw, yb, zb)],
          [[0, WING_H * ck / CSEG], [WING_W, WING_H * ck / CSEG],
           [WING_W, WING_H * (ck + 1) / CSEG], [0, WING_H * (ck + 1) / CSEG]],
          ceilTex, 0.40 * cfade, [0, 0, WING_W, WING_H]);
      }
      /* 천장 스크린 테두리(앞모서리는 밝게) + 번지는 빛 */
      face([toCam(-cw, cyAt(cz0), cz0), toCam(cw, cyAt(cz0), cz0),
            toCam(cw, cyAt(cz1), cz1), toCam(-cw, cyAt(cz1), cz1)],
           null, 'rgba(220,228,232,0.13)', 1.4);
      seg(toCam(-cw, cyAt(cz0), cz0), toCam(cw, cyAt(cz0), cz0), 'rgba(235,240,245,0.22)', 1.6);
      var cyy = cyAt((cz0 + cz1) / 2);
      var ccen = toCam(0, cyy, (cz0 + cz1) / 2);
      if (ccen[2] > NEAR) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        var cxp = sx(ccen), cyp = sy(ccen);
        var crd = Math.max(90, f * (cw * 1.1) / ccen[2]);
        var cg = ctx.createRadialGradient(cxp, cyp, crd * 0.2, cxp, cyp, crd);
        cg.addColorStop(0, 'rgba(255,232,205,0.04)');
        cg.addColorStop(1, 'rgba(255,205,165,0)');
        ctx.fillStyle = cg; ctx.fillRect(cxp - crd, cyp - crd, crd * 2, crd * 2);
        ctx.restore();
      }
    }

    /* ---- 스크린 아래 스피커 캐비닛 (사진처럼 스크린 양옆 어두운 박스) ---- */
    [-1, 1].forEach(function (sgn) {
      var sx0 = sgn * (scrW / 2 + 0.55), sx1 = sgn * (scrW / 2 + 1.45);
      face([toCam(sx0, 0.02, -0.35), toCam(sx1, 0.02, -0.35),
            toCam(sx1, 1.25, -0.35), toCam(sx0, 1.25, -0.35)], '#08090B');
      seg(toCam(sx0, 1.25, -0.35), toCam(sx1, 1.25, -0.35), 'rgba(170,178,182,0.10)', 1);
    });

    /* ---- 앞쪽 좌우 벽 출입문 + 그 위 비상구 표시등(초록) ----
       표시등은 허공에 띄우지 않고 출입문 사각형 바로 위에 붙인다.
       실제 표시등은 손바닥만 하므로 판과 번짐을 그만큼 작게 잡고, 화면에서 차지하는
       지름에 상한을 둬 앞줄에서도 초록 빛이 시야를 덮지 않게 한다. */
    [-1, 1].forEach(function (sgn) {
      var xw = sgn * (wallX - 0.06);
      var zA = -1.05, zB = -1.72;      /* 출입문 폭 (그대로) */
      var yB = 2.20, yT = 2.35;        /* 표시등 판 높이 */
      var gA = -1.34, gB = -1.72;      /* 표시등 가로 폭 0.38 m */
      /* 출입문(어두운 사각형 + 옅은 문틀) */
      face([toCam(xw * 0.997, 0.02, zA), toCam(xw * 0.997, 0.02, zB),
            toCam(xw * 0.997, 2.02, zB), toCam(xw * 0.997, 2.02, zA)], 'rgba(6,7,9,0.92)');
      face([toCam(xw * 0.996, 0.02, zA), toCam(xw * 0.996, 0.02, zA - 0.05),
            toCam(xw * 0.996, 2.02, zA - 0.05), toCam(xw * 0.996, 2.02, zA)], 'rgba(150,158,162,0.16)');
      face([toCam(xw * 0.996, 2.02, zA), toCam(xw * 0.996, 2.02, zB),
            toCam(xw * 0.996, 2.06, zB), toCam(xw * 0.996, 2.06, zA)], 'rgba(150,158,162,0.13)');
      face([toCam(xw, yB, gA), toCam(xw, yB, gB), toCam(xw, yT, gB), toCam(xw, yT, gA)], 'rgba(34,196,102,0.72)');
      /* 픽토그램: 흰 막대 하나 — 멀리서도 초록 표시로 읽히게 */
      face([toCam(xw * 0.995, yB + 0.045, gA - 0.05), toCam(xw * 0.995, yB + 0.045, gB + 0.05),
            toCam(xw * 0.995, yB + 0.075, gB + 0.05), toCam(xw * 0.995, yB + 0.075, gA - 0.05)], 'rgba(255,255,255,0.55)');
      /* 은은한 초록 번짐 — 거리에 따라 커지고 작아지되 화면 짧은 변의 4%까지만 */
      var ec = toCam(xw, (yB + yT) / 2, (gA + gB) / 2);
      pool(ec, 0.34, '80,235,140', 0.05, 0, Math.min(W, H) * 0.04);
    });
    /* 뒷벽 출입문 위 EXIT */
    (function () {
      var z = -rearD + 0.03;
      face([toCam(-0.34, 2.52, z), toCam(0.34, 2.52, z), toCam(0.34, 2.68, z), toCam(-0.34, 2.68, z)], 'rgba(36,200,104,0.70)');
      var ec = toCam(0, 2.60, z);
      pool(ec, 0.30, '80,235,140', 0.05, 0, Math.min(W, H) * 0.035);
      if (ec[2] > NEAR) {
        var hgt = Math.abs(f * 0.16 / ec[2]);
        if (hgt > 7) {
          ctx.save();
          ctx.fillStyle = 'rgba(6,32,18,0.85)';
          ctx.font = '700 ' + Math.min(18, hgt * 0.72).toFixed(1) + 'px -apple-system,system-ui,sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('EXIT', sx(ec), sy(ec));
          ctx.restore();
        }
      }
    })();

    /* ---- 천장 다운라이트 → 벽면 빛 번짐 + 스크린 쪽 스포트 ---- */
    var lampZ = [-0.9];
    for (var lz = -2.6; lz > -rearD; lz -= 3.6) lampZ.push(lz);
    lampZ.forEach(function (z, idx) {
      [-1, 1].forEach(function (sgn) {
        var lx = sgn * wallX * 0.55;
        var c0 = toCam(lx, ceilY - 0.10, z);
        if (c0[2] > NEAR) {
          var rr = Math.max(1.1, f * 0.07 / c0[2]);
          ctx.fillStyle = 'rgba(255,246,226,0.97)';
          ctx.beginPath(); ctx.arc(sx(c0), sy(c0), rr, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = 'rgba(255,228,184,0.13)';
          ctx.beginPath(); ctx.arc(sx(c0), sy(c0), rr * 3.0, 0, Math.PI * 2); ctx.fill();
        }
        /* 벽면에 떨어지는 빛 웅덩이 */
        pool(toCam(sgn * (wallX - 0.02), ceilY - 0.95, z), 2.1, '255,226,180', idx === 0 ? 0.10 : 0.065, 1.4);
        /* 천장 자체 번짐 */
        pool(toCam(lx, ceilY - 0.02, z), 1.2, '255,224,180', 0.09, 1);
      });
    });

    /* ---- 바닥 + 단차 + 좌석 ---- */
    var pitch = s.pitch, rows = s.rows, riser = p.riser;

    /* 스크린 앞 바닥(스테이지) */
    face([toCam(-wallX, 0.01, 0), toCam(wallX, 0.01, 0),
          toCam(wallX, 0.01, -(p.firstRow - p.rowGap * 0.5)), toCam(-wallX, 0.01, -(p.firstRow - p.rowGap * 0.5))], '#0A0C0E');
    /* 스크린 빛을 받아 살짝 빛나는 스테이지 앞쪽 */
    pool(toCam(0, 0.02, -1.2), Math.max(3.5, p.screenW * 0.35), '255,232,205', 0.05, 0.35);

    /* ---- 맨 앞 단상(왕십리 SCREENX like) ----
       스크린이 상단에 붙은 관은 무대(단상)가 앞에 설치되어 그 위로 화면이 떠 보인다. */
    if (p.stage && p.stage.h > 0.1) {
      var stH = p.stage.h, stD = Math.max(0.8, p.stage.d || 1.4);
      var stW = Math.min(wallX - 0.15, Math.max(scrW / 2 + 1.2, s.bankHalf + 1.0));
      /* 단상 윗면 */
      face([toCam(-stW, stH, 0.05), toCam(stW, stH, 0.05),
            toCam(stW, stH, -stD), toCam(-stW, stH, -stD)], '#141414');
      /* 단상 앞면(객석 쪽) — 어두운 판 + 위 모서리 반사광 */
      face([toCam(-stW, 0.0, 0.05), toCam(stW, 0.0, 0.05),
            toCam(stW, stH, 0.05), toCam(-stW, stH, 0.05)], '#0C0D0D');
      seg(toCam(-stW, stH - 0.015, 0.06), toCam(stW, stH - 0.015, 0.06), 'rgba(232,240,244,0.16)', 1.4);
      /* 단상 위 스크린 빛 반사 */
      pool(toCam(0, stH + 0.02, -stD * 0.5), Math.max(2.5, scrW * 0.30), '255,236,210', 0.05, 0.22);
    }

    /* 앞열 앞 크롬 난간 (사진의 스테이지 끝 가드레일) */
    (function () {
      var railZ = -(p.firstRow - p.rowGap * 0.55), railY = 1.0;
      seg(toCam(-wallX * 0.92, railY, railZ), toCam(wallX * 0.92, railY, railZ), 'rgba(196,206,212,0.13)', 1.1);
      seg(toCam(-wallX * 0.92, railY - 0.03, railZ), toCam(wallX * 0.92, railY - 0.03, railZ), 'rgba(120,132,138,0.07)', 1);
      for (var px2 = -wallX * 0.9; px2 <= wallX * 0.9; px2 += 3.1) {
        seg(toCam(px2, 0.02, railZ), toCam(px2, railY, railZ), 'rgba(170,182,188,0.10)', 1);
      }
    })();

    /* 통로 열(모든 행에서 빈 칸) — 3D 바닥에도 통로 띠를 깔아 좌석 줄 사이 통로가 보이게 한다 */
    var aisleCol = [];
    if (rows && rows.length) {
      for (var ac0 = 0; ac0 < p.cols; ac0++) {
        var empAll = true;
        for (var ar0 = 0; ar0 < rows.length; ar0++) {
          var cc0 = rows[ar0] && rows[ar0].c;
          if (cc0 && cc0[ac0] && cc0[ac0] !== '.') { empAll = false; break; }
        }
        aisleCol[ac0] = empAll;
      }
    }

    var order = [];
    for (var i2 = 0; i2 < p.rows; i2++) {
      var dc = p.firstRow + i2 * p.rowGap + ((p._extra && p._extra[i2]) || 0);
      order.push({ i: i2, dc: dc, depth: Math.abs(s.dCam - dc) });
    }
    order.sort(function (a, b) { return b.depth - a.depth; });


    /* ---- 둥근 판 만들기 — 2026-11-21 «클린 미니멀 3D»
       각진 사각형을 그대로 투영하면 종이 상자처럼 보인다. 모서리를 원호로 깎은 점들을
       투영하면 실루엣이 부드러워져 푹신한 의자로 읽힌다(점 수만 늘고 fill 횟수는 그대로).
       panelPts: 수직면(x-y) — 아래 z0, 위 z1 (등받이를 젖히면 위가 뒤로 눕는다)
       slabPts : 수평면(x-z) — 높이 y 고정 (좌판·팔걸이·침대 매트리스) */
    function panelPts(x0, x1, y0, y1, z0, z1, rTop, rBot, segs) {
      var pts = [], dxp = Math.abs(x1 - x0), dyp = Math.abs(y1 - y0);
      rTop = Math.max(0.001, Math.min(rTop, dxp / 2, dyp / 2));
      rBot = Math.max(0.001, Math.min(rBot == null ? rTop : rBot, dxp / 2, dyp / 2));
      segs = segs || 3;
      var yLo = Math.min(y0, y1), yHi = Math.max(y0, y1);
      var zLo = y0 <= y1 ? z0 : z1, zHi = y0 <= y1 ? z1 : z0;
      function P(x, y) { pts.push(toCam(x, y, zLo + (zHi - zLo) * ((y - yLo) / ((yHi - yLo) || 1)))); }
      function A(cx2, cy2, a0, a1, r) {
        for (var q2 = 1; q2 <= segs; q2++) { var a = a0 + (a1 - a0) * (q2 / segs); P(cx2 + Math.cos(a) * r, cy2 + Math.sin(a) * r); }
      }
      A(x0 + rBot, yLo + rBot, Math.PI, Math.PI * 1.5, rBot);
      A(x1 - rBot, yLo + rBot, Math.PI * 1.5, Math.PI * 2, rBot);
      A(x1 - rTop, yHi - rTop, 0, Math.PI * 0.5, rTop);
      A(x0 + rTop, yHi - rTop, Math.PI * 0.5, Math.PI, rTop);
      return pts;
    }
    function slabPts(x0, x1, zA, zB, y, rX, rZ, segs) {
      var pts = [], dxs = Math.abs(x1 - x0), dzs = Math.abs(zB - zA);
      rX = Math.max(0.001, Math.min(rX, dxs / 2, dzs / 2));
      rZ = Math.max(0.001, Math.min(rZ == null ? rX : rZ, dxs / 2, dzs / 2));
      segs = segs || 3;
      var zL = Math.min(zA, zB), zH = Math.max(zA, zB);
      function P(x, z) { pts.push(toCam(x, y, z)); }
      function A(cx2, cz2, a0, a1) {
        for (var q2 = 1; q2 <= segs; q2++) { var a = a0 + (a1 - a0) * (q2 / segs); P(cx2 + Math.cos(a) * rX, cz2 + Math.sin(a) * rZ); }
      }
      A(x0 + rX, zL + rZ, Math.PI, Math.PI * 1.5);
      A(x1 - rX, zL + rZ, Math.PI * 1.5, Math.PI * 2);
      A(x1 - rX, zH - rZ, 0, Math.PI * 0.5);
      A(x0 + rX, zH - rZ, Math.PI * 0.5, Math.PI);
      return pts;
    }

    order.forEach(function (R) {
      var i = R.i, dc = R.dc, g = p.rowGap, hz = i * riser;
      /* PRIVATE BOX 안에서는 관 좌석을 그리지 않는다 — 박스 안 가구는 따로 그린다.
         모관에 합친 박스는 **박스 줄만** 건너뛰고 일반석은 그린다(박스에서 내려다보는 그림). */
      if (s.isPB && !p.boxRows) return;
      if (p.boxRows && rows[i] && p.boxRows.indexOf(rows[i].l) >= 0) return;
      /* 내 좌석 뒤쪽 행은 그리지 않는다 — 위로 고개를 들면 시야 뒤·위 좌석이
         화면을 덮는 거대한 마디로 비치는 문제 방지 */
      if (dc > s.dCam - 0.15) return;
      /* 박스 안에서 볼 때 박스 눈높이보다 높이 솟은 행도 비린다.
         (인청 10관처럼 박스(4.2 m)보다 관 뒷열(5.6 m)이 높은 관은 등받이가 화면을 다 가렸다) */
      if (s.isPB && (hz + (s.recliner ? 0.82 : 0.94)) > s.cam.y - 0.05) return;
      var zf = -(dc - g * 0.5), zb = -(dc + g * 0.5);

      /* ===== 좌석판 바닥 — 디딤판·단차·통로 =====
         2026-11-21 «클린 미니멀 3D»(style-2.png): 바닥은 무광 차콜, 단차 코와 통로에는
         은은한 에메랄드 유도선만 얇게 깐다. 밝은 회색 선은 화면보다 눈에 띄어 걷어냈다. */
      var rowLit = clamp(1.02 - Math.abs(s.dCam - dc) / Math.max(8, p.rows * p.rowGap * 1.4), 0.42, 1);
      face([toCam(-wallX, hz, zf), toCam(wallX, hz, zf), toCam(wallX, hz, zb), toCam(-wallX, hz, zb)], '#12161C');
      /* 단차(앞면) */
      if (i > 0) {
        face([toCam(-wallX, (i - 1) * riser, zf), toCam(wallX, (i - 1) * riser, zf),
              toCam(wallX, hz, zf), toCam(-wallX, hz, zf)], '#0A0E13');
        /* 단차 코의 에메랄드 유도선 — 폭 넓은 흐림 한 줄 + 얇은 선 한 줄로 은은한 발광 */
        var emA = (0.075 * rowLit).toFixed(3), emB = (0.30 * rowLit).toFixed(3);
        seg(toCam(-wallX, hz - 0.014, zf), toCam(wallX, hz - 0.014, zf), 'rgba(16,185,129,' + emA + ')', 4.5);
        seg(toCam(-wallX, hz - 0.014, zf), toCam(wallX, hz - 0.014, zf), 'rgba(16,185,129,' + emB + ')', 1.1);
      }
      /* 통로 열 바닥 띠 — 좌석 사이 통로가 어두운 바닥에 묻히지 않게 */
      if (aisleCol && aisleCol.length) {
        for (var ac = 0; ac < aisleCol.length; ac++) {
          if (!aisleCol[ac]) continue;
          var xa = (ac - s.centerX) * pitch - pitch * 0.34;
          face([toCam(xa, hz + 0.003, zf - 0.02), toCam(xa + pitch * 0.68, hz + 0.003, zf - 0.02),
                toCam(xa + pitch * 0.68, hz + 0.003, zb + 0.02), toCam(xa, hz + 0.003, zb + 0.02)],
               'rgba(16,185,129,0.035)');
          /* 통로 양옆 얇은 유도선 */
          seg(toCam(xa, hz + 0.006, zf - 0.02), toCam(xa, hz + 0.006, zb + 0.02), 'rgba(16,185,129,' + (0.16 * rowLit).toFixed(3) + ')', 1);
          seg(toCam(xa + pitch * 0.68, hz + 0.006, zf - 0.02), toCam(xa + pitch * 0.68, hz + 0.006, zb + 0.02), 'rgba(16,185,129,' + (0.16 * rowLit).toFixed(3) + ')', 1);
        }
      }

      var cells = rows[i] ? rows[i].c : null;
      if (!cells) return;

      /* ---- 좌석: 등받이·머리받침·좌판·팔걸이를 둥근 판으로 나눠 그린다.
              같은 부품끼리 한 번의 fill로 묶어(행당 8~12회) 60fps를 지킨다.
              2026-11-21 «클린 미니멀 3D»(style-2.png): 각진 상자 대신 둥근 어깨의
              매끈한 다크 슬레이트 의자. 색은 #1A1E26~#262C36 안에서만 움직이고,
              형태와 위쪽 림라이트로 3D로 읽히게 한다 — 좌석이 화면보다 튀지 않게. ---- */
      var zBack = -(dc + 0.20), zFront = -(dc - 0.05);
      var bed = !!s.isBed;
      var lit = rowLit;
      var recLean = 0.22 * rec;                     /* 등받이를 젖히면 어깨가 뒤로 눕는다 */
      var bBot = hz + (bed ? 0.26 : 0.34);
      var bTop = hz + (bed ? 0.84 : (s.recliner ? 0.99 : 0.92));
      var cTop = hz + (bed ? 0.34 : (s.recliner ? 0.46 : 0.44));
      var cEdge = hz + (s.recliner ? 0.26 : 0.30);
      var seatW = pitch * (bed ? 0.90 : (s.recliner ? 0.50 : 0.47));
      var zTop = zBack - recLean;
      function zbk(y) { return (bTop - bBot) < 0.001 ? zBack : zBack + (zTop - zBack) * ((y - bBot) / (bTop - bBot)); }
      var MATC = {};
      function mats(t) {
        if (MATC[t]) return MATC[t];
        var c;
        /* [등받이 위, 등받이 아래, 머리받침, 좌판, 좌판 앞면, 팔걸이 윗면, 팔걸이 앞면]
           전부 무광 다크 슬레이트 계열 — 관 유형별 차이는 아주 좁은 색온도 차이로만 준다. */
        if (t === 'r') c = ['#262C36', '#181C23', '#2C333D', '#323945', '#1A2029', '#272D38', '#151A21'];  /* 리클라이너 */
        else if (t === 's') c = ['#282A33', '#191B22', '#2D3139', '#333642', '#1B2027', '#292C36', '#161920'];  /* SWEETBOX */
        else if (t === 'w') c = ['#2A2A2E', '#1A1A1E', '#2E2F35', '#34353C', '#1C1D22', '#2A2A30', '#17171B'];  /* WIDEBOX */
        else if (t === 'c') c = ['#282A28', '#191B19', '#2D302D', '#333633', '#1B1E1C', '#292C29', '#161917'];  /* 카바나 */
        else if (t === 'b') c = ['#2A2A29', '#1A1A19', '#2F2F2E', '#353533', '#1C1C1B', '#2B2B2A', '#171717'];  /* 빈백 */
        else if (t === 'p') c = ['#242C36', '#161C23', '#29313C', '#2F3845', '#181E26', '#252E38', '#141A21'];  /* 장애인석 */
        else if (t === 'v') c = ['#2A2724', '#1A1815', '#2E2B27', '#35322D', '#1C1A17', '#2B2825', '#171512'];  /* PRIVATE BOX */
        else c = ['#242A34', '#171B22', '#29303A', '#2E3541', '#19202A', '#252B35', '#141920'];              /* 일반석 */
        var m = { back: shade(c[0], lit), back2: shade(c[1], lit), pad: shade(c[2], lit),
                  cush: shade(c[3], lit), edge: shade(c[4], lit), arm: shade(c[5], lit), arm2: shade(c[6], lit) };
        MATC[t] = m;
        return m;
      }
      /* 템퍼 시네마·모션베드 — 다크 슬레이트 프레임 + 무광 슬레이트 매트리스.
         (예전 크림·베이지 매트리스는 화면보다 밝아 눈에 튀었다 — 2026-11-21 지적) */
      var BEDM = { hdr: shade('#242A34', lit), matt: shade('#2A303C', lit), matt2: shade('#20252E', lit),
                   pill: shade('#3A4350', lit), pill2: shade('#2C333D', lit), blank: shade('#2F3743', lit),
                   frame: shade('#15191F', lit), frame2: shade('#0E1218', lit), shadow: 'rgba(0,0,0,0.55)' };
      var G = {};
      function put(t, part, poly) { var k = t + '|' + part; (G[k] || (G[k] = [])).push(poly); }
      var firstSeatX = null;
      for (var cx = 0; cx < cells.length; cx++) {
        var cell = cells[cx];
        if (!cell || cell === '.' || !/^\d+[npsrcbxvw]$/.test(cell)) continue;
        var tt = cell.charAt(cell.length - 1);
        var xc = (cx - s.centerX) * pitch;
        var hw = seatW / 2;
        if (firstSeatX === null) firstSeatX = xc;

        if (bed) {
          /* 머리(등받이) 쪽은 z가 더 음수, 발치 쪽은 스크린 쪽 */
          var bh = pitch * 0.46;
          /* 침대 길이는 줄 간격 안에 들어오게 — 옆 줄 좌석과 겹치면 침대가 아니라 벽처럼 보인다 */
          var bedLen = Math.max(0.62, Math.min(1.00, (p.rowGap || 1.15) - 0.10));
          var zHead = zBack - 0.02, zFoot = zHead + bedLen;
          var mHead = hz + 0.46, mTop = hz + 0.40;
          /* 바닥 접지 그림자 — 침대가 바닥에서 떠 보이지 않게 아주 얇게 깐다 */
          put('B', 'bshadow', slabPts(xc - bh * 1.10, xc + bh * 1.10, zHead - 0.10, zFoot + 0.10, hz + 0.012, 0.09, 0.09, 2));
          /* 프레임(둥근 다크 슬레이트 상자) — 바닥에 낮게 깔린다 */
          put('B', 'bframe', slabPts(xc - bh * 1.02, xc + bh * 1.02, zHead - 0.03, zFoot + 0.03, hz + 0.13, 0.07, 0.07, 3));
          put('B', 'bframeside', panelPts(xc - bh * 1.02, xc + bh * 1.02, hz + 0.045, hz + 0.13, zFoot + 0.03, zFoot + 0.03, 0.05, 0.05, 3));
          /* 헤드보드 — 등 뒤쪽의 낮은 둥근 판 */
          put('B', 'bhead', panelPts(xc - bh * 1.00, xc + bh * 1.00, mHead - 0.03, hz + 0.90, zHead - 0.04, zHead - 0.055, 0.10, 0.05, 3));
          /* 매트리스 윗면 — 머리쪽이 살짝 높은 둥근 판 */
          put('B', 'bmatt', slabPts(xc - bh * 0.93, xc + bh * 0.93, zHead + 0.05, zFoot - 0.02, mTop, 0.10, 0.10, 4));
          /* 매트리스 발치 앞면 */
          put('B', 'bfoot', panelPts(xc - bh * 0.93, xc + bh * 0.93, hz + 0.16, mTop - 0.015, zFoot - 0.02, zFoot - 0.02, 0.06, 0.05, 3));
          /* 이불(발치 쪽 절반) — 매트리스와 같은 톤에서 한 단만 다르게 */
          put('B', 'bblank', slabPts(xc - bh * 0.89, xc + bh * 0.89, zHead + bedLen * 0.44, zFoot - 0.06, mTop + 0.014, 0.09, 0.09, 3));
          /* 베개 두 개 — 둥근 모서리의 낮은 슬레이트 그레이 쿠션 */
          put('B', 'bpill', slabPts(xc - bh * 0.80, xc - bh * 0.09, zHead + 0.09, zHead + 0.30, mTop + 0.10, 0.055, 0.055, 3));
          put('B', 'bpill', slabPts(xc + bh * 0.09, xc + bh * 0.80, zHead + 0.09, zHead + 0.30, mTop + 0.10, 0.055, 0.055, 3));
          /* 베개 발치 쪽 단면 */
          put('B', 'bpill2', panelPts(xc - bh * 0.80, xc - bh * 0.10, mTop + 0.012, mTop + 0.095, zHead + 0.30, zHead + 0.30, 0.05, 0.04, 3));
          put('B', 'bpill2', panelPts(xc + bh * 0.10, xc + bh * 0.80, mTop + 0.012, mTop + 0.095, zHead + 0.30, zHead + 0.30, 0.05, 0.04, 3));
          continue;
        }

        /* 등받이 — 둥근 어깨의 매끈한 패널 (젖히면 어깨가 뒤로 눕는다) */
        put(tt, 'back', panelPts(xc - hw, xc + hw, bBot, bTop, zBack, zTop, Math.min(0.11, hw * 0.34), 0.045, 4));
        /* 머리·목 받침 — 등받이보다 한 겹 앞에 얇게 얹는 둥근 패드 */
        var py0 = bTop - 0.29, py1 = bTop - 0.05;
        put(tt, 'pad', panelPts(xc - hw * 0.78, xc + hw * 0.78, py0, py1, zbk(py0) + 0.02, zbk(py1) + 0.02, Math.min(0.09, hw * 0.26), 0.03, 3));
        /* 좌판 윗면 — 뒤쪽이 살짝 높은 오목한 쿠션 */
        put(tt, 'cush', slabPts(xc - hw * 0.93, xc + hw * 0.93, zBack + 0.13, zFront, cTop + 0.05, 0.10, 0.10, 3));
        /* 좌판 앞면(둥근 두께) */
        put(tt, 'edge', panelPts(xc - hw * 0.93, xc + hw * 0.93, cEdge, cTop + 0.03, zFront, zFront, 0.035, 0.035, 3));
        /* 팔걸이 — 오른쪽 하나씩, 줄의 맨 왼쪽 좌석에만 왼쪽 하나 더. 끝이 둥근 캡슐 형태 */
        var armY = cTop + (s.recliner ? 0.19 : 0.16), aw = s.recliner ? 0.095 : 0.075;
        var ax = [xc + hw * 0.98];
        if (xc === firstSeatX) ax.push(xc - hw * 0.98);
        for (var ai = 0; ai < ax.length; ai++) {
          var axc = ax[ai];
          /* 팔걸이 윗면(캡슐) */
          put(tt, 'arm', slabPts(axc - aw / 2, axc + aw / 2, zBack + 0.12, zFront - 0.03, armY, aw * 0.46, 0.05, 3));
          /* 팔걸이 앞쪽 끝면(둥글게 감긴 끝) */
          put(tt, 'arm2', panelPts(axc - aw / 2, axc + aw / 2, cTop - 0.02, armY - 0.012, zFront - 0.03, zFront - 0.03, aw * 0.46, aw * 0.34, 3));
          /* 팔걸이 바깥 옆면 — 가장 어두운 면 */
          var sideX = axc + (axc > xc ? aw / 2 : -aw / 2);
          put(tt, 'arm2', panelPts(sideX, sideX, cTop - 0.02, armY, zBack + 0.12, zFront - 0.03, 0.012, 0.012, 2));
        }
        /* 리클라이너 — 발판이 앞으로 펼쳐진 모습 */
        if (s.recliner) {
          put(tt, 'foot', panelPts(xc - hw * 0.86, xc + hw * 0.86, cTop - 0.17, cTop - 0.03, zFront + 0.36, zFront + 0.03, 0.05, 0.04, 3));
        }
      }

      /* 부품을 뒤→앞 순서로 채운다(같은 부품은 한 번의 fill) */
      /* 깊이 정렬이 없는 화가算法이라 '나중에 그린 면'이 위로 올라온다.
         베드는 프레임 → 헤드보드 → 매트리스 → 이불·베개 → 발치면 순서로 그려야 매트리스가 가려지지 않는다. */
      var PART_ORDER = ['bshadow', 'bframe', 'bframeside', 'bhead', 'bmatt', 'bblank', 'bpill', 'bpill2', 'bfoot',
                        'back', 'pad', 'cush', 'foot', 'edge', 'arm', 'arm2'];
      for (var po = 0; po < PART_ORDER.length; po++) {
        var partName = PART_ORDER[po];
        for (var gkey in G) {
          var cut = gkey.length - partName.length - 1;
          if (cut < 1 || gkey.charAt(cut) !== '|' || gkey.slice(cut + 1) !== partName) continue;
          var tb = gkey.slice(0, cut);
          var style;
          if (tb === 'B') {
            var bmk = { bhead: 'hdr', bmatt: 'matt', bblank: 'blank', bpill: 'pill', bpill2: 'pill2', bjoint: 'frame2', bhend: 'matt2', bfoot: 'matt2', bframe: 'frame', bframeside: 'frame2', bshadow: 'shadow' }[partName];
            style = BEDM[bmk] || BEDM.frame;
          } else if (partName === 'back') {
            var mm = mats(tb);
            var pt = toCam(0, bTop, zTop), pb = toCam(0, bBot, zBack);
            if (pt[2] > NEAR && pb[2] > NEAR) {
              var gr = ctx.createLinearGradient(sx(pt), sy(pt), sx(pb), sy(pb));
              gr.addColorStop(0, mm.back); gr.addColorStop(0.55, mm.back2); gr.addColorStop(1, mm.back2);
              style = gr;
            } else style = mm.back;
          } else if (partName === 'bmatt') {
            var mbm = BEDM.matt;
            var ph = toCam(0, hz + 0.44, zBack), pf = toCam(0, hz + 0.40, zBack + 1.0);
            if (ph[2] > NEAR && pf[2] > NEAR) {
              /* 머리 쪽이 화면 빛을 받아 한 단 밝고 발치로 갈수록 가라앉는다 */
              var gb = ctx.createLinearGradient(sx(ph), sy(ph), sx(pf), sy(pf));
              gb.addColorStop(0, shade('#333A47', lit)); gb.addColorStop(0.5, mbm); gb.addColorStop(1, shade('#252B35', lit));
              style = gb;
            } else style = mbm;
          } else if (partName === 'cush') {
            var mc = mats(tb);
            /* 좌판은 뒤쪽(등받이 쪽)이 살짝 밝고 앞으로 갈수록 어둡다 */
            var qb = toCam(0, cTop + 0.05, zBack + 0.13), qf = toCam(0, cTop + 0.05, zFront);
            if (qb[2] > NEAR && qf[2] > NEAR) {
              var gc = ctx.createLinearGradient(sx(qb), sy(qb), sx(qf), sy(qf));
              gc.addColorStop(0, mc.cush); gc.addColorStop(1, shade('#242A33', lit));
              style = gc;
            } else style = mc.cush;
          } else {
            style = mats(tb)[partName] || mats(tb).back;
          }
          fillBatch(G[gkey], style);
        }
      }

      /* 등받이 어깨의 림라이트 — 스크린 빛이 위 모서리에 얇게 걸리는 정도로만 */
      if (!bed) {
        ctx.beginPath();
        var anyRim = false;
        for (var rr3 = 0; rr3 < cells.length; rr3++) {
          var cR = cells[rr3];
          if (!cR || cR === '.' || !/^\d+[npsrcbxvw]$/.test(cR)) continue;
          var xR = (rr3 - s.centerX) * pitch;
          var hwR = seatW / 2;
          /* 둥근 어깨를 따라 세 점으로 꺾어 긋는다 — 각진 판이 아니라 부드러운 곡면으로 읽힌다 */
          var pA = toCam(xR - hwR * 0.86, bTop - 0.055, zbk(bTop - 0.055));
          var pB = toCam(xR, bTop - 0.012, zbk(bTop - 0.012));
          var pC = toCam(xR + hwR * 0.86, bTop - 0.055, zbk(bTop - 0.055));
          if (pA[2] < NEAR || pB[2] < NEAR || pC[2] < NEAR) continue;
          ctx.moveTo(sx(pA), sy(pA)); ctx.lineTo(sx(pB), sy(pB)); ctx.lineTo(sx(pC), sy(pC));
          anyRim = true;
        }
        if (anyRim) { ctx.strokeStyle = 'rgba(150,170,200,' + (0.16 * lit).toFixed(3) + ')'; ctx.lineWidth = Math.max(1, W / 1500); ctx.stroke(); }
      }
      /* 침대 발치 모서리의 얇은 빛 — 매트리스 두께가 읽히게 */
      if (bed) {
        ctx.beginPath();
        var anyBedRim = false;
        for (var br = 0; br < cells.length; br++) {
          var cB = cells[br];
          if (!cB || cB === '.' || !/^\d+[npsrcbxvw]$/.test(cB)) continue;
          var xB = (br - s.centerX) * pitch, bhB = pitch * 0.46 * 0.93;
          var zFB = -(dc + 0.20) + Math.max(0.62, Math.min(1.00, (p.rowGap || 1.15) - 0.10)) - 0.02;
          var b1 = toCam(xB - bhB, hz + 0.395, zFB), b2 = toCam(xB + bhB, hz + 0.395, zFB);
          if (b1[2] < NEAR || b2[2] < NEAR) continue;
          ctx.moveTo(sx(b1), sy(b1)); ctx.lineTo(sx(b2), sy(b2));
          anyBedRim = true;
        }
        if (anyBedRim) { ctx.strokeStyle = 'rgba(168,186,210,' + (0.12 * lit).toFixed(3) + ')'; ctx.lineWidth = 1; ctx.stroke(); }
      }
      /* 좌석 사이 이음매 — 한 줄이 한 덩어리로 뭉개지지 않고 좌석 하나하나 읽히게 */
      for (var sm = 0; sm < cells.length; sm++) {
        var cm = cells[sm];
        if (!cm || cm === '.' || !/^\d+[npsrcbxvw]$/.test(cm)) continue;
        var xm = (sm - s.centerX) * pitch + seatW / 2;
        seg(toCam(xm, bed ? hz + 0.28 : bBot + 0.02, zBack + 0.004), toCam(xm, bed ? hz + 0.24 : bTop - 0.05, zBack + 0.004),
            'rgba(0,0,0,0.38)', 1.2);
      }
      /* 등받이 가운데 세로 이음매 — 한 덩어리 판이 아니라 푹신한 등판으로 읽히게 */
      if (!bed) {
        ctx.beginPath();
        var anyCrease = false;
        for (var cc2 = 0; cc2 < cells.length; cc2++) {
          var cell3 = cells[cc2];
          if (!cell3 || cell3 === '.' || !/^\d+[npsrcbxvw]$/.test(cell3)) continue;
          var xcr = (cc2 - s.centerX) * pitch;
          var k1c = toCam(xcr, bBot + 0.03, zBack + 0.003), k2c = toCam(xcr, bTop - 0.07, zbk(bTop - 0.07) + 0.003);
          if (k1c[2] < NEAR || k2c[2] < NEAR) continue;
          ctx.moveTo(sx(k1c), sy(k1c)); ctx.lineTo(sx(k2c), sy(k2c));
          anyCrease = true;
        }
        if (anyCrease) { ctx.strokeStyle = 'rgba(255,255,255,0.032)'; ctx.lineWidth = 1.1; ctx.stroke(); }
      }
      /* 좌판 앞 모서리의 얇은 하이라이트 — 빛을 받는 면과 그림자 면을 나눈다 */
      if (!bed) {
        ctx.beginPath();
        var anyEdge = false;
        for (var ce = 0; ce < cells.length; ce++) {
          var cell2 = cells[ce];
          if (!cell2 || cell2 === '.' || !/^\d+[npsrcbxvw]$/.test(cell2)) continue;
          var xe = (ce - s.centerX) * pitch, hwe = seatW / 2;
          var e1 = toCam(xe - hwe * 0.90, cTop + 0.028, zFront), e2 = toCam(xe + hwe * 0.90, cTop + 0.028, zFront);
          if (e1[2] < NEAR || e2[2] < NEAR) continue;
          ctx.moveTo(sx(e1), sy(e1)); ctx.lineTo(sx(e2), sy(e2));
          anyEdge = true;
        }
        if (anyEdge) { ctx.strokeStyle = 'rgba(196,212,232,' + (0.13 * lit).toFixed(3) + ')'; ctx.lineWidth = 1; ctx.stroke(); }
      }

      /* 통로 손잡이 — 좌우 끝 크롬 난간 (사진의 계단 손잡이) */
      [-1, 1].forEach(function (sgn) {
        var hx = sgn * (s.bankHalf + 0.55);
        if (hx > wallX - 0.2 || hx < -wallX + 0.2) return;
        var topY = hz + 0.92;
        seg(toCam(hx, topY, zf + 0.1), toCam(hx, topY, zb - 0.1), 'rgba(190,200,206,0.13)', 1.1);
        seg(toCam(hx, hz, -(dc - 0.02)), toCam(hx, topY, -(dc - 0.02)), 'rgba(170,180,186,0.10)', 1);
        /* 계단 유도등(에메랄드 LED) */
        var lc = toCam(hx - sgn * 0.12, hz + 0.1, -(dc + 0.2));
        if (lc[2] < NEAR + 0.2) return;
        var rr2 = Math.max(0.7, f * 0.028 / lc[2]);
        ctx.fillStyle = 'rgba(16,185,129,0.5)';
        ctx.beginPath(); ctx.arc(sx(lc), sy(lc), rr2, 0, Math.PI * 2); ctx.fill();
      });
      /* 옆벽 바닥 유도선 — 통로 계단을 따라 벽 밑으로 이어지는 얇은 에메랄드 선 */
      [-1, 1].forEach(function (sgn) {
        var wx2 = sgn * (wallX - 0.05);
        seg(toCam(wx2, hz + 0.012, zf), toCam(wx2, hz + 0.012, zb), 'rgba(16,185,129,' + (0.20 * rowLit).toFixed(3) + ')', 1.1);
      });
    });

    /* ---- IMAX 스크린 반사광: 화면 둘레로 크게 번지는 빛(벽·천장까지) ---- */
    if (isImax && scrMid[2] > NEAR) {
      var imx = sx(scrMid), imy = sy(scrMid);
      var ird = Math.max(160, f * (scrW * 1.05) / scrMid[2]);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      var ig = ctx.createRadialGradient(imx, imy, ird * 0.42, imx, imy, ird);
      ig.addColorStop(0, 'rgba(210,226,255,0.035)');
      ig.addColorStop(0.55, 'rgba(180,205,255,0.016)');
      ig.addColorStop(1, 'rgba(150,180,255,0)');
      ctx.fillStyle = ig; ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    /* ---- 스크린 빛이 객석 앞쪽으로 퍼지는 옅은 안개 ---- */
    var sc = toCam(0, scrB + scrH * 0.45, -0.2);
    if (sc[2] > NEAR) {
      var sxp = sx(sc), syp = sy(sc);
      var rad = Math.max(80, f * (scrW * 0.75) / sc[2]);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      var hz2 = ctx.createRadialGradient(sxp, syp, rad * 0.30, sxp, syp, rad);
      hz2.addColorStop(0, 'rgba(255,222,190,0.055)');
      hz2.addColorStop(1, 'rgba(255,205,165,0)');
      ctx.fillStyle = hz2; ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    /* 윙 스크린은 천장 다운라이트·벽 조명을 모두 그린 뒤 마지막에 얹는다(불빛이 윙 위에 겹치지 않게) */
    if (/SCREENX/i.test(tagsStr) || isUltra || o.fourSide) drawWingScreens();

    /* ---- 비네트 ---- */
    var vg = ctx.createRadialGradient(W / 2, H * 0.52, Math.min(W, H) * 0.30, W / 2, H * 0.52, Math.max(W, H) * 0.80);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

    /* ---- PRIVATE BOX: 유리창 너머로 보는 느낌(박스 창틀·유리 반사) ----
       압구정 IMAX 지하2층처럼 유리 없이 열린 박스는 창틀을 그리지 않는다. */
    if (s.isPB && s.glass !== false) {
      var bT = H * 0.10, bB = H * 0.14, bS = W * 0.065;
      ctx.save();
      ctx.fillStyle = 'rgba(8,10,12,0.96)';
      ctx.fillRect(0, 0, W, bT);
      ctx.fillRect(0, H - bB, W, bB);
      ctx.fillRect(0, 0, bS, H);
      ctx.fillRect(W - bS, 0, bS, H);
      /* 창틀 안쪽 모서리 — 위는 밝고 아래는 나무 선반 톤 */
      ctx.lineWidth = Math.max(1.4, W * 0.0032);
      ctx.strokeStyle = 'rgba(228,234,238,0.20)';
      ctx.strokeRect(bS, bT, W - bS * 2, H - bT - bB);
      ctx.strokeStyle = 'rgba(214,196,168,0.13)';
      ctx.beginPath();
      ctx.moveTo(bS, H - bB + 0.5); ctx.lineTo(W - bS, H - bB + 0.5);
      ctx.stroke();
      /* 유리 반사 — 왼쪽 위에서 내려오는 옅은 사선 */
      var gl = ctx.createLinearGradient(bS, bT, bS + W * 0.42, bT + H * 0.55);
      gl.addColorStop(0, 'rgba(255,255,255,0.085)');
      gl.addColorStop(0.45, 'rgba(255,255,255,0.022)');
      gl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gl;
      ctx.beginPath();
      ctx.moveTo(bS, bT); ctx.lineTo(bS + W * 0.20, bT); ctx.lineTo(bS, bT + H * 0.40);
      ctx.closePath(); ctx.fill();
      /* 유리창 테두리 안쪽 어둠(박스 안이 더 어둡다) */
      var sh = ctx.createLinearGradient(0, bT, 0, bT + H * 0.16);
      sh.addColorStop(0, 'rgba(0,0,0,0.35)');
      sh.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sh; ctx.fillRect(bS, bT, W - bS * 2, H * 0.16);
      ctx.restore();
    }

    /* 영상이 재생 중이면 어떤 경로로 그렸든 다음 프레임 루프를 이어 붙인다 */
    if (this.video && !this.video.paused && !this.raf && !this._inVid) this._loop();
  };

  Viewer.prototype.destroy = function () {
    var cv = this.cv;
    this.destroyed = true;
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
    /* 화면에서 사라지는 뷰어는 영상도 멈춘다(다른 화면에서 소리·재생이 남지 않게) */
    if (this.video) { try { this.video.pause(); } catch (e) {} }
    cv.removeEventListener('pointerdown', this._onDown);
    cv.removeEventListener('pointermove', this._onMove);
    cv.removeEventListener('pointerup', this._onUp);
    cv.removeEventListener('pointercancel', this._onUp);
    if (this._ro) this._ro.disconnect();
  };

  /* ---------------------------------------------------------------
     4. 마운트
     --------------------------------------------------------------- */
  var byCanvas = new WeakMap();

  function bindHud(v) {
    if (!v._sel('[data-zoom]').length) return;
    var zs = v._sel('[data-zoom]');
    for (var k = 0; k < zs.length; k++) {
      zs[k].addEventListener('click', function (e) {
        var z = e.currentTarget.getAttribute('data-zoom');
        v.zoom = z;
        v.fov1x = 76;   // 기준 1x 화각 유지, wide는 렌더에서 2배
        var all = v._sel('[data-zoom]');
        for (var m = 0; m < all.length; m++) {
          all[m].setAttribute('aria-pressed', all[m].getAttribute('data-zoom') === z ? 'true' : 'false');
        }
        var note = v._one('.v3d-zoomnote');
        if (note) note.textContent = z === 'wide' ? '광각 0.5x · 실제 눈보다 넓게 보입니다' : '사람 눈 1배율 · 실제로 보이는 크기';
        v.render();
      });
    }
    var rb = v._one('[data-reset]');
    if (rb) rb.addEventListener('click', function () { v.reset(false); });
    var vb = v._one('[data-vid]');
    if (vb) {
      v._vidButton(!!(v.video && !v.video.paused));
      vb.addEventListener('click', function (e) { e.preventDefault(); v.toggleVideo(); });
    }
    var rcb = v._one('[data-recline]');
    if (rcb) {
      v._paintRecBtn();
      rcb.addEventListener('click', function (e) { e.preventDefault(); v.toggleRecline(); });
    }
    var steps = v._sel('[data-recline-step]');
    for (var si = 0; si < steps.length; si++) {
      (function (bind) {
        bind.addEventListener('click', function (e) {
          e.preventDefault();
          v.nudgeRecline(parseFloat(bind.getAttribute('data-recline-step')) || 0);
        });
      })(steps[si]);
    }
    var mb = v._one('[data-mute]');
    if (mb) {
      if (!v.video || v.video.paused) mb.style.display = 'none';
      mb.addEventListener('click', function (e) { e.preventDefault(); v.toggleMute(); });
    }
  }

  function create(cv, opts) {
    var old = byCanvas.get(cv);
    if (old) old.destroy();
    var wrap = cv.parentNode;
    var v = new Viewer(cv, opts);
    v.root = wrap;
    activeViewer = v;
    /* 바인딩 범위: .v3d(캔버스·HUD) + 바로 뒤의 .v3d-bar(화면 아래 컨트롤 바) */
    v.scopes = [wrap];
    var sib = wrap && wrap.nextElementSibling;
    if (sib && /(^|\s)v3d-bar(\s|$)/.test(sib.className || '')) v.scopes.push(sib);
    byCanvas.set(cv, v);
    bindHud(v);
    if (global.ResizeObserver) {
      var lastW = 0;
      v._ro = new ResizeObserver(function () {
        var w2 = cv.offsetWidth;
        if (Math.abs(w2 - lastW) < 2) return;
        lastW = w2;
        v.resize();
      });
      v._ro.observe(cv);
    }
    return v;
  }

  function mount(root, opts) {
    var out = null;
    var cvs = root.querySelectorAll('.v3d-canvas');
    for (var i = 0; i < cvs.length; i++) {
      var seatKey = cvs[i].getAttribute('data-seat');
      var o = opts;
      if (seatKey && opts.bySeat && opts.bySeat[seatKey]) o = opts.bySeat[seatKey];
      out = create(cvs[i], o);
    }
    return out;
  }

  function dispose(rootish) {
    var cvs = rootish.querySelectorAll ? rootish.querySelectorAll('.v3d-canvas') : [];
    for (var i = 0; i < cvs.length; i++) {
      var v = byCanvas.get(cvs[i]);
      if (v) { v.destroy(); byCanvas.delete(cvs[i]); }
    }
  }

  /* 현재 화면에 붙어 있는 뷰어를 찾는다(모드·화각 전환을 재마운트 없이 바로 적용하기 위해) */
  function findFor(root) {
    if (!root) return null;
    var cv = root.querySelector('.v3d-canvas');
    return cv ? (byCanvas.get(cv) || null) : null;
  }

  /* 페이지 어디에서든 영상 재생을 끝낸다 — 뒤로가기·홈 이동·시트 닫기에서 호출 */
  function stopAll() {
    vprobe.bad = 0; vprobe.broken = false; vprobe.at = 0;
    if (sharedVideo) {
      try { sharedVideo.pause(); sharedVideo.currentTime = 0; } catch (e) {}
    } else {
      var vs = document.querySelectorAll('video');
      for (var i = 0; i < vs.length; i++) { try { vs[i].pause(); vs[i].currentTime = 0; } catch (e) {} }
    }
    var btns = document.querySelectorAll('[data-vid]');
    for (var k = 0; k < btns.length; k++) {
      btns[k].textContent = '\u25b6 \uc601\uc0c1';
      btns[k].setAttribute('aria-pressed', 'false');
    }
    var mbs = document.querySelectorAll('[data-mute]');
    for (var m = 0; m < mbs.length; m++) mbs[m].style.display = 'none';
  }

  global.Viewer3D = { mount: mount, create: create, dispose: dispose, frame: movieFrame, findFor: findFor, riserTable: RISER_STEP, stopAll: stopAll,
    /* 단면도가 현재 등받이 각도를 알 수 있게 — {rec:0~1, deg:110~160} */
    reclineOf: function () { return { rec: recState.v || 0, deg: Math.round(RECLINE_UP + (RECLINE_BACK - RECLINE_UP) * (recState.v || 0)) }; } };

})(window);
