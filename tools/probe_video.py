"""Extract moving orange objects near the basket for calibration."""
from pathlib import Path
import json

import cv2
import numpy as np


def main():
    cap = cv2.VideoCapture('artifacts/source.mp4')
    fps = cap.get(cv2.CAP_PROP_FPS)
    if not cap.isOpened() or fps <= 0:
        raise RuntimeError('Video is not ready')
    background = None
    rows = []
    frame_index = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        roi = frame[:260, :400]
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        if background is None:
            background = gray.astype(np.float32)
        diff = cv2.absdiff(gray, cv2.convertScaleAbs(background))
        hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, np.array([0, 65, 45]), np.array([28, 255, 255]))
        mask[diff < 22] = 0
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        detections = []
        for c in contours:
            area = cv2.contourArea(c)
            x, y, w, h = cv2.boundingRect(c)
            if area < 8 or area > 1000 or min(w, h) < 4 or max(w/h, h/w) > 3.5:
                continue
            if area / (w*h) < .25:
                continue
            m = cv2.moments(c)
            detections.append([round(m['m10']/m['m00'], 1), round(m['m01']/m['m00'], 1), round(area, 1), w, h])
        if detections:
            rows.append({'t': round(frame_index/fps, 4), 'd': detections})
        cv2.accumulateWeighted(gray, background, .025)
        frame_index += 1
    cap.release()
    Path('artifacts/detections.json').write_text(json.dumps(rows), encoding='utf-8')
    print(f'Scanned {frame_index} frames; {len(rows)} frames with candidates')
    near = [r for r in rows if any(x < 155 and 65 < y < 195 for x, y, *_ in r['d'])]
    groups = []
    for row in near:
        if not groups or row['t']-groups[-1][-1]['t'] > 1.0:
            groups.append([])
        groups[-1].append(row)
    for group in groups:
        print(round(group[0]['t'], 2), round(group[-1]['t'], 2), len(group))


if __name__ == '__main__':
    main()
