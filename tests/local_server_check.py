"""Regression: duplicate local servers, stale engines and empty result display."""
from pathlib import Path
import json
import shutil
import socket
import subprocess
import sys
import time
import uuid
from urllib.request import Request,urlopen

from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
case=ROOT/'artifacts'/('local-server-check-'+uuid.uuid4().hex[:8])
case.mkdir(parents=True)
for name in ['server.py','analyze.py']:
    shutil.copy2(ROOT/name,case/name)
shutil.copytree(ROOT/'app',case/'app')
(case/'tools').mkdir()
shutil.copy2(ROOT/'tools/classify.cjs',case/'tools/classify.cjs')
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
base=f'http://127.0.0.1:{port}'
log=(case/'server.log').open('wb')
process=subprocess.Popen([sys.executable,'server.py','--port',str(port)],cwd=case,stdout=log,stderr=log)


def api(path,data=None,headers=None):
    with urlopen(Request(base+path,data=data,headers=headers or {}),timeout=30) as r:
        return json.load(r)


def wait_job(job_id,status):
    deadline=time.monotonic()+40
    while time.monotonic()<deadline:
        job=api('/api/jobs/'+job_id)
        assert job['status']!='error',job
        if job['status']==status:return
        time.sleep(.15)
    raise AssertionError('Job timed out')


def upload_and_wait(file):
    job_id=api('/api/uploads',file.read_bytes(),{'X-Filename':file.name})['id']
    wait_job(job_id,'ready')
    return job_id


def ui_analyze(page,file):
    page.locator('#fileInput').set_input_files(str(file))
    page.wait_for_function('jobId!==null && !loading && video.readyState>=2')
    page.evaluate('hoop={left:48,top:130,right:110,bottom:156};controls();')
    page.locator('#analyzeButton').click()
    page.wait_for_function("data?.analysis_state==='complete' && !loading",timeout=40000)


try:
    deadline=time.monotonic()+20
    while True:
        try:health=api('/api/health');break
        except OSError:
            assert time.monotonic()<deadline,'Server did not start'
            time.sleep(.15)
    assert health['pid']==process.pid and health['analysis_version']==2
    duplicate=subprocess.run([sys.executable,'server.py','--port',str(port)],cwd=case,capture_output=True,timeout=15)
    assert duplicate.returncode==0
    assert all(api('/api/health')['pid']==process.pid for _ in range(4))
    # Edit the isolated engine after startup. The next job must load the new code.
    engine=case/'analyze.py'
    engine.write_text(engine.read_text(encoding='utf8').replace('ANALYSIS_VERSION = 2','ANALYSIS_VERSION = 3  # isolated hot-reload fixture'),encoding='utf8')
    job_id=upload_and_wait(ROOT/'artifacts/upload-test.mp4')
    api('/api/jobs/'+job_id+'/analyze',json.dumps({'hoop':{'left':48,'top':130,'right':110,'bottom':156}}).encode(),{'Content-Type':'application/json'})
    wait_job(job_id,'complete');result=api('/media/'+job_id+'/analysis.json')
    assert result['version']==3 and result['summary']['make']==1,result
    assert api('/api/health')['analysis_version']==3
    with urlopen(base+'/app.js') as r:assert r.headers['Cache-Control']=='no-store'
    with urlopen(base+'/site.webmanifest') as r:assert r.status==200
    blank=case/'empty.mp4'
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=gray:s=960x540:r=30:d=1','-an','-c:v','libx264','-preset','ultrafast','-y',str(blank)],check=True)
    errors=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        page=browser.new_page(viewport={'width':1440,'height':1000})
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(base)
        page.wait_for_function('backend===true')
        ui_analyze(page,ROOT/'artifacts/upload-test.mp4')
        assert page.locator('#makes').inner_text()=='1'
        assert '分析完成' in page.locator('#status').inner_text()
        ui_analyze(page,blank)
        assert page.locator('#attempts').inner_text()=='0'
        assert page.locator('#resultState').inner_text()=='未偵測到投籃'
        assert '沒有辨識到投籃' in page.locator('#status').inner_text()
        assert page.locator('#reviewEmpty').is_visible()
        page.screenshot(path=str(case/'zero-results.png'),full_page=True)
        # A legacy health response must never route a new clip to an old worker.
        legacy=browser.new_page(viewport={'width':1440,'height':1000})
        legacy.on('pageerror',lambda e:errors.append(str(e)))
        legacy.route('**/api/health',lambda route:route.fulfill(json={'status':'ok','sample':False}))
        legacy.goto(base)
        legacy.wait_for_function("document.querySelector('#status').textContent.includes('舊版 v1')")
        assert legacy.evaluate('backend===false')
        posts=[];legacy.on('request',lambda r:posts.append(r.url) if r.method=='POST' else None)
        legacy.locator('#fileInput').set_input_files(str(ROOT/'artifacts/upload-test.mp4'))
        legacy.wait_for_function('video.readyState>=2')
        legacy.evaluate('hoop={left:48,top:130,right:110,bottom:156};controls();')
        legacy.locator('#analyzeButton').click()
        legacy.wait_for_function("data?.analysis_state==='complete'",timeout=15000)
        assert legacy.locator('#makes').inner_text()=='1'
        assert not posts,posts
        assert not errors,errors
        browser.close()
    report={'singleton':'passed','reload_engine_between_jobs':'passed','actual_local_result_display':'passed','zero_result_message':'passed','legacy_worker_browser_fallback':'passed','cache_control':'passed','page_errors':errors}
    (ROOT/'artifacts/local-server-check.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report),flush=True)
finally:
    process.terminate()
    try:process.wait(timeout=5)
    except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
    log.close()
