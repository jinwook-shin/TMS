#!/usr/bin/env node
/**
 * 카카오모빌리티 길찾기 API CORS 프록시
 * ----------------------------------------------------------------------------
 * apis-navi.kakaomobility.com 은 서버 간 호출용이라 CORS 헤더를 내려주지 않습니다.
 * 이 프록시가 CORS 헤더를 붙여 브라우저에서 호출할 수 있게 하고,
 * REST API 키를 서버(이 프로세스)에만 보관해 브라우저 노출을 막습니다.
 *
 * 실행:
 *   KAKAO_REST_KEY=발급받은_REST_키 node tools/kakao-proxy.mjs
 *   KAKAO_REST_KEY=... PORT=8787 node tools/kakao-proxy.mjs
 *
 * 앱 설정 탭에서 "프록시 URL"을 http://localhost:8787 로 지정하세요.
 * 의존성 없음 (Node 18+ 내장 fetch 사용).
 */

import http from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const REST_KEY = process.env.KAKAO_REST_KEY || '';
const UPSTREAM = 'https://apis-navi.kakaomobility.com';
// 쉼표로 여러 오리진 지정. 미지정 시 로컬호스트 오리진만 허용한다.
// (기본값을 '*' 로 두면 사용자가 열어 둔 아무 웹페이지나 이 프록시를 호출해
//  운영자의 카카오 REST 키 쿼터를 소모할 수 있다. 필요하면 명시적으로 '*' 지정.)
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '';
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** 프록시가 중계를 허용하는 업스트림 경로 화이트리스트 */
const ALLOWED_PATHS = new Set([
  '/v1/directions',
  '/v1/waypoints/directions',
  '/v1/destinations/directions',
  '/v1/origins/directions',
]);

/** 이 오리진의 브라우저 요청을 중계해도 되는가 */
function originAllowed(origin) {
  if (!origin) return true;                     // curl 등 오리진 없는 호출
  if (ALLOW_ORIGIN === '*') return true;
  if (!ALLOW_ORIGIN) return LOCAL_ORIGIN_RE.test(origin);
  return ALLOW_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
}

function setCors(req, res) {
  const origin = req.headers.origin;
  // 허용된 오리진에만 CORS 헤더를 준다. 그 외에는 브라우저가 응답을 읽지 못한다.
  if (originAllowed(origin) && origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { // 2MB 방어
        reject(new Error('요청 본문이 너무 큽니다'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 허용되지 않은 오리진은 업스트림까지 보내지 않는다 (REST 키 쿼터 보호)
  if (!originAllowed(req.headers.origin)) {
    console.warn(`거부된 오리진: ${req.headers.origin}`);
    sendJson(res, 403, {
      error: 'ORIGIN_NOT_ALLOWED',
      message: `허용되지 않은 오리진입니다: ${req.headers.origin}. `
             + 'ALLOW_ORIGIN 환경변수에 해당 오리진을 추가하세요.',
    });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true, hasKey: Boolean(REST_KEY), upstream: UPSTREAM });
    return;
  }

  if (!ALLOWED_PATHS.has(url.pathname)) {
    sendJson(res, 404, {
      error: 'NOT_ALLOWED',
      message: `중계 불가 경로: ${url.pathname}`,
      allowed: [...ALLOWED_PATHS],
    });
    return;
  }

  // 키 우선순위: 프록시 환경변수 → 클라이언트가 보낸 Authorization 헤더
  const clientAuth = req.headers.authorization;
  const auth = REST_KEY ? `KakaoAK ${REST_KEY}` : clientAuth;
  if (!auth) {
    sendJson(res, 401, {
      error: 'NO_KEY',
      message: 'KAKAO_REST_KEY 환경변수를 설정하거나 Authorization 헤더를 보내세요.',
    });
    return;
  }

  const target = UPSTREAM + url.pathname + url.search;
  const init = {
    method: req.method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
  };

  if (req.method === 'POST') {
    try {
      init.body = await readBody(req);
    } catch (err) {
      sendJson(res, 413, { error: 'BODY_TOO_LARGE', message: String(err.message || err) });
      return;
    }
  }

  const started = Date.now();
  try {
    const upstream = await fetch(target, init);
    const text = await upstream.text();
    const ms = Date.now() - started;
    console.log(`${req.method} ${url.pathname} → ${upstream.status} (${ms}ms)`);
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    });
    res.end(text);
  } catch (err) {
    console.error(`${req.method} ${url.pathname} → 업스트림 오류:`, err.message);
    sendJson(res, 502, { error: 'UPSTREAM_ERROR', message: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log('─'.repeat(64));
  console.log(`  카카오모빌리티 프록시 실행 중  →  http://localhost:${PORT}`);
  console.log(`  REST 키       : ${REST_KEY ? '환경변수에서 로드됨 ✔' : '미설정 (클라이언트 헤더 사용)'}`);
  console.log(`  허용 오리진   : ${ALLOW_ORIGIN || 'localhost / 127.0.0.1 (기본)'}`);
  console.log(`  헬스체크      : http://localhost:${PORT}/health`);
  console.log('─'.repeat(64));
});
