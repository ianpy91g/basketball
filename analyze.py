"""Fixed-camera shooting prototype. No learned model or filename-based labels."""
from __future__ import annotations

import argparse
import csv
import html
import json
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
ANALYSIS_VERSION = 2


def convert_video(source: Path, output: Path) -> None:
    executable = shutil.which('ffmpeg')
    if not executable:
        raise RuntimeError('找不到 ffmpeg，請先安裝後再匯入 MTS / MOV 影片')
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [executable, '-hide_banner', '-loglevel', 'error', '-i', str(source),
               '-map', '0:v:0', '-vf', "scale='min(960,iw)':-2,fps=30", '-an',
               '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-threads', '2',
               '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', str(output)]
    result = subprocess.run(command, capture_output=True, timeout=900)
    if result.returncode:
        raise RuntimeError('影片轉檔失敗：' + result.stderr.decode('utf-8', errors='replace')[-800:])


def analyze_video(video: Path, hoop: dict, progress=None, *, candidate_output: Path | None = None) -> dict:
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS)
    width, height = int(cap.get(3)), int(cap.get(4))
    count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if not cap.isOpened() or fps <= 0:
        raise RuntimeError('無法讀取影片')
    left, top, right, bottom = (float(hoop[k]) for k in ('left', 'top', 'right', 'bottom'))
    if not (0 <= left < right <= width and 0 <= top < bottom <= height and right-left >= 12):
        cap.release()
        raise ValueError('請框選影片內的籃圈，寬度至少 12 像素')
    w = right-left
    cx, cy = (left+right)/2, (top+bottom)/2
    x0, y0 = max(0, int(cx-w*2.5)), max(0, int(cy-w*3.5))
    x1, y1 = min(width, int(np.ceil(cx+w*5.4))), min(height, int(np.ceil(cy+w*2)))
    frames, background = [], None
    index = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        roi = frame[y0:y1, x0:x1]
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        if background is None:
            background = gray.astype(np.float32)
        diff = cv2.absdiff(gray, cv2.convertScaleAbs(background))
        hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
        mask = (cv2.inRange(hsv, np.array([0, 55, 20]), np.array([30, 255, 255])) |
                cv2.inRange(hsv, np.array([165, 55, 20]), np.array([180, 255, 255])))
        mask[diff < 12] = 0
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        candidates = []
        for contour in contours:
            area = cv2.contourArea(contour)
            _, _, bw, bh = cv2.boundingRect(contour)
            if area < w*w*.018 or area > w*w*.8 or min(bw, bh) < 3 or max(bw/bh, bh/bw) > 3.5:
                continue
            if area/(bw*bh) < .25:
                continue
            m = cv2.moments(contour)
            candidates.append({'x': m['m10']/m['m00']+x0, 'y': m['m01']/m['m00']+y0, 'area': area})
        frames.append({'t': index/fps, 'candidates': candidates})
        cv2.accumulateWeighted(gray, background, .025)
        index += 1
        if progress and index % 30 == 0:
            progress(min(.97, index/max(count, 1)))
    cap.release()
    if not index:
        raise RuntimeError('影片沒有可解碼影格')
    if candidate_output:
        candidate_output.write_text(json.dumps({'hoop': hoop, 'frames': frames}), encoding='utf-8')
    node = shutil.which('node')
    if not node:
        raise RuntimeError('找不到 Node.js，無法執行共用判定規則')
    classified = subprocess.run([node, str(ROOT/'tools/classify.cjs')],
                                input=json.dumps({'hoop': hoop, 'frames': frames}),
                                capture_output=True, text=True, encoding='utf-8', check=True, timeout=90)
    events = json.loads(classified.stdout)['events']
    totals = {status: sum(e['result'] == status for e in events) for status in ('make', 'miss', 'unknown')}
    decided = totals['make']+totals['miss']
    return {'version': ANALYSIS_VERSION, 'method': f'fixed-camera-color-motion-v{ANALYSIS_VERSION}', 'source': video.name,
            'width': width, 'height': height, 'fps': fps, 'duration': index/fps, 'hoop': hoop,
            'events': events, 'summary': {'attempts_detected': len(events), **totals,
            'resolved_accuracy': round(totals['make']/decided*100, 2) if decided else None},
            'limitations': ['只統計偵測到球接近籃框的事件，畫面外或遠離籃框的投籃可能漏算。',
                            '固定鏡頭、單一橘褐色或深紅色籃球與清楚籃網為本原型的使用條件。',
                            '自動判定需逐球複核；目前未以獨立標註資料集驗證準確率。',
                            '時間碼以轉檔後影片的第一個影格為零；不包含音訊起點偏移。']}


