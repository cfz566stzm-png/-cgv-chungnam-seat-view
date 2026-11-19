'use strict';
/**
 * CGV 티켓 OCR — Vercel 서버리스 함수 (CommonJS)
 *
 * 사진(종이 입장권 또는 CGV 앱 캡처)을 Gemini 2.5 Flash에 보내
 * 지점·상영관·좌석·영화·일시를 JSON으로 받아 돌려준다.
 *
 * 보안: Gemini API 키는 오직 process.env.GEMINI_API_KEY 에서만 읽는다.
 *       키를 코드·로그·오류 메시지·응답 어디에도 남기지 않는다.
 *
 * 요청: POST /api/ocr  { "imageBase64": "...", "mimeType": "image/jpeg" }
 * 응답: { ok: true, theater, hall, seat, movie, date }
 *       { ok: false, error: "missing_api_key" | "rate_limited" | ... }
 */

const MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const ALLOWED_ORIGINS = [
  'https://yeongsimi.kr',
  'https://www.yeongsimi.kr',
  'https://cfz566stzm-png.github.io'   /* 예전 주소 — 리디렉션 전 페이지에서도 동작하게 */
];
const MAX_B64_CHARS = 8 * 1024 * 1024; /* base64 문자열 상한 (≈6MB 이미지) */
const UPSTREAM_TIMEOUT_MS = 12000;
const MIME_OK = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i;

const PROMPT = [
  '첨부된 사진은 CGV 영화 티켓이다. 종이 입장권을 찍은 사진이거나 CGV 앱·예매 화면을 캡처한 것이다.',
  '아래 JSON 객체 하나만 출력한다. 설명, 인사말, 코드블록 표시 없이 JSON만 쓴다.',
  '',
  '{"theater":"","hall":"","seat":"","movie":"","date":""}',
  '',
  '각 항목 규칙:',
  '- theater: CGV 지점명만. "CGV 천안펜타포트(104-81-45690)" → "천안펜타포트". "CGV", 사업자번호, 괄호는 뺀다.',
  '- hall: 상영관 이름. "9관 G열7번" → "9관". IMAX·4DX·SCREENX·씨네앤포레처럼 이름형이면 "IMAX관"처럼 뒤에 "관"을 붙인다.',
  '- seat: 알파벳 행 + 숫자 열을 공백 없이 붙인 표준 형식. "G열7번" → "G7", "F열 11" → "F11", "DX열 5번" → "DX5",',
  '  "10관 with PRIVATE BOX 5층 H열9~10번" → "H9,H10". 여러 좌석이면 쉼표로 잇는다.',
  '- movie: 영화 제목만(한국어 제목). 원제·영어 제목 줄은 넣지 않는다.',
  '- date: 관람 일시, "YYYY-MM-DD HH:MM"(24시간). "2026.11.15(일) 1회 10:00" → "2026-11-15 10:00".',
  '  시간이 없으면 날짜만 "YYYY-MM-DD".',
  '- 사진에서 확실히 읽히지 않는 항목은 빈 문자열 ""로 둔다. 추측해서 채우지 않는다.',
  '- 0/O, 1/I, 5/S처럼 헷갈리는 글자는 티켓 문맥(관 번호·좌석 행)에 맞게 판단한다.'
].join('\n');

/* ---------- CORS ---------- */

function originAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.indexOf(origin) >= 0) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
}

function commonHeaders(origin) {
  const h = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  if (originAllowed(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

/* ---------- 요청 본문 ---------- */

function safeJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function readBody(req) {
  const b = req && req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return Promise.resolve(b);
  if (typeof b === 'string') return Promise.resolve(safeJson(b));
  if (Buffer.isBuffer(b)) return Promise.resolve(safeJson(b.toString('utf8')));
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    if (typeof req.on !== 'function') { finish(null); return; }
    req.on('data', (chunk) => {
      data += typeof chunk === 'string' ? chunk : String(chunk);
      if (data.length > MAX_B64_CHARS + 4096) finish(null); /* 너무 큰 본문은 버린다 */
    });
    req.on('end', () => finish(safeJson(data)));
    req.on('error', () => finish(null));
  });
}

/* ---------- 값 정규화 ---------- */

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max || 80);
}

function normTheater(v) {
  return clean(v, 60)
    .replace(/^CGV\s*/i, '')
    .replace(/[\(（][^\)）]*[\)）]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normHall(v) {
  const s = clean(v, 40);
  if (!s) return '';
  const m = s.match(/(\d{1,2})\s*관/);
  if (m) return m[1] + '관';
  if (/imax|아이맥스/i.test(s)) return 'IMAX관';
  if (/4dx/i.test(s)) return '4DX관';
  if (/screen\s*x|스크린\s*x/i.test(s)) return 'SCREENX관';
  if (/씨네앤포레/.test(s)) return '씨네앤포레';
  return s.slice(0, 30);
}

function normSeat(v) {
  const s = clean(v, 60).toUpperCase()
    .replace(/열/g, ' ')
    .replace(/번/g, ' ')
    .replace(/[^A-Z0-9,\-–~ ]/g, ' ');
  if (!s.trim()) return '';
  const out = [];
  const seen = {};
  const re = /([A-Z]{1,2})\s*[-–~]?\s*(\d{1,3})/g;
  let m;
  while ((m = re.exec(s))) {
    const key = m[1] + String(+m[2]);
    if (seen[key]) continue;
    seen[key] = 1;
    out.push(key);
  }
  return out.slice(0, 4).join(',');
}

function pad2(v) { return String(v).padStart(2, '0'); }

function normDate(v) {
  const s = clean(v, 40);
  if (!s) return '';
  const d = s.match(/(20\d{2})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})/);
  if (!d) return '';
  let out = d[1] + '-' + pad2(d[2]) + '-' + pad2(d[3]);
  const t = s.match(/(\d{1,2})\s*:\s*(\d{2})/);
  if (t) out += ' ' + pad2(+t[1]) + ':' + t[2];
  return out;
}

