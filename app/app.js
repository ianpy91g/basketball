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
let localEngineNotice='';
const REQUIRED_ANALYSIS_VERSION=2;
const TRAJECTORY_COLOR='#ff8c00';
const HOOP_COLOR='#003b8e';
let mapVisible=false,courtAction=null,courtPairs=[],courtAnchor=null,courtPointer=null;
let selectedShotId=null,clipPlayback=false,reviewFrame=null,reviewAction=0,reviewSeek=false,sequenceFinished=false;
let replayMode='loop';
try{const saved=localStorage.getItem('basketball.playback-mode');if(['loop','sequence','once'].includes(saved))replayMode=saved;}catch{}
$('playbackMode').value=replayMode;
const fmt=t=>`${String(Math.floor(Math.max(0,t)/60)).padStart(2,'0')}:${Math.max(0,t%60).toFixed(1).padStart(4,'0')}`;
const message=(text,error=false)=>{$('status').textContent=text;$('status').classList.toggle('error',error);};
const dateLabel=()=>new Date().toLocaleDateString('zh-TW',{month:'2-digit',day:'2-digit'});
$('sessionDate').textContent=dateLabel();

function fitWorkspace(){
  const workspace=$('workspace');
  const top=workspace.getBoundingClientRect().top+window.scrollY;
  const minimum=window.innerWidth<=800?440:window.innerHeight<600?200:320;
  workspace.style.setProperty('--workspace-height',`${Math.min(950,Math.max(minimum,window.innerHeight-top-66))}px`);
}
window.addEventListener('resize',fitWorkspace);
function selectedShot(){return data?.events.find(e=>e.id===selectedShotId)||null;}
function reviewShots(target=selectedShot()){
  return (data?.events||[]).filter(e=>e.result!=='ignored'||e.id===target?.id).slice().sort((a,b)=>a.time-b.time||a.id-b.id);
}
function clipBounds(event){
  const list=reviewShots(event),index=list.findIndex(e=>e.id===event.id),time=Math.max(0,Number(event.time)||0);
  const duration=Number.isFinite(video.duration)?video.duration:Math.max(time+1,Number(event.end)||0);
  let start=Math.max(0,Math.min(Number.isFinite(event.start)?event.start:time-1.2,time-1.2));
  let end=Math.min(duration,Math.max(Number.isFinite(event.end)?event.end:time+.8,time+.8));
  if(index>0)start=Math.max(start,(list[index-1].time+time)/2);
  if(index>=0&&index<list.length-1)end=Math.min(end,(time+list[index+1].time)/2);
  return {start:Math.max(0,Math.min(start,duration)),end:Math.min(duration,Math.max(start+.08,end))};
}
function canReview(){return !!video.src&&!video.srcObject&&video.readyState>=2&&Number.isFinite(video.duration)&&video.duration>0&&!running&&!loading;}
function updatePlaybackControls(){
  const event=selectedShot(),list=reviewShots(),index=list.findIndex(e=>e.id===event?.id),ready=canReview()&&list.length>0;
  $('previousShot').disabled=!ready||index<=0;
  $('nextShot').disabled=!ready||index>=list.length-1;
  $('togglePlayback').disabled=!ready;
  $('playbackMode').disabled=!ready;
  $('activeShotLabel').textContent=event?`第 ${event.id} 球 · ${labels[event.result]}`:list.length?'選一球開始回看':'等待分析結果';
  const bounds=event&&ready?clipBounds(event):null;
  $('clipRange').textContent=bounds?`${fmt(bounds.start)} – ${fmt(bounds.end)}`:'';
  $('togglePlayback').textContent=!video.paused?'暫停':sequenceFinished&&replayMode==='sequence'?'從頭播放':event&&bounds&&video.currentTime>=bounds.end-.06?'重播本球':'播放';
}
function revealInside(container,node,horizontal=false){
  if(!node)return;
  const c=container.getBoundingClientRect(),n=node.getBoundingClientRect();
  if(horizontal){if(n.left<c.left+5)container.scrollLeft-=c.left+5-n.left;else if(n.right>c.right-5)container.scrollLeft+=n.right-c.right+5;}
  else{if(n.top<c.top+5)container.scrollTop-=c.top+5-n.top;else if(n.bottom>c.bottom-5)container.scrollTop+=n.bottom-c.bottom+5;}
}
function updateReviewSelection(reveal=false){
  for(const node of document.querySelectorAll('[data-shot-id]')){
    const selected=String(node.dataset.shotId)===String(selectedShotId);
    node.classList.toggle('selected',selected);
    if(selected)node.setAttribute('aria-current','true');else node.removeAttribute('aria-current');
  }
  if(reveal&&selectedShotId!==null){
    revealInside($('shotRows'),$('shotRows').querySelector(`[data-shot-id="${selectedShotId}"]`));
    revealInside($('shotStrip'),$('shotStrip').querySelector(`[data-shot-id="${selectedShotId}"]`),true);
  }
  updatePlaybackControls();
  refreshCourt();
}
function cancelReviewClock(){if(reviewFrame!==null)cancelAnimationFrame(reviewFrame);reviewFrame=null;}
function clearReview(){reviewAction++;clipPlayback=false;selectedShotId=null;sequenceFinished=false;reviewSeek=false;cancelReviewClock();cancelCourtAction();}
function reviewBoundary(){
  const event=selectedShot();if(!event||!clipPlayback)return;
  const bounds=clipBounds(event);if(video.currentTime<bounds.end-.025)return;
  if(replayMode==='loop'){
    reviewSeek=true;video.currentTime=bounds.start;video.play().catch(()=>{});return;
  }
  const list=reviewShots(),index=list.findIndex(e=>e.id===event.id);
  if(replayMode==='sequence'&&index>=0&&index<list.length-1){jump(list[index+1]);return;}
  clipPlayback=false;sequenceFinished=replayMode==='sequence';video.pause();
  reviewSeek=true;video.currentTime=bounds.end;updatePlaybackControls();draw();
  if(sequenceFinished)message('已依序播放完所有投籃片段。');
}
function startReviewClock(){
  if(reviewFrame!==null||running||video.paused)return;
  const tick=()=>{
    reviewFrame=null;
    if(running||video.paused)return;
    if(!video.seeking){draw();if(clipPlayback)reviewBoundary();}
    if(!video.paused&&!running)reviewFrame=requestAnimationFrame(tick);
  };
  reviewFrame=requestAnimationFrame(tick);
}
$('playbackMode').onchange=()=>{
  replayMode=$('playbackMode').value;sequenceFinished=false;
  try{localStorage.setItem('basketball.playback-mode',replayMode);}catch{}
  if(selectedShot()){clipPlayback=true;startReviewClock();}
  updatePlaybackControls();
};
$('previousShot').onclick=()=>{const list=reviewShots(),i=list.findIndex(e=>e.id===selectedShotId);if(i>0)jump(list[i-1]);};
$('nextShot').onclick=()=>{const list=reviewShots(),i=list.findIndex(e=>e.id===selectedShotId);if(list[i+1])jump(list[i+1]);};
$('togglePlayback').onclick=()=>{
  if(!video.paused){video.pause();return;}
  if(sequenceFinished&&replayMode==='sequence'){if(reviewShots()[0])jump(reviewShots()[0]);return;}
  const event=selectedShot()||reviewShots()[0];if(!event)return;
  const bounds=clipBounds(event);
  if(!selectedShot()||video.currentTime<bounds.start||video.currentTime>=bounds.end-.06)jump(event);
  else{clipPlayback=true;video.play().catch(()=>message('請再按播放以開始回看。',true));}
};

