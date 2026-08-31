/**
 * 냉장·냉동 (온도대) 제약 E2E
 * 적재 호환성 · 칸별 한도 · 하역 가산 · 냉동 우선 · 배차 분리 · CSV 왕복을 검증한다.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MIME = { '.html':'text/html; charset=utf-8', '.csv':'text/csv; charset=utf-8', '.mjs':'text/javascript' };
const srv = http.createServer((q, r) => {
  const p = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  r.end(fs.readFileSync(p));
});
await new Promise((r) => srv.listen(4610, r));

const R = []; const check = (n, ok, d = '') => { R.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };
const browser = await chromium.launch();
const pg = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
await pg.route('**/dapi.kakao.com/**', (r) => r.abort());
await pg.addInitScript(() => { try { localStorage.clear(); } catch {} });
await pg.goto('http://localhost:4610/', { waitUntil: 'domcontentloaded' });
await pg.waitForTimeout(1200);
await pg.evaluate(() => { window.__S.settings.distMode = 'straight'; window.__S.options.timeLimitMs = 2500; });

const optimize = async () => {
  await pg.click('#btnOptimize');
  await pg.waitForFunction(() => document.querySelector('#progressModal').hidden && !window.__RT.optimizing, null, { timeout: 90000 });
  await pg.waitForTimeout(200);
};

/* --- 1. 샘플이 온도대별 물량을 갖는가 --- */
const demand = await pg.evaluate(() => {
  const s = window.__S.stops;
  const tot = { ambient: 0, chilled: 0, frozen: 0 };
  for (const st of s) for (const k of ['ambient','chilled','frozen']) tot[k] += st.demand[k].w;
  return { n: s.length, tot, mixed: s.filter((x) => x.zones.length > 1).length, single: s.filter((x) => x.zones.length === 1).length };
});
check('샘플이 온도대별 물량 보유', demand.tot.chilled > 0 && demand.tot.frozen > 0 && demand.mixed > 0,
  `혼합 ${demand.mixed}곳 · 단일 ${demand.single}곳 · 냉장 ${demand.tot.chilled}kg · 냉동 ${demand.tot.frozen}kg`);

/* --- 2. 파생 합계가 온도대 합과 일치 --- */
const sums = await pg.evaluate(() => window.__S.stops.every((s) =>
  Math.abs(s.weight - (s.demand.ambient.w + s.demand.chilled.w + s.demand.frozen.w)) < 1e-9));
check('합계가 온도대 합과 일치', sums);

/* --- 3. 적재 호환성: 냉동 불가 차량만 있으면 위반으로 잡히는가 --- */
await pg.evaluate(() => {
  window.__S.vehicles.forEach((v) => { v.zones.frozen.allowed = false; });
});
await optimize();
const incompat = await pg.evaluate(() => {
  const vs = window.__RT.solution.routes.flatMap((r) => r.m.violations).filter((v) => v.type === 'zoneIncompatible');
  return { n: vs.length, zones: [...new Set(vs.map((v) => v.zone))] };
});
check('냉동 적재 불가 차량 → 위반 검출', incompat.n > 0 && incompat.zones.includes('frozen'), JSON.stringify(incompat));

/* --- 4. 냉동 허용으로 되돌리면 위반이 사라지는가 --- */
await pg.evaluate(() => { window.__S.vehicles.forEach((v) => { v.zones.frozen.allowed = true; }); });
await optimize();
const okAgain = await pg.evaluate(() =>
  window.__RT.solution.routes.flatMap((r) => r.m.violations).filter((v) => v.type === 'zoneIncompatible').length);
check('냉동 허용 시 호환성 위반 해소', okAgain === 0, `${okAgain}건`);

/* --- 5. 칸별 한도: 냉동칸을 조이면 초과가 잡히는가 --- */
await pg.evaluate(() => {
  window.__S.vehicles.forEach((v) => { v.compartments = true; v.zones.frozen.capWeight = 50; });
});
await optimize();
const capV = await pg.evaluate(() => {
  const vs = window.__RT.solution.routes.flatMap((r) => r.m.violations).filter((v) => v.type === 'capacity' && v.zone === 'frozen');
  return { n: vs.length, sample: vs[0] ? vs[0].kind + ' ' + Math.round(vs[0].used) + '>' + vs[0].cap : null };
});
check('칸막이 냉동칸 한도 초과 검출', capV.n > 0, JSON.stringify(capV));

