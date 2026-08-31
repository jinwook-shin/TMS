import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const srv=http.createServer((q,r)=>{const p=path.join(ROOT,q.url==='/'?'index.html':q.url.split('?')[0]);
  if(!fs.existsSync(p)){r.writeHead(404);r.end();return;}
  r.writeHead(200,{'Content-Type':p.endsWith('.csv')?'text/csv':'text/html; charset=utf-8'});r.end(fs.readFileSync(p));});
await new Promise(r=>srv.listen(4175,r));

const SDK_MOCK = `(function(){
  function LatLng(lat,lng){this._lat=lat;this._lng=lng;}
  LatLng.prototype.getLat=function(){return this._lat}; LatLng.prototype.getLng=function(){return this._lng};
  function LatLngBounds(){this.pts=[]} LatLngBounds.prototype.extend=function(p){this.pts.push(p)};
  function Map(el,opt){this._level=opt.level||8;}
  Map.prototype.addControl=function(){}; Map.prototype.setBounds=function(){};
  Map.prototype.setCenter=function(){}; Map.prototype.getLevel=function(){return this._level};
  Map.prototype.setLevel=function(l){this._level=l}; Map.prototype.relayout=function(){};
  function CustomOverlay(o){this.o=o;} 
  CustomOverlay.prototype.setMap=function(m){ if(m){ (window.__ov=window.__ov||[]).push(this.o); } };
  function Polyline(o){ (window.__pl=window.__pl||[]).push({c:o.strokeColor,s:o.strokeStyle,w:o.strokeWeight,n:o.path.length}); }
  Polyline.prototype.setMap=function(){};
  function ZoomControl(){}
  function Geocoder(){}
  Geocoder.prototype.addressSearch=function(q,cb){cb([{y:'37.5500',x:'126.9700',road_address:{address_name:'서울 중구 테스트로 1'}}],'OK')};
  Geocoder.prototype.coord2Address=function(x,y,cb){cb([{road_address:{address_name:'서울 강남구 역지오코딩로 9'}}],'OK')};
  function Places(){}
  Places.prototype.keywordSearch=function(q,cb){cb([{place_name:q+' 본점',road_address_name:'서울 마포구 검색로 3',y:'37.5600',x:'126.9800'}],'OK')};
  window.kakao={maps:{ load:function(cb){cb()}, Map:Map, LatLng:LatLng, LatLngBounds:LatLngBounds,
    CustomOverlay:CustomOverlay, Polyline:Polyline, ZoomControl:ZoomControl,
    ControlPosition:{RIGHT:'right'}, event:{addListener:function(){}},
    services:{Geocoder:Geocoder, Places:Places, Status:{OK:'OK',ZERO_RESULT:'ZERO'}} }};
})();`;

const b=await chromium.launch(); const pg=await b.newPage({viewport:{width:1600,height:950}});
const errs=[]; pg.on('pageerror',e=>errs.push(e.message)); pg.on('console',m=>{if(m.type()==='error')errs.push(m.text())});
await pg.route('**/dapi.kakao.com/**', r=>r.fulfill({status:200,contentType:'text/javascript',body:SDK_MOCK}));

const R=[]; const check=(n,ok,d='')=>{R.push(ok);console.log(`${ok?'✅':'❌'} ${n}${d?' — '+d:''}`)};

await pg.goto('http://localhost:4175/',{waitUntil:'domcontentloaded'}); await pg.waitForTimeout(700);
await pg.click('.tab[data-tab="settings"]');
await pg.fill('#cfgJsKey','TEST_JS_KEY');
await pg.click('#btnApplyJsKey');
await pg.waitForTimeout(600);

check('지도 SDK 초기화', await pg.evaluate(()=>window.__RT.sdkReady===true && !!window.__RT.map));
check('최적화 전 납품처 마커 표시', await pg.evaluate(()=>window.__ov.length) >= 16,
  `오버레이 ${await pg.evaluate(()=>window.__ov.length)}개 (차고지 1 + 납품처 15)`);

// 장소 검색 → 납품처 추가
await pg.click('.tab[data-tab="stops"]');
await pg.fill('#placeSearch','에쓰푸드'); await pg.click('#btnSearch'); await pg.waitForTimeout(300);
const nRes = await pg.evaluate(()=>document.querySelectorAll('#searchResults .search-result').length);
check('장소 검색 결과 표시', nRes>=1, `${nRes}건`);
await pg.click('#searchResults .search-result:first-child'); await pg.waitForTimeout(300);
check('검색 결과로 납품처 추가', await pg.textContent('#badgeStops')==='16', await pg.textContent('#badgeStops'));

