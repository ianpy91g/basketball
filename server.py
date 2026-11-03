"""Local-only HTTP service for MTS conversion and video analysis."""
from __future__ import annotations

import argparse
import importlib
import json
import mimetypes
import os
import re
import socket
import ssl
import threading
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import urlopen

import analyze

ROOT = analyze.ROOT
SERVER_VERSION = '2.1'

UPLOADS = ROOT/'artifacts/uploads'
JOBS = {}
GUARD = threading.Lock()
# Bound CPU work; camera inference stays in the browser.
WORKER = threading.Semaphore(1)


def run_job(job_id, mode, hoop=None):
    job = JOBS[job_id]
    try:
        with WORKER:
            # Reload updated analysis code between jobs, instead of retaining
            # functions imported before the user downloaded an update.
            engine = importlib.reload(analyze)
            job['analysis_version'] = engine.ANALYSIS_VERSION
            if mode == 'convert':
                job.update(status='converting', progress=0)
                engine.convert_video(job['input'], job['directory']/'video.mp4')
                job.update(status='ready', progress=1)
            else:
                job.update(status='analyzing', progress=0)
                result = engine.analyze_video(job['directory']/'video.mp4', hoop,
                                       lambda p: job.update(progress=p))
                result['source'] = job['filename']
                engine.save_results(result, job['directory'], 'video.mp4')
                job.update(status='complete', progress=1)
    except Exception as exc:
        job.update(status='error', error=str(exc))


