# Run your own album

The reference installation uses a Mac, a Linux RTX 4060 Ti with 16 GB of VRAM, and a Quest 2 on the Mac’s Wi-Fi. The GPU handles SHARP reconstruction and stereo rendering. The Mac serves HTTPS and forwards the selected photo and camera requests over SSH.

## Try the demo locally

From the repository root, run the following command and open [the demo](http://localhost:8000). Watch the family bicycle tour, then choose **Walk here**. Use WASD, the arrow keys or the on-screen pad to move. Drag to look around. **Original photo** opens the source crop.

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory docs
```

## Web demo in Quest over Wi-Fi

From a clone, set the IPv4 address of the computer running Docker. This starts the published web viewer with an HTTPS endpoint for the headset.

```sh
export VR_LAN_ADDRESS=192.168.1.20   # Replace with this computer's LAN address
docker compose -f compose.yaml -f compose.https.yaml up -d --pull always
```

Open `https://<VR_LAN_ADDRESS>:8443/` in Quest Browser and accept the local certificate prompt. If your browser requires a trusted certificate, use a trusted HTTPS reverse proxy or the public HTTPS demo. With USB debugging connected, another option is `adb reverse tcp:7860 tcp:7860` and `http://localhost:7860/` in the headset. Select **Walk here**, then **Enter VR**. For your photo, open **Try your photo**, create the scene, then **Enter VR**. The left stick walks, the right stick turns in 30-degree steps, and the trigger resets your position. Use the headset's system menu to leave VR.

## Quest album with Docker

Use a Linux x86-64 host with an NVIDIA GPU that supports CUDA 12.4 and H.264 NVENC, a compatible graphics driver and NVIDIA Container Toolkit. The Quest must be able to reach the host’s private IPv4 address. The host network lets the pairing-code page stay on loopback.

```sh
export VR_PHOTOS="$HOME/Pictures"   # Existing directory on that host
docker compose -f compose.album.yaml up -d --pull always
docker compose -f compose.album.yaml logs -f album
```

The server prints the address it selected from the default route. On a machine with a VPN or multiple interfaces, set `VR_LAN_ADDRESS` to the address reachable from the Quest. The first start downloads and verifies the 2.81 GB research checkpoint and builds the included example. Open the pairing code on the Linux host at [localhost:8765/vr/album/code](http://localhost:8765/vr/album/code). For a headless host, run `ssh -L 8765:127.0.0.1:8765 user@gpu-host` from your laptop and open the same link there. In Quest Browser open `https://<VR_LAN_ADDRESS>:8443/vr/`, accept the local certificate if prompted, and enter the code. Select your photo in the album.

Docker mounts your photos read-only. Named volumes keep the weights, scenes and pairing across restarts. Stop the album with `docker compose -f compose.album.yaml down`. Set `VR_PORT` or `VR_PREVIEW_PORT` before startup if either port is occupied.

## Prepare the GPU host

1. Make the host reachable from the Mac over SSH as `vr-gpu`, or set `VR_GPU_HOST` to your own SSH destination. Check that `ssh -o BatchMode=yes vr-gpu hostname` succeeds.
2. On the GPU host, clone this repository into `~/vr-memories`. The remote worker expects this layout. Set up Python 3.11+, CUDA and the bundled SHARP inference package. The reference renderer uses PyTorch 2.8.0+cu128, gsplat 1.5.3, Triton 3.4.0 and PyAV 18.1.0 with a working H.264 NVENC encoder. The renderer command sets `CUDA_HOME=/usr/local/cuda-12.4`; adjust that path in `scripts/remote_frames.py` for another toolkit location.
3. In a fresh GPU checkout, the following commands lay out the reconstruction and rendering workers. Install a CUDA build of PyTorch suitable for the host before installing SHARP. Review the upstream [model terms](../vendor-sharp/LICENSE_MODEL) before downloading the model.

```sh
cd ~/vr-memories
python3.11 -m venv .venv
.venv/bin/pip install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
.venv/bin/pip install -e ./vendor-sharp
.venv/bin/pip install gsplat==1.5.3 av==18.1.0
.venv/bin/python scripts/sharp_checkpoint.py
mkdir -p research-v2 outputs
cp scripts/{reconstruct,scene_bundle,sharp_checkpoint}.py .
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

## About the public scenes

The opening scene is a family bicycle lesson, shared with permission. The two landscape examples use crops from travel photographs. The published photos omit EXIF metadata. Apple SHARP inferred 1,179,648 Gaussians per scene.

| Scene | Guided walk | Source camera assumption |
| --- | --- | --- |
| The first ride | A 22-second film with five shots, opening with a seven-metre pullback | 60° horizontal field of view |
| Sunset canyon | A 12-second curve along the near slope, advancing 6.4 m before returning | 46° horizontal field of view |
| Cable-car window | An eight-second approach, advancing 42 cm as the window frame slides past the mountain | 50° horizontal field of view |

Each film was rendered on an RTX. **Walk here** loads that scene as a compressed SPZ and renders your camera locally with WebGL 2. Camera distances are in the model’s estimated scale. The live camera can turn freely and travel beyond the reconstructed surfaces. Scroll or pinch to change distance, and use **Return to original position** to get back to the source camera.

For the Python tests, install NumPy and Pillow, then run `python -m unittest discover -s tests`.
