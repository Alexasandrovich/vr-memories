#!/bin/sh
set -eu
if [ -z "${VR_LAN_ADDRESS:-}" ]; then
    VR_LAN_ADDRESS=$(python -c 'import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(("192.0.2.1", 9)); print(s.getsockname()[0])')
fi
test -d /photos
python -c 'import torch; assert torch.cuda.is_available(), "No CUDA GPU visible to Docker"'
python scripts/sharp_checkpoint.py /app/models/sharp_2572gikvuh.pt
ln -sfn /app/models/sharp_2572gikvuh.pt /app/sharp_2572gikvuh.pt
if [ ! -d outputs/mountain-memory ]; then
    work=$(mktemp -d outputs/.startup-XXXXXX)
    trap 'rm -rf -- "$work"' EXIT
    python scripts/reconstruct.py example/photo.webp "$work/scene" --horizontal-fov 50 --checkpoint /app/sharp_2572gikvuh.pt
    mv "$work/scene" outputs/mountain-memory
    rmdir "$work"
    trap - EXIT
fi
ln -sfnT mountain-memory outputs/023-2-jpg
exec python scripts/serve_local.py --address "$VR_LAN_ADDRESS" --port "${VR_PORT:-8443}" --path vr --preview-port "${VR_PREVIEW_PORT:-8765}" --album /photos
