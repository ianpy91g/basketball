"""Real browser smoke test; camera uses a video fixture, never the real camera."""
from pathlib import Path
import json
import time

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT/'artifacts'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=[
        '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        f'--use-file-for-fake-video-capture={OUT / "camera-test.y4m"}',
    ])
    context = browser.new_context(viewport={'width': 1440, 'height': 1050}, timezone_id='Asia/Taipei',
                                  permissions=['camera'], accept_downloads=True)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://127.0.0.1:8765')
    page.wait_for_function("document.querySelector('#attempts').textContent==='17'")
    page.wait_for_function("document.querySelector('#video').readyState>=2")
    assert page.locator('#makes').inner_text() == '12'
    assert page.locator('#misses').inner_text() == '5'
    assert page.locator('#accuracy').inner_text() == '70.6'
    page.screenshot(path=str(OUT/'desktop.png'), full_page=True)
    page.locator('#shotRows select').nth(1).select_option('unknown')
    assert page.locator('#makes').inner_text() == '11'
    assert page.locator('#unknowns').inner_text() == '1'
    if not page.locator('#sessionSummary').evaluate('(el)=>el.open'):
        page.locator('#sessionSummary > summary').click()
    with page.expect_download() as pending:
        page.locator('#exportCsv').click()
    download = pending.value
    download.save_as(str(OUT/'browser-export.csv'))
    assert '待確認' in (OUT/'browser-export.csv').read_text(encoding='utf-8-sig')
    page.reload()
    page.wait_for_function("document.querySelector('#attempts').textContent==='17'")
    if not page.locator('#sessionSummary').evaluate('(el)=>el.open'):
        page.locator('#sessionSummary > summary').click()
    page.locator('.history-item').first.click()
    assert page.locator('#unknowns').inner_text() == '1'
    # Camera path: browser permission, calibration, inference, recording and replay.
    page.locator('#liveTab').click()
    page.locator('#cameraButton').click()
    page.wait_for_function("document.querySelector('#video').srcObject && document.querySelector('#video').readyState>=2")
    page.evaluate("""() => { hoop={left:32,top:86.667,right:73.333,bottom:104}; data.setup={completed:true,aspect:overlay.width/overlay.height}; controls(); }""")
    page.locator('#startLiveButton').click()
    page.wait_for_timeout(6800)
    page.locator('#stopButton').click()
    page.wait_for_function("!document.querySelector('#downloadRecording').hidden")
    live = {k: page.locator('#'+k).inner_text() for k in ['attempts', 'makes', 'misses', 'unknowns']}
    assert int(live['attempts']) >= 1, live
    assert int(live['makes']) >= 1, live
    assert page.evaluate('stream===null')
    assert page.evaluate('recordedBlob.size>1000')
    # Mobile viewport checks layout, not real iOS hardware performance.
    mobile = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2,
                                 is_mobile=True, has_touch=True, timezone_id='Asia/Taipei')
    phone = mobile.new_page()
    phone.on('pageerror', lambda e: errors.append(str(e)))
    phone.goto('http://127.0.0.1:8765')
    phone.wait_for_function("document.querySelector('#attempts').textContent==='17'")
    phone.wait_for_function("document.querySelector('#video').readyState>=2")
    assert phone.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
    phone.screenshot(path=str(OUT/'mobile.png'), full_page=True)
    mobile.close()
    # Run the real JS pixel detector on all frames of the source in playback order.
    page.locator('#fileTab').click()
    page.locator('#sampleButton').click()
    page.wait_for_function("document.querySelector('#video').readyState>=2")
    page.locator('#calibrateButton').click();page.locator('#finishCourtCalibration').click()
    page.locator('#analyzeButton').click()
    page.wait_for_function('running===true')
    print(json.dumps({'stage':'browser-file-analysis-started','live_camera':live}), flush=True)
    page.wait_for_function('running===false', timeout=190000)
    file_result = page.evaluate('({summary:stats(data.events),events:data.events.map(e=>({time:e.time,result:e.result}))})')
    assert file_result['summary']['attempts_detected'] == 17, file_result
    assert file_result['summary']['make'] == 12, file_result
    assert file_result['summary']['miss'] == 5, file_result
    assert not errors, errors
    report = {'desktop':'passed','mobile_layout':'passed','correction_export_history':'passed',
              'simulated_camera_recording':'passed','live_camera_counts':live,
              'browser_full_video':file_result,'page_errors':errors,'real_iphone':'not tested'}
    (OUT/'browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False),flush=True)
    browser.close()
