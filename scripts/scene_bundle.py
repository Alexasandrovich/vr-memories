"""Single-file VR memory: bounded JSON metadata followed by unchanged PLY bytes."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import struct

MAGIC = b"VRMEM01\n"
MAX_METADATA = 1024 * 1024


def pack_scene(directory: Path) -> Path:
    ply = directory / "scene.ply"
    metadata = json.loads((directory / "scene.json").read_text())
    with ply.open("rb") as source:
        metadata["ply_sha256"] = hashlib.file_digest(source, "sha256").hexdigest()
    metadata["ply_bytes"] = ply.stat().st_size
    header = json.dumps(metadata, ensure_ascii=False).encode("utf-8")
    if len(header) > MAX_METADATA:
        raise ValueError("Scene metadata exceeds the supported limit")
    target = directory / "scene.vrmemory"
    if target.exists():
        raise FileExistsError(target)
    temporary = directory / "scene.vrmemory.part"
    with temporary.open("xb") as output, ply.open("rb") as source:
        output.write(MAGIC)
        output.write(struct.pack("<I", len(header)))
        output.write(header)
        shutil.copyfileobj(source, output)
    temporary.rename(target)
    return target


def inspect_bundle(path: Path) -> dict:
    with path.open("rb") as source:
        if source.read(8) != MAGIC:
            raise ValueError("Invalid VR memory signature")
        length_bytes = source.read(4)
        if len(length_bytes) != 4:
            raise ValueError("Truncated header")
        length = struct.unpack("<I", length_bytes)[0]
        if not 1 <= length <= MAX_METADATA:
            raise ValueError("Invalid metadata length")
        data = source.read(length)
        if len(data) != length:
            raise ValueError("Truncated metadata")
        metadata = json.loads(data)
        size = path.stat().st_size - 12 - length
        if size != metadata["ply_bytes"]:
            raise ValueError("Truncated or mismatched scene payload")
        if hashlib.file_digest(source, "sha256").hexdigest() != metadata["ply_sha256"]:
            raise ValueError("Scene checksum mismatch")
    return metadata


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    if args.path.is_dir():
        print(pack_scene(args.path))
    else:
        print(json.dumps(inspect_bundle(args.path), indent=2))
