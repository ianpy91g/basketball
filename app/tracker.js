/* Shared event rules: used by the browser camera and the offline video analyzer. */
(function (root) {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  class ShotTracker {
    constructor(hoop) {
      this.hoop = hoop;
      this.w = hoop.right - hoop.left;
      this.cx = (hoop.left + hoop.right) / 2;
      this.cy = (hoop.top + hoop.bottom) / 2;
      this.history = [];
      this.events = [];
      this.active = null;
      this.lastPoint = null;
      this.lastTime = null;
      this.cooldown = -Infinity;
    }
    update(t, candidates) {
      if (!Number.isFinite(t) || (this.lastTime !== null && t <= this.lastTime)) return null;
      let completed = null;
      // A camera interruption is missing evidence, never evidence of a miss.
      if (this.lastTime !== null && t - this.lastTime > .3) {
        if (this.active) completed = this.finish(true);
        this.history = [];
        this.lastPoint = null;
      }
      this.lastTime = t;
      const w = this.w;
      let options = candidates.filter(p => p.area >= w*w*.018 && p.area <= w*w*.8);
      if (this.lastPoint && t - this.lastPoint.t < .18) {
        const old = this.lastPoint;
        options = options.filter(p => Math.hypot(p.x-old.x, p.y-old.y) < w * 2.4);
        options.sort((a,b) => Math.hypot(a.x-old.x,a.y-old.y) - Math.hypot(b.x-old.x,b.y-old.y));
      } else {
        options.sort((a,b) => Math.abs(a.area-w*w*.13) - Math.abs(b.area-w*w*.13));
      }
      const p = options[0] ? {...options[0], t} : null;
      if (p) {
        this.lastPoint = p;
        this.history.push(p);
      }
      this.history = this.history.filter(q => q.t >= t-.65);
      if (!this.active && p && t >= this.cooldown && this.history.length >= 3) {
        const past = this.history.filter(q => t-q.t >= .055 && t-q.t <= .45);
        const fromAbove = past.some(q => q.y < this.cy-w*.45 && p.y-q.y > w*.2);
        const near = Math.abs(p.x-this.cx) <= w*.85 && p.y >= this.cy-w*.5 && p.y <= this.cy+w*.42;
        if (near && fromAbove) {
          this.active = {start: t, points: this.history.slice(), lastSeen: t};
          this.cooldown = t+2.0;
        }
      } else if (this.active && p) {
        this.active.points.push(p);
        this.active.lastSeen = t;
      }
      if (this.active && (t-this.active.start >= 1.4 || (t-this.active.lastSeen > .33 && t-this.active.start > .7))) {
        return this.finish(false);
      }
      return completed;
    }
    finish(interrupted = true) {
      if (!this.active) return null;
      const a = this.active;
      this.active = null;
      const w = this.w, cx = this.cx, cy = this.cy;
      const after = a.points.filter(p => p.t >= a.start);
      const core = after.filter(p => p.x >= this.hoop.left+w*.08 && p.x <= this.hoop.right-w*.2 && p.y >= cy+w*.23 && p.y <= cy+w*.95);
      let result = 'unknown', reason = '球的後續軌跡不足，請回看確認';
      const span = core.length ? core[core.length-1].t-core[0].t : 0;
      const drops = core.length ? Math.max(...core.map(p=>p.y))-Math.min(...core.map(p=>p.y)) : 0;
      const downThroughNet = core.length >= 4 && span >= .15 && drops >= w*.28 && core.some(p=>p.y > cy+w*.63);
      const contact = after.findIndex(p => Math.abs(p.x-cx)<w*.7 && p.y>cy-w*.4);
      let rebound = false;
      if (contact >= 0) {
        const touch = after[contact];
        rebound = after.slice(contact+1).some(p=>p.t-touch.t < .8 && p.y < touch.y-w*.28);
        rebound ||= after.slice(contact+1).some(p=>p.t-touch.t < .7 && Math.abs(p.x-cx)>w*1.65 && p.y < cy+w*.3);
      }
      let bypass = false;
      const line = cy+w*.32;
      for (let i=1;i<after.length;i++) {
        const p=after[i-1], q=after[i];
        if (p.y < line && q.y >= line && q.y>p.y && q.t-p.t < .14) {
          const x=p.x+(q.x-p.x)*(line-p.y)/(q.y-p.y);
          if (x > cx+w*.3 || x < cx-w*.42) {
            bypass = after.slice(i).some(r=>r.y>cy+w*.95);
          }
        }
      }
      if (downThroughNet) { result='make'; reason='偵測到球在籃網區持續向下穿出'; }
      else if (!interrupted && (rebound || bypass)) {
        result='miss'; reason=rebound?'偵測到球在籃框附近反彈離開':'偵測到球從籃網通道外落下';
      } else if (interrupted) reason='錄影結束或影格中斷，保留為待確認';
      // Timestamp the initial encounter, rather than a later bounce near the rim.
      let closest = after[0] || a.points[0];
      for (const p of after.filter(p=>p.t <= a.start+.35)) {
        if (Math.hypot(p.x-cx,p.y-cy)<Math.hypot(closest.x-cx,closest.y-cy)) closest=p;
      }
      const event={id:this.events.length+1,time:+closest.t.toFixed(3),start:+Math.max(0,a.start-.8).toFixed(3),end:+(a.lastSeen+.35).toFixed(3),result,automatic_result:result,reason,reviewed:false,points:a.points.map(p=>({t:+p.t.toFixed(3),x:+p.x.toFixed(2),y:+p.y.toFixed(2)}))};
      this.events.push(event);
      return event;
    }
  }

  class BallDetector {
    constructor(width,height,hoop) {
      this.width=width; this.height=height; this.hoop=hoop;
      const w=hoop.right-hoop.left, cx=(hoop.left+hoop.right)/2, cy=(hoop.top+hoop.bottom)/2;
      this.roi={x:Math.max(0,Math.floor(cx-w*2.5)),y:Math.max(0,Math.floor(cy-w*3.5)),right:Math.min(width,Math.ceil(cx+w*5.4)),bottom:Math.min(height,Math.ceil(cy+w*2))};
      const r=this.roi; this.rw=r.right-r.x; this.rh=r.bottom-r.y;
      this.background=null;
    }
    detect(imageData) {
      const {data}=imageData, rw=this.rw, rh=this.rh, roi=this.roi;
      const n=rw*rh, mask=new Uint8Array(n);
      if (!this.background) {
        this.background=new Float32Array(n);
        for(let y=0;y<rh;y++)for(let x=0;x<rw;x++){
          const k=((y+roi.y)*this.width+x+roi.x)*4;
          this.background[y*rw+x]=data[k]*.299+data[k+1]*.587+data[k+2]*.114;
        }
        return [];
      }
      for(let y=0;y<rh;y++)for(let x=0;x<rw;x++){
        const i=y*rw+x,k=((y+roi.y)*this.width+x+roi.x)*4;
        const r=data[k],g=data[k+1],b=data[k+2],gray=r*.299+g*.587+b*.114;
        const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;
        let hue=0;
        if(d){if(mx===r)hue=((g-b)/d)%6;else if(mx===g)hue=(b-r)/d+2;else hue=(r-g)/d+4;hue*=30;if(hue<0)hue+=180;}
        if(hue<=28 && mx>=45 && (mx?d/mx*255:0)>=65 && Math.abs(gray-this.background[i])>=22)mask[i]=1;
        this.background[i]+=(gray-this.background[i])*.025;
      }
      const stack=new Int32Array(n), candidates=[],w=this.hoop.right-this.hoop.left;
      for(let seed=0;seed<n;seed++){
        if(!mask[seed])continue;
        let top=0;stack[top++]=seed;mask[seed]=0;
        let count=0,sx=0,sy=0,minx=rw,miny=rh,maxx=0,maxy=0;
        while(top){
          const i=stack[--top],x=i%rw,y=Math.floor(i/rw);
          count++;sx+=x;sy+=y;minx=Math.min(minx,x);maxx=Math.max(maxx,x);miny=Math.min(miny,y);maxy=Math.max(maxy,y);
          for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
            if((dx===0&&dy===0)||x+dx<0||x+dx>=rw||y+dy<0||y+dy>=rh)continue;
            const j=i+dy*rw+dx;if(mask[j]){mask[j]=0;stack[top++]=j;}
          }
        }
        const bw=maxx-minx+1,bh=maxy-miny+1;
        if(count<w*w*.018||count>w*w*.8||Math.min(bw,bh)<3||Math.max(bw/bh,bh/bw)>3.5||count/(bw*bh)<.25)continue;
        candidates.push({x:sx/count+roi.x,y:sy/count+roi.y,area:count});
      }
      return candidates;
    }
  }
  const exported={ShotTracker,BallDetector,clamp};
  if(typeof module!=='undefined'&&module.exports) module.exports=exported;
  else root.Basketball=exported;
})(typeof globalThis!=='undefined'?globalThis:this);
