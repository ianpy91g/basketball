"""Exercise local upload -> conversion -> analysis, plus media seeking."""
from pathlib import Path
import json
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
BASE = 'http://127.0.0.1:8765'


def request(path, data=None, headers=None):
    with urlopen(Request(BASE+path, data=data, headers=headers or {}), timeout=30) as r:
        return r.status, dict(r.headers), r.read()


def expect_error(path, code, data=None, headers=None):
    try:
        request(path, data, headers)
        raise AssertionError('Expected HTTP error')
    except HTTPError as e:
        assert e.code == code, (e.code, code)


status, headers, content = request('/sample/video.mp4', headers={'Range': 'bytes=0-99'})
assert status == 206 and len(content) == 100
assert headers['Content-Range'].startswith('bytes 0-99/')
expect_error('/sample/video.mp4', 416, headers={'Range': 'bytes=999999999999-'})
expect_error('/../basketball_shooting_summary.md', 404)
expect_error('/api/uploads', 403, b'x', {'Origin': 'https://example.invalid', 'X-Filename': 'x.mp4'})
expect_error('/api/uploads', 400, b'x', {'X-Filename': 'x.exe'})
payload=(ROOT/'artifacts/upload-test.mp4').read_bytes()
_, _, body=request('/api/uploads',payload,{'X-Filename':'upload-test.mp4'})
job_id=json.loads(body)['id']


def wait(expected):
    deadline=time.monotonic()+90
    while time.monotonic()<deadline:
        _, _, body=request('/api/jobs/'+job_id)
        job=json.loads(body)
        assert job['status']!='error',job
        if job['status']==expected:return
        time.sleep(.2)
    raise AssertionError('Job timed out')


wait('ready')
expect_error('/api/jobs/'+job_id+'/analyze',400,json.dumps({'hoop':{'left':1}}).encode(),{'Content-Type':'application/json'})
hoop={'left':48,'top':130,'right':110,'bottom':156}
request('/api/jobs/'+job_id+'/analyze',json.dumps({'hoop':hoop}).encode(),{'Content-Type':'application/json'})
wait('complete')
_,_,body=request('/media/'+job_id+'/analysis.json')
result=json.loads(body)
assert result['summary']['make']==1 and result['summary']['miss']==0,result['summary']
print('API passed: upload, conversion, 1 made shot, JSON, byte ranges, invalid input, same-origin guard, path allowlist')
