/* Everything in camera mode is processed locally in this browser. */
'use strict';
const $ = id => document.getElementById(id);
const video=$('video'), overlay=$('overlay'), ctx=overlay.getContext('2d');
const scratch=document.createElement('canvas'), sx=scratch.getContext('2d',{willReadFrequently:true});
const {ShotTracker,BallDetector}=Basketball;
const labels={make:'進球',miss:'未進',unknown:'待確認',ignored:'忽略事件'};
let mode='file', backend=false, hoop=null, data=null, jobId=null, running=false, loading=false;
let tracker=null, detector=null, stream=null, recorder=null, recordedBlob=null;
let sourceUrl=null, recordingUrl=null, callbackId=null, generation=0, origin=0, frameTimes=[];
let calibrating=false, dragStart=null, dragEnd=null, sessionId=null, sourceKind=null;
const fmt=t=>`${String(Math.floor(Math.max(0,t)/60)).padStart(2,'0')}:${Math.max(0,t%60).toFixed(1).padStart(4,'0')}`;
const message=(text,error=false)=>{$('status').textContent=text;$('status').classList.toggle('error',error);};
const dateLabel=()=>new Date().toLocaleDateString('zh-TW',{month:'2-digit',day:'2-digit'});
$('sessionDate').textContent=dateLabel();

function stats(events){
  const count=result=>events.filter(e=>e.result===result).length;
  const make=count('make'),miss=count('miss'),unknown=count('unknown');
  return {attempts_detected:make+miss+unknown,make,miss,unknown,resolved_accuracy:make+miss?make/(make+miss)*100:null};
}
function refresh(full=true){
  const events=data?.events||[], s=stats(events);
  for(const [id,value] of Object.entries({attempts:s.attempts_detected,makes:s.make,misses:s.miss,unknowns:s.unknown}))$(id).textContent=value;
  $('accuracy').textContent=s.resolved_accuracy===null?'—':s.resolved_accuracy.toFixed(1);
  $('accuracyBar').style.width=`${s.resolved_accuracy||0}%`;
  const reviewed=events.filter(e=>e.reviewed&&e.result!=='ignored').length;
  $('reviewCount').textContent=events.length?`${reviewed} / ${s.attempts_detected} 球已確認`:'尚無紀錄';
  $('resultState').textContent=events.length?(reviewed===s.attempts_detected?'已人工確認':'自動結果 · 待複核'):'等待紀錄';
  $('exportCsv').disabled=$('exportJson').disabled=!events.length;
  $('addShot').disabled=!data||running||loading;
  $('reviewEmpty').hidden=!!events.length;
  if(!full)return;
  $('shotStrip').replaceChildren();$('shotRows').replaceChildren();
  if(!events.length){const p=document.createElement('p');p.textContent='分析完成後，點選球號跳至該次投籃。';$('shotStrip').append(p);}
  for(const e of events){
    const chip=document.createElement('button');chip.className=`shot-chip ${e.result}`;chip.textContent=e.id;chip.title=`第 ${e.id} 球 ${fmt(e.time)} ${labels[e.result]}`;chip.onclick=()=>jump(e);$('shotStrip').append(chip);
    const tr=document.createElement('tr');
    const num=document.createElement('td');num.textContent=String(e.id).padStart(2,'0');
    const time=document.createElement('td'),link=document.createElement('button');link.className='time-button';link.textContent=fmt(e.time);link.onclick=()=>jump(e);time.append(link);
    const result=document.createElement('td'),select=document.createElement('select');select.className=`result-select ${e.result}`;select.setAttribute('aria-label',`第 ${e.id} 球結果`);
    for(const [v,label] of Object.entries(labels)){const o=document.createElement('option');o.value=v;o.textContent=label;select.append(o);}select.value=e.result;
    select.onchange=()=>{e.result=select.value;e.reviewed=true;refresh();saveSession();};result.append(select);
    const reason=document.createElement('td');reason.className='reason-cell';reason.textContent=e.result!==e.automatic_result?`人工修正；原判定：${labels[e.automatic_result]||'手動補記'}`:e.reason;
    const review=document.createElement('td'),box=document.createElement('input');box.type='checkbox';box.className='review-box';box.checked=e.reviewed;box.setAttribute('aria-label',`確認第 ${e.id} 球`);box.onchange=()=>{e.reviewed=box.checked;refresh(false);saveSession();};review.append(box);
    tr.append(num,time,result,reason,review);$('shotRows').append(tr);
  }
}
function controls(){
  $('fileTools').hidden=mode!=='file'||running;
  $('liveTools').hidden=mode!=='live'||running;
  $('runActions').hidden=!running;
  const loaded=!!video.videoWidth;
  $('calibrateButton').disabled=!loaded||loading;
  $('liveCalibrateButton').disabled=!stream||loading;
  $('analyzeButton').disabled=!loaded||!hoop||loading||mode!=='file';
  $('startLiveButton').disabled=!stream||!hoop||loading;
  $('fileInput').disabled=$('sampleButton').disabled=loading;
  $('cameraButton').disabled=loading;
  $('addShot').disabled=!data||running||loading;
}
function newData(name){
  sessionId=crypto.randomUUID?crypto.randomUUID():String(Date.now());
  data={version:2,source:name,width:scratch.width,height:scratch.height,hoop,method:'browser-color-motion-v2',events:[],created_at:new Date().toISOString()};
  refresh();
}
function resize(){
  if(!video.videoWidth)return;
  const width=Math.min(960,video.videoWidth),height=Math.round(video.videoHeight*width/video.videoWidth);
  scratch.width=overlay.width=width;scratch.height=overlay.height=height;
  $('stage').style.aspectRatio=`${width}/${height}`;
  $('sourceMeta').textContent=`${video.videoWidth} × ${video.videoHeight}${Number.isFinite(video.duration)?` · ${fmt(video.duration)}`:''}`;
  $('empty').hidden=true;controls();draw();
}
video.addEventListener('loadedmetadata',resize);
video.addEventListener('timeupdate',()=>{if(!running)draw();});
video.addEventListener('ended',async()=>{if(running)await stop(true);});
video.addEventListener('error',()=>{if(sourceKind==='local')message('此瀏覽器無法播放這個格式。MTS 請用本機服務匯入轉檔；iPhone 建議使用 MP4 / MOV。',true);});

