const assert=require('node:assert/strict');
const {ShotTracker,BallDetector}=require('../app/tracker.js');
const hoop={left:50,top:130,right:110,bottom:156};
const point=(x,y)=>({x,y,area:400});
function run(points,finishAt=2){
  const tracker=new ShotTracker(hoop);
  for(let i=0;i<=Math.round(finishAt*30);i++){
    const p=points[i];tracker.update(i/30,p?[point(...p)]:[]);
  }
  return tracker;
}
const approaching=[[160,80],[142,100],[123,119],[105,134],[84,147]];
const make=run([...approaching,[72,151],[71,153],[71,155],[71,158],[72,162],[72,168],[72,174],[72,181],[72,189],[72,201],[72,218]]);
assert.equal(make.events.length,1);assert.equal(make.events[0].result,'make');
const miss=run([...approaching,[92,131],[105,115],[120,100],[145,91],[175,92],[190,104]]);
assert.equal(miss.events.length,1);assert.equal(miss.events[0].result,'miss');
const occluded=run(approaching);
assert.equal(occluded.events.length,1);assert.equal(occluded.events[0].result,'unknown');
const interrupted=new ShotTracker(hoop);
approaching.forEach((p,i)=>interrupted.update(i/30,[point(...p)]));
const completed=interrupted.update(1.5,[]);
assert.equal(completed.result,'unknown');assert.equal(interrupted.events.length,1);
const fragments=new ShotTracker(hoop);
for(let i=0;i<100;i++)fragments.update(i/30,[{x:80,y:150,area:10}]);
assert.equal(fragments.events.length,0);
const duplicateTime=new ShotTracker(hoop);duplicateTime.update(1,[point(100,80)]);duplicateTime.update(1,[point(100,140)]);
assert.equal(duplicateTime.history.length,1);
// Low-frame-rate, distant shots can traverse the entire net in two frames.
const distantHoop={left:196,top:181,right:237,bottom:193};
const distantMake=[[252,116],[233,144],[216,176],[208,204],[209,221],[210,233]];
const fast=new ShotTracker(distantHoop);
for(let i=0;i<48;i++)fast.update(i/24,distantMake[i]?[{...point(...distantMake[i]),area:140}]:[]);
assert.equal(fast.events.length,1);assert.equal(fast.events[0].result,'make');
// Repeated shots less than two seconds apart must remain separate attempts.
const rapidPoints=Array(145).fill(null);
for(const offset of [0,48]) [...approaching,[72,151],[71,153],[71,155],[71,158],[72,162],[72,168],[72,174],[72,181],[72,189],[72,201]].forEach((p,i)=>rapidPoints[offset+i]=p);
const rapid=run(rapidPoints,4.8);
assert.equal(rapid.events.length,2);assert.ok(rapid.events.every(e=>e.result==='make'));
// A rebound can peak above the rim between sampled frames.
const aboveRim=[[256,116],[238,146],[213,156],[204,142],[195,133],[183,127],[164,133],[147,156],[135,185]];
const high=new ShotTracker(distantHoop);
for(let i=0;i<40;i++)high.update(i/24,aboveRim[i]?[{...point(...aboveRim[i]),area:140}]:[]);
assert.equal(high.events.length,1);assert.equal(high.events[0].result,'miss');
// Clip end preserves an already-observed outcome; absence alone stays unknown.
const end=new ShotTracker(distantHoop);
aboveRim.forEach((p,i)=>end.update(i/24,[{...point(...p),area:140}]));
end.finish(true);assert.equal(end.events[0].result,'miss');
const outside=[[260,115],[242,146],[235,176],[242,204],[249,232],[256,265]];
const bypass=new ShotTracker(distantHoop);
for(let i=0;i<40;i++)bypass.update(i/24,outside[i]?[{...point(...outside[i]),area:140}]:[]);
assert.equal(bypass.events[0].result,'miss');
// Red hue wraps across zero; very dark red is below the former value threshold.
for(const color of [[105,25,38],[32,8,10],[190,95,35]]){
  const width=128,height=96,rgba=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<rgba.length;i+=4)rgba.set([110,160,150,255],i);
  const detector=new BallDetector(width,height,{left:40,top:40,right:80,bottom:48});
  assert.equal(detector.detect({data:rgba}).length,0);
  for(let y=22;y<=34;y++)for(let x=69;x<=81;x++)if((x-75)**2+(y-28)**2<=36)rgba.set([...color,255],(y*width+x)*4);
  const balls=detector.detect({data:rgba});assert.equal(balls.length,1);
  assert.ok(Math.abs(balls[0].x-75)<.5 && Math.abs(balls[0].y-28)<.5);
}
const switched=new ShotTracker(hoop);
const ghost=[[100,125],[80,105],[60,85],[80,139],[80,139],[80,139],[80,139],[80,139]];
for(let i=0;i<50;i++)switched.update(i/30,ghost[i]?[point(...ghost[i])]:[]);
assert.equal(switched.events.length,0);
const distractor=new ShotTracker(hoop);
const ballPath=[[170,40],[150,65],[130,90],[110,115],[88,139],[74,152],[71,161],[71,172],[71,185],[71,202]];
for(let i=0;i<60;i++){
  const candidates=[{x:290-i*.2,y:90+i,area:400}];
  if(ballPath[i])candidates.push(point(...ballPath[i]));
  distractor.update(i/30,candidates);
}
assert.equal(distractor.events.length,1);assert.equal(distractor.events[0].result,'make');
const fragmented=new ShotTracker({left:48,top:130,right:110,bottom:156});
const fragmentsAfterOcclusion=[[211,80,78],[186,60,403],[142,18,1352],[88,105,2800],[31,134,112],[36,90,2380],[17,84,1187],[42,139,129],[42,139,118],[41,139,101]];
for(let i=0;i<70;i++){
  const p=fragmentsAfterOcclusion[i];fragmented.update(i/30,p?[{x:p[0],y:p[1],area:p[2]}]:[]);
}
assert.equal(fragmented.events.length,0);
console.log('17 regression checks passed: original cases, fast/rapid shots, rebounds, clip end, outside pass, colors, rim fragments, distractors, abrupt size switch');
