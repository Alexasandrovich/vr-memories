"""Temporarily share one VR memory on the user's LAN using an unguessable link."""
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import secrets
import threading
from urllib.parse import urlsplit


def byte_range(header: str | None, size: int) -> tuple[int, int, int]:
    if not header:
        return 0, size - 1, 200
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header)
    if not match or not any(match.groups()):
        raise ValueError("Unsupported byte range")
    left, right = match.groups()
    if not left:
        if int(right) == 0:
            raise ValueError("Empty byte range")
        start, end = max(0, size - int(right)), size - 1
    else:
        start, end = int(left), min(int(right), size - 1) if right else size - 1
    if start >= size or end < start:
        raise ValueError("Range outside file")
    return start, end, 206


def make_handler(path: Path, token: str):
    initial = path.stat()
    route = f"/{token}/memory.vrmemory"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # The capability URL should not be copied into access logs.

        def do_HEAD(self):
            self.respond(False)

        def do_GET(self):
            self.respond(True)

        def respond(self, body):
            if urlsplit(self.path).path != route:
                self.send_error(404)
                return
            current = path.stat()
            if (current.st_size, current.st_mtime_ns) != (initial.st_size, initial.st_mtime_ns):
                self.send_error(409, "The scene changed. Restart sharing.")
                return
            try:
                start, end, status = byte_range(self.headers.get("Range"), current.st_size)
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{current.st_size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(status)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", 'attachment; filename="memory.vrmemory"')
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("X-Content-Type-Options", "nosniff")
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{current.st_size}")
            self.end_headers()
            if not body:
                return
            try:
                with path.open("rb") as source:
                    source.seek(start)
                    remaining = end - start + 1
                    while remaining:
                        block = source.read(min(1024 * 1024, remaining))
                        if not block:
                            break
                        self.wfile.write(block)
                        remaining -= len(block)
            except (BrokenPipeError, ConnectionResetError):
                pass

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scene", type=Path)
    parser.add_argument("--lan", action="store_true")
    parser.add_argument("--address", default="127.0.0.1", help="Address displayed in the download link")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--minutes", type=int, default=60)
    args = parser.parse_args()
    if not 1 <= args.minutes <= 240:
        parser.error("Lifetime must be 1–240 minutes")
    from scene_bundle import inspect_bundle
    inspect_bundle(args.scene)
    token = secrets.token_urlsafe(24)
    server = ThreadingHTTPServer(("0.0.0.0" if args.lan else "127.0.0.1", args.port), make_handler(args.scene.resolve(), token))
    timer = threading.Timer(args.minutes * 60, server.shutdown)
    timer.daemon = True
    timer.start()
    print(json.dumps({"download_url": f"http://{args.address}:{args.port}/{token}/memory.vrmemory", "expires_in_minutes":args.minutes}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        timer.cancel()
        server.server_close()


if __name__ == "__main__":
    main()