def save_results(result: dict, directory: Path, video_name: str = 'source.mp4') -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory/'analysis.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    with (directory/'shots.csv').open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['序號', '到框時間_秒', '自動結果', '判定線索', '已人工確認'])
        labels = {'make': '進球', 'miss': '未進', 'unknown': '待確認'}
        for event in result['events']:
            writer.writerow([event['id'], event['time'], labels[event['result']], event['reason'], '否'])
    summary = result['summary']
    rows = ''.join(
        f'<tr><td>{event["id"]}</td><td><button onclick="jump({event["time"]})">'
        f'{int(event["time"]//60):02d}:{event["time"]%60:04.1f}</button></td>'
        f'<td class="{event["result"]}">{labels[event["result"]]}</td>'
        f'<td>{html.escape(event["reason"])}</td></tr>' for event in result['events'])
    accuracy = summary['resolved_accuracy']
    report = f'''<!doctype html><html lang="zh-Hant"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>投籃簿｜影片測試報告</title>
<style>body{{background:#101713;color:#edf3e9;font:16px/1.8 system-ui,sans-serif;max-width:960px;margin:40px auto;padding:0 20px}}h1{{font-size:30px}}a,button,.make{{color:#cbef91}}button{{background:none;border:0;text-decoration:underline;cursor:pointer;font:inherit}}video{{width:100%;border-radius:10px;background:#000}}.stats{{display:flex;gap:32px;flex-wrap:wrap;padding:20px 0}}.stats strong{{font-size:32px;display:block}}.stats span,p,td:last-child{{color:#a9b7a6}}table{{width:100%;border-collapse:collapse;font-size:14px}}th,td{{text-align:left;border-bottom:1px solid #30402e;padding:12px 6px}}.note{{border:1px solid #41533a;padding:16px;border-radius:8px}}.unknown{{color:#e4a06b}}@media(max-width:600px){{body{{font-size:14px}}.stats{{gap:20px}}td:last-child{{font-size:11px}}}}</style>
<p>投籃簿 · 固定鏡頭測試</p><h1>{html.escape(result['source'])}</h1>
<div class="stats"><div><strong>{summary['attempts_detected']}</strong><span>偵測到框事件</span></div><div><strong class="make">{summary['make']}</strong><span>進球</span></div><div><strong>{summary['miss']}</strong><span>未進</span></div><div><strong>{summary['unknown']}</strong><span>待確認</span></div><div><strong>{accuracy if accuracy is not None else '—'}%</strong><span>已判定球數命中率</span></div></div>
<p class="note">這是依影像自動判定的結果，尚待逐球人工複核。只統計偵測到球接近籃框的事件，不能據此確定影片包含的完整出手數；檔名中的球數沒有用於判定。這支影片同時用於校準，不能推論跨球場準確率。</p>
<video id="v" src="{html.escape(video_name, quote=True)}" controls playsinline preload="metadata"></video>
<p>點時間回看該球前後。修正與補記請使用本機原型介面。 · <a href="shots.csv">下載逐球 CSV</a> · <a href="analysis.json">原始分析 JSON</a></p>
<table><thead><tr><th>球號</th><th>到框時間</th><th>自動結果</th><th>線索</th></tr></thead><tbody>{rows}</tbody></table>
<script>function jump(t){{const v=document.getElementById('v');v.currentTime=Math.max(0,t-.8);v.play();v.scrollIntoView({{behavior:'smooth',block:'center'}});}}</script>
<p>時間以轉檔後影片為準。其他影片需重新標定籃圈；目前為單人、單球、固定鏡頭與橘褐色或深紅色球的辨識原型。</p></html>'''
    (directory/'report.html').write_text(report, encoding='utf-8')


def evidence_sheet(video: Path, result: dict, output: Path) -> None:
    from PIL import Image, ImageDraw
    cap = cv2.VideoCapture(str(video))
    hoop = result['hoop']
    w = hoop['right']-hoop['left']
    x0, y0 = max(0, int(hoop['left']-w*.5)), max(0, int(hoop['top']-w))
    x1, y1 = min(result['width'], int(hoop['right']+w)), min(result['height'], int(hoop['bottom']+w*1.6))
    events = result['events']
    sheet = Image.new('RGB', (960, max(1, len(events))*174), '#11171b')
    draw = ImageDraw.Draw(sheet)
    for row, event in enumerate(events):
        draw.text((8, row*174+3), f"#{event['id']:02d}  {event['time']:.2f}s  {event['result'].upper()}", fill='white')
        for col, dt in enumerate((-.12, .06, .24, .46)):
            cap.set(cv2.CAP_PROP_POS_MSEC, max(0, event['time']+dt)*1000)
            ok, frame = cap.read()
            if ok:
                frame = cv2.resize(frame[y0:y1, x0:x1], (238, 146))
                sheet.paste(Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)), (col*240, row*174+24))
    cap.release()
    sheet.save(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='固定鏡頭練投影片分析原型')
    parser.add_argument('source', type=Path)
    parser.add_argument('--proxy', type=Path, default=ROOT/'artifacts/source.mp4')
    parser.add_argument('--out', type=Path, default=ROOT/'artifacts')
    parser.add_argument('--hoop', required=True, help='轉檔影片的籃圈 left,top,right,bottom 像素座標')
    parser.add_argument('--reuse-proxy', action='store_true', help='明確重用已存在、且已確認屬於這支原片的 MP4')
    args = parser.parse_args()
    if not args.reuse_proxy or not args.proxy.exists():
        convert_video(args.source, args.proxy)
    hoop = dict(zip(('left', 'top', 'right', 'bottom'), map(float, args.hoop.split(','))))
    result = analyze_video(args.proxy, hoop)
    result['source'] = args.source.name
    save_results(result, args.out)
    evidence_sheet(args.proxy, result, args.out/'evidence.jpg')
    print(json.dumps(result['summary'], ensure_ascii=False))
