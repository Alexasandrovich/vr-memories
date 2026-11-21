"""Record native RTX references, exercise the shipping WebGL shader and track silhouette motion.

Start the self-hosted viewer, install Python numpy, opencv-python and Pillow,
and put ffmpeg and Node with Playwright on PATH. CHROME_PATH can select a
system Chrome. Use NODE_PATH for a shared Playwright installation.
"""
import argparse
import functools
import http.client
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit
import zlib

import cv2
import numpy as np
from PIL import Image

PROJECT = Path(__file__).resolve().parents[1]


def capture(root, url, scene):
    left, top = (405, 695) if scene == "023-2" else (605, 590)
    (root / "crop.json").write_text(json.dumps([left, top]))
    connection = http.client.HTTPConnection(url.netloc, timeout=90)
    events = [
        (0, 0),
        (6, 7),
        (12, 13),
        (19, 20),
        (25, 24),
        (32, 19),
        (39, 12),
        (46, 5),
        (52, 0),
    ]

    def request(i, x, session, key, align):
        v = []
        for eye in [-0.0315, 0.0315]:
            v.extend([1, 0, 0, -eye - x, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
        q = dict(
            id=session,
            scene=scene,
            sequence=i + 1,
            w=1440,
            h=1584,
            v=v,
            k=[800, 0, 720, 0, 800, 792, 0, 0, 1] * 2,
            key=key,
            depth=align,
            motionField=align,
            contourMotion=align,
        )
        connection.request(
            "POST",
            url.path.rstrip("/") + "/frame",
            json.dumps(q),
            {
                "Origin": url.scheme + "://" + url.netloc,
                "Content-Type": "application/json",
            },
        )
        r = connection.getresponse()
        b = r.read()
        assert r.status == 200, (r.status, b[:150])
        return b

    session = "replay" + str(time.monotonic_ns())

    def decode_stream(data, count, callback):
        p = subprocess.Popen(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "h264",
                "-i",
                str(data),
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
            ],
            stdout=subprocess.PIPE,
        )
        for i in range(count):
            frame = p.stdout.read(2880 * 1584 * 3)
            assert len(frame) == 2880 * 1584 * 3
            callback(i, np.frombuffer(frame, np.uint8).reshape(1584, 2880, 3))
        assert p.wait() == 0

    movie = root / "pairs.h264"
    with movie.open("wb") as file:
        for i, (t, x) in enumerate(events):
            b = request(i, x * 0.008, session, i == 0, True)
            magic, w, h, n, base = struct.unpack("!4sHHIQ", b[:20])
            assert magic == b"VRA2" and base == i
            raw = zlib.decompress(b[20 : 20 + n])
            (root / ("field%d.bin" % i)).write_bytes(raw)
            file.write(b[20 + n :])
    decode_stream(
        movie,
        len(events),
        lambda i, im: Image.fromarray(im).save(
            root / ("pair%d.png" % i), compress_level=1
        ),
    )
    movie = root / "reference.h264"
    with movie.open("wb") as file:
        for i in range(27):
            file.write(request(i, i * 0.008, session + "ref", True, False))

    def store_ref(i, im):
        for j, eye in enumerate([0, 1440]):
            Image.fromarray(im[top:top+270, eye+left:eye+left+260]).save(
                root / ("ref%d-%d.png" % (j, i))
            )

    decode_stream(movie, 27, store_ref)
    (root / "events.json").write_text(json.dumps(events))
    print(
        "Recorded",
        len(events),
        "stereo anchors and 27 separate stereo reference images",
    )


def score(root, region):
    results = []
    for eye in (0, 1):
        gt = [
            np.asarray(
                Image.open(root / ("ref%d-%d.png" % (eye, t if t <= 26 else 52 - t)))
            ).astype("f")
            for t in range(53)
        ]
        raw = [
            np.fromfile(root / ("edge-%d-%d.rgb" % (eye, m)), np.uint8)
            .reshape(53, 270, 260, 3)
            .astype("f")
            for m in (0, 1)
        ]
        if np.abs(raw[0][0] - gt[0]).mean() > 1:
            raise ValueError("Origin does not match the native render")
        tracks = []
        for yy in range(38, 250, 4):
            gray = gt[0][yy].mean(1)
            dark = np.flatnonzero(
                (gray < 72) & (np.arange(260) > 32) & (np.arange(260) < 250)
            )
            if not len(dark):
                continue
            if region == "silhouette":
                locations = (dark[0], dark[-1])
            else:
                gradients = np.abs(np.gradient(gray))
                locations = (
                    12 + np.argmax(gradients[12:42]),
                    220 + np.argmax(gradients[220:247]),
                )
            for pos in locations:
                if not 12 < pos < 247:
                    continue
                prev = pos
                track = []
                for r in gt:
                    line = cv2.GaussianBlur(
                        r[yy - 1 : yy + 2].mean(0).mean(-1)[None, :], (5, 1), 0.8
                    )[0]
                    grad = np.abs(np.gradient(line))
                    lo = max(13, prev - 7)
                    hi = min(len(line) - 13, prev + 8)
                    px = lo + np.argmax(grad[lo:hi])
                    prev = px
                    if grad[px] < 6:
                        break
                    track.append(px)
                if len(track) == len(gt):
                    tracks.append((yy, track))
        for mode, frames in enumerate(raw):
            errors = []
            for y, track in tracks:
                e = []
                for f, r, x in zip(frames, gt, track):
                    target = r[y - 1 : y + 2, x - 2 : x + 3]
                    d = np.array(
                        [
                            np.mean(
                                (target - f[y - 1 : y + 2, x + k - 2 : x + k + 3]) ** 2
                            )
                            for k in range(-7, 8)
                        ]
                    )
                    j = np.argmin(d)
                    delta = 0
                    if 0 < j < 14:
                        delta = (d[j - 1] - d[j + 1]) / (
                            2 * (d[j - 1] + d[j + 1] - 2 * d[j]) + 1e-6
                        )
                    e.append(j - 7 + delta)
                errors.append(e)
            err = np.array(errors)
            jump = np.abs(np.diff(err, axis=1))
            seam = jump[:, [5, 11, 18, 24, 31, 38, 45, 51]]
            results.append(
                dict(
                    region=region,
                    eye=eye,
                    correction=bool(mode),
                    tracks=len(tracks),
                    position_p95=float(np.percentile(np.abs(err), 95)),
                    jump_p95=float(np.percentile(jump, 95)),
                    refresh_jump_p95=float(np.percentile(seam, 95)),
                    worst_jump=float(jump.max()),
                )
            )
    return results


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8765/vr/")
    parser.add_argument("--scene", choices=("mountain-memory","023-2"), default="mountain-memory")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    url = urlsplit(args.url)
    if url.scheme != "http" or url.hostname not in ("localhost", "127.0.0.1"):
        parser.error("Use the loopback preview URL on the host Mac")
    with tempfile.TemporaryDirectory(prefix="sharp-contour-") as tmp:
        web = Path(tmp)
        root = web / "qa"
        root.mkdir()
        capture(root, url, args.scene)
        (web / "vendor").symlink_to(
            PROJECT / "viewer/dist/vendor", target_is_directory=True
        )
        shutil.copy(PROJECT / "viewer/dist/reproject.js", web)
        shutil.copy(PROJECT / "tests/contour-replay.html", web)

        class Quiet(SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(
            ("127.0.0.1", 0), functools.partial(Quiet, directory=str(web))
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            subprocess.run(
                [
                    "node",
                    str(PROJECT / "tests/contour-replay.cjs"),
                    f"http://127.0.0.1:{server.server_port}/contour-replay.html",
                    str(root),
                ],
                check=True,
            )
        finally:
            server.shutdown()
            server.server_close()
        results = score(root, "silhouette") + score(root, "background")
        report = json.dumps(results, indent=2)
        print(report)
        if args.output:
            args.output.write_text(report + "\n")
        for before, after in zip(results[::2], results[1::2]):
            if (
                after["tracks"] < 30
                or (
                    after["region"] == "silhouette" and after["refresh_jump_p95"] > 1.25
                )
                or after["jump_p95"] >= before["jump_p95"]
            ):
                raise SystemExit("Silhouette motion regression")


if __name__ == "__main__":
    run()
