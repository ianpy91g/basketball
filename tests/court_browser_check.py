"""Test manual location editing with synthetic calibration points, not court measurements."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts'
errors=[]

def click_image(page,x,y):
    box=page.locator('#overlay').bounding_box()
    w,h=page.evaluate('[overlay.width,overlay.height]')
    scale=min(box['width']/w,box['height']/h)
    page.mouse.click(box['x']+(box['width']-w*scale)/2+x*w*scale,
                     box['y']+(box['height']-h*scale)/2+y*h*scale)

def click_map(page,x,y):
    p=page.evaluate('''([x,y])=>{const m=document.querySelector('#courtGraphic svg').getScreenCTM();const p=new DOMPoint(x,y).matrixTransform(m);return {x:p.x,y:p.y};}''',[x,y])
    page.mouse.click(p['x'],p['y'])

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1440,'height':1000},accept_downloads=True)
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('http://127.0.0.1:8772')
    page.wait_for_function('data?.events?.length===17 && video.readyState>=2 && !loading')
    page.evaluate("data.events=data.events.slice(0,3);Court.createPoseEstimator=async()=>({detect:()=>({landmarks:[]})});refresh();")
    page.locator('#reviewMapTab').click()
    assert page.locator('#courtPanel').is_visible() and page.locator('#shotRows').is_hidden()
    scroll=page.evaluate('window.scrollY')
    page.locator('#mapShot').select_option('1')
    page.wait_for_function('!video.seeking')
    assert page.evaluate('video.paused && !clipPlayback && selectedShotId===1')
    assert page.locator('#markVideoPosition').is_disabled()
    # Approximate placement works without a video-to-court calibration.
    page.locator('#markMapPosition').click();click_map(page,-5,4)
    assert page.evaluate("data.events[0].position.method==='map' && Math.abs(data.events[0].position.x+5)<.1")
    assert page.locator('[data-map-shot="1"].miss').count()==1
    # Pair four named ground points using pointer input on the letterboxed video.
    page.locator('#calibrateCourt').click()
    anchors=[('key-left-base',.15,.8),('key-right-base',.55,.8),('key-left-free',.15,.4),('key-right-free',.55,.4)]
    for anchor,x,y in anchors:
        page.locator('#courtLandmark').select_option(anchor)
        click_image(page,x,y)
    assert page.evaluate('courtAction===\'calibrate\' && courtPairs.length===4')
    page.locator('#finishCourtCalibration').click()
    page.wait_for_function('!positionScan && !loading',timeout=60000)
    assert page.evaluate('data.courtCalibration?.pairs.length===4 && courtAction===null')
    assert page.locator('#markVideoPosition').is_enabled()
    # Save a foot contact point and its source frame; no clamping of out-of-court positions.
    page.locator('#mapShot').select_option('2');page.wait_for_function('!video.seeking')
    page.locator('#markVideoPosition').click();click_image(page,.35,.6)
    pos=page.evaluate('data.events[1].position')
    assert pos['method']=='video' and abs(pos['x'])<.04 and abs(pos['y']-2.9)<.04,pos
    assert abs(pos['video_time']-(18.4-1.6))<.5,pos
    page.locator('#markVideoPosition').click();click_image(page,.99,.1)
    assert page.evaluate("courtAction==='video' && data.events[1].position.video_point.x<.4")
    assert '超出半場' in page.locator('#status').inner_text()
    page.locator('#cancelCourtAction').click()
    # A frame jog remains on this shot rather than starting a clip loop.
    before=page.evaluate('video.currentTime')
    page.locator('#locationBack').click();page.wait_for_function('!video.seeking')
    assert abs(page.evaluate('video.currentTime')-(before-.1))<.03
    assert page.evaluate('selectedShotId===2 && video.paused')
    # Result corrections update map symbols; ignored events leave the map and denominator.
    page.locator('#reviewListTab').click()
    page.locator('#shotRows select').nth(1).select_option('miss')
    page.locator('#reviewMapTab').click()
    assert page.locator('[data-map-shot="2"].miss').count()==1
    assert abs(page.evaluate('window.scrollY')-scroll)<1
    # Recalibration transforms video points again, without moving direct map estimates.
    page.locator('#calibrateCourt').click()
    for anchor,x,y in anchors:
        page.locator('#courtLandmark').select_option(anchor);click_image(page,x,y+.04)
    page.locator('#finishCourtCalibration').click()
    page.wait_for_function('!positionScan && !loading',timeout=60000)
    changed=page.evaluate('data.events[1].position')
    assert abs(changed['y']-pos['y']-.58)<.05,(pos,changed)
    assert page.evaluate('Math.abs(data.events[0].position.x+5)<.1')
    # Cancelling a replacement calibration leaves the last confirmed one intact.
    original=page.evaluate('JSON.stringify(data.courtCalibration)')
    page.locator('#calibrateCourt').click()
    page.locator('#clearCourtPoints').click()
    page.locator('#courtLandmark').select_option('key-left-base');click_image(page,.2,.8)
    page.locator('#undoCourtPoint').click();assert page.evaluate('courtPairs.length===0')
    page.locator('#cancelCourtAction').click()
    assert page.evaluate('JSON.stringify(data.courtCalibration)')==original
    page.locator('#courtPanel').evaluate('(el)=>el.scrollTop=0')
    click_map(page,changed['x'],changed['y'])
    assert page.evaluate('selectedShotId===2')
    page.locator('#togglePlayback').click()
    # A new selection is saved and can be removed independently of the outcome.
    page.locator('#mapShot').select_option('3')
    page.locator('#markMapPosition').click();click_map(page,0,9)
    page.locator('#removePosition').click()
    assert page.evaluate('!data.events[2].position')
    page.locator('#markMapPosition').click();click_map(page,0,9)
    # JSON/CSV include locations and the calibration; browser history retains them.
    page.locator('#sessionSummary > summary').click()
    for selector,name in [('#exportJson','court-export.json'),('#exportCsv','court-export.csv')]:
        with page.expect_download() as download:
            page.locator(selector).click()
        download.value.save_as(str(OUT/name))
    saved=json.loads((OUT/'court-export.json').read_text(encoding='utf8'))
    assert saved['courtCalibration']['pairs'] and saved['events'][1]['position']['method']=='video'
    assert '影片人工定位' in (OUT/'court-export.csv').read_text(encoding='utf-8-sig')
    page.evaluate("document.querySelector('#sessionSummary').open=false;window.scrollTo(0,0)")
    page.screenshot(path=str(OUT/'court-desktop.png'),full_page=True)
    for width,height,name in [(390,844,'mobile'),(844,390,'landscape')]:
        page.set_viewport_size({'width':width,'height':height})
        page.evaluate("window.scrollTo(0,0);fitWorkspace();document.querySelector('#courtPanel').scrollTop=0")
        page.wait_for_timeout(200)
        bounds=page.evaluate("({video:video.getBoundingClientRect().toJSON(),map:document.querySelector('#courtPanel').getBoundingClientRect().toJSON(),width:document.documentElement.scrollWidth})")
        assert bounds['width']<=width,bounds
        assert bounds['video']['bottom']<=height and bounds['map']['bottom']<=height,bounds
        page.screenshot(path=str(OUT/f'court-{name}.png'),full_page=True)
    page.set_viewport_size({'width':1440,'height':1000})
    page.locator('#sessionSummary > summary').click()
    page.locator('.history-item').first.click()
    assert page.evaluate("data.courtCalibration && data.events[1].position.method==='video'")
    assert page.locator('#markVideoPosition').is_disabled() # History has no associated movie.
    # Use touch input on a phone viewport, including its independently scrolling map panel.
    mobile=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    phone=mobile.new_page();phone.on('pageerror',lambda e:errors.append(str(e)))
    phone.goto('http://127.0.0.1:8772')
    phone.wait_for_function('data?.events?.length===17 && video.readyState>=2 && !loading')
    phone.evaluate("data.events=data.events.slice(0,3);Court.createPoseEstimator=async()=>({detect:()=>({landmarks:[]})});refresh();")
    phone.locator('#reviewMapTab').tap();phone.locator('#mapShot').select_option('1')
    phone.locator('#markMapPosition').tap()
    p=phone.evaluate('''()=>{const p=new DOMPoint(2,8).matrixTransform(document.querySelector('#courtGraphic svg').getScreenCTM());return {x:p.x,y:p.y};}''')
    phone.touchscreen.tap(p['x'],p['y'])
    assert phone.evaluate("data.events[0].position?.method==='map'")
    assert phone.evaluate('window.scrollY===0')
    phone.locator('#calibrateCourt').tap()
    for anchor,x,y in anchors:
        phone.locator('#courtLandmark').select_option(anchor)
        bounds=phone.locator('#overlay').bounding_box();w,h=phone.evaluate('[overlay.width,overlay.height]')
        scale=min(bounds['width']/w,bounds['height']/h)
        phone.touchscreen.tap(bounds['x']+(bounds['width']-w*scale)/2+x*w*scale,
                              bounds['y']+(bounds['height']-h*scale)/2+y*h*scale)
    phone.locator('#finishCourtCalibration').tap()
    phone.wait_for_function('!positionScan && !loading',timeout=60000)
    assert phone.evaluate('data.courtCalibration?.pairs.length===4')
    phone.screenshot(path=str(OUT/'court-touch-finish.png'),full_page=True)
    assert phone.evaluate('window.scrollY===0'),phone.evaluate('({scroll:scrollY,workspace:document.querySelector("#workspace").getBoundingClientRect().toJSON()})')
    assert phone.evaluate('''()=>{const p=document.querySelector('#courtPanel').getBoundingClientRect(),c=document.querySelector('#courtGraphic').getBoundingClientRect();return c.top>=p.top-1&&c.bottom<=p.bottom+1;}''')
    assert not errors,errors
    print(json.dumps({'manual_map':'passed','ground_calibration':'passed','video_foot_location':'passed','out_of_court_rejected':'passed','recalibration':'passed','cancel_undo':'passed','correction_sync':'passed','export_history':'passed','mobile_layout_touch':'passed','page_errors':errors,'reference_points':'synthetic, not measured court positions'}),flush=True)
    browser.close()
