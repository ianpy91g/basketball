"""Player and arbitrary ground references on a cropped, non-standard court.

Pose results are controlled fixtures here; real-model reference detection is checked separately.
"""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

OUT=Path(__file__).resolve().parents[1]/'artifacts'

def image_click(page,x,y,touch=False):
    box=page.locator('#overlay').bounding_box();w,h=page.evaluate('[overlay.width,overlay.height]')
    scale=min(box['width']/w,box['height']/h)
    px=box['x']+(box['width']-w*scale)/2+x*w*scale
    py=box['y']+(box['height']-h*scale)/2+y*h*scale
    (page.touchscreen.tap if touch else page.mouse.click)(px,py)

def map_click(page,x,y,touch=False):
    point=page.evaluate('''([x,y])=>{const p=new DOMPoint(x,y).matrixTransform(document.querySelector('#courtGraphic svg').getScreenCTM());return {x:p.x,y:p.y};}''',[x,y])
    (page.touchscreen.tap if touch else page.mouse.click)(point['x'],point['y'])

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1440,'height':1000},accept_downloads=True)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('http://127.0.0.1:8772')
    page.wait_for_function('data?.events.length===17 && !loading && video.readyState>=2')
    page.evaluate('''()=>{
      data.events=data.events.slice(0,3);data.events[0].position={method:'map',x:-4,y:4};
      data.events[1].location_candidate={video_point:{x:.4,y:.58},video_time:17};
      data.events[2].location_candidate={video_point:{x:.5,y:.55},video_time:25};
      const points=Array.from({length:33},()=>({x:.45,y:.4,visibility:1,presence:1}));
      for(const i of [11,12])points[i].y=.2;
      for(const i of [23,24])points[i].y=.4;
      for(const i of [25,26])points[i].y=.48;
      for(const i of [27,28,29,30,31,32])points[i].y=.55;
      points[15].visibility=points[16].visibility=0;
      window.referencePose=points;Court.createPoseEstimator=async()=>({detect:()=>({landmarks:[referencePose]})});refresh();
    }''')
    page.locator('#reviewMapTab').click()
    assert page.locator('#courtExtent').input_value()=='near'
    assert page.locator('#courtGraphic svg').get_attribute('viewBox')=='-8 -.5 16 11'
    page.locator('#calibrateCourt').click()
    assert page.locator('#courtLandmark option[value="court-left-mid"]').count()==0
    page.locator('#cancelCourtAction').click()
    page.locator('#relativeCourt').check()
    assert page.locator('#courtZones .zone-row').count()==3
    assert '三分' not in page.locator('#courtZones').inner_text()
    page.locator('#calibrateCourt').click()
    page.locator('#addPersonReference').click()
    assert page.locator('#finishCourtCalibration').is_disabled()
    page.locator('#courtExtent').select_option('full');page.locator('#courtExtent').select_option('near')
    assert page.evaluate("courtReference.kind==='person' && courtReference.image===null")
    image_click(page,.35,.6);map_click(page,0,4)
    assert page.evaluate("courtPairs.length===1 && courtPairs[0].kind==='person' && courtPairs[0].source==='manual'")
    page.locator('#addGroundReference').click();image_click(page,.15,.8);map_click(page,-2.45,0)
    assert page.evaluate('courtPairs.length===2 && !courtReference'),page.evaluate('({courtPairs,courtReference})')
    page.locator('#finishCourtCalibration').click();page.wait_for_function('!loading && !positionScan')
    assert page.evaluate("data.courtCalibration.template==='relative' && data.courtCalibration.matrix && data.courtCalibration.pairs.every(p=>p.kind)")
    assert page.evaluate('Math.abs(data.events[1].position.x)>0.01 && Math.abs(data.events[1].position.x-data.events[2].position.x)>.01')
    assert page.evaluate("data.events[0].position.x===-4 && data.events[0].position.method==='map'")
    # A standing person can be a reference even when no raised hands are visible.
    page.locator('#calibrateCourt').click();page.locator('#addPersonReference').click()
    page.locator('#detectCurrentFoot').click()
    page.wait_for_function('courtReference?.image && !loading')
    assert page.evaluate("courtReference.source==='pose'")
    map_click(page,3,7)
    assert page.evaluate('courtPairs.length===3')
    page.locator('#finishCourtCalibration').click();page.wait_for_function('!loading && !positionScan')
    saved=page.evaluate('data.courtCalibration')
    assert saved['method']=='affine' and saved['pairs'][2]['source']=='pose'
    # Multiple visible people require manual choice rather than picking one silently.
    page.locator('#calibrateCourt').click();page.locator('#addPersonReference').click()
    page.evaluate('()=>{Court.createPoseEstimator=async()=>({detect:()=>({landmarks:[referencePose,referencePose]})});}')
    page.locator('#detectCurrentFoot').click();page.wait_for_function('!loading')
    assert page.evaluate('courtReference.image===null && courtPairs.length===3')
    assert '多位' in page.locator('#status').inner_text()
    page.locator('#undoCourtPoint').click();page.locator('#cancelCourtAction').click()
    assert page.evaluate('data.courtCalibration.pairs.length===3')
    page.locator('#calibrateCourt').click();page.locator('#addPersonReference').click()
    page.evaluate('()=>{Court.createPoseEstimator=()=>new Promise(resolve=>window.releaseReference=resolve);}')
    page.locator('#detectCurrentFoot').click()
    page.wait_for_function('referenceDetection!==null && typeof releaseReference===\'function\'')
    page.locator('#cancelCourtAction').click();page.wait_for_function('!loading && referenceDetection===null')
    assert page.evaluate('data.courtCalibration.pairs.length===3 && courtAction===null && courtReference===null')
    page.evaluate('releaseReference({detect:()=>({landmarks:[]})})')
    # Cropping is a view choice; it never deletes out-of-range shots.
    page.evaluate("data.events[0].position={method:'map',x:0,y:12};refreshCourt();")
    assert '範圍外' in page.locator('#courtViewHint').inner_text()
    page.locator('#courtExtent').select_option('full')
    assert page.locator('#courtGraphic svg').get_attribute('viewBox')=='-8 -.5 16 15'
    assert page.evaluate('data.events[0].position.y===12')
    page.locator('#sessionSummary > summary').click()
    for selector,name in [('#exportJson','person-reference.json'),('#exportCsv','person-reference.csv')]:
        with page.expect_download() as pending:page.locator(selector).click()
        pending.value.save_as(str(OUT/name))
    record=json.loads((OUT/'person-reference.json').read_text(encoding='utf8'))
    assert record['courtProfile']['relative'] and record['courtCalibration']['pairs'][0]['kind']=='person'
    csv=(OUT/'person-reference.csv').read_text(encoding='utf-8-sig')
    assert '相對百分比' in csv and '公尺' not in csv
    page.locator('.history-item').first.click()
    assert page.locator('#relativeCourt').is_checked() and page.locator('#courtExtent').input_value()=='full'
    assert page.evaluate('data.courtCalibration.pairs[2].kind===\'person\'')
    # Touch reference pairing without any midcourt point on a phone screen.
    phone=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True).new_page()
    phone.on('pageerror',lambda e:errors.append(str(e)))
    phone.goto('http://127.0.0.1:8772');phone.wait_for_function('data?.events.length===17 && !loading && video.readyState>=2')
    phone.evaluate("data.events=data.events.slice(0,1);data.events[0].position={method:'map',x:0,y:3};refresh();")
    phone.locator('#reviewMapTab').tap();phone.locator('#relativeCourt').check();phone.locator('#calibrateCourt').tap()
    phone.locator('#addPersonReference').tap();image_click(phone,.35,.6,True);map_click(phone,0,4,True)
    phone.locator('#addGroundReference').tap();image_click(phone,.15,.8,True);map_click(phone,-2.45,0,True)
    phone.locator('#finishCourtCalibration').tap();phone.wait_for_function('!loading && !positionScan')
    assert phone.evaluate('window.scrollY===0 && data.courtCalibration.pairs.length===2')
    assert phone.evaluate('document.documentElement.scrollWidth<=innerWidth')
    phone.screenshot(path=str(OUT/'person-reference-mobile.png'),full_page=True)
    assert not errors,errors
    report={'person_manual_reference':'passed','standing_person_pose_reference':'passed','multiple_people_manual_fallback':'passed','free_ground_point':'passed','no_midcourt_required':'passed','relative_zones_csv':'passed','profile_reference_history':'passed','cropped_shots_preserved':'passed','touch_pairing':'passed','page_errors':errors}
    (OUT/'person-reference-report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report),flush=True);browser.close()
