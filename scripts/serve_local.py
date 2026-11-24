"""Self-host the VR viewer and one selected scene over HTTPS on the LAN."""
from __future__ import annotations

import argparse
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import secrets
import re
import ssl
import socket
import subprocess
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit

from scene_bundle import inspect_bundle
from share_memory import byte_range
from remote_frames import render as render_remote_frame

ROOT = Path(__file__).resolve().parents[1]


class TLSHTTPServer(ThreadingHTTPServer):
    def __init__(self, address, handler, context):
        self.tls_context = context
        super().__init__(address, handler)

    def get_request(self):
        connection, address = super().get_request()
        print(f'TCP connection from {address[0]}', flush=True)
        connection.settimeout(20)
        # Protocol detection and TLS happen in the request thread. A stalled
        # client must not block acceptance of other connections.
        return connection, address


def make_handler(dist: Path, scene: Path, token: str, album=None, pairing=None):
    dist, scene = dist.resolve(), scene.resolve()
    prefix = f'/{token}/'
    last_xr_sample = None

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        disable_nagle_algorithm = True
        def log_message(self, *_):
            pass

        def setup(self):
            if isinstance(self.server, TLSHTTPServer) and self.request.recv(1, socket.MSG_PEEK) == b'\x16':
                try:
                    self.request = self.server.tls_context.wrap_socket(self.request, server_side=True)
                    print(f'TLS ready from {self.client_address[0]}', flush=True)
                except (OSError, ssl.SSLError) as error:
                    print(f'TLS failed from {self.client_address[0]}: {getattr(error, "reason", type(error).__name__)}', flush=True)
                    raise
            super().setup()

        def on_mac(self):
            return (self.client_address[0]=='127.0.0.1' and self.server.server_address[0]=='127.0.0.1'
                    and urlsplit('//'+self.headers.get('Host','')).hostname in ('localhost','127.0.0.1'))

        def album_access(self):
            if self.on_mac():
                return True
            if not pairing or not isinstance(self.connection,ssl.SSLSocket):
                return False
            jar=SimpleCookie()
            try:
                jar.load(self.headers.get('Cookie',''))
            except CookieError:
                return False
            cookie=jar.get('vr_album_device')
            return bool(cookie and pairing.accepts(cookie.value))

        def do_GET(self):
            self.respond(True)

        def do_HEAD(self):
            self.respond(False)

        def do_POST(self):
            nonlocal last_xr_sample
            route = urlsplit(self.path).path
            if route not in (prefix+'frame',prefix+'album/select',prefix+'album/pair') or self.headers.get_content_type() != 'application/json':
                self.send_error(404)
                return
            origin = self.headers.get('Origin', '')
            if urlsplit(origin).netloc != self.headers.get('Host') or self.headers.get('Sec-Fetch-Site') == 'cross-site':
                self.send_error(403)
                return
            try:
                length = int(self.headers.get('Content-Length', 0))
                if not 0 < length <= 7000:
                    raise ValueError()
                request = json.loads(self.rfile.read(length))
                if not isinstance(request, dict):
                    raise ValueError()
                if route == prefix+'album/pair':
                    if not pairing or not isinstance(self.connection,ssl.SSLSocket):
                        self.send_error(403)
                        return
                    code=request.get('code')
                    if not isinstance(code,str) or not re.fullmatch(r'[0-9]{6}',code):
                        raise ValueError()
                    try:
                        device=pairing.authorize(code)
                    except TimeoutError:
                        self.send_error(429)
                        return
                    if not device:
                        self.send_error(403)
                        return
                    self.send_response(200)
                    self.common_headers('application/json',2)
                    self.send_header('Set-Cookie',f'vr_album_device={device}; Path={prefix}; Max-Age=7776000; Secure; HttpOnly; SameSite=Strict')
                    self.end_headers()
                    self.wfile.write(b'{}')
                    return
                if route == prefix+'album/select':
                    if not self.album_access():
                        self.send_error(401)
                        return
                    if not album or not isinstance(request.get('id'),str):
                        raise ValueError()
                    try:
                        state = album.select(request['id'])
                    except KeyError:
                        self.send_error(404, 'Photo unavailable')
                        return
                    self.payload(json.dumps(state).encode(),'application/json',True)
                    return
                selected = request.get('scene')
                if isinstance(selected,str) and selected.startswith('album-') and (
                    not self.album_access() or album is None or album.status(selected[6:]).get('scene') != selected
                ):
                    self.send_error(404, 'Prepare this photo first')
                    return
                stats = request.pop('xrStats', None)
                frame, key = render_remote_frame(request)
                if isinstance(stats, list) and len(stats) in (3, 5) and all(type(n) is int and 0 <= n <= 60000 for n in stats):
                    last_xr_sample = dict(time=int(time.time()), display_fps=stats[0],
                                          stereo_fps=stats[1], latency_ms=stats[2])
                    if len(stats) == 5:
                        last_xr_sample.update(display_p95_ms=stats[3], stereo_gap_p95_ms=stats[4])
            except (ValueError, TypeError):
                self.send_error(400, 'Invalid camera request')
                return
            except (OSError, TimeoutError) as error:
                print(f'SHARP stream: {error}', flush=True)
                self.send_error(503, 'GPU stream unavailable')
                return
            self.send_response(200 if frame else 204)
            self.common_headers('application/octet-stream',len(frame))
            self.send_header('X-Keyframe','1' if key else '0')
            self.end_headers()
            try:
                self.wfile.write(frame)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def respond(self, body):
            route = unquote(urlsplit(self.path).path)
            if isinstance(self.server, TLSHTTPServer) and not isinstance(self.connection, ssl.SSLSocket):
                if not (route.startswith(prefix) or route == prefix[:-1]):
                    self.send_error(404)
                    return
                host, port = self.server.server_address[:2]
                self.send_response(308)
                self.send_header('Location', f'https://{host}:{port}{prefix}')
                self.send_header('Content-Length', '0')
                self.send_header('Connection', 'close')
                self.end_headers()
                print(f'HTTP redirected to HTTPS for {self.client_address[0]}', flush=True)
                return
            if route == prefix[:-1]:
                self.send_response(302)
                self.send_header('Location', prefix)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            if not route.startswith(prefix):
                self.send_error(404)
                return
            relative = route[len(prefix):] or 'index.html'
            if '\\' in relative or any(p in ('.', '..') or p.startswith('.') for p in relative.split('/')):
                self.send_error(404)
                return
            if relative == 'album/code':
                if not self.on_mac() or not pairing or self.headers.get('Sec-Fetch-Site')=='cross-site':
                    self.send_error(403)
                    return
                code=pairing.local_code()
                self.payload(('Код для альбома в Quest: '+code+'\nВведите его в шлеме в течение 15 минут.').encode(),'text/plain; charset=utf-8',body)
                return
            if relative.startswith('album/'):
                if not self.album_access():
                    self.send_error(401)
                    return
                if album is None:
                    self.send_error(404,'Album not configured')
                    return
                try:
                    if relative == 'album/catalog':
                        self.payload(json.dumps(album.catalog(),ensure_ascii=False).encode(),'application/json',body)
                        return
                    volume = re.fullmatch(r'album/volume/([a-f0-9]{64})', relative)
                    if volume:
                        key = volume[1]
                        album.photo(key)
                        prepared = album.prepared_volume(key)
                        if prepared:
                            self.file_response(prepared, body)
                            return
                    match = re.fullmatch(r'album/(thumb|status)/([a-f0-9]{64})',relative)
                    if match:
                        kind,key = match.groups()
                        path = album.photo(key)
                        if kind == 'thumb':
                            self.payload(album.make_thumbnail(key,path),'image/jpeg',body)
                        else:
                            self.payload(json.dumps(album.status(key)).encode(),'application/json',body)
                        return
                except (KeyError,OSError):
                    pass
                self.send_error(404,'Album item unavailable')
                return
            if relative == 'xr-stats' and self.client_address[0] == '127.0.0.1':
                data = json.dumps(last_xr_sample).encode()
                self.send_response(200)
                self.common_headers('application/json', len(data))
                self.end_headers()
                if body:
                    self.wfile.write(data)
                return
            if relative == 'local-scene.json':
                data = json.dumps({'available':True,'album':album is not None}).encode()
                self.send_response(200)
                self.common_headers('application/json', len(data))
                self.end_headers()
                if body:
                    self.wfile.write(data)
                return
            if relative in ('volume-loader.js', 'volume-material.js', 'volume-worker.js', 'vendor/meshopt-encoder.js'):
                self.file_response(ROOT / 'docs' / relative, body)
                return
            path = scene if relative == 'scene.vrmemory' else (dist / relative).resolve()
            if relative == 'scene.vrmemory' and parse_qs(urlsplit(self.path).query).get('scene') == ['023-2']:
                path = ROOT / 'outputs/023-2-jpg/scene.vrmemory'
            if relative != 'scene.vrmemory' and not path.is_relative_to(dist):
                self.send_error(404)
                return
            self.file_response(path, body)

        def file_response(self, path, body):
            if not path.is_file():
                self.send_error(404)
                return
            try:
                with path.open('rb') as source:
                    size = os.fstat(source.fileno()).st_size
                    try:
                        start, end, status = byte_range(self.headers.get('Range'), size)
                    except ValueError:
                        self.send_response(416)
                        self.send_header('Content-Range', f'bytes */{size}')
                        self.send_header('Content-Length', '0')
                        self.end_headers()
                        return
                    self.send_response(status)
                    mime = 'application/octet-stream' if path == scene else mimetypes.guess_type(path)[0] or 'application/octet-stream'
                    self.common_headers(mime, end - start + 1)
                    self.send_header('Accept-Ranges', 'bytes')
                    if status == 206:
                        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                    self.end_headers()
                    if body:
                        source.seek(start)
                        remaining = end - start + 1
                        while remaining:
                            block = source.read(min(1048576, remaining))
                            if not block:
                                break
                            self.wfile.write(block)
                            remaining -= len(block)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def payload(self, data, mime, body):
            self.send_response(200)
            self.common_headers(mime,len(data))
            self.end_headers()
            if body:
                self.wfile.write(data)

        def common_headers(self, mime, length):
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(length))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Cross-Origin-Resource-Policy','same-origin')
            self.send_header('X-Frame-Options','DENY')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Permissions-Policy', 'xr-spatial-tracking=(self)')

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--address', required=True, help='Local IPv4 address of this Mac')
    parser.add_argument('--port', type=int, default=8443)
    parser.add_argument('--scene', type=Path, default=ROOT / 'outputs/mountain-memory/scene.vrmemory')
    parser.add_argument('--album', type=Path, help='Local photo folder for the immersive gallery')
    parser.add_argument('--preview-port', type=int, help='Optional HTTP preview on 127.0.0.1 only')
    parser.add_argument('--path', help='Readable URL path instead of the private random link (e.g. vr)')
    args = parser.parse_args()
    if args.path and not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', args.path):
        parser.error('--path must contain only letters, digits, underscores or hyphens')
    address = ipaddress.IPv4Address(args.address)
    if not address.is_private or address.is_unspecified:
        parser.error('Use the private LAN address of this computer')
    inspect_bundle(args.scene)
    private = ROOT / '.local'
    private.mkdir(mode=0o700, exist_ok=True)
    token_file = private / 'access-token'
    if not token_file.exists():
        token_file.write_text(secrets.token_urlsafe(16))
        token_file.chmod(0o600)
    token = args.path or token_file.read_text().strip()
    cert, key = private / f'{address}.crt', private / f'{address}.key'
    valid = cert.exists() and key.exists() and subprocess.run(
        ['openssl', 'x509', '-checkend', '86400', '-noout', '-in', str(cert)],
        capture_output=True).returncode == 0
    if not valid:
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-keyout', str(key), '-out', str(cert), '-days', '365',
                        '-subj', '/CN=VR Memories Local', '-addext',
                        f'subjectAltName=IP:{address},IP:127.0.0.1,DNS:localhost'],
                       check=True, capture_output=True)
        key.chmod(0o600)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert, key)
    album = pairing = None
    if args.album:
        from photo_album import PhotoAlbum, AlbumPairing
        album = PhotoAlbum(args.album, ROOT / 'outputs')
        import hashlib
        scope = hashlib.sha256(str(album.folder).encode()).hexdigest()[:16]
        pairing = AlbumPairing(private / f'album-{scope}-devices.json')
    handler = make_handler(ROOT / 'viewer/dist', args.scene, token, album, pairing)
    server = TLSHTTPServer((str(address), args.port), handler, context)
    preview = None
    if args.preview_port:
        preview = ThreadingHTTPServer(('127.0.0.1', args.preview_port), handler)
        threading.Thread(target=preview.serve_forever, daemon=True).start()
    print(json.dumps({'url':f'https://{address}:{args.port}/{token}/',
                      'preview_url':f'http://127.0.0.1:{args.preview_port}/{token}/' if preview else None,
                      'certificate':str(cert), 'pid':os.getpid()}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if preview:
            preview.shutdown()
            preview.server_close()


if __name__ == '__main__':
    main()
