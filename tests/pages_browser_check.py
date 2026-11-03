"""Check the hosted artifact at a project subpath with no Python API."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import threading

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT/'artifacts'
preview = OUT/'pages-preview'
shutil.copytree(ROOT/'dist', preview/'basketball', dirs_exist_ok=True)
server = ThreadingHTTPServer(('127.0.0.1', 8771), partial(SimpleHTTPRequestHandler, directory=str(preview)))
threading.Thread(target=server.serve_forever, daemon=True).start()
errors, failed, requests = [], [], []


def select_hoop(page):
    page.locator('#liveCalibrateButton' if page.evaluate("mode==='live'") else '#calibrateButton').click()
    box = page.locator('#overlay').bounding_box()
    dims = page.evaluate('[overlay.width,overlay.height]')
    # The video and overlay are letterboxed together in the fixed review panel.
    image_scale=min(box['width']/dims[0],box['height']/dims[1])
    left=box['x']+(box['width']-dims[0]*image_scale)/2
    top=box['y']+(box['height']-dims[1]*image_scale)/2
    source_scale = dims[0]/960
    def point(x, y):
        return left+x*source_scale*image_scale,top+y*source_scale*image_scale
    page.mouse.move(*point(48,130))
    page.mouse.down()
    page.mouse.move(*point(110,156), steps=8)
    page.mouse.up()
    assert page.evaluate('hoop!==null && !calibrating')
    assert page.evaluate('setupEditing===true')
    for anchor,x,y in [('key-left-base',.15,.8),('key-right-base',.55,.8),('key-left-free',.15,.4),('key-right-free',.55,.4)]:
        page.locator('#courtLandmark').select_option(anchor)
        page.mouse.click(left+x*dims[0]*image_scale,top+y*dims[1]*image_scale)
    page.locator('#finishCourtCalibration').click()
    assert page.evaluate('!setupEditing && data.setup.completed')


try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
            f'--use-file-for-fake-video-capture={OUT / "camera-test.y4m"}',
        ])
        context = browser.new_context(viewport={'width':1440,'height':1000}, permissions=['camera'])
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('response', lambda r: failed.append(r.url) if r.status>=400 else None)
        page.on('request', lambda r: requests.append(r.url))
        page.goto('http://127.0.0.1:8771/basketball/')
        page.wait_for_function("document.querySelector('#liveTab').classList.contains('active')")
        page.evaluate('''()=>{
          Court.createPoseEstimator=async()=>({detect:()=>{
            const p=Array.from({length:33},()=>({x:.35,y:.4,visibility:1,presence:1}));
            for(const i of [11,12])p[i].y=.2;
            for(const i of [23,24])p[i].y=.4;
            for(const i of [25,26])p[i].y=.5;
            for(const i of [27,28,29,30,31,32])p[i].y=.6;
            p[15].y=p[16].y=.12;p[31].x=.325;p[32].x=.375;return {landmarks:[p]};
          }});
        }''')
        assert page.evaluate('backend===false')
        assert page.locator('#sampleButton').is_hidden()
        page.locator('#fileTab').click()
        page.locator('#fileInput').set_input_files(str(OUT/'upload-test.mp4'))
        page.wait_for_function('video.readyState>=2 && overlay.width===960')
        select_hoop(page)
        page.locator('#analyzeButton').click()
        page.wait_for_function('running===true')
        page.wait_for_function('!running && !loading && !positionScan', timeout=30000)
        file_counts = page.evaluate('stats(data.events)')
        assert file_counts['make']==1 and file_counts['miss']==0, file_counts
        assert page.evaluate("data.courtCalibration.pairs.length===4 && data.position_analysis.status==='complete' && data.events[0].position.method==='auto'")
        page.locator('#liveTab').click()
        page.locator('#cameraButton').click()
        page.wait_for_function('stream!==null && video.readyState>=2')
        select_hoop(page)
        page.locator('#startLiveButton').click()
        page.wait_for_function("tracker?.events.some(e=>e.result==='make' && e.time>1)",timeout=15000)
        page.locator('#stopButton').click()
        page.wait_for_function("!document.querySelector('#downloadRecording').hidden")
        page.wait_for_function('!running && !loading && !positionScan',timeout=30000)
        live_counts=page.evaluate('stats(data.events)')
        assert live_counts['make']>=1,live_counts
        assert page.evaluate('stream===null && recordedBlob.size>1000')
        assert page.evaluate("data.setup.completed && data.courtCalibration.pairs.length===4 && data.events.some(e=>e.position?.method==='auto')"),page.evaluate('({analysis:data.position_analysis,events:data.events.map(e=>({time:e.time,position:e.position,status:e.location_status})),duration:data.duration,mediaDuration:video.duration})')
        page.screenshot(path=str(OUT/'pages-desktop.png'),full_page=True)
        mobile=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
        phone=mobile.new_page()
        phone.goto('http://127.0.0.1:8771/basketball/')
        phone.wait_for_function("document.querySelector('#liveTab').classList.contains('active')")
        assert phone.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
        phone.screenshot(path=str(OUT/'pages-mobile.png'),full_page=True)
        assert not errors,errors
        assert not failed,failed
        assert not any('/api/' in u or '/sample/' in u or '/media/' in u for u in requests),requests
        report={'project_subpath':'passed','manual_calibration':'passed','native_video_analysis':file_counts,
                'simulated_camera_recording':live_counts,'api_requests':0,'failed_requests':failed,
                'page_errors':errors,'mobile_layout':'passed','real_iphone':'not tested'}
        (OUT/'pages-browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps(report,ensure_ascii=False),flush=True)
        browser.close()
finally:
    server.shutdown()
    server.server_close()
