/* Ground-plane calibration, pose evidence selection and a reference half court. */
(function(root){
  'use strict';
  const anchors=[
    {id:'key-left-base',label:'禁區左底角',x:-2.45,y:0},
    {id:'key-right-base',label:'禁區右底角',x:2.45,y:0},
    {id:'key-left-free',label:'禁區左罰球線角',x:-2.45,y:5.8},
    {id:'key-right-free',label:'禁區右罰球線角',x:2.45,y:5.8},
    {id:'free-left',label:'罰球線左端',x:-1.8,y:5.8},
    {id:'free-right',label:'罰球線右端',x:1.8,y:5.8},
    {id:'court-left-base',label:'球場左底角',x:-7.5,y:0},
    {id:'court-right-base',label:'球場右底角',x:7.5,y:0},
    {id:'court-left-mid',label:'左邊線與中線交點',x:-7.5,y:14},
    {id:'court-right-mid',label:'右邊線與中線交點',x:7.5,y:14},
  ];
  function project(h,p){
    const d=h[6]*p.x+h[7]*p.y+h[8];
    if(!Number.isFinite(d)||Math.abs(d)<1e-9)return null;
    const x=(h[0]*p.x+h[1]*p.y+h[2])/d,y=(h[3]*p.x+h[4]*p.y+h[5])/d;
    return Number.isFinite(x)&&Number.isFinite(y)?{x,y}:null;
  }
  // Householder QR solves all supplied correspondences without normal equations.
  function leastSquares(input,n){
    const a=input.map(row=>row.slice());
    if(a.length<n)throw Error('對應點不足。');
    for(let col=0;col<n;col++){
      const norm=Math.hypot(...a.slice(col).map(row=>row[col]));
      if(norm<1e-8)throw Error('校正點太靠近或在同一直線上。');
      const v=a.slice(col).map(row=>row[col]);v[0]+=v[0]>=0?norm:-norm;
      const length=Math.hypot(...v);for(let i=0;i<v.length;i++)v[i]/=length;
      for(let k=col;k<=n;k++){
        let dot=0;for(let i=0;i<v.length;i++)dot+=v[i]*a[col+i][k];
        for(let i=0;i<v.length;i++)a[col+i][k]-=2*v[i]*dot;
      }
    }
    const out=Array(n).fill(0);
    for(let i=n-1;i>=0;i--){let value=a[i][n];for(let k=i+1;k<n;k++)value-=a[i][k]*out[k];out[i]=value/a[i][i];}
    return out;
  }
  function calibrate(pairs,{depth=14}={}){
    validatePairs(pairs);
    if(pairs.length<4)throw Error('透視校正至少需要四組地面對應點。');
    const rows=[];
    for(const {image:{x,y},court:{x:u,y:v}} of pairs){
      rows.push([x,y,1,0,0,0,-u*x,-u*y,u],[0,0,0,x,y,1,-v*x,-v*y,v]);
    }
    const h=leastSquares(rows,8).concat(1);
    // A court cannot pass through the projective horizon or fold over itself.
    const inverse=invert(h);
    const corners=[{x:-7.5,y:0},{x:7.5,y:0},{x:7.5,y:depth},{x:-7.5,y:depth}];
    const denominators=corners.map(p=>inverse[6]*p.x+inverse[7]*p.y+inverse[8]);
    if(denominators.some(d=>Math.abs(d)<1e-9)||!denominators.every(d=>Math.sign(d)===Math.sign(denominators[0])))throw Error('校正方向不合理。請確認影片點與球場圖地標一一對應。');
    return h;
  }
  function validatePairs(pairs){
    if(!pairs.length||pairs.some(p=>![p.image?.x,p.image?.y,p.court?.x,p.court?.y].every(Number.isFinite)))throw Error('請至少配對一個完整的地面點。');
    for(let i=0;i<pairs.length;i++)for(let j=i+1;j<pairs.length;j++){
      if(Math.hypot(pairs[i].image.x-pairs[j].image.x,pairs[i].image.y-pairs[j].image.y)<.005||Math.hypot(pairs[i].court.x-pairs[j].court.x,pairs[i].court.y-pairs[j].court.y)<.01)throw Error('對應點重複或太靠近，請調整或退回一點。');
    }
  }
  function fitCalibration(pairs,{aspect=1,mirror=false,depth=14}={}){
    validatePairs(pairs);
    if(pairs.length===1)return {matrix:null,method:'reference',quality:'僅參考點',rms:null};
    let matrix=null,method='',fallback=false;
    if(pairs.length>=4){try{matrix=calibrate(pairs,{depth});method='perspective';}catch(error){fallback=true;}}
    if(!matrix&&pairs.length>=3){
      try{
        const rows=[];
        for(const {image:{x,y},court:{x:u,y:v}} of pairs)rows.push([x,y,1,0,0,0,u],[0,0,0,x,y,1,v]);
        matrix=leastSquares(rows,6).concat(0,0,1);invert(matrix);method='affine';
      }catch(error){fallback=true;matrix=null;}
    }
    if(!matrix){
      const rows=[],sign=mirror?-1:1;
      for(const {image, court:{x:u,y:v}} of pairs){
        const x=image.x*aspect,y=image.y*sign;
        rows.push([x,-y,1,0,u],[y,x,0,1,v]);
      }
      const [a,b,tx,ty]=leastSquares(rows,4);
      matrix=[a*aspect,-b*sign,tx,b*aspect,a*sign,ty,0,0,1];invert(matrix);method='similarity';
    }
    const rms=Math.sqrt(pairs.reduce((sum,p)=>{const q=project(matrix,p.image);return sum+(q?(q.x-p.court.x)**2+(q.y-p.court.y)**2:Infinity);},0)/pairs.length);
    if(!Number.isFinite(rms)||rms>1.5)throw Error('對應點互相矛盾，平均偏差超過 1.5 參考公尺。請調整錯誤的點再完成。');
    return {matrix,method,rms,quality:method==='perspective'?'透視估計':method==='affine'?'近似估計':'少點粗估',fallback,domain_depth:depth};
  }
  function invert(h){
    const [a,b,c,d,e,f,g,i,j]=h;
    const out=[e*j-f*i,c*i-b*j,b*f-c*e,f*g-d*j,a*j-c*g,c*d-a*f,d*i-e*g,b*g-a*i,a*e-b*d];
    const det=a*out[0]+b*out[3]+c*out[6];
    if(Math.abs(det)<1e-12)throw Error('球場校正無效，請重新校正。');
    return out.map(v=>v/det);
  }
  const inCourt=p=>!!p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=-7.5&&p.x<=7.5&&p.y>=0&&p.y<=14;
  const zones=['禁區','左側中距離','正面中距離','右側中距離','左側三分','正面三分','右側三分'];
  function zone(p,relative=false){
    if(!inCourt(p))return null;
    if(relative)return p.x<-2.45?'圖上左側':p.x>2.45?'圖上右側':'圖上正面';
    if(Math.abs(p.x)>=6.6||Math.hypot(p.x,p.y-1.575)>=6.75)return zones[p.x<-2.45?4:p.x>2.45?6:5];
    if(Math.abs(p.x)<=2.45&&p.y<=5.8)return zones[0];
    return zones[p.x<-2.45?1:p.x>2.45?3:2];
  }
  function summarize(events,{relative=false}={}){
    return (relative?['圖上左側','圖上正面','圖上右側']:zones).map(name=>{
      const shots=events.filter(e=>e.result!=='ignored'&&zone(e.position,relative)===name);
      const makes=shots.filter(e=>e.result==='make').length,misses=shots.filter(e=>e.result==='miss').length;
      return {name,makes,misses,unknown:shots.filter(e=>e.result==='unknown').length,total:shots.length,accuracy:makes+misses?makes/(makes+misses)*100:null};
    });
  }
  function groundPerson(points,time){
    const visible=i=>{const p=points[i];return p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>0&&p.x<1&&p.y>0&&p.y<.99&&(p.visibility??0)>=.65&&(p.presence??1)>=.6;};
    if(![11,12,23,24,25,26,27,28,31,32].every(visible))return null;
    const hip={x:(points[23].x+points[24].x)/2,y:(points[23].y+points[24].y)/2};
    const shoulderY=(points[11].y+points[12].y)/2,torso=hip.y-shoulderY;
    if(torso<.045)return null;
    const feet={x:(points[31].x+points[32].x)/2,y:(points[31].y+points[32].y)/2};
    if(Math.abs(points[31].x-points[32].x)>.3||feet.y<=hip.y+torso*.5)return null;
    return {time,hip,feet,shoulderY,torso,visibility:Math.min(...[27,28,31,32].map(i=>points[i].visibility))};
  }
  function currentPersonFoot(poses,time){
    const people=poses.map(p=>groundPerson(p,time)).filter(Boolean);
    if(people.length!==1)return {point:null,reason:people.length?'偵測到多位人物，請點選要參考的那位人物腳下。':'腳部不夠清楚，請直接點選影片中的腳下地面。'};
    return {point:people[0].feet,confidence:people[0].visibility};
  }
  function poseEvidence(points,time){
    const body=groundPerson(points,time);if(!body)return null;
    const wrists=[15,16].map(i=>points[i]).filter(p=>p&&p.x>0&&p.x<1&&p.y>0&&p.y<1&&(p.visibility??0)>=.65&&(p.presence??1)>=.6);
    if(!wrists.length)return null;
    return {...body,raised:Math.max(...wrists.map(p=>(body.shoulderY-p.y)/body.torso))};
  }
  function selectShootingPosition(samples,arrival){
    const evidence=samples.map(frame=>({time:frame.time,people:(frame.poses||[]).map(p=>poseEvidence(p,frame.time)).filter(Boolean)}));
    const frames=evidence.filter(f=>f.time<arrival-.25);
    if(!frames.some(f=>f.people.length))return {candidate:null,reason:'未清楚看到雙腳或身體，請人工定位'};
    if(frames.some(f=>f.people.filter(p=>p.raised>.2).length>1))return {candidate:null,reason:'畫面中有多位疑似出手者，請人工確認'};
    const releases=frames.flatMap(f=>f.people).filter(p=>p.raised>.2).sort((a,b)=>b.raised-a.raised||a.time-b.time);
    for(const release of releases){
      const preceding=frames.filter(f=>f.time>=release.time-.5&&f.time<=release.time).flatMap(f=>f.people).filter(p=>Math.abs(p.feet.x-release.feet.x)<.08&&Math.hypot(p.hip.x-release.hip.x,p.hip.y-release.hip.y)<.15);
      if(preceding.length<2)continue;
      const ground=preceding.slice().sort((a,b)=>b.feet.y-a.feet.y||a.time-b.time)[0];
      const stable=preceding.filter(p=>Math.hypot(p.feet.x-ground.feet.x,p.feet.y-ground.feet.y)<.045);
      if(stable.length<2)continue;
      return {candidate:{video_point:ground.feet,video_time:ground.time,release_time:release.time,confidence:Math.min(.95,ground.visibility),model:'mediapipe-pose-lite-1',reviewed:false},reason:'依出手前抬手與腳部線索估計，待複核'};
    }
    return {candidate:null,reason:'未找到穩定的出手前腳下位置，請人工定位'};
  }
  let estimatorPromise=null;
  function createPoseEstimator(){
    if(!estimatorPromise)estimatorPromise=(async()=>{
      const base='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32';
      const {FilesetResolver,PoseLandmarker}=await import(`${base}/vision_bundle.mjs`);
      const files=await FilesetResolver.forVisionTasks(`${base}/wasm`);
      return PoseLandmarker.createFromOptions(files,{
        baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',delegate:'CPU'},
        runningMode:'IMAGE',numPoses:2,minPoseDetectionConfidence:.5,minPosePresenceConfidence:.5,outputSegmentationMasks:false,
      });
    })().catch(error=>{estimatorPromise=null;throw error;});
    return estimatorPromise;
  }
  const exported={anchors,project,calibrate,fitCalibration,invert,inCourt,zone,summarize,poseEvidence,currentPersonFoot,selectShootingPosition,createPoseEstimator};
  if(typeof module!=='undefined'&&module.exports)module.exports=exported;else root.Court=exported;
})(typeof globalThis!=='undefined'?globalThis:this);
