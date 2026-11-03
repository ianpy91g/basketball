"""Set up hoop and court before analysis; one action runs counting then positioning.

The counting engine processes the real short video. Pose outputs are controlled fixtures.
"""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts'
BASE='http://127.0.0.1:8772'

def drag_hoop(page,box=(48,130,110,156)):
    page.locator('#setupHoop').click()
    r=page.locator('#overlay').bounding_box();w,h=page.evaluate('[overlay.width,overlay.height]')
    scale=min(r['width']/w,r['height']/h)
    def point(x,y):return (r['x']+(r['width']-w*scale)/2+x*scale,r['y']+(r['height']-h*scale)/2+y*scale)
    page.mouse.move(*point(*box[:2]));page.mouse.down();page.mouse.move(*point(*box[2:]),steps=5);page.mouse.up()
    assert page.evaluate('!calibrating && !!hoop')

def pair(page,anchor,x,y):
    page.locator('#courtLandmark').select_option(anchor)
    r=page.locator('#overlay').bounding_box();w,h=page.evaluate('[overlay.width,overlay.height]')
    scale=min(r['width']/w,r['height']/h)
    page.mouse.click(r['x']+(r['width']-w*scale)/2+x*w*scale,r['y']+(r['height']-h*scale)/2+y*h*scale)

def load_video(page):
    page.locator('#fileInput').set_input_files(str(OUT/'upload-test.mp4'))
    page.wait_for_function('jobId && video.readyState>=2 && !loading')
    assert page.evaluate("data.events.length===0 && data.analysis_state==='ready' && !setupReady()")
    assert page.locator('#analyzeButton').is_disabled()
    assert page.locator('#calibrateCourt').is_enabled()

def wait_analysis(page):
    page.wait_for_function("data?.analysis_state==='complete' && !loading && !positionScan && !running",timeout=45000)
    assert page.evaluate('data.events.length===1 && data.events[0].result===\'make\'')

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1440,'height':1000})
    errors=[];posts=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.on('request',lambda r:posts.append(r.url) if r.method=='POST' and r.url.endswith('/analyze') else None)
    page.goto(BASE);page.wait_for_function('backend===true && !loading')
    page.evaluate('''()=>{
      window.poseCalls=0;
      Court.createPoseEstimator=async()=>({detect:()=>{
        poseCalls++;const p=Array.from({length:33},()=>({x:.35,y:.4,visibility:1,presence:1}));
        for(const i of [11,12])p[i].y=.2;
        for(const i of [23,24])p[i].y=.4;
        for(const i of [25,26])p[i].y=.5;
        for(const i of [27,28,29,30,31,32])p[i].y=.6;
        p[15].y=p[16].y=.12;p[31].x=.325;p[32].x=.375;
        return {landmarks:[p]};
      }});
    }''')
    load_video(page)
    page.locator('#calibrateButton').click()
    assert page.locator('#sceneSetup').is_visible()
    assert page.evaluate('data.events.length===0 && setupEditing')
    drag_hoop(page)
    assert page.locator('#analyzeButton').is_disabled()
    for anchor,x,y in [('key-left-base',.15,.8),('key-right-base',.55,.8),('key-left-free',.15,.4),('key-right-free',.55,.4)]:pair(page,anchor,x,y)
    assert page.evaluate('courtPairs.length===4 && data.events.length===0 && poseCalls===0')
    assert not posts,posts
    page.locator('#finishCourtCalibration').click()
    assert page.evaluate('setupReady() && !setupEditing && data.courtCalibration.pairs.length===4 && poseCalls===0')
    assert page.locator('#analyzeButton').is_enabled()
    # Cancelled edits restore the entire scene, including hoop, profile and court points.
    original=page.evaluate('JSON.stringify(sceneConfiguration())')
    page.locator('#calibrateButton').click();drag_hoop(page,(60,130,125,156))
    page.locator('#clearCourtPoints').click();page.locator('#relativeCourt').check()
    assert page.locator('#analyzeButton').is_disabled()
    page.locator('#cancelCourtAction').click()
    assert page.evaluate('JSON.stringify(sceneConfiguration())')==original
    page.locator('#analyzeButton').click();wait_analysis(page)
    assert len(posts)==1
    assert page.evaluate("data.setup.completed && data.courtCalibration.pairs.length===4 && data.events[0].position.method==='auto' && Court.inCourt(data.events[0].position)")
    assert page.evaluate("data.position_analysis.status==='complete' && poseCalls>0")
    assert '已定位' in page.locator('#status').inner_text()
    page.screenshot(path=str(OUT/'setup-workflow-result.png'),full_page=True)
    # A new source invalidates completed settings. Court points can be skipped explicitly.
    calls=page.evaluate('poseCalls');load_video(page)
    page.locator('#calibrateButton').click();drag_hoop(page)
    assert page.evaluate('courtPairs.length===0')
    page.locator('#finishCourtCalibration').click()
    assert page.evaluate('setupReady() && !data.courtCalibration')
    page.locator('#analyzeButton').click();wait_analysis(page)
    assert page.evaluate("data.position_analysis.status==='pending' && !data.events[0].position && !data.setup.position_ready")
    assert page.evaluate('poseCalls')==calls
    # One saved point also leaves positions pending while retaining the actual count.
    page.locator('#calibrateButton').click();pair(page,'key-left-base',.15,.8)
    page.locator('#finishCourtCalibration').click()
    page.locator('#analyzeButton').click();wait_analysis(page)
    assert page.evaluate("data.courtCalibration.pairs.length===1 && !data.courtCalibration.matrix && data.position_analysis.status==='pending'")
    assert page.evaluate('poseCalls')==calls
    # Pre-analysis setup and explicit completion work in the phone viewport as well.
    phone=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True).new_page()
    phone.on('pageerror',lambda e:errors.append(str(e)))
    phone.goto(BASE);phone.wait_for_function('backend===true && !loading')
    load_video(phone);phone.locator('#calibrateButton').tap();drag_hoop(phone)
    phone.locator('#relativeCourt').check()
    for button,x,y,cx,cy in [('#addPersonReference',.35,.6,0,4),('#addGroundReference',.15,.8,-2.45,.05)]:
        phone.locator(button).tap()
        r=phone.locator('#overlay').bounding_box();w,h=phone.evaluate('[overlay.width,overlay.height]');scale=min(r['width']/w,r['height']/h)
        phone.touchscreen.tap(r['x']+(r['width']-w*scale)/2+x*w*scale,r['y']+(r['height']-h*scale)/2+y*h*scale)
        p=phone.evaluate('''([x,y])=>{const p=new DOMPoint(x,y).matrixTransform(document.querySelector('#courtGraphic svg').getScreenCTM());return {x:p.x,y:p.y};}''',[cx,cy])
        phone.touchscreen.tap(p['x'],p['y'])
    assert phone.evaluate("data.events.length===0 && courtPairs[0].kind==='person'")
    phone.locator('#finishCourtCalibration').tap()
    assert phone.evaluate('setupReady() && data.courtCalibration.matrix && scrollY===0 && document.documentElement.scrollWidth<=innerWidth')
    phone.screenshot(path=str(OUT/'setup-workflow-mobile.png'),full_page=True)
    assert not errors,errors
    report={'setup_before_any_events':'passed','start_requires_explicit_completion':'passed','hoop_court_saved_together':'passed','cancel_restores_scene':'passed','backend_count_then_auto_position_one_action':'passed','new_source_resets_setup':'passed','zero_one_point_count_only':'passed','mobile_setup':'passed','page_errors':errors}
    (OUT/'setup-workflow-report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report),flush=True);browser.close()
