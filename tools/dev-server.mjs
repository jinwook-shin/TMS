#!/usr/bin/env node
/**
 * TMS 개발 서버 — 정적 서빙 + 같은 오리진 길찾기 프록시
 * ----------------------------------------------------------------------------
 * 왜 필요한가
 *   1) 카카오맵 JS SDK 는 **등록된 도메인**에서만 동작한다. file:// 로 열면
 *      오리진이 null 이라 앱키를 넣어도 지도가 뜨지 않는다.
 *   2) 카카오모빌리티 길찾기 API 는 CORS 헤더를 주지 않아 브라우저에서 직접
 *      호출할 수 없다.
 *
 * 이 서버가 앱과 API 를 **같은 오리진**으로 묶어 두 문제를 한 번에 없앤다.
 * 같은 오리진이면 프리플라이트(OPTIONS)조차 발생하지 않는다.
 *
 * 실행
 *   node tools/dev-server.mjs              (또는 npm start)
 *   PORT=3000 node tools/dev-server.mjs
 *
 * REST 키는 .env 에 넣거나(권장, 브라우저에 노출되지 않음) 앱 설정에서 입력한다.
 * 의존성 없음 — Node 18+ 내장 모듈만 사용.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const UPSTREAM = 'https://apis-navi.kakaomobility.com';
const DEFAULT_PORT = Number(process.env.PORT || 3000);
const MAX_PORT_TRIES = 20;

/** 이 서버가 응답할 Host 값 — DNS 리바인딩으로 사설 IP 를 겨눈 요청을 막는다 */
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i;

/** 중계를 허용하는 업스트림 경로 (tools/kakao-proxy.mjs 와 동일하게 유지) */
const ALLOWED_API_PATHS = new Set([
  '/v1/directions',
  '/v1/waypoints/directions',
  '/v1/destinations/directions',
  '/v1/origins/directions',
]);

/* ============================== .env 로딩 ============================== */
/** Node 20.6+ 의 --env-file 에 의존하지 않도록 직접 파싱한다 (18/20 하위호환) */
function loadEnvFile(file) {
  const out = {};
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { vars: out, found: false }; }
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return { vars: out, found: true };
}

const envFile = path.join(ROOT, '.env');
let envCache = { mtime: 0, vars: {}, found: false };

/** .env 를 mtime 기준으로 다시 읽는다 — 서버 재시작 없이 키를 넣을 수 있게. */
function currentEnv() {
  let mtime = 0;
  try { mtime = fs.statSync(envFile).mtimeMs; } catch { mtime = 0; }
  if (mtime !== envCache.mtime) {
    const { vars, found } = loadEnvFile(envFile);
    envCache = { mtime, vars, found: found && mtime > 0 };
    if (found && mtime > 0) console.log('  .env 를 다시 읽었습니다' + (vars.KAKAO_REST_KEY ? ' (REST 키 감지됨)' : ''));
  }
  return envCache;
}

/** 지금 유효한 REST 키 (환경변수 > .env) */
function restKey() {
  return (process.env.KAKAO_REST_KEY || currentEnv().vars.KAKAO_REST_KEY || '').trim();
}

currentEnv();

/* ========================== 정적 파일 경로 해석 ========================== */
/** 서빙하면 안 되는 디렉터리·파일 이름 */
const DENY_SEGMENTS = new Set(['node_modules', '.git', '.env']);

/**
 * URL 경로 → 저장소 안의 실제 파일 경로. 위험하면 null.
 * 경로 순회 차단만으로는 부족하다 — `/.env` 나 `/.git/config` 는 "루트 안"이지만
 * 절대 노출하면 안 되므로 점(.)으로 시작하는 세그먼트를 전부 막는다.
 */
function safeResolve(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); }
  catch { return null; }                          // 깨진 퍼센트 인코딩
  if (decoded.includes('\0')) return null;        // 널바이트 주입
  decoded = decoded.replace(/\\/g, '/');          // 윈도우 역슬래시 정규화

  const segments = path.posix.normalize(decoded).split('/').filter((s) => s && s !== '.');
  for (const seg of segments) {
    if (seg === '..') return null;
    if (seg.startsWith('.')) return null;                  // 모든 점파일
    if (DENY_SEGMENTS.has(seg.toLowerCase())) return null;
  }

  const resolved = path.resolve(root, ...segments);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('요청 본문이 너무 큽니다')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ============================== 요청 처리 ============================== */
