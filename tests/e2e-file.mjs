import { launchChromium } from './_browser.mjs';
const b = await launchChromium();
const pg = await b.newPage({ viewport:{width:1600,height:950} });
const errs=[]; pg.on('pageerror',e=>errs.push(e.message)); pg.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
await pg.route('**/dapi.kakao.com/**', r=>r.abort());   // 앱키 없음 = 실제 상황

const R=[]; const check=(n,ok,d='')=>{R.push(ok);console.log(`${ok?'✅':'❌'} ${n}${d?' — '+d:''}`)};

// 브라우저에서 파일을 직접 여는 것과 동일 (file:// 오리진)
await pg.goto(new URL('../index.html', import.meta.url).href, { waitUntil:'domcontentloaded' });
await pg.waitForTimeout(1200);

check('file:// 로 앱 부팅', await pg.textContent('#badgeStops') === '15');
check('localStorage 동작', await pg.evaluate(()=>{ try{localStorage.setItem('t','1');return localStorage.getItem('t')==='1';}catch(e){return false;} }));

const fb = await pg.evaluate(()=>({
  svg: !!document.querySelector('#map svg'),
  circles: document.querySelectorAll('#map svg circle').length,
  depot: document.querySelectorAll('#map svg rect[rx="6"]').length,
  note: document.querySelector('#map div')?.textContent || '',
  w: document.querySelector('#map svg')?.getAttribute('width'),
}));
check('간이 지도 렌더링 (납품처 15 + 차고지)', fb.svg && fb.circles===15 && fb.depot===1, JSON.stringify({c:fb.circles,d:fb.depot,w:fb.w}));
check('간이 지도 안내 문구', fb.note.includes('간이 지도'), fb.note.slice(0,40));

// 도로거리 모드 그대로 최적화 → 실패 후 폴백 버튼이 떠야 함
await pg.click('#btnOptimize');
await pg.waitForFunction(()=>document.querySelector('#progressModal').hidden && !window.__RT.optimizing,null,{timeout:60000});
await pg.waitForTimeout(300);
const fbBtn = await pg.evaluate(()=>{
  const b=[...document.querySelectorAll('#mapAlerts button')].find(x=>x.textContent.includes('직선거리'));
  return b ? b.textContent.trim() : null;
});
check('프록시 없을 때 폴백 버튼 제공', !!fbBtn, fbBtn || '버튼 없음');

// 폴백 버튼으로 재실행
await pg.evaluate(()=>{ [...document.querySelectorAll('#mapAlerts button')].find(x=>x.textContent.includes('직선거리')).click(); });
await pg.waitForFunction(()=>document.querySelector('#progressModal').hidden && !window.__RT.optimizing,null,{timeout:60000});
await pg.waitForTimeout(500);

const done = await pg.evaluate(()=>({
  dist: document.querySelector('#kpiDist').textContent.trim(),
  viol: document.querySelector('#kpiViol').textContent.trim(),
  paths: document.querySelectorAll('#map svg path').length,
  legend: document.querySelectorAll('#legendItems .legend-item').length,
  bars: document.querySelectorAll('#dockTimeline svg rect').length,
}));
check('폴백으로 최적화 완료', done.dist !== '–', JSON.stringify(done));
check('간이 지도에 경로 그려짐 (케이싱+본선)', done.paths >= 2 && done.paths % 2 === 0, `${done.paths} paths / 코스 ${done.legend}개`);
check('타임라인 렌더링', done.bars > 20, `${done.bars} rects`);

// CSV 내보내기가 file:// 에서도 되는가
const dl = pg.waitForEvent('download',{timeout:8000}).catch(()=>null);
await pg.click('#btnExportCsv');
const d = await dl;
check('file:// 에서 CSV 내보내기', !!d, d? await d.suggestedFilename():'실패');

check('처리되지 않은 콘솔 에러 없음', errs.filter(e=>!/dapi\.kakao|ERR_FAILED|Failed to load|프록시.*연결하지 못했|blocked by CORS policy/i.test(e)).length===0,
  errs.filter(e=>!/dapi\.kakao|ERR_FAILED|Failed to load|프록시.*연결하지 못했|blocked by CORS policy/i.test(e)).slice(0,2).join(' | '));

// 모든 마커가 하단 도크에 가려지지 않는가
const fit = await pg.evaluate(()=>{
  const dockTop = document.querySelector('#dock').getBoundingClientRect().top;
  const mapTop = document.querySelector('#map').getBoundingClientRect().top;
  const nodes=[...document.querySelectorAll('#map svg circle, #map svg rect[rx="6"]')];
  const hidden = nodes.filter(n=>{const r=n.getBoundingClientRect(); return r.bottom > dockTop || r.top < mapTop;});
  return { total:nodes.length, hidden:hidden.length };
});
check('마커가 하단 패널에 가려지지 않음', fit.hidden===0, JSON.stringify(fit));

await pg.screenshot({path: process.env.SHOT || '/tmp/file.png'});
await b.close();
const f=R.filter(x=>!x).length;
console.log(`\n${'─'.repeat(60)}\n결과: ${R.length-f}/${R.length} 통과`);
process.exit(f?1:0);