function draw(candidates=[]){
  ctx.clearRect(0,0,overlay.width,overlay.height);
  const box=calibrating&&dragStart&&dragEnd?{left:Math.min(dragStart.x,dragEnd.x),right:Math.max(dragStart.x,dragEnd.x),top:Math.min(dragStart.y,dragEnd.y),bottom:Math.max(dragStart.y,dragEnd.y)}:hoop;
  if(box){ctx.strokeStyle='#cbef91';ctx.lineWidth=2;ctx.setLineDash([6,4]);ctx.strokeRect(box.left,box.top,box.right-box.left,box.bottom-box.top);ctx.setLineDash([]);}
  const t=mode==='live'&&stream?Math.max(0,video.currentTime-origin):video.currentTime;
  const current=running?tracker?.active?.points:data?.events.flatMap(e=>e.points||[]);
  if(current){
    const pts=current.filter(p=>p.t<=t&&p.t>=t-.6);ctx.strokeStyle='#cbef91';ctx.lineWidth=2;ctx.beginPath();
    pts.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();
  }
  for(const p of candidates){ctx.strokeStyle='#f2b276';ctx.beginPath();ctx.arc(p.x,p.y,Math.sqrt(p.area/Math.PI),0,Math.PI*2);ctx.stroke();}
}
function calibrate(){
  if(running||!video.videoWidth)return;
  if(mode==='file')video.pause();
  calibrating=true;dragStart=dragEnd=null;$('stage').classList.add('calibrating');$('stageLabel').hidden=false;$('stageLabel').textContent='拖曳框選橢圓形籃圈，不含籃板與籃網';
  message('在畫面上拖曳，框住橢圓形籃圈；重新拍攝或移動手機後，請重新框選。');
}
function point(e){const r=overlay.getBoundingClientRect();return{x:Math.max(0,Math.min(overlay.width,(e.clientX-r.left)/r.width*overlay.width)),y:Math.max(0,Math.min(overlay.height,(e.clientY-r.top)/r.height*overlay.height))};}
overlay.addEventListener('pointerdown',e=>{if(!calibrating)return;overlay.setPointerCapture(e.pointerId);dragStart=dragEnd=point(e);draw();});
overlay.addEventListener('pointermove',e=>{if(calibrating&&dragStart){dragEnd=point(e);draw();}});
overlay.addEventListener('pointerup',e=>{
  if(!calibrating||!dragStart)return;dragEnd=point(e);
  const box={left:Math.min(dragStart.x,dragEnd.x),right:Math.max(dragStart.x,dragEnd.x),top:Math.min(dragStart.y,dragEnd.y),bottom:Math.max(dragStart.y,dragEnd.y)};
  if(box.right-box.left<12||box.bottom-box.top<3){message('籃圈框選範圍太小，請再拖曳一次。',true);dragStart=dragEnd=null;return;}
  hoop=box;calibrating=false;$('stage').classList.remove('calibrating');$('stageLabel').hidden=true;draw();controls();message('籃圈已設定。開始前，請確認鏡頭固定、籃球軌跡清楚。');
});
overlay.addEventListener('pointercancel',()=>{dragStart=dragEnd=null;draw();});
$('calibrateButton').onclick=$('liveCalibrateButton').onclick=calibrate;

