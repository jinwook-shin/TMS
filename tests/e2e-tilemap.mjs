/**
 * 내장 타일 지도 E2E — 카카오 키 없이 file:// 로 열었을 때의 지도.
 * 실제 타일 서버 대신 색 블록 타일을 돌려주는 모의 서버를 쓴다.
 * (투영 계산·타일 좌표·팬/줌·마커 위치를 실제 브라우저에서 검증)
 */
import { launchChromium } from './_browser.mjs';

const R = []; const check = (n, ok, d = '') => { R.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };
const browser = await launchChromium();
const pg = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
await pg.route('**/dapi.kakao.com/**', (r) => r.abort());

// 모의 타일: 요청된 z/x/y 를 기록하고 1x1 PNG 를 돌려준다
const tileHits = [];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
await pg.route('**/tile.openstreetmap.org/**', (r) => {
  const m = r.request().url().match(/\/(\d+)\/(\d+)\/(\d+)\.png/);
  if (m) tileHits.push({ z: +m[1], x: +m[2], y: +m[3] });
  r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
});

await pg.addInitScript(() => { try { localStorage.clear(); } catch {} });
await pg.goto(new URL('../index.html', import.meta.url).href, { waitUntil: 'domcontentloaded' });
await pg.waitForTimeout(1500);

/* --- 1. 타일이 실제로 요청되는가 --- */
check('file:// 에서 타일 요청 발생', tileHits.length > 0, `${tileHits.length}개 타일`);
const zooms = [...new Set(tileHits.map((t) => t.z))];
check('단일 줌 레벨로 요청', zooms.length === 1, `z=${zooms.join(',')}`);

/* --- 2. 타일 좌표가 서울 범위와 맞는가 (z에서 서울은 대략 x/n≈0.853, y/n≈0.396) --- */
const z = zooms[0], n = 2 ** z;
const inSeoul = tileHits.every((t) => {
  const lng = t.x / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * t.y / n))) * 180 / Math.PI;
  return lng > 125 && lng < 130 && lat > 36 && lat < 39;
});
check('타일 좌표가 서울 권역', inSeoul, `z=${z}, ${tileHits.length}개`);

/* --- 3. DOM 레이어 구조 --- */
const layers = await pg.evaluate(() => ({
  tiles: document.querySelectorAll('#mapTiles .tile').length,
  overlay: !!document.querySelector('#mapOverlay'),
  zoomBtns: document.querySelectorAll('.map-zoom-btn').length,
  scale: document.querySelector('.map-scale span')?.textContent,
  attr: document.querySelector('.map-attr')?.textContent,
  markers: document.querySelectorAll('#mapOverlay circle').length,
  depot: document.querySelectorAll('#mapOverlay rect').length,
}));
check('타일 · 오버레이 · 줌버튼 · 축척 · 출처 렌더링',
  layers.tiles > 0 && layers.overlay && layers.zoomBtns === 3 && layers.scale && layers.attr,
  JSON.stringify({ tiles: layers.tiles, scale: layers.scale, attr: layers.attr?.slice(0, 22) }));
check('납품처 15곳 + 차고지 마커', layers.markers === 15 && layers.depot === 1,
  `마커 ${layers.markers} · 차고지 ${layers.depot}`);
check('OSM 출처 표기 (타일 이용 정책)', (layers.attr || '').includes('OpenStreetMap'), layers.attr);

/* --- 3-2. 레이어가 실제로 지도 위에 겹쳐 있는가 (요소 개수만 세면 못 잡는다) --- */
const align = await pg.evaluate(() => {
  const host = document.querySelector('#map').getBoundingClientRect();
  const svg = document.querySelector('#mapOverlay').getBoundingClientRect();
  const tiles = document.querySelector('#mapTiles').getBoundingClientRect();
  const cs = getComputedStyle(document.querySelector('#mapOverlay'));
  const firstMarker = document.querySelector('#mapOverlay circle')?.getBoundingClientRect();
  return {
    svgOffset: [Math.round(svg.x - host.x), Math.round(svg.y - host.y)],
    tileOffset: [Math.round(tiles.x - host.x), Math.round(tiles.y - host.y)],
    position: cs.position,
    markerInsideMap: firstMarker
      ? firstMarker.top >= host.top - 40 && firstMarker.bottom <= host.bottom + 40
        && firstMarker.left >= host.left - 40 && firstMarker.right <= host.right + 40
      : false,
  };
});
check('오버레이가 지도와 정확히 겹침', align.svgOffset[0] === 0 && align.svgOffset[1] === 0 && align.position === 'absolute',
  `offset ${align.svgOffset} · position ${align.position}`);
check('타일 레이어가 지도와 겹침', align.tileOffset[0] === 0 && align.tileOffset[1] === 0, `offset ${align.tileOffset}`);
check('마커가 지도 영역 안에 그려짐', align.markerInsideMap);

/* --- 4. 투영 왕복 정확도 --- */
const proj = await pg.evaluate(() => {
  const host = document.querySelector('#map');
  const P = window.__makeProjector(host.clientWidth, host.clientHeight);
  const pts = [[37.5665, 126.9780], [37.4979, 127.0276], [37.6553, 127.0614]];
  return pts.map(([la, ln]) => {
    const x = P.x(ln), y = P.y(la);
    return { dLat: Math.abs(P.lat(y) - la), dLng: Math.abs(P.lng(x) - ln) };
  });
});
check('좌표 ↔ 화면 왕복 오차 없음',
  proj.every((d) => d.dLat < 1e-9 && d.dLng < 1e-9),
  `최대오차 ${Math.max(...proj.flatMap((d) => [d.dLat, d.dLng])).toExponential(1)}`);

