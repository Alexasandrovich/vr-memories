#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo 'Usage: bash run_memory.sh INPUT_PHOTO NEW_OUTPUT_DIRECTORY [IPD_MM]' >&2
  exit 2
fi
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# The scripts live at the project root on the compute host.
if [[ ! -x "$project_root/.venv/bin/python" ]]; then
  echo 'Run this script from the installed compute-host project.' >&2
  exit 2
fi
"$project_root/.venv/bin/python" "$project_root/reconstruct.py" "$1" "$2" \
  --checkpoint "$project_root/sharp_2572gikvuh.pt"
PATH="$project_root/.venv/bin:${CUDA_HOME:-/usr/local/cuda-12.4}/bin:$PATH" \
  CUDA_HOME="${CUDA_HOME:-/usr/local/cuda-12.4}" MAX_JOBS="${MAX_JOBS:-4}" \
  "$project_root/.venv/bin/python" "$project_root/qa_stereo.py" "$2" --ipd-mm "${3:-63}"
"$project_root/.venv/bin/python" "$project_root/scene_bundle.py" "$2/scene.vrmemory"
echo "Created $2/scene.vrmemory. Review QA images before using the scene in VR."
