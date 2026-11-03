"""Exercise real clip playback and a stable video/list review workspace."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts'
errors=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    context=browser.new_context(viewport={'width':1440,'height':900})
    page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto('http://127.0.0.1:8765')
    page.wait_for_function('data?.events?.length===17 && video.readyState>=2 && !loading')
    original_events=page.evaluate('data.events')
    assert not page.locator('#sessionSummary').evaluate('(el)=>el.open')
    assert page.evaluate('TRAJECTORY_COLOR')=='#ff8c00'
    initial=page.evaluate('({scroll:window.scrollY,height:innerHeight,video:video.getBoundingClientRect().toJSON(),list:document.querySelector("#shotRows").getBoundingClientRect().toJSON()})')
    assert initial['video']['bottom']<=initial['height'] and initial['list']['bottom']<=initial['height'],initial
    # Selecting a distant card scrolls only its list, never the document.
    page.locator('#shotRows').evaluate('(el)=>el.scrollTop=el.scrollHeight')
    before=page.evaluate('window.scrollY')
    page.locator('#shotRows .shot-open').last.click()
    page.wait_for_function('selectedShotId===17 && !video.paused')
    assert abs(page.evaluate('window.scrollY')-before)<1
    assert page.locator('#shotRows .shot-card.selected').count()==1
    page.locator('#togglePlayback').click()
    # A real loop must seek back to the segment start more than once.
    page.evaluate("window.reviewSeeks=[];video.addEventListener('seeking',()=>reviewSeeks.push({time:video.currentTime,id:selectedShotId}));")
    page.locator('#playbackMode').select_option('loop')
    page.locator('#shotStrip .shot-chip').first.click()
    page.wait_for_timeout(4800)
    loop=page.evaluate('({id:selectedShotId,time:video.currentTime,bounds:clipBounds(selectedShot()),seeks:reviewSeeks.filter(s=>s.id===1),scroll:window.scrollY})')
    assert loop['id']==1 and len(loop['seeks'])>=3,loop
    assert loop['bounds']['start']-.1<=loop['time']<=loop['bounds']['end']+.1,loop
    assert abs(loop['scroll']-before)<1
    # Single-play mode stops at the current segment, rather than the whole film.
    page.locator('#playbackMode').select_option('once')
    page.locator('#shotStrip .shot-chip').first.click()
    page.wait_for_function('video.paused && selectedShotId===1',timeout=7000)
    assert page.evaluate('Math.abs(video.currentTime-clipBounds(selectedShot()).end)<.12')
    # Sequential mode advances to the next recorded shot and skips the long gap.
    page.locator('#playbackMode').select_option('sequence')
    page.locator('#shotStrip .shot-chip').first.click()
    page.wait_for_function('selectedShotId===2',timeout=7000)
    assert page.evaluate('video.currentTime>=clipBounds(selectedShot()).start-.1')
    assert abs(page.evaluate('window.scrollY')-before)<1
    page.locator('#togglePlayback').click()
    # Finishing a short sequence pauses once and supports restarting from shot 1.
    page.evaluate('data.events=data.events.slice(0,2);refresh();')
    page.locator('#shotStrip .shot-chip').first.click()
    page.wait_for_function('sequenceFinished && video.paused',timeout=12000)
    assert page.evaluate('selectedShotId===2')
    page.locator('#togglePlayback').click()
    page.wait_for_function('selectedShotId===1 && !video.paused')
    page.locator('#togglePlayback').click()
    # Draw the actual trajectory at a real made-shot timestamp.
    page.evaluate('(events)=>{data.events=events;refresh();}',original_events)
    page.locator('#shotStrip .shot-chip').nth(1).click()
    page.evaluate('video.pause();video.currentTime=18.8;')
    page.wait_for_function('!video.seeking')
    orange=page.evaluate('''() => {draw();const rgba=ctx.getImageData(0,0,overlay.width,overlay.height).data;let count=0;for(let i=0;i<rgba.length;i+=4)if(rgba[i]>=250&&rgba[i+1]>=120&&rgba[i+1]<=160&&rgba[i+2]<15&&rgba[i+3]>180)count++;return count;}''')
    assert orange>10,orange
    page.screenshot(path=str(OUT/'review-desktop.png'),full_page=True)
    layouts=[]
    for width,height,name in [(1280,720,'laptop'),(390,844,'mobile'),(844,390,'mobile-landscape')]:
        page.set_viewport_size({'width':width,'height':height})
        page.evaluate('window.scrollTo(0,0);fitWorkspace()')
        page.wait_for_timeout(200)
        layout=page.evaluate('({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,video:video.getBoundingClientRect().toJSON(),list:document.querySelector("#shotRows").getBoundingClientRect().toJSON()})')
        assert not layout['overflow'],layout
        assert layout['video']['top']>=0 and layout['video']['bottom']<=height,layout
        assert layout['list']['top']>=0 and layout['list']['bottom']<=height,layout
        layouts.append(layout)
        page.screenshot(path=str(OUT/f'review-{name}.png'),full_page=True)
    # Corrections keep the selected shot and survive CSV export in the new panel.
    page.locator('#shotRows select').nth(1).select_option('unknown')
    assert page.evaluate("selectedShotId===2 && data.events[1].result==='unknown' && data.events[1].reviewed")
    page.locator('#sessionSummary > summary').click()
    with page.expect_download() as pending:
        page.locator('#exportCsv').click()
    pending.value.save_as(str(OUT/'review-export.csv'))
    assert '待確認' in (OUT/'review-export.csv').read_text(encoding='utf-8-sig')
    assert not errors,errors
    report={'single_clip_loop':'passed','single_clip_once':'passed','sequential_playback':'passed','sequence_end_restart':'passed','document_scroll_unchanged':'passed','statistics_collapsed':'passed','correction_csv_export':'passed','orange_trajectory_pixels':orange,'layouts':layouts,'page_errors':errors}
    (OUT/'review-browser-report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps({k:v for k,v in report.items() if k!='layouts'}),flush=True)
    browser.close()