/* --- 5. 줌 버튼 --- */
const beforeZoom = await pg.evaluate(() => window.__RT.view.zoom);
await pg.click('.map-zoom-btn:nth-child(1)');
await pg.waitForTimeout(300);
const afterZoom = await pg.evaluate(() => window.__RT.view.zoom);
check('확대 버튼 동작', afterZoom === beforeZoom + 1, `z ${beforeZoom} → ${afterZoom}`);

/* --- 6. 휠 줌이 커서 아래 지점을 고정하는가 --- */
const anchorTest = await pg.evaluate(() => {
  const host = document.querySelector('#map');
  const W = host.clientWidth, H = host.clientHeight;
  const ax = 300, ay = 200;
  const before = window.__makeProjector(W, H);
  const lat0 = before.lat(ay), lng0 = before.lng(ax);
  window.__zoomBy(1, ax, ay);
  const after = window.__makeProjector(W, H);
  return { dx: Math.abs(after.x(lng0) - ax), dy: Math.abs(after.y(lat0) - ay) };
});
check('줌 시 커서 아래 지점 고정', anchorTest.dx < 1 && anchorTest.dy < 1,
  `어긋남 ${anchorTest.dx.toFixed(2)}px, ${anchorTest.dy.toFixed(2)}px`);

/* --- 7. 드래그 팬 --- */
const panned = await pg.evaluate(async () => {
  const host = document.querySelector('#map');
  const before = { ...window.__RT.view };
  const r = host.getBoundingClientRect();
  const fire = (type, x, y) => (type === 'mousedown' ? host : window)
    .dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
  fire('mousedown', r.left + 500, r.top + 300);
  fire('mousemove', r.left + 400, r.top + 300);
  fire('mouseup', r.left + 400, r.top + 300);
  const after = window.__RT.view;
  return { movedLng: after.lng - before.lng, sameZoom: after.zoom === before.zoom };
});
check('드래그 팬 동작 (왼쪽으로 끌면 동쪽으로 이동)',
  panned.movedLng > 0 && panned.sameZoom, `Δlng ${panned.movedLng.toExponential(2)}`);

/* --- 8. 타일 실패 시에도 경로는 남는가 --- */
await pg.evaluate(() => {
  window.__S.settings.tiles = 'none';
  window.__RT.view.fitted = false;      // 앞선 줌/팬 때문에 마커가 화면 밖으로 나가 있다
  window.__renderLocalMap();
});
await pg.waitForTimeout(300);
const noTiles = await pg.evaluate(() => ({
  tiles: document.querySelectorAll('#mapTiles .tile').length,
  markers: document.querySelectorAll('#mapOverlay circle').length,
  scale: !!document.querySelector('.map-scale'),
}));
check('타일 없음 모드 — 마커·축척 유지', noTiles.tiles === 0 && noTiles.markers === 15 && noTiles.scale,
  JSON.stringify(noTiles));
await pg.evaluate(() => { window.__S.settings.tiles = 'osm'; window.__renderLocalMap(); });

/* --- 9. 최적화 후 경로가 타일 위에 그려지는가 --- */
await pg.evaluate(() => { window.__S.settings.distMode = 'straight'; window.__S.options.timeLimitMs = 2000; });
await pg.click('#btnOptimize');
await pg.waitForFunction(() => document.querySelector('#progressModal').hidden && !window.__RT.optimizing, null, { timeout: 90000 });
await pg.waitForTimeout(600);
const routed = await pg.evaluate(() => ({
  paths: document.querySelectorAll('#mapOverlay path').length,
  routes: window.__RT.solution.routes.filter((r) => r.seq.length).length,
  tiles: document.querySelectorAll('#mapTiles .tile').length,
}));
check('경로 폴리라인이 타일 위에 렌더링', routed.paths === routed.routes * 2 && routed.tiles > 0,
  `경로 ${routed.routes}개 → path ${routed.paths}개 (케이싱+본선), 타일 ${routed.tiles}장`);

/* --- 10. 마커가 도크에 가리지 않는가 --- */
const fit = await pg.evaluate(() => {
  const dockTop = document.querySelector('#dock').getBoundingClientRect().top;
  const mapTop = document.querySelector('#map').getBoundingClientRect().top;
  const nodes = [...document.querySelectorAll('#mapOverlay circle, #mapOverlay rect')];
  return { total: nodes.length, hidden: nodes.filter((nEl) => {
    const r = nEl.getBoundingClientRect();
    return r.bottom > dockTop || r.top < mapTop;
  }).length };
});
check('마커가 하단 패널에 가려지지 않음', fit.hidden === 0, JSON.stringify(fit));

check('처리되지 않은 콘솔 에러 없음', errs.length === 0, errs.slice(0, 2).join(' | '));
await pg.screenshot({ path: process.env.SHOT || '/tmp/tilemap.png' });
await browser.close();

const f = R.filter((x) => !x).length;
console.log(`\n${'─'.repeat(60)}\n결과: ${R.length - f}/${R.length} 통과`);
process.exit(f ? 1 : 0);