function stats(events){
  const count=result=>events.filter(e=>e.result===result).length;
  const make=count('make'),miss=count('miss'),unknown=count('unknown');
  return {attempts_detected:make+miss+unknown,make,miss,unknown,resolved_accuracy:make+miss?make/(make+miss)*100:null};
}
function refresh(full=true){
  const events=data?.events||[], s=stats(events);
  document.body.classList.toggle('has-shots',events.length>0);
  for(const [id,value] of Object.entries({attempts:s.attempts_detected,makes:s.make,misses:s.miss,unknowns:s.unknown}))$(id).textContent=value;
  $('accuracy').textContent=s.resolved_accuracy===null?'—':s.resolved_accuracy.toFixed(1);
  $('accuracyBar').style.width=`${s.resolved_accuracy||0}%`;
  const reviewed=events.filter(e=>e.reviewed&&e.result!=='ignored').length;
  $('reviewCount').textContent=events.length?`${reviewed} / ${s.attempts_detected} 球已確認`:'尚無紀錄';
  const finished=data?.analysis_state==='complete'||data?.analysis_state==='stopped';
  $('resultState').textContent=events.length?(reviewed===s.attempts_detected?'已人工確認':'自動結果 · 待複核'):finished?'未偵測到投籃':'等待紀錄';
  $('exportCsv').disabled=$('exportJson').disabled=!events.length;
  $('addShot').disabled=!data||running||loading;
  $('reviewEmpty').hidden=!!events.length;
  $('reviewEmpty').textContent=finished?'本次未辨識到投籃。請重新確認籃圈框選位置，再分析一次。':'你的第一份練投紀錄，會出現在這裡。';
  $('summaryBrief').textContent=events.length?`${s.attempts_detected} 筆紀錄 · 需要時展開`:'需要時再展開查看';
  if(selectedShotId!==null&&!selectedShot()){selectedShotId=null;clipPlayback=false;}
  if(!full){updatePlaybackControls();refreshCourt();return;}
  const listScroll=$('shotRows').scrollTop,stripScroll=$('shotStrip').scrollLeft;
  $('shotStrip').replaceChildren();$('shotRows').replaceChildren();
  if(!events.length){const p=document.createElement('p');p.textContent=finished?'沒有辨識到投籃；這不代表實際出手數為零。':'分析完成後，點選球號跳至該次投籃。';$('shotStrip').append(p);}
  for(const e of events){
    const chip=document.createElement('button');chip.className=`shot-chip ${e.result}`;chip.dataset.shotId=e.id;chip.textContent=e.id;chip.title=`第 ${e.id} 球 ${fmt(e.time)} ${labels[e.result]}`;chip.onclick=()=>jump(e);$('shotStrip').append(chip);
    const card=document.createElement('article');card.className=`shot-card ${e.result}`;card.dataset.shotId=e.id;card.setAttribute('role','listitem');
    const top=document.createElement('div');top.className='shot-card-top';
    const link=document.createElement('button');link.className='shot-open';link.setAttribute('aria-label',`回看第 ${e.id} 球`);link.onclick=()=>jump(e);
    const num=document.createElement('span');num.className='shot-number';num.textContent=String(e.id).padStart(2,'0');
    const time=document.createElement('span');time.className='shot-time';time.textContent=fmt(e.time);link.append(num,time);
    const select=document.createElement('select');select.className=`result-select ${e.result}`;select.setAttribute('aria-label',`第 ${e.id} 球結果`);
    for(const [v,label] of Object.entries(labels)){const o=document.createElement('option');o.value=v;o.textContent=label;select.append(o);}select.value=e.result;
    select.onchange=()=>{e.result=select.value;e.reviewed=true;refresh();saveSession();};top.append(link,select);
    const bottom=document.createElement('div');bottom.className='shot-card-bottom';
    const reason=document.createElement('p');reason.className='reason-cell';reason.textContent=e.result!==e.automatic_result?`人工修正；原判定：${labels[e.automatic_result]||'手動補記'}`:e.reason;
    const review=document.createElement('label');review.className='review-check';const box=document.createElement('input');box.type='checkbox';box.className='review-box';box.checked=e.reviewed;box.setAttribute('aria-label',`確認第 ${e.id} 球`);box.onchange=()=>{e.reviewed=box.checked;refresh(false);saveSession();};review.append(box,document.createTextNode('已確認'));
    bottom.append(reason,review);card.append(top,bottom);card.onclick=event=>{if(!event.target.closest('button,select,input,label,a'))jump(e);};$('shotRows').append(card);
  }
  $('shotRows').scrollTop=listScroll;$('shotStrip').scrollLeft=stripScroll;updateReviewSelection();requestAnimationFrame(fitWorkspace);
}
function showOutcome(completed){
  if(!data?.events.length){
    message('分析已結束，但沒有辨識到投籃。請只框住橢圓形籃圈，確認球清楚可見後重試；實際出手數不能據此當成零。',true);
    return;
  }
  const s=stats(data.events);
  message(`${completed?'分析完成':'已結束'}：${s.attempts_detected} 次，${s.make} 進、${s.miss} 未進、${s.unknown} 待確認。請逐球回看與複核。`);
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
  updatePlaybackControls();requestAnimationFrame(fitWorkspace);
  refreshCourt();
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
video.addEventListener('loadeddata',()=>{updatePlaybackControls();refreshCourt();});
video.addEventListener('timeupdate',()=>{if(!running){draw();if(clipPlayback&&!video.paused&&!video.seeking)reviewBoundary();}});
video.addEventListener('play',()=>{updatePlaybackControls();if(!running)startReviewClock();});
video.addEventListener('pause',()=>{cancelReviewClock();updatePlaybackControls();});
video.addEventListener('seeking',()=>{
  if(!running&&clipPlayback&&!reviewSeek&&selectedShot()){
    const bounds=clipBounds(selectedShot());
    if(video.currentTime<bounds.start-.08||video.currentTime>bounds.end+.08){clipPlayback=false;selectedShotId=null;sequenceFinished=false;updateReviewSelection();}
  }
});
video.addEventListener('seeked',()=>{reviewSeek=false;if(!running){draw();updatePlaybackControls();refreshCourt();startReviewClock();}});
video.addEventListener('ended',async()=>{if(running)await stop(true);else if(clipPlayback)reviewBoundary();});
video.addEventListener('error',()=>{if(sourceKind==='local')message('此瀏覽器無法播放這個格式。MTS 請用本機服務匯入轉檔；iPhone 建議使用 MP4 / MOV。',true);});

function draw(candidates=[]){
  ctx.clearRect(0,0,overlay.width,overlay.height);
  const box=calibrating&&dragStart&&dragEnd?{left:Math.min(dragStart.x,dragEnd.x),right:Math.max(dragStart.x,dragEnd.x),top:Math.min(dragStart.y,dragEnd.y),bottom:Math.max(dragStart.y,dragEnd.y)}:hoop;
  if(box){ctx.strokeStyle=HOOP_COLOR;ctx.lineWidth=2;ctx.setLineDash([6,4]);ctx.strokeRect(box.left,box.top,box.right-box.left,box.bottom-box.top);ctx.setLineDash([]);}
  const t=mode==='live'&&stream?Math.max(0,video.currentTime-origin):video.currentTime;
  const current=running?tracker?.active?.points:(selectedShot()||(data?.events||[]).find(e=>t>=e.start&&t<=e.end))?.points;
  if(current){
    const pts=current.filter(p=>p.t<=t&&(video.paused||p.t>=t-.9));ctx.save();ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();
    pts.forEach((p,i)=>i&&p.t-pts[i-1].t<.2?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));
    ctx.strokeStyle=TRAJECTORY_COLOR;ctx.lineWidth=4;ctx.stroke();
    if(pts.length){const p=pts[pts.length-1];ctx.beginPath();ctx.arc(p.x,p.y,4,0,Math.PI*2);ctx.fillStyle=TRAJECTORY_COLOR;ctx.fill();}ctx.restore();
  }
  for(const p of candidates){ctx.save();ctx.strokeStyle=TRAJECTORY_COLOR;ctx.lineWidth=2.5;ctx.beginPath();ctx.arc(p.x,p.y,Math.sqrt(p.area/Math.PI),0,Math.PI*2);ctx.stroke();ctx.restore();}
  drawCourtOverlay();
}
function calibrate(){
  if(running||!video.videoWidth)return;
  cancelCourtAction();refreshCourt();
  if(mode==='file')video.pause();
  calibrating=true;dragStart=dragEnd=null;$('stage').classList.add('calibrating');$('stageLabel').hidden=false;$('stageLabel').textContent='拖曳框選橢圓形籃圈，不含籃板與籃網';
  message('在畫面上拖曳，框住橢圓形籃圈；重新拍攝或移動手機後，請重新框選。');
}
function point(e){
  const r=overlay.getBoundingClientRect(),scale=Math.min(r.width/overlay.width,r.height/overlay.height);
  const left=r.left+(r.width-overlay.width*scale)/2,top=r.top+(r.height-overlay.height*scale)/2;
  return{x:Math.max(0,Math.min(overlay.width,(e.clientX-left)/scale)),y:Math.max(0,Math.min(overlay.height,(e.clientY-top)/scale))};
}
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
  clearReview();
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
  if(/\.m[2]?ts$/i.test(file.name)){message(localEngineNotice?'偵測到舊版本機服務。MTS 轉檔需要關閉原本 start.cmd 視窗後重新啟動，或先轉成 MP4 再匯入。':'MTS 需先在電腦轉成 MP4。本機服務可自動轉檔；此瀏覽器頁面請匯入 MP4 / MOV。',true);return;}
  sourceUrl=URL.createObjectURL(file);video.src=sourceUrl;video.load();message(`${localEngineNotice?'目前改用新版瀏覽器引擎分析。':'影片已選取。'}請框選籃圈，再開始分析。`);
};

