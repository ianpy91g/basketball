const assert=require('node:assert/strict');
const Court=require('../app/court.js');
const corners=Court.anchors.slice(0,4);
// Recover an independently specified perspective camera, then project unseen points.
const camera=[.03,.01,.4,.002,-.04,.8,.001,.004,1];
const pairs=corners.map(a=>({image:Court.project(camera,a),court:{x:a.x,y:a.y}}));
const h=Court.calibrate(pairs);
for(const expected of [{x:0,y:2.9},{x:-5,y:7},{x:5.2,y:10},{x:0,y:13.9}]){
  const actual=Court.project(h,Court.project(camera,expected));
  assert.ok(Math.hypot(actual.x-expected.x,actual.y-expected.y)<1e-8);
}
assert.throws(()=>Court.calibrate(pairs.slice(0,3)),/四組/);
assert.throws(()=>Court.calibrate(pairs.map((p,i)=>({...p,image:{x:i/4,y:i/4}}))),/同一直線/);
assert.throws(()=>Court.calibrate(pairs.map((p,i)=>i===3?{...p,court:{x:-2.45,y:2.9}}:p)),/同一直線|無效/);
assert.throws(()=>Court.calibrate(pairs.map((p,i)=>i===3?{...p,image:{x:NaN,y:.5}}:p)),/完整/);
assert.throws(()=>Court.calibrate(pairs.map((p,i)=>i===3?pairs[2]:p)),/重複/);
const horizon=[.04,0,.5,0,.04,.5,0,-1/7,1];
assert.throws(()=>Court.calibrate(corners.map(a=>({image:Court.project(horizon,a),court:a}))),/方向不合理/);
assert.equal(Court.project([1,0,0,0,1,0,0,0,0],{x:1,y:1}),null);
assert.equal(Court.inCourt({x:9,y:4}),false);
assert.equal(Court.inCourt({x:null,y:null}),false);
assert.equal(Court.zone({x:0,y:3}),'禁區');
assert.equal(Court.zone({x:-5,y:3}),'左側中距離');
assert.equal(Court.zone({x:5,y:3}),'右側中距離');
assert.equal(Court.zone({x:0,y:7}),'正面中距離');
assert.equal(Court.zone({x:0,y:9}),'正面三分');
assert.equal(Court.zone({x:-7,y:1}),'左側三分');
const stats=Court.summarize([
  {result:'make',position:{x:0,y:3}},{result:'miss',position:{x:0,y:3}},
  {result:'unknown',position:{x:0,y:3}},{result:'ignored',position:{x:0,y:3}},
  {result:'make'},{result:'make',position:{x:99,y:3}},
]);
assert.deepEqual(stats[0],{name:'禁區',makes:1,misses:1,unknown:1,total:3,accuracy:50});
assert.equal(stats.slice(1).every(z=>z.total===0&&z.accuracy===null),true);
assert.equal(Court.fitCalibration(pairs.slice(0,1)).matrix,null);
assert.equal(Court.fitCalibration(pairs.slice(0,2)).method,'similarity');
assert.equal(Court.fitCalibration(pairs.slice(0,3)).method,'affine');
const extra=Court.anchors.slice(4,6).map(a=>({image:Court.project(camera,a),court:{x:a.x,y:a.y}}));
const all=Court.fitCalibration(pairs.concat(extra));
assert.equal(all.method,'perspective');assert.ok(all.rms<1e-8);
// Three collinear landmarks can still be used as a clearly labelled coarse fit.
const line=[0,1,2].map(i=>({image:{x:.2+i*.1,y:.5},court:{x:i,y:4}}));
assert.equal(Court.fitCalibration(line).method,'similarity');
const inconsistent=pairs.concat({image:{x:.99,y:.99},court:{x:0,y:0}});
assert.throws(()=>Court.fitCalibration(inconsistent),/矛盾/);
function pose({x=.5,feet=.88,wrists=.5,visible=1}={}){
  const p=Array.from({length:33},()=>({x,y:.5,visibility:visible,presence:1}));
  for(const i of [11,12])p[i].y=.35;
  for(const i of [23,24])p[i].y=.6;
  for(const i of [25,26])p[i].y=.72;
  for(const i of [27,28,29,30,31,32])p[i].y=feet;
  p[15].y=p[16].y=wrists;p[31].x=x-.025;p[32].x=x+.025;
  return p;
}
const sample=[{time:1,poses:[pose()]},{time:1.2,poses:[pose()]},{time:1.4,poses:[pose({feet:.84,wrists:.2})]}];
const shot=Court.selectShootingPosition(sample,2.4);
assert.equal(shot.candidate.video_time,1);assert.equal(shot.candidate.video_point.y,.88);
assert.equal(shot.candidate.reviewed,false);
assert.equal(Court.selectShootingPosition(sample.map(f=>({...f,poses:f.poses.map(p=>p.map((a,i)=>i>=27?{...a,y:1.05}:a))})),2.4).candidate,null);
assert.equal(Court.selectShootingPosition([{time:1,poses:[pose({wrists:.2}),pose({x:.8,wrists:.2})]}],2.4).candidate,null);
assert.equal(Court.selectShootingPosition([{time:1,poses:[pose()]},{time:1.2,poses:[pose()]}],2.4).candidate,null);
assert.equal(Court.selectShootingPosition([{time:1,poses:[pose({visible:.2})]}],2.4).candidate,null);
const standing=pose();standing[15].visibility=standing[16].visibility=0;
assert.ok(Court.currentPersonFoot([standing],10).point);
assert.equal(Court.currentPersonFoot([standing,standing],10).point,null);
assert.equal(Court.currentPersonFoot([pose({feet:1.1})],10).point,null);
assert.equal(Court.zone({x:5,y:8},true),'圖上右側');
const relative=Court.summarize([{result:'make',position:{x:5,y:8}}],{relative:true});
assert.equal(relative.length,3);assert.equal(relative[2].makes,1);assert.equal(relative[2].accuracy,100);
assert.ok(relative.every(z=>!z.name.includes('三分')));
const nearCamera=[.04,0,.5,0,.04,.5,0,-1/12,1];
const nearPairs=corners.map(a=>({image:Court.project(nearCamera,a),court:a}));
assert.throws(()=>Court.calibrate(nearPairs),/方向不合理/);
assert.equal(Court.fitCalibration(nearPairs,{depth:10}).method,'perspective');
console.log('Court checks passed: perspective projection, bad calibration, horizon, bounds, zones, unknown/ignored counts');