function normMovie(v) {
  return clean(v, 60).replace(/^[\[\]「」『』"']+/g, '').replace(/[\[\]「」『』]+$/g, '').trim();
}

/* ---------- Gemini 호출 ---------- */

async function callGemini(key, imageBase64, mimeType) {
  const url = API_BASE + MODEL + ':generateContent?key=' + encodeURIComponent(key);
  const baseBody = {
    contents: [{
      role: 'user',
      parts: [
        { text: PROMPT },
        { inline_data: { mime_type: mimeType, data: imageBase64 } }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 512
    }
  };

  const send = async (body) => {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, UPSTREAM_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined
      });
    } finally {
      clearTimeout(timer);
    }
  };

  /* 2.5 Flash의 thinking은 지연을 키운다 — 먼저 끄고 부르고, 그 설정이 거부되면(400)
     thinkingConfig 없이 한 번 더 부른다. */
  const fastBody = JSON.parse(JSON.stringify(baseBody));
  fastBody.generationConfig.thinkingConfig = { thinkingBudget: 0 };

  let res = await send(fastBody);
  if (res.status === 400) res = await send(baseBody);

  if (!res.ok) {
    if (res.status === 429) {
      const err = new Error('rate_limited');
      err.status = 429;
      err.code = 'rate_limited';
      throw err;
    }
    const t = await res.text().catch(() => '');
    const err = new Error('upstream_' + res.status);
    err.status = 502;
    err.code = 'upstream_' + res.status;
    err.detail = String(t || '').slice(0, 300);
    throw err;
  }

  const data = await res.json().catch(() => null);
  const cand = ((data && data.candidates) || [])[0] || {};
  const parts = ((cand.content && cand.content.parts) || []);
  let text = parts.map((p) => (p && p.text) || '').join('').trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) {
    const err = new Error('bad_response');
    err.status = 502;
    err.code = 'bad_response';
    throw err;
  }
  const parsed = safeJson(text.slice(a, b + 1));
  if (!parsed || typeof parsed !== 'object') {
    const err = new Error('bad_response');
    err.status = 502;
    err.code = 'bad_response';
    throw err;
  }
  return parsed;
}

/* ---------- 핸들러 ---------- */

module.exports = async (req, res) => {
  const headers = req && req.headers ? req.headers : {};
  const origin = headers.origin || headers.Origin || '';

  const send = (code, obj) => {
    const h = commonHeaders(origin);
    Object.keys(h).forEach((k) => { try { res.setHeader(k, h[k]); } catch (e) {} });
    res.statusCode = code;
    if (code === 204 || obj === undefined) { res.end(); return; }
    res.end(JSON.stringify(obj));
  };

  if (req && req.method === 'OPTIONS') {
    if (!originAllowed(origin)) { send(403, { ok: false, error: 'origin_not_allowed' }); return; }
    send(204);
    return;
  }

  if (!req || req.method !== 'POST') {
    send(405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  /* 허용 목록 밖의 웹 페이지가 브라우저에서 부르는 것은 막는다(ACAO 헤더를 주지 않는다) */
  if (origin && !originAllowed(origin)) {
    send(403, { ok: false, error: 'origin_not_allowed' });
    return;
  }

  let body = null;
  try { body = await readBody(req); } catch (e) { body = null; }
  if (!body || typeof body !== 'object') {
    send(400, { ok: false, error: 'bad_body' });
    return;
  }

  const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.replace(/\s+/g, '') : '';
  const mimeType = typeof body.mimeType === 'string' && body.mimeType ? body.mimeType.toLowerCase() : 'image/jpeg';

  if (!imageBase64) {
    send(400, { ok: false, error: 'missing_image' });
    return;
  }
  if (imageBase64.length > MAX_B64_CHARS) {
    send(413, { ok: false, error: 'image_too_large' });
    return;
  }
  if (!MIME_OK.test(mimeType)) {
    send(415, { ok: false, error: 'unsupported_mime' });
    return;
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    /* 키가 없다는 사실만 알린다. 키 값이나 환경 정보는 응답·로그에 남기지 않는다. */
    send(500, { ok: false, error: 'missing_api_key' });
    return;
  }

  let parsed;
  try {
    parsed = await callGemini(key, imageBase64, mimeType);
  } catch (e) {
    const code = e && e.status ? e.status : 502;
    const name = (e && e.code) || (e && e.name === 'AbortError' ? 'timeout' : 'upstream_error');
    if (name !== 'rate_limited') {
      /* 키가 메시지에 섞여 들어오는 경우를 대비해 지운 뒤 남긴다 */
      const msg = String((e && e.detail) || (e && e.message) || '').split(key).join('<redacted>').slice(0, 200);
      console.error('[ocr] ' + name + ' ' + msg);
    }
    send(name === 'timeout' ? 504 : code, { ok: false, error: name === 'timeout' ? 'timeout' : name });
    return;
  }

  send(200, {
    ok: true,
    theater: normTheater(parsed.theater),
    hall: normHall(parsed.hall),
    seat: normSeat(parsed.seat),
    movie: normMovie(parsed.movie),
    date: normDate(parsed.date)
  });
};