async function cleanup(){
  if(running)await stop(false);
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
  video.pause();video.srcObject=null;video.removeAttribute('src');video.load();
  if(sourceUrl){URL.revokeObjectURL(sourceUrl);sourceUrl=null;}
  if(recordingUrl){URL.revokeObjectURL(recordingUrl);recordingUrl=null;}
  recordedBlob=null;$('downloadRecording').hidden=true;
  hoop=null;data=null;jobId=null;calibrating=false;dragStart=dragEnd=null;$('stage').classList.remove('calibrating');$('stageLabel').hidden=true;ctx.clearRect(0,0,overlay.width,overlay.height);$('empty').hidden=false;refresh();controls();
}
async function switchMode(next){
  if(loading)return;
  await cleanup();mode=next;
  $('fileTab').classList.toggle('active',next==='file');$('liveTab').classList.toggle('active',next==='live');
  $('fileTab').setAttribute('aria-selected',next==='file');$('liveTab').setAttribute('aria-selected',next==='live');
  $('sourceName').textContent=next==='live'?'iPhone / 相機即時練投':'選擇一段練投影片';$('sourceMeta').textContent='尚未載入';
  message(next==='live'?'開啟後置相機並框選籃圈。iPhone 需以 HTTPS 網址開啟；統計在手機內完成。':'先匯入影片，再框選橢圓形籃圈。不需要框整塊籃板。');controls();
}
$('fileTab').onclick=()=>switchMode('file');$('liveTab').onclick=()=>switchMode('live');

