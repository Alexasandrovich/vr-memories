# Run your own album

The reference installation uses a Mac, a Linux RTX 4060 Ti with 16 GB of VRAM, and a Quest 2 on the Mac’s Wi-Fi. The GPU handles SHARP reconstruction and stereo rendering. The Mac serves HTTPS and forwards the selected photo and camera requests over SSH.

## Try the demo locally

From the repository root, run the following command and open [the demo](http://localhost:8000). Watch the eight-second tour, then choose **Walk here**. Use WASD, the arrow keys or the on-screen pad to move. Drag to look around. **Original photo** opens the source crop.

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory docs
```

## Prepare the GPU host

1. Make the host reachable from the Mac over SSH as `vr-gpu`, or set `VR_GPU_HOST` to your own SSH destination. Check that `ssh -o BatchMode=yes vr-gpu hostname` succeeds.
2. On the GPU host, clone this repository into `~/vr-memories`. The remote worker expects this layout. Set up Python 3.11+, CUDA, and the dependencies for [Apple SHARP](https://github.com/apple-aiml-research/ml-sharp). The reference renderer uses PyTorch 2.8.0+cu128, gsplat 1.5.3, Triton 3.4.0 and PyAV 18.1.0 with a working H.264 NVENC encoder. The renderer command sets `CUDA_HOME=/usr/local/cuda-12.4`; adjust that path in `scripts/remote_frames.py` for another toolkit location.
3. In a fresh GPU checkout, the following commands lay out the reconstruction and rendering workers. Install a CUDA build of PyTorch suitable for the host before installing SHARP. Review the upstream [model terms](https://github.com/apple-aiml-research/ml-sharp/blob/main/LICENSE_MODEL) before downloading the model.

```sh
cd ~/vr-memories
python3.11 -m venv .venv
git clone https://github.com/apple-aiml-research/ml-sharp.git vendor-sharp
git -C vendor-sharp checkout aed6527499ef91cba3b54c18d49a870f25947190
.venv/bin/pip install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
.venv/bin/pip install -e ./vendor-sharp
.venv/bin/pip install gsplat==1.5.3 av==18.1.0
curl -fLO https://ml-site.cdn-apple.com/models/sharp/sharp_2572gikvuh.pt
mkdir -p research-v2 outputs
cp scripts/{reconstruct,scene_bundle}.py .
cp scripts/{stream_sharp,sharp_nv12,contour_motion,build_album_scene}.py research-v2/
ln -s ../.venv research-v2/apple-depth-env
```

Create the two startup scene paths used by the current viewer. You can use the public demo photograph for both. The desktop landing page uses the second path and the standalone viewer uses the first. Your album photos are independent and get their own scenes when selected.

```sh
.venv/bin/python reconstruct.py docs/walk/photo.webp outputs/mountain-memory \
  --horizontal-fov 50 --checkpoint sharp_2572gikvuh.pt
ln -s mountain-memory outputs/023-2-jpg
```

## Start the Mac and pair the Quest

In a clone on the Mac, install Pillow and copy the startup bundles from the GPU. Substitute your SSH destination if you use a different host name.

```sh
python3.11 -m venv .venv
.venv/bin/pip install Pillow
mkdir -p outputs/mountain-memory outputs/023-2-jpg
scp vr-gpu:vr-memories/outputs/mountain-memory/scene.vrmemory outputs/mountain-memory/
cp outputs/mountain-memory/scene.vrmemory outputs/023-2-jpg/
VR_PYTHON="$PWD/.venv/bin/python" "./Start VR.command" "$HOME/Pictures"
```

Open the pairing code on the Mac at [localhost](http://127.0.0.1:8765/vr/album/code). In Quest Browser, open the HTTPS address printed by the launcher, confirm the local certificate if prompted, choose **Смотреть в VR** (Enter VR), and enter the code. The server looks for Wi-Fi on `en0` by default. Set `VR_LAN_ADDRESS` to the Mac’s Wi-Fi IP if it uses a different interface.

| Control | Action |
| --- | --- |
| Trigger in the album | Open a photo |
| Grip | Open or close the album |
| Left stick | Move forward, back or sideways |
| Right stick | Turn or change height |
| Trigger in a scene | Return to the capture position |

Add JPEG, PNG or WebP files and reopen the album to refresh it. Subfolders are included. Keep both hosts running while viewing. Paired devices can open the album. The two startup scenes are accessible to devices that can reach the viewer URL, so choose a shareable photo for those slots.

## About the cable-car scene

The demo starts with a metadata-free, person-free landscape crop from the owner's photograph. SHARP inferred 1,179,648 Gaussians using a 50° horizontal field of view. The short film moves the camera 42 cm toward the window and to the side on the RTX. The interactive mode downloads a 16 MB compressed SPZ scene and renders each new camera position locally with WebGL 2. Travel is bounded to the neighborhood of the photograph. Distances are in the model’s estimated scale.

For the Python tests, install NumPy and Pillow, then run `python -m unittest discover -s tests`.