let actualPort = DEFAULT_PORT;

async function handle(req, res) {
  // DNS 리바인딩 방어 — 공격자 도메인이 이 서버를 가리키게 해도 Host 가 다르면 거부한다
  if (!LOCAL_HOST_RE.test(req.headers.host || '')) {
    sendJson(res, 403, {
      error: 'BAD_HOST',
      message: `허용되지 않은 Host 입니다: ${req.headers.host}. localhost 로 접속하세요.`,
    });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  /* --- 앱이 환경을 파악하는 상태 엔드포인트 (설정 마법사가 호출) --- */
  if (pathname === '/__status') {
    sendJson(res, 200, {
      ok: true,
      server: 'tms-dev-server',
      port: actualPort,
      origin: `http://localhost:${actualPort}`,
      hasRestKey: Boolean(restKey()),
      envFile: currentEnv().found,
      upstream: UPSTREAM,
      node: process.versions.node,
    });
    return;
  }

  /* --- 같은 오리진 길찾기 프록시 --- */
  if (pathname.startsWith('/v1/')) {
    // 이 프록시는 **이 서버가 서빙한 페이지 전용**이다.
    // 오리진이 없으면(같은 출처 fetch) 통과, 있으면 자기 자신일 때만 통과시킨다.
    // 이렇게 하지 않으면 사용자가 열어 둔 아무 웹페이지나 REST 키 쿼터를 소모할 수 있다.
    const origin = req.headers.origin;
    if (origin) {
      let sameOrigin = false;
      try {
        const o = new URL(origin);
        sameOrigin = LOCAL_HOST_RE.test(o.host) && o.port === String(actualPort);
      } catch { sameOrigin = false; }
      if (!sameOrigin) {
        console.warn(`  거부된 오리진: ${origin}`);
        sendJson(res, 403, {
          error: 'ORIGIN_NOT_ALLOWED',
          message: `이 프록시는 개발 서버가 서빙한 페이지에서만 호출할 수 있습니다 (요청 오리진: ${origin}).`,
        });
        return;
      }
    }
    if (!ALLOWED_API_PATHS.has(pathname)) {
      sendJson(res, 404, {
        error: 'NOT_ALLOWED',
        message: `중계할 수 없는 경로입니다: ${pathname}`,
        allowed: [...ALLOWED_API_PATHS],
      });
      return;
    }
    // 키 우선순위: .env(서버 보관) → 브라우저가 보낸 Authorization 헤더
    const key = restKey();
    const auth = key ? `KakaoAK ${key}` : req.headers.authorization;
    if (!auth) {
      sendJson(res, 401, {
        error: 'NO_REST_KEY',
        message: 'REST 키가 없습니다. .env 에 KAKAO_REST_KEY 를 넣거나 앱 설정 탭에서 입력하세요.',
      });
      return;
    }

    const init = { method: req.method, headers: { Authorization: auth, 'Content-Type': 'application/json' } };
    if (req.method === 'POST') {
      try { init.body = await readBody(req); }
      catch (err) { sendJson(res, 413, { error: 'BODY_TOO_LARGE', message: String(err.message || err) }); return; }
    }

    const started = Date.now();
    try {
      const upstream = await fetch(UPSTREAM + pathname + url.search, init);
      const text = await upstream.text();
      console.log(`  ${req.method} ${pathname} → ${upstream.status} (${Date.now() - started}ms)`);
      // 업스트림 상태와 본문을 그대로 전달한다.
      // 카카오가 보낸 오류 메시지를 사용자가 직접 봐야 원인을 알 수 있다.
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(text);
    } catch (err) {
      console.error(`  ${req.method} ${pathname} → 업스트림 연결 실패: ${err.message}`);
      sendJson(res, 502, {
        error: 'UPSTREAM_UNREACHABLE',
        message: `카카오모빌리티 서버에 연결하지 못했습니다: ${err.message}. 네트워크나 사내 방화벽을 확인하세요.`,
      });
    }
    return;
  }

  /* --- 정적 파일 --- */
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: `${req.method} 는 지원하지 않습니다.` });
    return;
  }

  let filePath = safeResolve(ROOT, pathname);
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 접근할 수 없는 경로입니다');
    return;
  }

  try {
    let stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fsp.stat(filePath);
    }
    // 경로 문자열 검사만으로는 부족하다 — 저장소 안의 심볼릭 링크가 밖을 가리키면
    // 그대로 따라가 버린다. 실제 경로를 풀어 루트 안에 있는지 다시 확인한다.
    const real = await fsp.realpath(filePath);
    const realRoot = await fsp.realpath(ROOT);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      console.warn(`  심볼릭 링크 탈출 차단: ${pathname} → ${real}`);
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 저장소 밖을 가리키는 링크입니다');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',      // 개발 서버 — 항상 최신 파일을 준다
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 파일을 찾을 수 없습니다: ' + pathname);
  }
}

