import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.csv':'text/csv', '.json':'application/json' };

const server = http.createServer((req,res)=>{
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, {'Content-Type': MIME[path.extname(p)] || 'application/octet-stream'});
  res.end(fs.readFileSync(p));
});
await new Promise(r=>server.listen(4173, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport:{width:1600,height:950} });

const errors = [], warns = [];
page.on('console', m => { if (m.type()==='error') errors.push(m.text()); if (m.type()==='warning') warns.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message + '\n' + (e.stack||'').split('\n').slice(0,4).join('\n')));

// 카카오 SDK는 앱키가 없으므로 로드 실패가 정상. 요청 자체를 차단해 대기시간을 없앤다.
await page.route('**/dapi.kakao.com/**', r => r.abort());

const waitOpt = async () => {
  await page.waitForFunction(() => !document.querySelector('#progressModal').hidden, null, { timeout: 15000 }).catch(()=>{});
  await page.waitForFunction(() => document.querySelector('#progressModal').hidden && !window.__RT.optimizing, null, { timeout: 90000 });
  await page.waitForTimeout(250);
};

const results = [];
const check = (name, ok, detail='') => { results.push({name, ok, detail}); console.log(`${ok?'✅':'❌'} ${name}${detail?' — '+detail:''}`); };

await page.goto('http://localhost:4173/', { waitUntil:'domcontentloaded' });
await page.waitForTimeout(1200);

// --- 1. 부팅 & 샘플 자동 로드 ---
const stopCount = await page.textContent('#badgeStops');
check('부팅 + 샘플 15곳 자동 로드', stopCount === '15', `badge=${stopCount}`);

// --- 2. 직선거리 모드로 전환 (API 키 없이 최적화 가능하게) ---
await page.click('.tab[data-tab="settings"]');
await page.evaluate(() => { document.querySelector('#advSettings').open = true; });  // 고급 설정 펼치기
await page.click('#segDistMode button[data-val="straight"]');
const straightOn = await page.getAttribute('#segDistMode button[data-val="straight"]', 'aria-pressed');
check('거리 모드 전환 (직선거리)', straightOn === 'true');

// --- 3. 최적화 실행 (차량 3대 = VRP) ---
await page.click('.tab[data-tab="options"]');
await page.fill('#optTimeLimit', '2000').catch(()=>{});
await page.evaluate(() => { const t=document.querySelector('#optTimeLimit'); t.value='2000'; t.dispatchEvent(new Event('change')); });
await page.click('#btnOptimize');
await waitOpt();

const kpi = await page.evaluate(() => ({
  dist: document.querySelector('#kpiDist').textContent.trim(),
  time: document.querySelector('#kpiTime').textContent.trim(),
  veh:  document.querySelector('#kpiVeh').textContent.trim(),
  viol: document.querySelector('#kpiViol').textContent.trim(),
}));
check('VRP 최적화 완료 (KPI 산출)', kpi.dist !== '–' && kpi.time !== '–', JSON.stringify(kpi));

// --- 4. 해의 무결성: 모든 납품처가 정확히 1번씩 배정 ---
const integrity = await page.evaluate(() => {
  const sol = window.__RT.solution;
  const all = sol.routes.flatMap(r => r.seq);
  const uniq = new Set(all);
  return { total: all.length, uniq: uniq.size, stops: window.__S.stops.length,
           routes: sol.routes.length, nonEmpty: sol.routes.filter(r=>r.seq.length).length };
});
check('해 무결성: 전 납품처 1회씩 배정',
  integrity.total === integrity.stops && integrity.uniq === integrity.stops,
  JSON.stringify(integrity));

// --- 5. 스케줄 단조성: 도착 ≤ 하역시작 ≤ 출발, 그리고 누적 증가 ---
const sched = await page.evaluate(() => {
  const bad = [];
  for (const rt of window.__RT.solution.routes) {
    let prevDepart = -Infinity;
    rt.m.legs.forEach((lg,k) => {
      if (!(lg.arrive <= lg.startSvc + 1e-6)) bad.push(`도착>하역시작 r/${k}`);
      if (!(lg.startSvc <= lg.depart + 1e-6)) bad.push(`하역시작>출발 r/${k}`);
      if (lg.arrive < prevDepart - 1e-6) bad.push(`도착<이전출발 r/${k}`);
      if (lg.cumDist < 0) bad.push(`누적거리 음수 r/${k}`);
      prevDepart = lg.depart;
    });
  }
  return bad;
});
check('스케줄 시간 단조성', sched.length === 0, sched.slice(0,3).join(' | '));

// --- 6. 용량 제약이 실제로 지켜지는가 ---
const cap = await page.evaluate(() => {
  const out = [];
  const veh = window.__S.vehicles.filter(v=>v.enabled);
  window.__RT.solution.routes.forEach(rt => {
    const v = veh[rt.vehIdx];
    if (rt.m.load.w > v.capWeight) out.push(`${v.name} 중량 ${Math.round(rt.m.load.w)}>${v.capWeight}`);
  });
  return out;
});
check('적재 용량 제약 준수', cap.length === 0, cap.join(' | '));

