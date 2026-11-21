"""One persistent, private SSH stream from the Mac to the SHARP renderer."""
from collections import OrderedDict
from gpu_host import GPU_HOST
import json
import math
import os
import re
import select
import struct
import subprocess
import threading
import time

_lock = threading.Lock()
_process = None
_last_sequences = OrderedDict()


def validate(q):
    if not isinstance(q, dict) or not isinstance(q.get('id'),str) or not re.fullmatch(r'[a-zA-Z0-9-]{1,64}',q['id']):
        raise ValueError('Invalid session')
    scene = q.get('scene', 'mountain-memory')
    if not isinstance(scene,str) or (scene not in ('mountain-memory', '023-2') and not re.fullmatch(r'album-[a-f0-9]{64}',scene)):
        raise ValueError('Unknown scene')
    if 'sequence' in q and (type(q['sequence']) is not int or not 0 < q['sequence'] < 2**53):
        raise ValueError('Invalid sequence')
    if type(q.get('key')) is not bool:
        raise ValueError('Invalid keyframe flag')
    for name in ('w','h'):
        n = q.get(name)
        if type(n) is not int or not 64 <= n <= 2048 or n % 2:
            raise ValueError('Invalid image size')
    for key, length in [('v',32),('k',18)]:
        a=q.get(key)
        if not isinstance(a,list) or len(a)!=length or not all(type(x) in (float,int) and math.isfinite(x) and abs(x)<100000 for x in a):
            raise ValueError('Invalid camera')
    for offset in (0,9):
        if not (1 <= q['k'][offset] <= 8192 and 1 <= q['k'][offset+4] <= 8192):
            raise ValueError('Invalid focal length')


def read_exact(fd, count, deadline):
    result=bytearray()
    while len(result)<count:
        if not select.select([fd],[],[],max(0,deadline-time.monotonic()))[0]:
            raise TimeoutError('GPU timed out')
        chunk=os.read(fd,count-len(result))
        if not chunk:
            raise ConnectionError('GPU stream ended')
        result.extend(chunk)
    return result


def render(q):
    global _process
    validate(q)
    with _lock:
        # Two HTTP requests may arrive out of order on different connections.
        # Only encode monotonically newer poses in a given H.264 stream.
        sequence = q.get('sequence')
        if sequence is not None:
            if sequence <= _last_sequences.get(q['id'], 0):
                return b'', False
            _last_sequences[q['id']] = sequence
            _last_sequences.move_to_end(q['id'])
            if len(_last_sequences) > 128:
                _last_sequences.popitem(last=False)
        if _process is None or _process.poll() is not None:
            _process=subprocess.Popen(['ssh','-T','-o','BatchMode=yes','-o','ConnectTimeout=5',
                GPU_HOST,'cd vr-memories && PATH="$PWD/.venv/bin:/usr/local/cuda-12.4/bin:$PATH" CUDA_HOME=/usr/local/cuda-12.4 research-v2/apple-depth-env/bin/python -u research-v2/stream_sharp.py outputs/mountain-memory/scene.ply'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,bufsize=0)
            q['key']=True
        try:
            _process.stdin.write(json.dumps(q,allow_nan=False).encode()+b'\n')
            fd=_process.stdout.fileno()
            deadline=time.monotonic()+40
            size, key = struct.unpack('!IB',read_exact(fd,5,deadline))
            if not 0<size<=12000000:
                raise ValueError('Invalid GPU response')
            return read_exact(fd,size,deadline), bool(key)
        except Exception:
            _process.kill();_process.wait();_process=None
            raise