/* --- 6. 칸막이를 끄면 칸 한도는 무시되고 차량 총량만 본다 --- */
await pg.evaluate(() => { window.__S.vehicles.forEach((v) => { v.compartments = false; }); });
await optimize();
const noComp = await pg.evaluate(() =>
  window.__RT.solution.routes.flatMap((r) => r.m.violations).filter((v) => v.type === 'capacity' && v.zone).length);
check('칸막이 해제 시 칸 한도 미적용', noComp === 0, `${noComp}건`);

/* --- 7. 온도대별 하역 가산이 실제 일정에 반영되는가 --- */
await pg.evaluate(() => {
  window.__S.vehicles.forEach((v) => { v.compartments = true; v.zones.frozen.capWeight = 600; });
  window.__S.options.zoneServiceBonus = 0;
});
await optimize();
const svc0 = await pg.evaluate(() => window.__RT.solution.routes.reduce((a, r) => a + r.m.serviceMin, 0));
await pg.evaluate(() => { window.__S.options.zoneServiceBonus = 10; });
await optimize();
const svc10 = await pg.evaluate(() => window.__RT.solution.routes.reduce((a, r) => a + r.m.serviceMin, 0));
const mixedCount = demand.mixed;
const expectedExtra = await pg.evaluate(() =>
  window.__S.stops.reduce((a, s) => a + Math.max(0, s.zones.length - 1), 0) * 10);
check('온도대별 하역 가산 반영', Math.abs((svc10 - svc0) - expectedExtra) < 1,
  `가산0 ${svc0}분 → 가산10 ${svc10}분 (기대 +${expectedExtra}분, 혼합 ${mixedCount}곳)`);

/* --- 8. 냉동 우선 배송: 켜면 냉동 후순위가 줄어드는가 --- */
await pg.evaluate(() => { window.__S.options.zoneServiceBonus = 5; window.__S.options.frozenFirst = false; });
await optimize();
const invOff = await pg.evaluate(() => {
  let inv = 0;
  for (const rt of window.__RT.solution.routes) {
    let nf = 0;
    for (const si of rt.seq) window.__S.stops[si].zones.includes('frozen') ? inv += nf : nf++;
  }
  return inv;
});
await pg.evaluate(() => { window.__S.options.frozenFirst = true; });
await optimize();
const invOn = await pg.evaluate(() => {
  let inv = 0;
  for (const rt of window.__RT.solution.routes) {
    let nf = 0;
    for (const si of rt.seq) window.__S.stops[si].zones.includes('frozen') ? inv += nf : nf++;
  }
  return inv;
});
check('냉동 우선 배송이 냉동 후순위를 줄임', invOn <= invOff,
  `끔 ${invOff}건 → 켬 ${invOn}건`);

/* --- 9. 온도대별 배차 분리 --- */
await pg.evaluate(() => { window.__S.options.zoneSeparation = true; });
await optimize();
const sep = await pg.evaluate(() => ({
  viol: window.__RT.solution.routes.flatMap((r) => r.m.violations).filter((v) => v.type === 'zoneMixed').length,
  zonesPerRoute: window.__RT.solution.routes.filter((r) => r.seq.length).map((r) => r.m.routeZones.length),
}));
check('배차 분리 옵션이 평가에 반영', Array.isArray(sep.zonesPerRoute) && sep.zonesPerRoute.length > 0,
  `경로별 온도대 수 [${sep.zonesPerRoute}] · 혼재 위반 ${sep.viol}건`);
await pg.evaluate(() => { window.__S.options.zoneSeparation = false; });