/* ============================ 기동 · 포트 확보 ============================ */
function listen(port, triesLeft) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('처리 중 오류:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL', message: String(err.message || err) });
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log(`  포트 ${port} 사용 중 → ${port + 1} 시도`);
      listen(port + 1, triesLeft - 1);
      return;
    }
    if (err.code === 'EADDRINUSE') {
      console.error(`\n포트 ${DEFAULT_PORT}~${port} 가 모두 사용 중입니다. PORT=8080 node tools/dev-server.mjs 처럼 지정하세요.\n`);
    } else {
      console.error('\n서버를 시작하지 못했습니다:', err.message, '\n');
    }
    process.exit(1);
  });

  // 루프백에만 바인딩한다. 같은 네트워크의 다른 기기가 이 서버(와 REST 키)에 닿으면 안 된다.
  server.listen(port, '127.0.0.1', () => {
    actualPort = port;
    banner(port);
  });
}

/** 터미널 표시 폭 — 한글·기호는 두 칸을 차지한다 */
function dispWidth(str) {
  let w = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1f9ff);
    w += wide ? 2 : 1;
  }
  return w;
}

const BOX_W = 64;   // ║ 사이 내부 폭

function boxLine(text = '') {
  const pad = Math.max(0, BOX_W - dispWidth(text));
  return `║${text}${' '.repeat(pad)}║`;
}

function banner(port) {
  const origin = `http://localhost:${port}`;
  const rule = '═'.repeat(BOX_W);
  const key = restKey();
  const moved = port !== DEFAULT_PORT;
  const out = [
    '',
    `╔${rule}╗`,
    boxLine('  TMS 배송코스 최적화 · 개발 서버'),
    `╠${rule}╣`,
    boxLine(`  앱 주소   ${origin}`),
    boxLine(),
    boxLine('  ▸ 카카오 디벨로퍼스에 등록할 사이트 도메인'),
    boxLine(`      ${origin}`),
    boxLine('      내 애플리케이션 → 앱 설정 → 플랫폼 → Web'),
    ...(moved ? [
      boxLine(),
      boxLine(`  ⚠ 포트 ${DEFAULT_PORT} 이 사용 중이라 ${port} 으로 열었습니다.`),
      boxLine(`     카카오에 ${DEFAULT_PORT} 을 등록해 두셨다면 지도가 뜨지 않습니다.`),
      boxLine(`     위 주소(${port})를 추가로 등록하거나, ${DEFAULT_PORT} 을 쓰는`),
      boxLine('     다른 프로그램을 끄고 다시 실행하세요.'),
    ] : []),
    boxLine(),
    boxLine(`  REST 키   ${key ? '.env 에서 로드됨 (브라우저에 노출 안 됨)' : '미설정 — 앱 설정 탭 또는 .env'}`),
    boxLine(`  길찾기    ${origin}/v1/*`),
    boxLine('            앱과 같은 오리진이라 CORS 가 발생하지 않습니다'),
    `╚${rule}╝`,
    '',
    `브라우저에서 ${origin} 을 열고 [설정] 탭의 안내를 따라가세요.`,
    '종료: Ctrl+C',
    '',
  ];
  console.log(out.join('\n'));
}

listen(DEFAULT_PORT, MAX_PORT_TRIES);
