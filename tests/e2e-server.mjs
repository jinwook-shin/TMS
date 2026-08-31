/**
 * 개발 서버 + 설정 마법사 E2E
 * 실제 카카오 서버 대신 모의 업스트림을 세워, 키 입력 → 검증 흐름 전체를 확인한다.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 4510;
const R = []; const check = (n, ok, d = '') => { R.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };

/* --- 카카오맵 SDK 모의 (앱키 유효성에 따라 다르게 응답) --- */
const SDK_OK = `(function(){
  function LatLng(a,b){this._lat=a;this._lng=b} LatLng.prototype.getLat=function(){return this._lat};LatLng.prototype.getLng=function(){return this._lng};
  function LatLngBounds(){} LatLngBounds.prototype.extend=function(){};
  function Map(){} Map.prototype.addControl=function(){};Map.prototype.setBounds=function(){};Map.prototype.setCenter=function(){};
  Map.prototype.getLevel=function(){return 8};Map.prototype.setLevel=function(){};Map.prototype.relayout=function(){};
  function CO(o){this.o=o} CO.prototype.setMap=function(){};
  function PL(){} PL.prototype.setMap=function(){};
  function G(){} G.prototype.addressSearch=function(q,cb){ cb(window.__DOMAIN_OK===false?[]:[{y:'37.5',x:'126.9',road_address:{address_name:'테스트'}}], window.__DOMAIN_OK===false?'ERROR':'OK') };
  G.prototype.coord2Address=function(x,y,cb){cb([{road_address:{address_name:'테스트로'}}],'OK')};
  function P(){} P.prototype.keywordSearch=function(q,cb){cb([{place_name:q,road_address_name:'테스트',y:'37.5',x:'126.9'}],'OK')};
  window.kakao={maps:{load:function(cb){cb()},Map:Map,LatLng:LatLng,LatLngBounds:LatLngBounds,CustomOverlay:CO,Polyline:PL,
    ZoomControl:function(){},ControlPosition:{RIGHT:'r'},event:{addListener:function(){}},
    services:{Geocoder:G,Places:P,Status:{OK:'OK',ZERO_RESULT:'ZERO_RESULT',ERROR:'ERROR'}}}};
})();`;

/* --- 모의 카카오모빌리티 업스트림 --- */
let lastAuth = null;
const hits = { directions: 0, destinations: 0, waypoints: 0 };
const upstream = http.createServer(async (req, res) => {
  lastAuth = req.headers.authorization || null;
  const p = req.url.split('?')[0];
  if (lastAuth !== 'KakaoAK VALID_REST_KEY') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ msg: 'invalid app key', code: -401 })); return;
  }
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (p === '/v1/destinations/directions') {
    hits.destinations++;
    // 실제 API 와 동일하게 목적지별 key 를 되돌려준다
    const body = JSON.parse(await new Promise((r) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => r(b || '{}')); }));
    json({ routes: (body.destinations || []).map((d) => ({
      result_code: 0, key: d.key, summary: { distance: 8000 + (+d.key) * 137, duration: 900 + (+d.key) * 23 } })) });
    return;
  }
  if (p === '/v1/waypoints/directions') {
    hits.waypoints++;
    json({ routes: [{ result_code: 0, summary: { distance: 30000, duration: 3600 },
      sections: [{ roads: [{ vertexes: [126.97, 37.55, 127.02, 37.50, 127.05, 37.51] }] }] }] });
    return;
  }
  hits.directions++;
  json({ routes: [{ result_code: 0, summary: { distance: 11200, duration: 1620 } }] });
});
await new Promise((r) => upstream.listen(4511, r));

/* --- 개발 서버 기동 (업스트림을 모의 서버로 돌려놓고) --- */
const serverFile = path.join(ROOT, 'tools/dev-server.mjs');
const patched = path.join(ROOT, 'tools/.dev-server.test.mjs');
// 개발자의 실제 .env 에 영향받지 않도록 테스트 전용 env 경로로 갈아끼운다.
// (이 테스트는 REST 키가 서버에 "없는" 상태를 전제로 3단계 입력란을 검사한다)
const testEnv = path.join(os.tmpdir(), `tms-test-env-${process.pid}`);
fs.writeFileSync(patched, fs.readFileSync(serverFile, 'utf8')
  .replace("const UPSTREAM = 'https://apis-navi.kakaomobility.com';", "const UPSTREAM = 'http://127.0.0.1:4511';")
  .replace("const envFile = path.join(ROOT, '.env');", `const envFile = ${JSON.stringify(testEnv)};`));

