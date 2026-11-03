"""Generate small test fixtures from the local MP4, without editing the original."""
from pathlib import Path
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
ffmpeg = shutil.which('ffmpeg')
if not ffmpeg:
    raise SystemExit('FFmpeg is required')
base = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-ss', '17.5', '-i',
        str(root/'artifacts/source.mp4'), '-t', '3', '-an']
subprocess.run(base+['-vf', 'scale=640:360', '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe',
                     '-y', str(root/'artifacts/camera-test.y4m')], check=True)
subprocess.run(base+['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24',
                     '-y', str(root/'artifacts/upload-test.mp4')], check=True)
print('Created 3-second camera and upload fixtures')