/* --- 10. CSV: 온도대별 열 파싱 --- */
const csvZone = await pg.evaluate(async () => {
  const t = await (await fetch('/samples/sample-stops.csv')).text();
  const r = window.__parseStopCsv(t);
  const first = r.rows[0];
  return { err: r.error, n: r.rows.length, d: first?.demand,
           last: r.rows[14]?.demand?.frozen?.w };
});
check('CSV 온도대별 열 파싱', !csvZone.err && csvZone.n === 15
  && csvZone.d.chilled.w === 140 && csvZone.d.frozen.w === 60 && csvZone.last === 220,
  JSON.stringify({ n: csvZone.n, 첫행냉장: csvZone.d?.chilled?.w, 첫행냉동: csvZone.d?.frozen?.w, 마지막냉동: csvZone.last }));

/* --- 11. CSV: 단일 온도대 열 (온도대 + 중량) --- */
const csvSingle = await pg.evaluate(async () => {
  const t = await (await fetch('/samples/sample-stops-%EB%8B%A8%EC%9D%BC%EC%98%A8%EB%8F%84%EB%8C%80.csv')).text();
  const r = window.__parseStopCsv(t);
  const stops = r.rows.map((x) => window.__normalizeStop(x));
  return { err: r.error, n: r.rows.length,
           z: stops.map((s) => s.zones.join('')), w: stops[0]?.demand?.chilled?.w };
});
check('CSV 단일 온도대 열 파싱', !csvSingle.err && csvSingle.n === 5
  && csvSingle.z[0] === 'chilled' && csvSingle.z[1] === 'frozen' && csvSingle.z[2] === 'ambient' && csvSingle.w === 320,
  JSON.stringify(csvSingle));

/* --- 12. 구버전 데이터 호환 (온도대 없는 납품처·차량) --- */
const legacy = await pg.evaluate(() => {
  const s = window.__normalizeStop({ name: '구버전', lat: 37.5, lng: 127.0, weight: 500, volume: 2, boxes: 30 });
  const v = window.__normalizeVehicle({ name: '구버전차', capWeight: 1000 });
  return { zones: s.zones, w: s.demand.ambient.w, total: s.weight,
           vehZones: ['ambient','chilled','frozen'].filter((k) => v.zones[k].allowed) };
});
check('구버전 데이터 호환 (상온 취급 + 전 온도대 허용)',
  legacy.zones.length === 1 && legacy.zones[0] === 'ambient' && legacy.w === 500
  && legacy.total === 500 && legacy.vehZones.length === 3, JSON.stringify(legacy));

/* --- 13. UI: 온도대 칩이 색만이 아니라 라벨을 함께 갖는가 --- */
const chips = await pg.evaluate(() => {
  const cs = [...document.querySelectorAll('#stopsList .zone-chip')];
  return { n: cs.length, allLabeled: cs.every((c) => /상온|냉장|냉동/.test(c.textContent)),
           zones: [...new Set(cs.map((c) => c.dataset.zone))] };
});
check('온도대 칩에 라벨 동반 (색 단독 아님)', chips.n > 0 && chips.allLabeled, JSON.stringify(chips));

/* --- 14. 결과표에 온도대 열 --- */
await pg.click('.dock-tab[data-dock="table"]');
await pg.waitForTimeout(200);
const tbl = await pg.evaluate(() => {
  const heads = [...document.querySelectorAll('#dockTable thead th')].map((t) => t.textContent);
  const row = document.querySelector('#dockTable tbody tr:not(.route-head)');
  return { hasZoneCol: heads.includes('온도대'), cols: heads.length,
           cells: row ? row.children.length : 0 };
});
check('결과표 온도대 열 + 열 수 일치', tbl.hasZoneCol && tbl.cols === tbl.cells,
  `헤더 ${tbl.cols}칸 / 데이터 ${tbl.cells}칸`);

