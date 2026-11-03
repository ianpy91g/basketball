"""Exercise explicit completion, 1–5 point fitting, automated editing and cancellation.

Pose outputs here are controlled fixtures. Real-model footage coverage is checked separately.
"""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

OUT=Path(__file__).resolve().parents[1]/'artifacts'

def image_click(page,x,y):
    box=page.locator('#overlay').bounding_box();w,h=page.evaluate('[overlay.width,overlay.height]')
    scale=min(box['width']/w,box['height']/h)
    page.mouse.click(box['x']+(box['width']-w*scale)/2+x*w*scale,
                     box['y']+(box['height']-h*scale)/2+y*h*scale)

def add_pair(page,anchor,x,y):
    page.locator('#courtLandmark').select_option(anchor);image_click(page,x,y)

def finish(page):
    page.locator('#finishCourtCalibration').click()
    page.wait_for_function('!loading && !positionScan',timeout=60000)

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1440,'height':1000})
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('http://127.0.0.1:8772')
    page.wait_for_function('data?.events.length===17 && video.readyState>=2 && !loading')
    page.evaluate('''()=>{
      data.events=data.events.slice(0,3);data.events[0].position={x:-5,y:4,method:'map'};
      window.fakeEstimator={detect:()=>{
        const p=Array.from({length:33},()=>({x:.35,y:.4,visibility:1,presence:1}));
        for(const i of [11,12])p[i].y=.2;
        for(const i of [23,24])p[i].y=.4;
        for(const i of [25,26])p[i].y=.5;
        for(const i of [27,28,29,30,31,32])p[i].y=.6;
        p[15].y=p[16].y=.12;p[31].x=.325;p[32].x=.375;
        return {landmarks:[p]};
      }};
      Court.createPoseEstimator=async()=>fakeEstimator;refresh();
    }''')
    page.locator('#reviewMapTab').click();page.locator('#calibrateCourt').click()
    add_pair(page,'key-left-base',.15,.8)
    assert page.evaluate('courtAction===\'calibrate\' && !data.courtCalibration')
    finish(page)
    assert page.evaluate("data.courtCalibration.pairs.length===1 && data.courtCalibration.matrix===null")
    page.locator('#autoLocateShots').click();page.wait_for_function('!loading && !positionScan')
    assert page.evaluate('data.events.slice(1).every(e=>e.location_candidate && !Court.inCourt(e.position))')
    assert page.evaluate("data.events[0].position.method==='map' && data.events[0].position.x===-5")
    page.locator('#calibrateCourt').click();add_pair(page,'key-right-base',.55,.8);finish(page)
    assert page.evaluate("data.courtCalibration.method==='similarity' && data.courtCalibration.pairs.length===2")
    assert page.evaluate('data.events.slice(1).every(e=>Court.inCourt(e.position) && e.position.method===\'auto\')')
    coarse=page.evaluate('data.events[1].position.y')
    page.locator('#calibrateCourt').click();add_pair(page,'key-left-free',.15,.4);finish(page)
    assert page.evaluate("data.courtCalibration.method==='affine'")
    assert abs(page.evaluate('data.events[1].position.y')-2.9)<.02
    assert abs(coarse-2.9)>.1
    page.locator('#calibrateCourt').click();add_pair(page,'key-right-free',.55,.4)
    assert page.evaluate('courtAction===\'calibrate\' && data.courtCalibration.pairs.length===3')
    add_pair(page,'free-left',.15+.65/4.9*.4,.4);finish(page)
    assert page.evaluate("data.courtCalibration.method==='perspective' && data.courtCalibration.pairs.length===5")
    assert abs(page.evaluate('data.events[1].position.y')-2.9)<.02
    # Confirmed automatic locations and manual locations are protected on retry.
    page.locator('#mapShot').select_option('2');page.wait_for_function('!video.seeking')
    page.locator('#confirmPosition').click()
    page.evaluate('Court.createPoseEstimator=async()=>({detect:()=>({landmarks:[]})});')
    page.locator('#autoLocateShots').click();page.wait_for_function('!loading && !positionScan',timeout=60000)
    assert page.evaluate("data.events[1].position.location_reviewed && data.events[0].position.x===-5")
    assert page.evaluate('!data.events[2].position && !data.events[2].location_candidate')
    # A pending model request is cancellable; loading state must release immediately.
    page.evaluate('()=>{Court.createPoseEstimator=()=>new Promise(resolve=>window.releaseEstimator=resolve);}')
    page.locator('#autoLocateShots').click();page.wait_for_function('positionScan!==null && typeof releaseEstimator===\'function\'')
    page.locator('#stopAutoPosition').click()
    page.wait_for_function('!loading && !positionScan')
    assert '已停止' in page.locator('#positionScanStatus').inner_text()
    page.evaluate('releaseEstimator(fakeEstimator)')
    # A network/model error is shown as a failure, never as a completed scan.
    page.evaluate("()=>{Court.createPoseEstimator=async()=>{throw Error('test model unavailable');};}")
    page.locator('#autoLocateShots').click();page.wait_for_function('!loading && !positionScan')
    assert '未完成' in page.locator('#positionScanStatus').inner_text()
    assert page.evaluate('data.courtCalibration.pairs.length===5 && data.events[1].position.location_reviewed')
    assert not errors,errors
    page.screenshot(path=str(OUT/'flexible-court-desktop.png'),full_page=True)
    report={'explicit_finish':'passed','one_point_reference':'passed','two_point_coarse':'passed','three_point_approximation':'passed','five_point_perspective':'passed','automatic_candidate_projection':'passed','manual_confirmed_positions_protected':'passed','cancel_model_loading':'passed','model_error_preserves_data':'passed','page_errors':errors,'pose_outputs':'controlled test fixture'}
    (OUT/'flexible-court-report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report),flush=True)
    browser.close()
