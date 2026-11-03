const assert=require('node:assert/strict');
const {ShotTracker}=require('../app/tracker.js');
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
console.log('6 event tests passed: make, rebound, occlusion, interruption, small fragments, duplicate timestamp');
