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
assert.throws(()=>Court.calibrate(pairs.map((p,i)=>i===3?{...p,court:{x:-2.45,y:2.9}}:p)),/同一直線/);
assert.throws(()=>Court.calibrate(pairs.map((p,i)=>i===3?{...p,image:{x:NaN,y:.5}}:p)),/四組/);
assert.throws(()=>Court.calibrate(pairs.map((p,i)=>i===3?pairs[2]:p)),/同一直線/);
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
console.log('Court checks passed: perspective projection, bad calibration, horizon, bounds, zones, unknown/ignored counts');
