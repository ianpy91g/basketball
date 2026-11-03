/* Ground-plane calibration and a FIBA 2024 reference half court. No player inference. */
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
  function validSpread(points,epsilon){
    for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++)for(let k=j+1;k<points.length;k++){
      const a=points[i],b=points[j],c=points[k];
      if(Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))<epsilon)return false;
    }
    return true;
  }
  function calibrate(pairs){
    if(pairs.length!==4||pairs.some(p=>![p.image.x,p.image.y,p.court.x,p.court.y].every(Number.isFinite)))throw Error('需要四組完整的地面對應點。');
    if(!validSpread(pairs.map(p=>p.image),.0005)||!validSpread(pairs.map(p=>p.court),.02))throw Error('校正點太靠近或有三點在同一直線上。請改選分散的四個地面角點。');
    const rows=[];
    for(const {image:{x,y},court:{x:u,y:v}} of pairs){
      rows.push([x,y,1,0,0,0,-u*x,-u*y,u],[0,0,0,x,y,1,-v*x,-v*y,v]);
    }
    for(let col=0;col<8;col++){
      let pivot=col;for(let row=col+1;row<8;row++)if(Math.abs(rows[row][col])>Math.abs(rows[pivot][col]))pivot=row;
      if(Math.abs(rows[pivot][col])<1e-10)throw Error('無法建立球場校正，請重新選擇地面點。');
      [rows[col],rows[pivot]]=[rows[pivot],rows[col]];
      const divisor=rows[col][col];for(let k=col;k<=8;k++)rows[col][k]/=divisor;
      for(let row=0;row<8;row++)if(row!==col){const f=rows[row][col];for(let k=col;k<=8;k++)rows[row][k]-=f*rows[col][k];}
    }
    const h=rows.map(row=>row[8]).concat(1);
    if(pairs.some(p=>{const q=project(h,p.image);return !q||Math.hypot(q.x-p.court.x,q.y-p.court.y)>.001;}))throw Error('校正誤差過大，請重選。');
    // A court cannot pass through the projective horizon or fold over itself.
    const inverse=invert(h);
    const corners=[{x:-7.5,y:0},{x:7.5,y:0},{x:7.5,y:14},{x:-7.5,y:14}];
    const denominators=corners.map(p=>inverse[6]*p.x+inverse[7]*p.y+inverse[8]);
    if(denominators.some(d=>Math.abs(d)<1e-9)||!denominators.every(d=>Math.sign(d)===Math.sign(denominators[0])))throw Error('校正方向不合理。請確認影片點與球場圖地標一一對應。');
    return h;
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
  function zone(p){
    if(!inCourt(p))return null;
    if(Math.abs(p.x)>=6.6||Math.hypot(p.x,p.y-1.575)>=6.75)return zones[p.x<-2.45?4:p.x>2.45?6:5];
    if(Math.abs(p.x)<=2.45&&p.y<=5.8)return zones[0];
    return zones[p.x<-2.45?1:p.x>2.45?3:2];
  }
  function summarize(events){
    return zones.map(name=>{
      const shots=events.filter(e=>e.result!=='ignored'&&zone(e.position)===name);
      const makes=shots.filter(e=>e.result==='make').length,misses=shots.filter(e=>e.result==='miss').length;
      return {name,makes,misses,unknown:shots.filter(e=>e.result==='unknown').length,total:shots.length,accuracy:makes+misses?makes/(makes+misses)*100:null};
    });
  }
  const exported={anchors,project,calibrate,invert,inCourt,zone,summarize};
  if(typeof module!=='undefined'&&module.exports)module.exports=exported;else root.Court=exported;
})(typeof globalThis!=='undefined'?globalThis:this);