// --- 7. 고정 순번(마지막) 제약: 상봉점이 자기 코스의 마지막인가 ---
const fixedOk = await page.evaluate(() => {
  const si = window.__S.stops.findIndex(s => s.fixed === 'last');
  if (si < 0) return 'no-fixed-stop';
  for (const rt of window.__RT.solution.routes) {
    const k = rt.seq.indexOf(si);
    if (k >= 0) return k === rt.seq.length - 1 ? true : `pos ${k+1}/${rt.seq.length}`;
  }
  return 'not-assigned';
});
check('고정 순번(마지막) 제약 반영', fixedOk === true, String(fixedOk));

// --- 8. 결과 UI 렌더링 ---
const ui = await page.evaluate(() => ({
  legend: document.querySelectorAll('#legendItems .legend-item').length,
  timelineBars: document.querySelectorAll('#dockTimeline svg rect').length,
  tableRows: document.querySelectorAll('#dockTable tbody tr').length,
  resultRoutes: document.querySelectorAll('#resultContent .list-item').length,
}));
check('범례 렌더링', ui.legend >= 1, `${ui.legend}개`);
check('타임라인 SVG 렌더링', ui.timelineBars > 20, `${ui.timelineBars} rects`);
await page.click('.dock-tab[data-dock="table"]');
await page.waitForTimeout(200);
const rows = await page.evaluate(() => document.querySelectorAll('#dockTable tbody tr').length);
check('결과 순서표 렌더링', rows >= 15, `${rows} rows`);

// --- 9. 재현성: 같은 시드 → 같은 결과 ---
const first = await page.evaluate(() => window.__RT.solution.routes.map(r=>r.seq.join('-')).join('|'));
await page.click('#btnOptimize');
await waitOpt();
const second = await page.evaluate(() => window.__RT.solution.routes.map(r=>r.seq.join('-')).join('|'));
check('시드 고정 시 결과 재현', first === second, first===second?'':'다름');

// --- 10. 단일 차량(TSP) 모드 ---
await page.click('.tab[data-tab="fleet"]');
await page.evaluate(() => {
  window.__S.vehicles[1].enabled = false;
  window.__S.vehicles[2].enabled = false;
  window.__S.vehicles[0].capWeight = 999999;
  window.__S.vehicles[0].maxMinutes = 3000;
});
await page.click('#btnOptimize');
await waitOpt();
const tsp = await page.evaluate(() => {
  const sol = window.__RT.solution;
  const ne = sol.routes.filter(r=>r.seq.length);
  return { routes: ne.length, stops: ne[0]?.seq.length ?? 0, total: window.__S.stops.length };
});
check('단일 차량 TSP 모드', tsp.routes === 1 && tsp.stops === tsp.total, JSON.stringify(tsp));

// --- 11. 제약 OFF 시 거리 감소 (제약이 실제로 비용에 반영되는지) ---
const withC = await page.evaluate(() => window.__RT.solution.routes.reduce((a,r)=>a+r.m.distance,0));
await page.click('.tab[data-tab="options"]');
await page.evaluate(() => {
  // 온도대 제약(냉동 우선·혼적 금지 등)도 꺼야 순수 거리 기준선이 된다
  ['optTimeWindow','optCapacity','optFixedOrder','optMaxDuration',
   'optTemperature','optFrozenFirst','optStrictMix','optZoneSeparation'].forEach(id=>{
    const n=document.querySelector('#'+id); n.checked=false; n.dispatchEvent(new Event('change'));
  });
});
await page.click('#btnOptimize');
await waitOpt();
const noC = await page.evaluate(() => window.__RT.solution.routes.reduce((a,r)=>a+r.m.distance,0));
check('제약 해제 시 순수 거리 개선', noC <= withC + 1, `제약O ${(withC/1000).toFixed(1)}km → 제약X ${(noC/1000).toFixed(1)}km`);

// --- 12. CSV 파서 ---
const csvOk = await page.evaluate(async () => {
  const text = await (await fetch('/samples/sample-stops.csv')).text();
  const r = window.__parseStopCsv(text);
  return { err: r.error, n: r.rows.length, first: r.rows[0]?.name, tw: r.rows[0]?.twStart, fixed: r.rows[14]?.fixed };
});
check('CSV 파싱', !csvOk.err && csvOk.n === 15 && csvOk.fixed === 'last', JSON.stringify(csvOk));

// --- 13. 탭 CSV(엑셀 붙여넣기) 파싱 ---
const tsvOk = await page.evaluate(() => {
  const t = "납품처명\t주소\t위도\t경도\t중량\n가맹A\t서울시\t37.5\t127.0\t100\n가맹B\t서울시\t37.6\t127.1\t200";
  const r = window.__parseStopCsv(t);
  return { err:r.error, n:r.rows.length, w:r.rows[1]?.weight };
});
check('엑셀 탭구분 붙여넣기 파싱', !tsvOk.err && tsvOk.n===2 && tsvOk.w===200, JSON.stringify(tsvOk));

