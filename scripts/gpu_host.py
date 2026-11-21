"""Resolve the SSH destination shared by reconstruction and rendering."""
import os
from pathlib import Path

host_file = Path(__file__).resolve().parents[1] / ".local" / "gpu-host"
GPU_HOST = os.environ.get("VR_GPU_HOST") or (
    host_file.read_text().strip() if host_file.is_file() else "vr-gpu"
)
if not GPU_HOST or GPU_HOST.startswith("-") or any(c.isspace() for c in GPU_HOST):
    raise ValueError("VR_GPU_HOST must be an SSH destination such as user@gpu")