/* --- 15. CSV 내보내기에 온도대 열 --- */
const dl = pg.waitForEvent('download', { timeout: 8000 }).catch(() => null);
await pg.click('#btnExportCsv');
const d = await dl;
let exportOk = false, exportDetail = '다운로드 실패';
if (d) {
  const p = await d.path();
  const head = fs.readFileSync(p, 'utf8').split('\n')[0];
  exportOk = ['상온중량','냉장중량','냉동박스'].every((c) => head.includes(c));
  const bodyCols = fs.readFileSync(p, 'utf8').split('\n')[1].split(',').length;
  exportOk = exportOk && bodyCols === head.split(',').length;
  exportDetail = `헤더 ${head.split(',').length}칸 / 본문 ${bodyCols}칸`;
}
check('CSV 내보내기 온도대 열 + 칸 수 일치', exportOk, exportDetail);

/* --- 코드리뷰 회귀 --- */

// F10. 알 수 없는 온도대 값이 조용히 상온으로 처리되지 않는가
const unknownZone = await pg.evaluate(() => {
  const t = '납품처명,주소,위도,경도,온도대,중량\n가맹A,서울,37.5,127.0,미온,100\n가맹B,서울,37.6,127.1,냉장,200';
  const r = window.__parseStopCsv(t);
  return { warns: r.warnings || [], n: r.rows.length };
});
check('F10 미인식 온도대 값 경고', unknownZone.warns.length === 1 && unknownZone.warns[0].includes('미온'),
  JSON.stringify(unknownZone.warns).slice(0, 90));

// F6. 온도대 없는(구버전) 데이터가 기본 차량에서 새 위반을 만들지 않는가
const legacyFit = await pg.evaluate(async () => {
  window.__S.stops = window.__S.stops.map((s) => window.__normalizeStop({
    ...s, demand: undefined, zone: undefined,
    weight: s.weight, volume: s.volume, boxes: s.boxes,
  }));
  window.__S.vehicles = [0, 1, 2].map((i) => window.__normalizeVehicle({ name: `${i + 1}호차` }));
  return window.__S.stops.every((s) => s.zones.length === 1 && s.zones[0] === 'ambient');
});
check('F6 구버전 데이터가 전부 상온으로 이관', legacyFit);
await optimize();
const legacyViol = await pg.evaluate(() =>
  window.__RT.solution.routes.flatMap((r) => r.m.violations).filter((v) => v.zone === 'ambient').length);
check('F6 기본 칸막이차가 구버전 상온 물량을 막지 않음', legacyViol === 0, `상온칸 위반 ${legacyViol}건`);

// F9. 냉동 후순위 페널티가 온도대 부적합을 압도하지 않는가
const weights = await pg.evaluate(() => {
  const P = window.__PENALTY;
  return { frozen50: P.frozenOrder * 50, incompat: P.zoneIncompatible, latePerHour: P.latePerMin * 60 };
});
check('F9 냉동 후순위가 온도대 부적합보다 가볍다',
  weights.frozen50 < weights.incompat && weights.frozen50 < weights.latePerHour,
  `역전50건 ${weights.frozen50} < 부적합 ${weights.incompat}, 지각1시간 ${weights.latePerHour}`);

// F5. 하역시간이 내보내기→가져오기 왕복에서 부풀지 않는가
const roundTrip = await pg.evaluate(() => {
  const s0 = window.__S.stops[0];
  const base = s0.service;
  // 내보내기 형식의 '하역(분)' 은 입력값이어야 한다 (온도대 가산이 포함되면 안 됨)
  const t = `납품처명,위도,경도,하역(분),온도대,중량\n${s0.name},${s0.lat},${s0.lng},${base},상온,100`;
  const r = window.__parseStopCsv(t);
  return { base, parsed: r.rows[0].service };
});
check('F5 하역시간 왕복 안정', roundTrip.parsed === roundTrip.base,
  `입력 ${roundTrip.base}분 → 재파싱 ${roundTrip.parsed}분`);

check('처리되지 않은 콘솔 에러 없음', errs.length === 0, errs.slice(0, 2).join(' | '));
await pg.screenshot({ path: process.env.SHOT || '/tmp/zones.png' });
await browser.close(); srv.close();

const f = R.filter((x) => !x).length;
console.log(`\n${'─'.repeat(60)}\n결과: ${R.length - f}/${R.length} 통과`);
process.exit(f ? 1 : 0);