async function loadSample(){
  if(loading)return;await cleanup();loading=true;controls();message('正在載入資料夾影片與自動辨識結果…');
  try{
    const response=await fetch('/sample/analysis.json');if(!response.ok)throw Error('尚無測試結果，請先執行 analyze.py');
    data=await response.json();data.events.forEach(e=>{e.reviewed=false;});sessionId=`sample-${Date.now()}`;
    hoop=data.hoop;sourceKind='sample';video.src='/sample/video.mp4';video.controls=true;video.load();
    $('sourceName').textContent=data.source;refresh();message('已載入自動結果；請逐球回看並勾選確認。檔名的球數未用於判定。');
  }catch(e){message(e.message,true);}finally{loading=false;controls();}
}
$('sampleButton').onclick=loadSample;

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function pollJob(id,expected){
  for(;;){
    await sleep(700);const response=await fetch(`/api/jobs/${id}`);if(!response.ok)throw Error('無法取得影片處理進度');const job=await response.json();
    if(job.status==='error')throw Error(job.error||'影片處理失敗');
    if(job.status===expected)return job;
    $('progress').value=job.progress||0;message(job.status==='analyzing'?`逐格分析中… ${Math.round(job.progress*100)}%`:'正在本機轉成可播放格式，請稍候…');
  }
}
async function upload(file){
  loading=true;controls();$('progress').hidden=false;message('正在傳送到這台電腦轉檔…');
  try{
    const id=await new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();xhr.open('POST','/api/uploads');xhr.setRequestHeader('X-Filename',encodeURIComponent(file.name));
      xhr.upload.onprogress=e=>{if(e.lengthComputable){$('progress').value=e.loaded/e.total;message(`匯入本機電腦… ${Math.round(e.loaded/e.total*100)}%`);}};
      xhr.onerror=()=>reject(Error('影片匯入失敗，請確認本機服務仍在執行'));xhr.onload=()=>{try{const body=JSON.parse(xhr.responseText);xhr.status<300?resolve(body.id):reject(Error(body.error));}catch{reject(Error('本機服務回應異常'));}};xhr.send(file);
    });
    jobId=id;await pollJob(id,'ready');sourceKind='server';video.src=`/media/${id}/video.mp4`;video.controls=true;video.load();message('轉檔完成。請框選籃圈，再開始分析。');
  }catch(e){message(e.message,true);}finally{loading=false;$('progress').hidden=true;controls();}
}
$('fileInput').onchange=async e=>{
  const file=e.target.files[0];if(!file)return;e.target.value='';await cleanup();sourceKind='local';$('sourceName').textContent=file.name;video.controls=true;
  if(backend){await upload(file);return;}
  if(/\.m[2]?ts$/i.test(file.name)){message('MTS 需先在電腦轉成 MP4。本機服務可自動轉檔；此瀏覽器頁面請匯入 MP4 / MOV。',true);return;}
  sourceUrl=URL.createObjectURL(file);video.src=sourceUrl;video.load();message('影片已選取。請框選籃圈，再開始分析。');
};

async function startServerAnalysis(){
  loading=true;controls();$('progress').hidden=false;
  try{
    const response=await fetch(`/api/jobs/${jobId}/analyze`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hoop})});
    if(!response.ok)throw Error((await response.json()).error);await pollJob(jobId,'complete');
    const result=await fetch(`/media/${jobId}/analysis.json`);data=await result.json();sessionId=crypto.randomUUID();refresh();saveSession();message('分析完成。請逐球回看、修正並勾選確認。');
  }catch(e){message(e.message,true);}finally{loading=false;$('progress').hidden=true;controls();}
}
$('analyzeButton').onclick=()=>jobId?startServerAnalysis():start('file');

$('cameraButton').onclick=async()=>{
  if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){message('iPhone 即時相機需要有效的 HTTPS 網址。電腦 localhost 可測試；一般區網 HTTP 位址無法開啟手機相機。',true);return;}
  loading=true;controls();
  try{
    if(stream)stream.getTracks().forEach(t=>t.stop());
    stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30}}});
    hoop=null;video.srcObject=stream;video.controls=false;await video.play();resize();sourceKind='camera';$('sourceName').textContent='相機練投';message('相機已開啟。固定手機、橫放取景，再框選籃圈。');
  }catch(e){if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}message(e.name==='NotAllowedError'?'相機權限未開啟，請在 Safari 網站設定中允許相機。':`無法開啟相機：${e.message}`,true);}finally{loading=false;controls();}
};
$('startLiveButton').onclick=()=>start('live');

