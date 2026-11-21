#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
if [[ -f .local/launcher.env ]]; then source .local/launcher.env; fi
python_bin="${VR_PYTHON:-python3}"
lan_address="${VR_LAN_ADDRESS:-$(ipconfig getifaddr en0)}"
exec "$python_bin" scripts/serve_local.py --address "$lan_address" --path vr \
  --preview-port 8765 --album "${1:-${VR_ALBUM_DIR:-$HOME/Pictures}}"
