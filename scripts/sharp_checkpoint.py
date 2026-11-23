"""Fetch the pinned SHARP research checkpoint from this project's GitHub release."""
import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
from urllib.request import urlopen
from zipfile import ZipFile

NAME = "sharp_2572gikvuh.pt"
SIZE = 2809738232
SHA256 = "94211a75198c47f61fca7d739ba08a215418d8d398d48fddf023baccc24f073d"
RELEASE = "https://github.com/Alexasandrovich/vr-memories/releases/download/sharp-2572gikvuh"
PARTS = (1450000000, SIZE - 1450000000)


def stream_sha256(stream):
    digest = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(block)
    return digest.hexdigest()


def verify(path):
    if path.stat().st_size != SIZE:
        raise ValueError(f"Unexpected size for {path.name}")
    with path.open("rb") as stream:
        if stream_sha256(stream) != SHA256:
            raise ValueError(f"SHA-256 mismatch for {path.name}")


def fetch(path):
    path = Path(path)
    if path.exists():
        verify(path)
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=path.parent) as work:
        archive = Path(work) / "download.zip"
        assembled = Path(work) / NAME
        with assembled.open("wb") as output:
            for index, expected in enumerate(PARTS, 1):
                stem = f"sharp-part-{index:02}"
                print(f"Downloading SHARP part {index}/{len(PARTS)}", flush=True)
                with urlopen(f"{RELEASE}/{stem}.zip", timeout=120) as response, archive.open("wb") as out:
                    shutil.copyfileobj(response, out, length=1024 * 1024)
                with ZipFile(archive) as bundle:
                    if bundle.getinfo(stem).file_size != expected:
                        raise ValueError(f"Unexpected size for {stem}")
                    with bundle.open(stem) as part:
                        shutil.copyfileobj(part, output, length=1024 * 1024)
                archive.unlink()
        verify(assembled)
        assembled.replace(path)
    return path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, nargs="?", default=Path(NAME))
    print(fetch(parser.parse_args().destination))