class Handler(BaseHTTPRequestHandler):
    def json(self, value, status=200):
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/api/health':
            return self.json({'status': 'ok', 'app': 'shotbook-local',
                              'server_version': SERVER_VERSION,
                              'analysis_version': analyze.ANALYSIS_VERSION,
                              'pid': os.getpid(),
                              'sample': (ROOT/'artifacts/analysis.json').exists()})
        match = re.fullmatch(r'/api/jobs/([a-f0-9]{32})', path)
        if match:
            job = JOBS.get(match[1])
            if not job:
                return self.json({'error': '找不到工作'}, 404)
            return self.json({k: job[k] for k in ('status', 'progress', 'filename', 'error', 'analysis_version') if k in job})
        sample = {'/sample/video.mp4': 'source.mp4', '/sample/analysis.json': 'analysis.json',
                  '/sample/evidence.jpg': 'evidence.jpg', '/sample/shots.csv': 'shots.csv'}
        if path in sample:
            return self.file(ROOT/'artifacts'/sample[path])
        match = re.fullmatch(r'/media/([a-f0-9]{32})/(video.mp4|analysis.json|shots.csv)', path)
        if match and match[1] in JOBS:
            return self.file(JOBS[match[1]]['directory']/match[2])
        assets = {'/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css',
                  '/app.js': 'app.js', '/tracker.js': 'tracker.js',
                  '/icon.svg': 'icon.svg', '/site.webmanifest': 'site.webmanifest'}
        if path in assets:
            return self.file(ROOT/'app'/assets[path])
        return self.json({'error': '找不到頁面'}, 404)

    def file(self, path):
        if not path.is_file():
            return self.json({'error': '找不到檔案'}, 404)
        size = path.stat().st_size
        start, end, partial = 0, size-1, False
        value = self.headers.get('Range')
        if value:
            match = re.fullmatch(r'bytes=(\d+)-(\d*)', value)
            if not match:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.end_headers()
                return
            start = int(match[1])
            end = min(int(match[2]) if match[2] else size-1, size-1)
            if start > end:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.end_headers()
                return
            partial = True
        self.send_response(206 if partial else 200)
        self.send_header('Content-Type', mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(end-start+1))
        self.send_header('Accept-Ranges', 'bytes')
        if path.suffix.lower() in {'.html', '.js', '.css', '.json', '.svg', '.webmanifest', '.csv'}:
            self.send_header('Cache-Control', 'no-store')
        if partial:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        try:
            with path.open('rb') as f:
                f.seek(start)
                remaining = end-start+1
                while remaining > 0:
                    chunk = f.read(min(128*1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_POST(self):
        # Keep browser requests same-origin; this service exposes no general filesystem API.
        origin = self.headers.get('Origin')
        if origin and urlsplit(origin).netloc != self.headers.get('Host'):
            return self.json({'error': '不接受跨來源請求'}, 403)
        path = urlsplit(self.path).path
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return self.json({'error': '無效的檔案大小'}, 400)
        if path == '/api/uploads':
            name = Path(unquote(self.headers.get('X-Filename', 'video.mp4'))).name
            suffix = Path(name).suffix.lower()
            if suffix not in {'.mts', '.m2ts', '.mp4', '.mov', '.m4v', '.webm'} or not 0 < length <= 2*1024**3:
                return self.json({'error': '請選擇 2GB 內的 MTS / MP4 / MOV 影片'}, 400)
            job_id = uuid.uuid4().hex
            directory = UPLOADS/job_id
            directory.mkdir(parents=True)
            source = directory/('input'+suffix)
            try:
                with source.open('wb') as f:
                    left = length
                    while left:
                        chunk = self.rfile.read(min(1024*1024, left))
                        if not chunk:
                            raise ValueError('影片上傳中斷')
                        f.write(chunk)
                        left -= len(chunk)
            except Exception as exc:
                source.unlink(missing_ok=True)
                return self.json({'error': str(exc)}, 400)
            with GUARD:
                JOBS[job_id] = {'directory': directory, 'input': source, 'filename': name,
                                'status': 'queued', 'progress': 0}
            threading.Thread(target=run_job, args=(job_id, 'convert'), daemon=True).start()
            return self.json({'id': job_id}, 202)
        match = re.fullmatch(r'/api/jobs/([a-f0-9]{32})/analyze', path)
        if match and match[1] in JOBS:
            job = JOBS[match[1]]
            if not 0 < length < 4096:
                return self.json({'error': '無效的籃框設定'}, 400)
            try:
                hoop = json.loads(self.rfile.read(length))['hoop']
                coords = [float(hoop[k]) for k in ('left', 'top', 'right', 'bottom')]
                if not all(0 <= c <= 2000 for c in coords) or coords[2]-coords[0] < 12 or coords[3] <= coords[1]:
                    raise ValueError()
            except (ValueError, KeyError, TypeError):
                return self.json({'error': '請重新框選籃圈'}, 400)
            with GUARD:
                if job['status'] not in {'ready', 'complete'}:
                    return self.json({'error': '影片尚未就緒或正在分析'}, 409)
                job.update(status='queued', progress=0)
            threading.Thread(target=run_job, args=(match[1], 'analyze', hoop), daemon=True).start()
            return self.json({'id': match[1]}, 202)
        return self.json({'error': '找不到操作'}, 404)


class AppServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR can allow multiple listeners on the same address.
    allow_reuse_address = os.name != 'nt'

    def server_bind(self):
        if os.name == 'nt' and hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--cert', type=Path)
    parser.add_argument('--key', type=Path)
    parser.add_argument('--open-browser', action='store_true')
    args = parser.parse_args()
    scheme = 'https' if args.cert or args.key else 'http'
    browser_host = '127.0.0.1' if args.host == '0.0.0.0' else args.host
    local_url = f'{scheme}://{browser_host}:{args.port}'
    try:
        server = AppServer((args.host, args.port), Handler)
    except OSError as exc:
        try:
            with urlopen(local_url+'/api/health', timeout=2) as response:
                existing = json.load(response)
            if existing.get('app') == 'shotbook-local' and existing.get('analysis_version', 0) >= 2:
                print(f'本機服務已在執行：{local_url}', flush=True)
                if args.open_browser:
                    webbrowser.open(local_url)
                raise SystemExit(0)
            if existing.get('status') == 'ok':
                print('這個網址仍有舊版本機服務。請關閉原本 start.cmd 的視窗，再重新啟動。', flush=True)
                raise SystemExit(1)
        except (OSError, ValueError):
            pass
        print(f'無法啟動本機服務，請確認連接埠 {args.port} 未被其他程式使用：{exc}', flush=True)
        raise SystemExit(1)
    if args.cert or args.key:
        if not (args.cert and args.key):
            parser.error('--cert 和 --key 必須一起指定')
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(args.cert, args.key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = 'https'
    print(f'投籃簿本機服務 v{SERVER_VERSION} / 分析引擎 v{analyze.ANALYSIS_VERSION}: {local_url}', flush=True)
    if args.open_browser:
        webbrowser.open(local_url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