// 지도 클릭으로 납품처 추가
await pg.evaluate(()=>{ window.__handleMapPick(37.51,127.05); });
await pg.waitForTimeout(400);
const picked = await pg.evaluate(()=>{const s=window.__S.stops.at(-1);return {n:s.name,a:s.addr,lat:s.lat}});
check('지도 클릭 + 역지오코딩 추가', picked.lat===37.51 && picked.a.includes('역지오코딩'), JSON.stringify(picked));

// 6대 차량으로 최적화 → 색상 4종 × 선패턴 복합 인코딩 확인
await pg.evaluate(()=>{
  window.__S.settings.distMode='straight';
  window.__S.vehicles = Array.from({length:6},(_,i)=>({id:'v'+i,name:(i+1)+'호차',
    capWeight:1600,capVolume:8,capBoxes:120,start:'06:00',end:'20:00',maxMinutes:600,enabled:true}));
  window.__S.options.timeLimitMs=2000;
  window.__pl=[]; window.__ov=[];
});
await pg.click('#btnOptimize');
await pg.waitForFunction(()=>document.querySelector('#progressModal').hidden && !window.__RT.optimizing,null,{timeout:90000});
await pg.waitForTimeout(400);

const pl = await pg.evaluate(()=>window.__pl);
const routes = await pg.evaluate(()=>window.__RT.solution.routes.filter(r=>r.seq.length).length);
check('경로 폴리라인 생성 (본선 + 흰색 케이싱)', pl.length === routes*2, `${pl.length}개 / 코스 ${routes}개`);
check('폴리라인 케이싱이 본선보다 두껍다',
  pl.filter(p=>p.c==='#ffffff').every(c=>c.w===8) && pl.filter(p=>p.c!=='#ffffff').every(l=>l.w===4));

const styles = pl.filter(p=>p.c!=='#ffffff').map(p=>p.c+'/'+p.s);
check('차량별 스타일이 모두 고유 (4색 × 선패턴)', new Set(styles).size===styles.length, styles.join(' '));
const hues = new Set(pl.filter(p=>p.c!=='#ffffff').map(p=>p.c));
check('검증 통과 4색만 사용', [...hues].every(h=>['#2a78d6','#eb6834','#1baf7a','#4a3aa7'].includes(h)), [...hues].join(' '));
check('5번째 차량부터 선 패턴으로 구분',
  routes<5 || pl.some(p=>p.c!=='#ffffff' && p.s!=='solid'),
  pl.filter(p=>p.c!=='#ffffff').map(p=>p.s).join(','));

const ov = await pg.evaluate(()=>window.__ov.length);
check('결과 마커 렌더링', ov >= 17, `${ov}개`);
check('콘솔 에러 없음', errs.length===0, errs.slice(0,2).join(' | '));

// R7. 색은 경로 순서가 아니라 차량을 따라가는가
const colorMap = async () => pg.evaluate(() =>
  Object.fromEntries(window.__RT.solution.routes.filter(r=>r.seq.length)
    .map(r => [window.__vehicleOf(r).name, window.__routeStyle(r).color + '/' + window.__routeStyle(r).pattern.name])));

const c1 = await colorMap();
check('R7a 차량 고유 순번대로 색 배정',
  Object.entries(c1).every(([n,c]) => {
    const i = +n.replace('호차','') - 1;
    const hue = ['#2a78d6','#eb6834','#1baf7a','#4a3aa7'][i%4];
    const pat = ['solid','dashed','dotted'][Math.floor(i/4)%3];
    return c === hue+'/'+pat;
  }), JSON.stringify(c1));

// 시드를 바꿔 다른 배차가 나와도 차량별 색은 그대로여야 한다
await pg.evaluate(()=>{ window.__S.options.seed = 777; });
await pg.click('#btnOptimize');
await pg.waitForFunction(()=>document.querySelector('#progressModal').hidden && !window.__RT.optimizing,null,{timeout:90000});
await pg.waitForTimeout(300);
const c2 = await colorMap();
const shared = Object.keys(c1).filter(k=>k in c2);
check('R7b 재최적화해도 차량 색 유지', shared.length>0 && shared.every(k=>c1[k]===c2[k]),
  shared.map(k=>`${k}:${c1[k]===c2[k]?'동일':c1[k]+'→'+c2[k]}`).join(' '));

await pg.screenshot({path:process.env.SHOT||'/tmp/map.png'});
await b.close(); srv.close();
const f=R.filter(x=>!x).length;
console.log(`\n${'─'.repeat(60)}\n결과: ${R.length-f}/${R.length} 통과`);
process.exit(f?1:0);
