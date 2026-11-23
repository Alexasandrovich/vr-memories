"""Check or atomically build one content-addressed SHARP scene on the RTX host."""
import argparse
import fcntl
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))
from sharp_checkpoint import stream_sha256


def metadata(target, digest):
    data = json.loads((target / "scene.json").read_text())
    if data["source_sha256"] != digest or not (target / "scene.ply").is_file():
        raise ValueError("Incomplete scene")
    return {key: data[key] for key in ("width", "height", "vertical_fov_deg", "gaussian_count")}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["check", "build"])
    parser.add_argument("digest", type=lambda s: s if re.fullmatch("[0-9a-f]{64}", s) else parser.error("Invalid digest"))
    args = parser.parse_args()
    cache = ROOT / "outputs" / "album"
    cache.mkdir(exist_ok=True)
    target = cache / args.digest
    if args.mode == "check":
        print(json.dumps(metadata(target, args.digest) if target.exists() else None))
        return
    with tempfile.TemporaryDirectory(dir=cache, prefix=".building-") as tmp:
        photo = Path(tmp) / "source"
        with photo.open("wb") as stream:
            shutil.copyfileobj(sys.stdin.buffer, stream)
        with photo.open("rb") as stream:
            if stream_sha256(stream) != args.digest:
                raise ValueError("Source changed during transfer")
        with (cache / ".build.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not target.exists():
                output = Path(tmp) / "scene"
                subprocess.run([sys.executable, str(ROOT / "reconstruct.py"), str(photo), str(output),
                                "--checkpoint", str(ROOT / "sharp_2572gikvuh.pt"), "--stream-only"],
                               check=True, stdout=sys.stderr)
                metadata(output, args.digest)
                output.rename(target)
    print(json.dumps(metadata(target, args.digest)))


if __name__ == "__main__":
    main()
