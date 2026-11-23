"""A local photo catalogue, thumbnail service and one-at-a-time GPU build queue."""
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from sharp_checkpoint import stream_sha256
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import threading
import time
from PIL import Image, ImageOps
from gpu_host import GPU_HOST

FORMATS = {".jpg", ".jpeg", ".png", ".webp"}
SSH = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "ServerAliveInterval=10",
       "-o", "ServerAliveCountMax=3", GPU_HOST]
HELPER = "cd vr-memories && .venv/bin/python research-v2/build_album_scene.py"


def build_command(mode, digest):
    if os.environ.get("VR_LOCAL_GPU") == "1":
        return [sys.executable, str(Path(__file__).with_name("build_album_scene.py")), mode, digest]
    return SSH + [f"{HELPER} {mode} {digest}"]


class PhotoAlbum:
    def __init__(self, folder, output):
        self.folder = folder.resolve()
        self.output = output
        self.lock = threading.RLock()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="album")
        self.paths = {}
        self.jobs = {}
        self.known = {}
        for directory, name in [("023-2-jpg","023-2"), ("mountain-memory","mountain-memory")]:
            path = output / directory / "scene.json"
            if path.exists():
                data = json.loads(path.read_text())
                self.known[data["source_sha256"]] = self.ready(name, data)

    @staticmethod
    def ready(name, data):
        return dict(state="ready", scene=name, width=data["width"], height=data["height"],
                    fov=data["vertical_fov_deg"])

    @staticmethod
    @lru_cache(maxsize=4096)
    def digest(path, signature):
        with path.open("rb") as stream:
            return stream_sha256(stream)

    def catalog(self):
        photos, paths = [], {}
        if not self.folder.is_dir():
            raise FileNotFoundError("Папка альбома недоступна на Mac")
        for path in sorted(self.folder.rglob("*"), key=lambda p:p.as_posix().casefold()):
            relative = path.relative_to(self.folder)
            if any(part.startswith(".") for part in relative.parts) or path.suffix.lower() not in FORMATS:
                continue
            if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(self.folder):
                continue
            try:
                stat = path.stat()
                key = self.digest(path,(stat.st_size,stat.st_mtime_ns,stat.st_ino))
            except FileNotFoundError:
                continue
            paths[key] = path
            with self.lock:
                ready = self.jobs.get(key,self.known.get(key,{})).get("state") == "ready"
            photos.append(dict(id=key, name=str(relative), ready=ready))
        with self.lock:
            self.paths = paths
        return dict(name=self.folder.name, photos=photos)

    def photo(self, key):
        with self.lock:
            path = self.paths.get(key)
        if path is None or not path.resolve().is_relative_to(self.folder) or not path.is_file():
            raise KeyError("Фотография больше недоступна")
        return path

    @staticmethod
    @lru_cache(maxsize=256)
    def make_thumbnail(key, path):
        with Image.open(path) as image:
            image.draft("RGB",(512,512))
            oriented = ImageOps.exif_transpose(image)
            oriented.thumbnail((480,480))
            image = oriented.convert("RGB")
            out = io.BytesIO()
            image.save(out,"JPEG",quality=86)
            return out.getvalue()

    def status(self,key):
        with self.lock:
            return self.jobs.get(key,self.known.get(key,{"state":"idle"})).copy()

    def select(self,key):
        self.photo(key)
        with self.lock:
            current = self.status(key)
            if current["state"] in ("idle","error"):
                self.jobs[key] = {"state":"queued"}
                self.worker.submit(self.build,key)
            return self.status(key)

    def update(self,key,**data):
        with self.lock:
            self.jobs[key] = data

    def build(self,key):
        try:
            self.update(key,state="checking")
            # Only a digest obtained from the catalogue reaches the remote shell.
            assert re.fullmatch("[a-f0-9]{64}",key)
            result = subprocess.run(build_command("check", key),capture_output=True,check=True,timeout=30)
            data = json.loads(result.stdout)
            if data is None:
                self.update(key,state="building")
                with self.photo(key).open("rb") as stream:
                    result = subprocess.run(build_command("build", key),stdin=stream,capture_output=True,check=True,timeout=420)
                data = json.loads(result.stdout)
            self.update(key,**self.ready("album-"+key,data))
        except Exception as error:
            detail = getattr(error,"stderr",b"") or b""
            print("Album build:",key[:10],str(error),detail[-1200:].decode(errors="replace"),flush=True)
            self.update(key,state="error",message="Не удалось подготовить сцену на RTX. Можно повторить.")

class AlbumPairing:
    """Short-lived local enrollment code; remember only hashes of device cookies."""
    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()
        self.code = None
        self.expires = 0
        self.attempts = []
        self.tokens = set(json.loads(store.read_text()) if store.exists() else [])

    def local_code(self):
        with self.lock:
            if not self.code or time.monotonic() >= self.expires:
                self.code = f"{secrets.randbelow(1000000):06d}"
                self.expires = time.monotonic()+900
            return self.code

    def authorize(self, value):
        now = time.monotonic()
        with self.lock:
            self.attempts = [t for t in self.attempts if now-t<60]
            if len(self.attempts)>=8:
                raise TimeoutError("Подождите минуту перед следующей попыткой.")
            self.attempts.append(now)
            if not self.code or self.expires<=now or not secrets.compare_digest(self.code,value):
                return None
            token = secrets.token_urlsafe(32)
            enrolled = self.tokens | {hashlib.sha256(token.encode()).hexdigest()}
            temp = self.store.with_suffix(".tmp")
            fd = os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
            with os.fdopen(fd,"w") as f:
                json.dump(sorted(enrolled),f)
            temp.replace(self.store)
            self.tokens = enrolled
            self.code = None
            self.attempts.clear()
            return token

    def accepts(self,token):
        return hashlib.sha256(token.encode()).hexdigest() in self.tokens