function beginRecording(){
  recorder=null;
  if(!$('recordToggle').checked||!window.MediaRecorder)return;
  try{
    const mime=['video/mp4;codecs=avc1.42E01E','video/mp4','video/webm;codecs=vp8','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));
    recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);const chunks=[];
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
    recorder.onstop=()=>{
      recordedBlob=new Blob(chunks,{type:recorder.mimeType});recordingUrl=URL.createObjectURL(recordedBlob);
      $('downloadRecording').href=recordingUrl;$('downloadRecording').download=`練投-${new Date().toISOString().slice(0,10)}.${recorder.mimeType.includes('mp4')?'mp4':'webm'}`;$('downloadRecording').hidden=false;
      video.srcObject=null;video.src=recordingUrl;video.controls=true;video.load();
    };
    recorder.start(1000);
  }catch(e){message(`即時計數可用，但錄影未啟動：${e.message}`,true);recorder=null;}
}
async function start(kind){
  if(running||!hoop)return;
  if(kind==='file'){
    video.pause();video.currentTime=0;video.playbackRate=1;
    if(video.seeking)await new Promise(resolve=>video.addEventListener('seeked',resolve,{once:true}));
  }
  resize();newData($('sourceName').textContent);data.hoop={...hoop};
  tracker=new ShotTracker(hoop);detector=new BallDetector(scratch.width,scratch.height,hoop);
  origin=kind==='live'?video.currentTime:0;frameTimes=[];running=true;generation++;const gen=generation;
  if(kind==='live')beginRecording();
  video.controls=false;$('runLabel').textContent=kind==='live'?'練投計數中':'逐格分析中';$('stageLabel').hidden=false;$('stageLabel').textContent='REC · 保持鏡頭固定';
  controls();message(kind==='live'?'即時計數中。請保持頁面在前景；結束後可修正每球結果。':'以影片播放速度分析中，請保持頁面開啟。');
  try{await video.play();}catch(e){await stop(false);message(`無法播放：${e.message}`,true);return;}
  let last=-1, frames=0, checkpoint=performance.now();
  const tick=(now,metadata)=>{
    if(!running||gen!==generation)return;
    const media=metadata?.mediaTime??video.currentTime,t=Math.max(0,media-origin);
    if(media!==last&&video.readyState>=2){
      if(video.videoWidth && Math.abs(video.videoWidth/video.videoHeight-scratch.width/scratch.height)>.05){stop(false);message('拍攝方向改變，請重新框選籃圈後開始。',true);return;}
      last=media;sx.drawImage(video,0,0,scratch.width,scratch.height);
      const candidates=detector.detect(sx.getImageData(0,0,scratch.width,scratch.height));
      const event=tracker.update(t,candidates);if(event){data.events=tracker.events;refresh();saveSession();}
      draw(candidates);frames++;
      if(now-checkpoint>1200){const fps=frames*1000/(now-checkpoint);$('fpsLabel').textContent=`${fps.toFixed(0)} fps${fps<15?' · 偏低，可能漏球':''}`;frames=0;checkpoint=now;}
      if(kind==='file'&&Number.isFinite(video.duration)){$('progress').hidden=false;$('progress').value=t/video.duration;}
    }
    callbackId=video.requestVideoFrameCallback?video.requestVideoFrameCallback(tick):requestAnimationFrame(tick);
  };
  callbackId=video.requestVideoFrameCallback?video.requestVideoFrameCallback(tick):requestAnimationFrame(tick);
}
async function stop(ended=false){
  if(!running)return;
  running=false;generation++;
  if(video.cancelVideoFrameCallback)video.cancelVideoFrameCallback(callbackId);else cancelAnimationFrame(callbackId);
  // An unfinished last shot stays unknown unless its make evidence is already complete.
  tracker.finish(true);data.events=tracker.events;data.duration=mode==='live'?Math.max(0,video.currentTime-origin):video.duration;
  if(mode==='live'){
    if(recorder&&recorder.state!=='inactive'){
      const stopped=new Promise(resolve=>recorder.addEventListener('stop',resolve,{once:true}));recorder.stop();await stopped;
    }
    if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
  }else video.pause();
  video.controls=true;$('stageLabel').hidden=true;$('progress').hidden=true;refresh();saveSession();controls();
  message(!data.events.length?'未偵測到投籃。請確認籃圈框選位置、球色和影像清晰度；這不代表實際出手數為零。':ended?'分析完成。請逐球回看、修正並確認結果。':'已結束。最後一球若缺少完整軌跡，會保留為待確認。');draw();
}
$('stopButton').onclick=()=>stop(false);
async function jump(e){
  if(running)await stop(false);
  if(!video.src||video.srcObject){message('這筆紀錄沒有可回看的影片。即時練投請開啟「同時錄影」。');return;}
  video.currentTime=Math.max(0,e.time-.8);await video.play().catch(()=>{});$('stage').scrollIntoView({behavior:'smooth',block:'center'});
}
$('addShot').onclick=()=>{
  if(!data)return;data.events.push({id:Math.max(0,...data.events.map(e=>e.id))+1,time:video.currentTime||0,result:'unknown',automatic_result:'manual',reason:'人工補記，請選擇結果',reviewed:false,points:[]});refresh();saveSession();
};
function download(content,name,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('exportJson').onclick=()=>download(JSON.stringify({...data,summary:stats(data.events)},null,2),'練投紀錄.json','application/json');
$('exportCsv').onclick=()=>{
  const rows=[['球號','到框時間_秒','結果','自動結果','人工確認','線索'],...data.events.map(e=>[e.id,e.time,labels[e.result],labels[e.automatic_result]||'手動補記',e.reviewed?'是':'否',e.reason])];
  download('\ufeff'+rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n'),'練投紀錄.csv','text/csv;charset=utf-8');
};
function history(){try{return JSON.parse(localStorage.getItem('basketball.sessions.v1')||'[]');}catch{return[];}}
function saveSession(){
  if(!data?.events.length)return;
  try{const old=history().filter(s=>s.id!==sessionId);old.unshift({id:sessionId,saved:new Date().toISOString(),data:{...data,summary:stats(data.events)}});localStorage.setItem('basketball.sessions.v1',JSON.stringify(old.slice(0,10)));showHistory();}catch{message('瀏覽器儲存空間不足，請匯出 JSON 保存這次紀錄。',true);}
}
function showHistory(){
  const list=history();if(!list.length)return;$('historyList').replaceChildren();
  for(const s of list){
    const b=document.createElement('button');b.className='history-item';const name=document.createElement('strong');name.textContent=s.data.source;
    const summary=document.createElement('span'),v=stats(s.data.events);summary.textContent=`${new Date(s.saved).toLocaleDateString('zh-TW')} · ${v.make} 進 / ${v.attempts_detected} 球 · ${v.unknown} 待確認`;
    b.append(name,summary);b.onclick=async()=>{if(loading)return;await cleanup();data=s.data;sessionId=s.id;hoop=data.hoop;refresh();message('已載入統計紀錄。影片不會保存在瀏覽器紀錄內，可匯出統計或重新匯入影片分析。');};$('historyList').append(b);
  }
}
window.addEventListener('pagehide',()=>{if(stream)stream.getTracks().forEach(t=>t.stop());});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&running){stop(false);message('頁面已進入背景，為避免漏算已停止本次分析。');}});
(async()=>{
  showHistory();
  if(window.SHOTBOOK_HOSTED===true){
    // GitHub Pages has no Python service. Keep camera and file inference on-device.
    await switchMode('live');
    message('固定手機後開啟後置相機，再框選籃圈。影像在這台裝置內處理；匯入影片請使用 MP4 / MOV。');
    controls();return;
  }
  try{const r=await fetch('/api/health');if(r.ok){const health=await r.json();backend=health.status==='ok';$('sampleButton').hidden=!health.sample;if(health.sample)await loadSample();}}catch{}
  controls();
})();