// --- 14. CSV 내보내기 ---
const dl = page.waitForEvent('download', { timeout: 8000 }).catch(()=>null);
await page.click('#btnExportCsv');
const d = await dl;
check('결과 CSV 내보내기', !!d, d ? await d.suggestedFilename() : '다운로드 이벤트 없음');

// --- 15. 콘솔 에러 ---
const realErrors = errors.filter(e => !/dapi\.kakao|net::ERR|Failed to load resource/i.test(e));
check('콘솔 에러 없음', realErrors.length === 0, realErrors.slice(0,3).join(' | '));

// ===== 코드리뷰 회귀 테스트 =====

// R1. 엑셀 단위 헤더 `중량(kg)` 인식 (앱 자체 CSV 내보내기 형식)
const unitHdr = await page.evaluate(() => {
  const t = "납품처명,주소,위도,경도,중량(kg),부피 (CBM),박스,하역(분)\n가맹A,서울,37.5,127.0,850,2.5,40,20";
  const r = window.__parseStopCsv(t);
  return { err:r.error, w:r.rows[0]?.weight, v:r.rows[0]?.volume, sv:r.rows[0]?.service };
});
check('R1 단위 괄호 헤더 인식', !unitHdr.err && unitHdr.w===850 && unitHdr.v===2.5 && unitHdr.sv===20, JSON.stringify(unitHdr));

// R2. 납품처 편집 모달이 메모를 채우는가 (이전 납품처 메모 전이 방지)
const memoOk = await page.evaluate(() => {
  window.__S.stops[0].memo = '냉장 우선';
  window.__S.stops[1].memo = '';
  document.querySelector('#fMemo').value = '오염된값';
  window.__openStopEditor(window.__S.stops[1].id);
  const afterEmpty = document.querySelector('#fMemo').value;
  window.__openStopEditor(window.__S.stops[0].id);
  const afterFilled = document.querySelector('#fMemo').value;
  document.querySelector('#stopModal').hidden = true;
  return { afterEmpty, afterFilled };
});
check('R2 편집 모달 메모 전이 없음', memoOk.afterEmpty === '' && memoOk.afterFilled === '냉장 우선', JSON.stringify(memoOk));

// R3. 소수 단위 초과량이 0으로 반올림되지 않는가
const qty = await page.evaluate(() => window.__describeViolation({type:'capacity',kind:'부피',used:8.4,cap:8,unit:'CBM',over:0.4}));
check('R3 CBM 초과량 표기', qty.includes('0.4') && !qty.includes('초과 0CBM'), qty);

// R4. 우회계수를 바꾸면 거리 추정이 실제로 달라지는가 (캐시가 옛 값을 고정하지 않음)
const detour = await page.evaluate(async () => {
  window.__S.settings.distMode='straight';
  const ctx1 = window.__buildContext();
  window.__S.settings.detour = 1.2;
  const m1 = await window.__buildMatrix(ctx1.nodes, null);
  window.__S.settings.detour = 1.9;
  const m2 = await window.__buildMatrix(ctx1.nodes, null);
  window.__S.settings.detour = 1.35;
  return { a: Math.round(m1.dist[0][1]), b: Math.round(m2.dist[0][1]) };
});
check('R4 우회계수 변경이 거리에 반영', detour.b > detour.a * 1.4, JSON.stringify(detour));

// R5. 전체 삭제 후 새로고침해도 샘플이 되살아나지 않는가
await page.evaluate(() => { window.__S.stops = []; window.__saveState(); });
await page.reload({ waitUntil:'domcontentloaded' });
await page.waitForTimeout(900);
const afterReload = await page.textContent('#badgeStops');
check('R5 삭제 후 새로고침에도 샘플 미복원', afterReload === '0', `badge=${afterReload}`);

// R6. 차량 사용 토글 시 결과 화면이 함께 비워지는가
await page.evaluate(() => { window.__loadSample(); });
await page.click('.tab[data-tab="options"]');
await page.evaluate(() => {
  ['optTimeWindow','optCapacity','optFixedOrder','optMaxDuration','optTemperature'].forEach(id=>{
    const n=document.querySelector('#'+id); n.checked=true; n.dispatchEvent(new Event('change'));
  });
  window.__S.settings.distMode='straight';
  window.__S.vehicles.forEach(v=>v.enabled=true);
});
await page.click('#btnOptimize');
await waitOpt();
await page.click('.tab[data-tab="fleet"]');
await page.click('#vehicleList .list-item:first-child .list-actions button:first-child');
await page.waitForTimeout(300);
const stale = await page.evaluate(() => ({
  sol: window.__RT.solution === null,
  legend: document.querySelectorAll('#legendItems .legend-item').length,
  kpi: document.querySelector('#kpiDist').textContent.trim(),
}));
check('R6 차량 토글 시 옛 결과 정리', stale.sol && stale.legend===0 && stale.kpi==='–', JSON.stringify(stale));

await page.screenshot({ path: process.env.SHOT || '/tmp/shot.png', fullPage:false });

await browser.close();
server.close();

const failed = results.filter(r=>!r.ok);
console.log(`\n${'─'.repeat(60)}\n결과: ${results.length-failed.length}/${results.length} 통과`);
process.exit(failed.length ? 1 : 0);