async function startServerAnalysis(){
  clearReview();video.pause();
  loading=true;controls();$('progress').hidden=false;
  try{
    const response=await fetch(`/api/jobs/${jobId}/analyze`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hoop})});
    if(!response.ok)throw Error((await response.json()).error);await pollJob(jobId,'complete');
    const result=await fetch(`/media/${jobId}/analysis.json`,{cache:'no-store'});
    if(!result.ok)throw Error('無法載入分析結果，請重新匯入影片後再分析。');
    const analyzed=await result.json();
    if(!Array.isArray(analyzed.events))throw Error('本機回傳的分析結果不完整，請重新啟動 start.cmd。');
    if(Number(analyzed.version||1)<REQUIRED_ANALYSIS_VERSION)throw Error('這次結果仍來自舊版 v1 引擎。請關閉原本 start.cmd 視窗後重新啟動，再匯入影片。');
    data={...analyzed,analysis_state:'complete'};sessionId=crypto.randomUUID();refresh();saveSession();showOutcome(true);
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
  clearReview();
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
  tracker.finish(true);data.events=tracker.events;data.analysis_state=ended?'complete':'stopped';data.duration=mode==='live'?Math.max(0,video.currentTime-origin):video.duration;
  if(mode==='live'){
    if(recorder&&recorder.state!=='inactive'){
      const stopped=new Promise(resolve=>recorder.addEventListener('stop',resolve,{once:true}));recorder.stop();await stopped;
    }
    if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
  }else video.pause();
  video.controls=true;$('stageLabel').hidden=true;$('progress').hidden=true;refresh();saveSession();controls();
  showOutcome(ended);draw();
}
$('stopButton').onclick=()=>stop(false);
async function jump(e){
  if(running||loading){message('請先完成或結束分析，再選球回看。');return;}
  if(!canReview()){message('這筆紀錄沒有可回看的影片。即時練投請開啟「同時錄影」。');return;}
  cancelCourtAction();const action=++reviewAction;cancelReviewClock();video.pause();selectedShotId=e.id;clipPlayback=true;sequenceFinished=false;
  const bounds=clipBounds(e);reviewSeek=true;video.currentTime=bounds.start;
  updateReviewSelection(true);draw();
  message(`第 ${e.id} 球片段 · ${{loop:'單球循環',sequence:'依序播放',once:'單球一次'}[replayMode]}。可直接選擇另一球回看。`);
  try{await video.play();if(action===reviewAction)startReviewClock();}
  catch(error){if(action===reviewAction&&error.name!=='AbortError'){updatePlaybackControls();message('請按播放以回看這一球。');}}
}
$('addShot').onclick=()=>{
  if(!data)return;data.events.push({id:Math.max(0,...data.events.map(e=>e.id))+1,time:video.currentTime||0,result:'unknown',automatic_result:'manual',reason:'人工補記，請選擇結果',reviewed:false,points:[]});refresh();saveSession();
};
function download(content,name,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('exportJson').onclick=()=>download(JSON.stringify({...data,summary:stats(data.events)},null,2),'練投紀錄.json','application/json');
$('exportCsv').onclick=()=>{
  const rows=[['球號','到框時間_秒','結果','自動結果','人工確認','線索','位置X_參考公尺_球場中央左右','位置Y_參考公尺_距底線','位置來源','定位影格_秒'],...data.events.map(e=>[e.id,e.time,labels[e.result],labels[e.automatic_result]||'手動補記',e.reviewed?'是':'否',e.reason,Court.inCourt(e.position)?e.position.x:'',Court.inCourt(e.position)?e.position.y:'',e.position?.method==='video'?'人工影片定位':e.position?.method==='map'?'人工圖上估計':'',e.position?.video_time??''])];
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

// The court map shares the review workspace; changing views never scrolls the page.
function setReviewView(showMap){
  mapVisible=showMap;
  if(!showMap)cancelCourtAction();
  $('reviewListTab').setAttribute('aria-selected',String(!showMap));
  $('reviewMapTab').setAttribute('aria-selected',String(showMap));
  $('courtPanel').hidden=!showMap;$('shotRows').hidden=showMap;$('shotStrip').hidden=showMap;
  $('reviewEmpty').hidden=showMap||!!data?.events.length;
  refreshCourt();draw();requestAnimationFrame(fitWorkspace);
}
$('reviewListTab').onclick=()=>setReviewView(false);
$('reviewMapTab').onclick=()=>setReviewView(true);
function cancelCourtAction(){
  courtAction=null;courtPairs=[];courtAnchor=null;courtPointer=null;
  $('stage').classList.remove('mapping');
  if(!calibrating&&!running)$('stageLabel').hidden=true;
}
function normalizedImagePoint(e){
  const r=overlay.getBoundingClientRect(),scale=Math.min(r.width/overlay.width,r.height/overlay.height);
  const x=(e.clientX-r.left-(r.width-overlay.width*scale)/2)/(overlay.width*scale);
  const y=(e.clientY-r.top-(r.height-overlay.height*scale)/2)/(overlay.height*scale);
  return Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&x<=1&&y>=0&&y<=1?{x,y}:null;
}
function courtSvgPoint(e){
  const svg=$('courtGraphic').querySelector('svg'),matrix=svg?.getScreenCTM();
  if(!matrix)return null;
  const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse());
  return Court.inCourt(p)?{x:p.x,y:p.y}:null;
}
function prepareLocation(event){
  cancelCourtAction();cancelReviewClock();reviewAction++;clipPlayback=false;sequenceFinished=false;
  selectedShotId=event.id;video.pause();
  if(canReview()){
    reviewSeek=true;video.currentTime=Math.min(video.duration,Math.max(0,event.position?.video_time??event.time-1.6));
  }
  updateReviewSelection();draw();
}
function roundedPosition(p,extra){return {...extra,x:+p.x.toFixed(3),y:+p.y.toFixed(3)};}
function placeShot(p,method,image=null){
  const event=selectedShot();if(!event||!Court.inCourt(p)||running||loading)return;
  event.position=roundedPosition(p,{method,...(image?{video_point:image,video_time:+video.currentTime.toFixed(3)}:{})});
  cancelCourtAction();refresh();saveSession();draw();
  message(`第 ${event.id} 球位置已儲存 · ${labels[event.result]}。${method==='map'?'這是人工在球場圖上估計的位置。':'位置由人工腳下標記與球場校正換算。'}`);
}
function chooseCourtAnchor(id){
  const anchor=Court.anchors.find(a=>a.id===id);if(!anchor||courtPairs.some(p=>p.anchor===id))return;
  courtAnchor=anchor;refreshCourt();
}
function finishCourtPair(image){
  if(!courtAnchor)return;
  courtPairs.push({anchor:courtAnchor.id,image,court:{x:courtAnchor.x,y:courtAnchor.y}});courtAnchor=null;
  if(courtPairs.length===4){
    try{
      const matrix=Court.calibrate(courtPairs);
      data.courtCalibration={version:1,template:'fiba-2024',matrix,pairs:courtPairs,width:overlay.width,height:overlay.height};
      let invalid=0;
      for(const event of data.events){
        if(event.position?.method!=='video'||!event.position.video_point)continue;
        const p=Court.project(matrix,event.position.video_point);
        if(Court.inCourt(p))event.position=roundedPosition(p,event.position);
        else{event.position={...event.position,x:null,y:null};invalid++;}
      }
      cancelCourtAction();saveSession();refreshCourt();draw();
      message(`球場校正完成。請選球並點選出手前的腳下位置。${invalid?`另有 ${invalid} 球換算後超出半場，請重新標記。`:''}`);
      return;
    }catch(error){courtPairs.pop();message(error.message,true);}
  }
  refreshCourt();draw();
}
function renderCourt(){
  const arcY=1.575+Math.sqrt(6.75**2-6.6**2);
  $('courtGraphic').innerHTML=`<svg viewBox="-8 -.5 16 15" role="group" aria-label="投籃位置半場圖，籃框在上方">
    <defs><clipPath id="courtClip"><rect x="-7.5" y="0" width="15" height="14"/></clipPath></defs>
    <rect class="court-floor" x="-7.5" y="0" width="15" height="14"/>
    <g class="court-lines" clip-path="url(#courtClip)"><rect class="court-key" x="-2.45" y="0" width="4.9" height="5.8"/>
    <circle cx="0" cy="5.8" r="1.8"/><circle cx="0" cy="14" r="1.8"/>
    <path d="M -6.6 0 V ${arcY} A 6.75 6.75 0 0 0 6.6 ${arcY} V 0"/>
    <path d="M -1.3 1.575 A 1.3 1.3 0 0 0 1.3 1.575 M -1.3 1.575 V 1.2 M 1.3 1.575 V 1.2"/>
    <path class="court-backboard" d="M -.9 1.2 H .9"/><circle class="court-rim" cx="0" cy="1.575" r=".225"/>
    <rect x="-7.5" y="0" width="15" height="14"/></g>
    <text class="court-caption" x="0" y="-.15">底線 · 籃框方向</text><g id="courtMarks"></g><g id="courtAnchors"></g></svg>`;
  const ns='http://www.w3.org/2000/svg';
  const node=(name,attrs,parent,text)=>{const el=document.createElementNS(ns,name);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));if(text!==undefined)el.textContent=text;parent.append(el);return el;};
  for(const event of data?.events||[]){
    if(event.result==='ignored'||!Court.inCourt(event.position))continue;
    const p=event.position,g=node('g',{class:`court-mark ${event.result}${event.id===selectedShotId?' selected':''}`,transform:`translate(${p.x} ${p.y})`,tabindex:0,role:'button','aria-label':`第 ${event.id} 球 ${labels[event.result]}`, 'data-map-shot':event.id},$('courtMarks'));
    node('title',{},g,`第 ${event.id} 球 · ${labels[event.result]} · ${event.position.method==='video'?'影片人工定位':'圖上人工估計'}`);
    node('circle',{r:.42,class:'court-hit'},g);
    if(event.id===selectedShotId)node('circle',{r:.34,class:'court-selected-ring'},g);
    if(event.result==='make')node('circle',{r:.16,class:'court-symbol'},g);
    else if(event.result==='miss')node('path',{d:'M -.17 -.17 L .17 .17 M -.17 .17 L .17 -.17',class:'court-symbol'},g);
    else node('path',{d:'M 0 -.22 L .2 0 L 0 .22 L -.2 0 Z',class:'court-symbol'},g);
    if(event.id===selectedShotId)node('text',{x:.36,y:-.27,class:'court-shot-number'},g,event.id);
  }
  if(courtAction==='calibrate')for(const [i,a] of Court.anchors.entries()){
    const used=courtPairs.some(p=>p.anchor===a.id);
    const g=node('g',{class:`court-anchor${used?' used':''}${courtAnchor?.id===a.id?' active':''}`,transform:`translate(${a.x} ${a.y})`,'data-anchor':a.id,tabindex:used?-1:0,role:'button','aria-label':`${i+1} ${a.label}${used?' 已設定':''}`},$('courtAnchors'));
    node('title',{},g,`${i+1} ${a.label}`);node('circle',{r:.32},g);node('text',{y:.12},g,i+1);
  }
}
function refreshCourt(){
  const events=(data?.events||[]).filter(e=>e.result!=='ignored'),event=selectedShot(),busy=running||loading;
  const located=events.filter(e=>Court.inCourt(e.position));
  $('reviewEmpty').hidden=mapVisible||!!data?.events.length;
  $('mapProgress').textContent=`${located.length} / ${events.length} 球已定位`;
  const picker=$('mapShot');picker.replaceChildren();
  const empty=document.createElement('option');empty.value='';empty.textContent=events.length?'請選一球':'尚無投籃紀錄';picker.append(empty);
  for(const e of events){const o=document.createElement('option');o.value=String(e.id);o.textContent=`第 ${e.id} 球 · ${labels[e.result]}${Court.inCourt(e.position)?' · 已定位':''}`;picker.append(o);}
  picker.value=event?String(event.id):'';picker.disabled=busy||!events.length;
  const valid=event&&event.result!=='ignored'&&!busy;
  $('markMapPosition').disabled=!valid;
  $('markVideoPosition').disabled=!valid||!canReview()||!data?.courtCalibration;
  $('removePosition').disabled=!valid||!event.position;
  $('calibrateCourt').disabled=busy||!data||!canReview();
  $('locationBack').disabled=$('locationForward').disabled=!valid||!canReview();
  $('locationInfo').textContent=!event?'選擇球號後，標記出手前雙腳著地的位置。':Court.inCourt(event.position)?`第 ${event.id} 球：${event.position.method==='video'?'影片人工定位':'圖上人工估計'} · ${labels[event.result]} · ${Court.zone(event.position)}`:event.position?.method==='video'?'此球換算後超出半場，請檢查校正或重新標記。':`第 ${event.id} 球尚未定位。可用影片腳下位置換算，或直接在球場圖估計。`;
  $('undoCourtPoint').hidden=courtAction!=='calibrate';$('undoCourtPoint').disabled=!courtPairs.length&&!courtAnchor;
  $('cancelCourtAction').hidden=!courtAction;
  $('courtLandmark').hidden=courtAction!=='calibrate';
  if(courtAction==='calibrate'){
    $('courtLandmark').replaceChildren();const prompt=document.createElement('option');prompt.value='';prompt.textContent='選擇圖上地標，再點影片同一位置';$('courtLandmark').append(prompt);
    Court.anchors.forEach((a,i)=>{const o=document.createElement('option');o.value=a.id;o.textContent=`${i+1} · ${a.label}`;o.disabled=courtPairs.some(p=>p.anchor===a.id);$('courtLandmark').append(o);});
    $('courtLandmark').value=courtAnchor?.id||'';
  }
  let help=data?.courtCalibration?'已校正地面。鏡頭移動後請重新校正；位置為人工估計，非精密測量。':'以 FIBA 矩形禁區為參考。舊式梯形禁區或地面線看不清時，可直接在圖上標記大約位置。';
  if(courtAction==='calibrate')help=`已配對 ${courtPairs.length} / 4 點。${courtAnchor?`請點影片上的「${courtAnchor.label}」。`:'先選球場圖的編號地標，再點影片同一地面位置。'}圖上左右為準；四點須分散，不可三點共線。不要選籃板。`;
  if(courtAction==='video')help=`請將第 ${event?.id} 球移到起跳前的影格，點選雙腳之間的地面位置。可拖曳影片進度或用 ±0.1 秒微調。`;
  if(courtAction==='map')help=`請點球場圖，儲存第 ${event?.id} 球的大約出手位置。`;
  $('courtHelp').textContent=help;
  $('stage').classList.toggle('mapping',courtAction==='calibrate'||courtAction==='video');
  if(courtAction==='calibrate'||courtAction==='video'){
    $('stageLabel').hidden=false;$('stageLabel').textContent=courtAction==='video'?'點選起跳前，雙腳之間的地面':courtAnchor?`點選地面：${courtAnchor.label}`:'先在右側球場圖選擇地標';
  }
  $('courtGraphic').classList.toggle('placing',courtAction==='map');
  renderCourt();$('courtZones').replaceChildren();
  for(const z of Court.summarize(events)){
    const row=document.createElement('div');row.className='zone-row';
    const name=document.createElement('span');name.textContent=z.name;
    const detail=document.createElement('span');detail.textContent=z.total?`${z.makes} 進 / ${z.makes+z.misses} 判定${z.unknown?` · ${z.unknown} 待確認`:''}`:'尚無紀錄';
    const accuracy=document.createElement('strong');accuracy.textContent=z.accuracy===null?'—':`${Math.round(z.accuracy)}%`;row.append(name,detail,accuracy);$('courtZones').append(row);
  }
}
$('mapShot').onchange=()=>{const event=data?.events.find(e=>String(e.id)===$('mapShot').value);if(event)prepareLocation(event);};
$('calibrateCourt').onclick=()=>{
  if(!data||!canReview())return;
  cancelCourtAction();calibrating=false;dragStart=dragEnd=null;$('stage').classList.remove('calibrating');
  video.pause();clipPlayback=false;courtAction='calibrate';refreshCourt();draw();
  message('選四個地面對應點。建議使用矩形禁區四個角；看不清的點請不要猜。球場線與示意圖不同時，可直接在圖上標記。');
};
$('courtLandmark').onchange=()=>chooseCourtAnchor($('courtLandmark').value);
$('undoCourtPoint').onclick=()=>{if(courtAnchor)courtAnchor=null;else courtPairs.pop();refreshCourt();draw();};
$('cancelCourtAction').onclick=()=>{cancelCourtAction();refreshCourt();draw();};
$('markVideoPosition').onclick=()=>{
  if(!selectedShot()||!canReview()||!data?.courtCalibration)return;
  cancelCourtAction();calibrating=false;$('stage').classList.remove('calibrating');video.pause();clipPlayback=false;courtAction='video';refreshCourt();draw();
};
$('markMapPosition').onclick=()=>{
  if(!selectedShot()||running||loading)return;
  cancelCourtAction();calibrating=false;$('stage').classList.remove('calibrating');video.pause();clipPlayback=false;courtAction='map';refreshCourt();draw();
  revealInside($('courtPanel'),$('courtGraphic'));
};
$('removePosition').onclick=()=>{const event=selectedShot();if(!event)return;delete event.position;cancelCourtAction();refresh();saveSession();draw();};
function stepLocation(delta){if(!canReview())return;video.pause();clipPlayback=false;reviewSeek=true;video.currentTime=Math.max(0,Math.min(video.duration,video.currentTime+delta));}
$('locationBack').onclick=()=>stepLocation(-.1);$('locationForward').onclick=()=>stepLocation(.1);
function courtClick(e){
  if(running||loading)return;
  if(courtAction==='map'){const p=courtSvgPoint(e);if(p)placeShot(p,'map');return;}
  if(courtAction==='calibrate'){const anchor=e.target.closest('[data-anchor]');if(anchor)chooseCourtAnchor(anchor.dataset.anchor);return;}
  const mark=e.target.closest('[data-map-shot]');if(mark){const event=data?.events.find(s=>String(s.id)===mark.dataset.mapShot);if(event)jump(event);}
}
$('courtGraphic').addEventListener('click',courtClick);
$('courtGraphic').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();courtClick(e);}});
overlay.addEventListener('pointerdown',e=>{
  if(!['calibrate','video'].includes(courtAction))return;
  courtPointer=normalizedImagePoint(e);if(courtPointer)overlay.setPointerCapture(e.pointerId);
});
overlay.addEventListener('pointerup',e=>{
  const down=courtPointer;courtPointer=null;if(!down||!['calibrate','video'].includes(courtAction)||running||loading)return;
  const p=normalizedImagePoint(e);if(!p||Math.hypot(p.x-down.x,p.y-down.y)>.025)return;
  video.pause();
  if(courtAction==='calibrate'){finishCourtPair(p);return;}
  const position=Court.project(data.courtCalibration.matrix,p);
  if(!Court.inCourt(position)){message('此點換算後超出半場。請確認點在地板上，或重新校正球場；也可直接在圖上標記。',true);return;}
  placeShot(position,'video',p);
});
overlay.addEventListener('pointercancel',()=>{courtPointer=null;});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&courtAction){cancelCourtAction();refreshCourt();draw();}});
function drawCourtOverlay(){
  if(!mapVisible)return;
  const pairs=courtAction==='calibrate'?courtPairs:[];
  ctx.save();ctx.font='bold 12px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
  for(const [i,pair] of pairs.entries()){
    const x=pair.image.x*overlay.width,y=pair.image.y*overlay.height;
    ctx.fillStyle=HOOP_COLOR;ctx.beginPath();ctx.arc(x,y,8,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.fillText(String(i+1),x,y);
  }
  const event=selectedShot(),p=event?.position;
  if(p?.method==='video'&&p.video_point&&Math.abs(video.currentTime-p.video_time)<.25){
    const x=p.video_point.x*overlay.width,y=p.video_point.y*overlay.height;
    ctx.strokeStyle=HOOP_COLOR;ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x-8,y);ctx.lineTo(x+8,y);ctx.moveTo(x,y-8);ctx.lineTo(x,y+8);ctx.stroke();
  }
  ctx.restore();
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
  try{
    const r=await fetch('/api/health',{cache:'no-store'});
    if(r.ok){
      const health=await r.json();
      backend=health.status==='ok'&&Number(health.analysis_version||1)>=REQUIRED_ANALYSIS_VERSION;
      $('sampleButton').hidden=!health.sample;
      if(health.sample)await loadSample();
      const label=document.querySelector('.local-label'),dot=document.createElement('i');
      if(backend){label.replaceChildren(dot,document.createTextNode(`本機分析引擎 v${health.analysis_version} · 影像留在這台電腦`));}
      else if(health.status==='ok'){
        localEngineNotice='本機仍是舊版 v1 服務。請關閉原本 start.cmd 視窗後重新啟動；MP4 / MOV 暫時改由新版瀏覽器引擎分析。';
        label.replaceChildren(dot,document.createTextNode('舊版本機服務 · 已切換瀏覽器分析'));
        message(localEngineNotice,true);
      }
    }
  }catch{}
  controls();
})();
