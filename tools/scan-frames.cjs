/* Feed raw RGBA frames to the exact browser detector without a DOM or OCR. */
const fs=require('node:fs');
const path=require('node:path');
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const {BallDetector,ShotTracker}=require(config.trackerModule||path.resolve(__dirname,'../app/tracker.js'));
const detector=new BallDetector(config.width,config.height,config.hoop);
const tracker=new ShotTracker(config.hoop);
const frame=Buffer.alloc(config.width*config.height*4);
let filled=0,index=0;
const candidateFrames=[];
process.stdin.on('data',chunk=>{
  let cursor=0;
  while(cursor<chunk.length){
    const count=Math.min(frame.length-filled,chunk.length-cursor);
    chunk.copy(frame,filled,cursor,cursor+count);cursor+=count;filled+=count;
    if(filled===frame.length){
      const candidates=detector.detect({data:frame});
      tracker.update(index/config.fps,candidates);
      if(config.captureCandidates)candidateFrames.push({t:index/config.fps,candidates,selected:tracker.lastPoint});
      index++;filled=0;
    }
  }
});
process.stdin.on('end',()=>{
  if(filled)throw Error('Incomplete raw frame');
  tracker.finish(true);
  const summary={attempts:tracker.events.length,...Object.fromEntries(['make','miss','unknown'].map(k=>[k,tracker.events.filter(e=>e.result===k).length]))};
  process.stdout.write(JSON.stringify({frames:index,summary,events:tracker.events,...(config.captureCandidates?{candidateFrames}:{})}));
});