const proc = spawn(process.execPath, [patched], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
let bootLog = '';
proc.stdout.on('data', (d) => { bootLog += d.toString(); });
proc.stderr.on('data', (d) => { bootLog += d.toString(); });
await new Promise((r) => setTimeout(r, 1400));

// 이 테스트는 .env 를 만들지 않는다. 지우면 개발자의 실제 REST 키 파일이 날아간다.
// 개발자의 실제 .env 는 절대 건드리지 않는다 — 테스트 전용 임시 파일만 정리한다
const cleanup = () => {
  try { proc.kill(); } catch {}
  try { fs.unlinkSync(patched); } catch {}
  try { fs.unlinkSync(testEnv); } catch {}
  upstream.close();
};

try {
  check('개발 서버 기동 + 등록 도메인 안내 출력',
    bootLog.includes(`http://localhost:${PORT}`) && bootLog.includes('플랫폼'), bootLog.split('\n').find((l) => l.includes('앱 주소'))?.trim());

  const st = await (await fetch(`http://localhost:${PORT}/__status`)).json();
  check('/__status 응답', st.server === 'tms-dev-server' && st.port === PORT, JSON.stringify({ port: st.port, hasRestKey: st.hasRestKey }));
  check('실제 .env 와 격리됨 (서버에 키 없음 상태)', st.hasRestKey === false, `hasRestKey=${st.hasRestKey}`);

  // F4. /v1/* 이 외부 오리진에서 호출되면 거부되는가 (REST 키 쿼터 보호)
  const foreign = await fetch(`http://localhost:${PORT}/v1/directions?origin=127,37&destination=127.1,37.1`,
    { headers: { Origin: 'https://evil.example.com' } });
  check('F4 외부 오리진의 길찾기 호출 차단', foreign.status === 403, `HTTP ${foreign.status}`);

  // F4. DNS 리바인딩 방어 — Host 가 localhost 가 아니면 거부.
  // fetch 는 Host 를 금지 헤더로 취급해 무시하므로 http.request 로 직접 보낸다.
  const rawStatus = (host) => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/__status', method: 'GET', headers: { Host: host } },
      (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', () => resolve('ERR'));
    r.end();
  });
  check('F4 허용되지 않은 Host 차단 (DNS 리바인딩)', await rawStatus('evil.example.com') === 403,
    `HTTP ${await rawStatus('evil.example.com')}`);
  check('F4 정상 Host 는 통과', await rawStatus(`localhost:${PORT}`) === 200);

  const browser = await chromium.launch();
  const pg = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.route('**/dapi.kakao.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: SDK_OK }));
  await pg.addInitScript(() => { try { localStorage.clear(); } catch {} });

  await pg.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(1300);
  await pg.click('.tab[data-tab="settings"]');
  await pg.waitForTimeout(200);

  /* 1단계: 개발 서버 감지 */
  const env = await pg.evaluate(() => ({
    state: document.querySelector('#wizEnv').dataset.state,
    sub: document.querySelector('#wizEnvSub').textContent,
    origin: document.querySelector('#wizEnvBody code')?.textContent,
    transport: window.__S.settings.transport,
    dev: !!window.__RT.devServer,
  }));
  check('1단계 실행 환경 통과 + 같은 오리진 자동 선택',
    env.state === 'ok' && env.transport === 'same-origin' && env.dev, JSON.stringify(env));
  check('등록할 도메인을 그대로 제시', env.origin === `http://localhost:${PORT}`, env.origin);

  /* 2단계: 도메인 미등록 시나리오 → 실패로 잡혀야 함 */
  await pg.evaluate(() => { window.__DOMAIN_OK = false; });
  await pg.fill('#wizJsKey', 'TEST_JS_KEY_0000');
  await pg.evaluate(() => window.__checkMapKey());
  await pg.waitForFunction(() => document.querySelector('#wizMap').dataset.state !== 'checking', null, { timeout: 20000 });
  const bad = await pg.evaluate(() => ({ s: document.querySelector('#wizMap').dataset.state, m: document.querySelector('#wizMapSub').textContent }));
  check('2단계 도메인 미등록을 실패로 진단', bad.s === 'fail' && bad.m.includes('도메인'), JSON.stringify(bad));

  /* 2단계: 정상 시나리오 */
  await pg.evaluate(() => { window.__DOMAIN_OK = true; });
  await pg.evaluate(() => window.__checkMapKey());
  await pg.waitForFunction(() => document.querySelector('#wizMap').dataset.state !== 'checking', null, { timeout: 20000 });
  const good = await pg.evaluate(() => ({ s: document.querySelector('#wizMap').dataset.state, key: window.__S.settings.jsKey, sdk: window.__RT.sdkReady }));
  check('2단계 정상 키 통과 + 저장', good.s === 'ok' && good.key === 'TEST_JS_KEY_0000' && good.sdk, JSON.stringify(good));

  /* 3단계: 잘못된 REST 키 → 업스트림 401 이 사용자에게 전달되는가 */
  await pg.waitForSelector('#wizRestKey', { timeout: 10000 });
  await pg.fill('#wizRestKey', 'WRONG_KEY');
  await pg.evaluate(() => window.__checkNaviKey());
  await pg.waitForFunction(() => document.querySelector('#wizNavi').dataset.state !== 'checking', null, { timeout: 20000 });
  const naviBad = await pg.evaluate(() => ({ s: document.querySelector('#wizNavi').dataset.state, m: document.querySelector('#wizNaviMsg').textContent }));
  check('3단계 잘못된 REST 키를 실패로 진단', naviBad.s === 'fail' && /401|거부|키/.test(naviBad.m), naviBad.m.slice(0, 70));

  /* 3단계: 올바른 REST 키 → 실제 거리값을 보여주는가 */
  await pg.fill('#wizRestKey', 'VALID_REST_KEY');
  await pg.evaluate(() => window.__checkNaviKey());
  await pg.waitForFunction(() => document.querySelector('#wizNavi').dataset.state !== 'checking', null, { timeout: 20000 });
  const naviOk = await pg.evaluate(() => ({ s: document.querySelector('#wizNavi').dataset.state, sub: document.querySelector('#wizNaviSub').textContent }));
  check('3단계 정상 키 통과 + 실제 거리 표시', naviOk.s === 'ok' && naviOk.sub.includes('11.2km'), naviOk.sub);
  check('브라우저 키가 업스트림까지 전달됨', lastAuth === 'KakaoAK VALID_REST_KEY', String(lastAuth));

  /* 같은 오리진 → 프리플라이트 없음 */
  const preflights = await pg.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/v1/')).length);
  check('길찾기 요청이 같은 오리진으로 나감', preflights >= 1, `${preflights}건`);

  /* 실제 최적화가 도로거리로 도는가 */
  const base = { ...hits };   // 마법사 검증 호출을 제외한 기준선
  await pg.click('#btnOptimize');
  await pg.waitForFunction(() => document.querySelector('#progressModal').hidden && !window.__RT.optimizing, null, { timeout: 120000 });
  const opt = await pg.evaluate(() => ({
    mode: window.__RT.solutionMeta?.matrixMode,
    calls: window.__RT.solutionMeta?.apiCalls,
    dist: document.querySelector('#kpiDist').textContent.trim(),
  }));
  check('실제 도로거리 모드로 최적화 완료', opt.mode === 'road' && opt.calls > 0, JSON.stringify(opt));

  // 1:N 일괄 조회가 실제로 동작하는가 — 노드 16개면 N² (240) 이 아니라 N (16) 회여야 한다
  const nodes = await pg.evaluate(() => window.__S.stops.length + 1);
  const usedDest = hits.destinations - base.destinations;
  const usedDir = hits.directions - base.directions;
  check('1:N 일괄 조회로 API 호출 절약',
    usedDest <= nodes && usedDir === 0,
    `노드 ${nodes}개 · destinations ${usedDest}회 · 개별 directions ${usedDir}회 (N² 라면 ${nodes * (nodes - 1)}회)`);
  check('최종 경로 폴리라인 조회', hits.waypoints >= 1, `${hits.waypoints}회`);

  // 캐시가 실제로 API 호출을 없애는가
  const before = hits.destinations + hits.directions;
  await pg.click('#btnOptimize');
  await pg.waitForFunction(() => document.querySelector('#progressModal').hidden && !window.__RT.optimizing, null, { timeout: 120000 });
  check('재최적화 시 캐시로 길찾기 재호출 없음',
    hits.destinations + hits.directions === before, `추가 ${hits.destinations + hits.directions - before}회`);

  check('처리되지 않은 콘솔 에러 없음', errs.length === 0, errs.slice(0, 2).join(' | '));
  await pg.screenshot({ path: process.env.SHOT || '/tmp/wizard.png' });
  await browser.close();
} finally { cleanup(); }

const f = R.filter((x) => !x).length;
console.log(`\n${'─'.repeat(60)}\n결과: ${R.length - f}/${R.length} 통과`);
process.exit(f ? 1 : 0);
