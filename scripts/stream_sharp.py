"""Render full-resolution stereo views on the GPU for the local Quest viewer."""
import json
import re
import select
import struct
import sys
import time
from collections import OrderedDict
import zlib
from fractions import Fraction
from pathlib import Path

wire = sys.stdout.buffer
sys.stdout = sys.stderr
sys.path.append(str(Path(__file__).resolve().parents[1] / "vendor-sharp" / "src"))

import av
import numpy as np
from contour_motion import ContourMotion
import gsplat
import torch
import torch.nn.functional as F
from sharp_nv12 import pack_nv12
from sharp.utils.gaussians import load_ply
from sharp.utils.gsplat import GSplatRenderer


def encoder(width, height):
    ctx = av.CodecContext.create("h264_nvenc", "w")
    ctx.width, ctx.height = width * 2, height
    ctx.pix_fmt = "nv12"
    ctx.time_base = Fraction(1, 60)
    ctx.framerate = 60
    ctx.bit_rate = 32000000
    ctx.gop_size = 120
    ctx.colorspace = 1  # BT.709 matrix and primaries, sRGB input transfer.
    ctx.color_primaries = 1
    ctx.color_trc = 13
    ctx.options = {"preset":"p2", "tune":"ull", "delay":"0", "zerolatency":"1",
                   "bf":"0", "rc-lookahead":"0", "forced-idr":"1", "profile":"high"}
    ctx.open()
    return ctx


@torch.inference_mode()
def run(ply):
    paths = {"mountain-memory": ply, "023-2": ply.parents[1] / "023-2-jpg" / "scene.ply"}
    scenes = OrderedDict()
    sessions = OrderedDict()
    while select.select([sys.stdin],[],[],75)[0]:
        line = sys.stdin.buffer.readline(8192)
        if not line:
            break
        q = json.loads(line)
        w, h = q["w"], q["h"]
        scene_name = q.get("scene", "mountain-memory")
        if scene_name not in scenes:
            if scene_name in paths:
                scene_path = paths[scene_name]
            elif re.fullmatch(r"album-[a-f0-9]{64}",scene_name):
                scene_path = ply.parents[1] / "album" / scene_name[6:] / "scene.ply"
            else:
                raise ValueError("Unknown scene")
            if len(scenes) >= 2:
                scenes.popitem(last=False)
            model, meta = load_ply(scene_path)
            eps = GSplatRenderer(color_space=meta.color_space).low_pass_filter_eps
            scenes[scene_name] = model.to(torch.device("cuda")), meta, eps
            del model
        scenes.move_to_end(scene_name)
        g, meta, eps = scenes[scene_name]
        signature = (scene_name,q["id"],w,h)
        now = time.monotonic()
        for inactive in [sid for sid, (_, _, used, _) in sessions.items() if now - used > 12]:
            del sessions[inactive]
        previous = sessions.pop(signature, None)
        if previous is None or q["key"]:
            if len(sessions) >= 3:
                sessions.popitem(last=False)
            codec, pts, tracker = encoder(w,h), 0, None
        else:
            codec, pts, _, tracker = previous
        # Client sends the world-to-camera matrix in OpenCV axes and the
        # intrinsics of each rendered eye; positions include physical IPD.
        v = torch.as_tensor(q["v"],device="cuda",dtype=torch.float32).reshape(2,4,4)
        k = torch.as_tensor(q["k"],device="cuda",dtype=torch.float32).reshape(2,3,3)
        with_depth = q.get("depth") is True
        rgb, alpha, _ = gsplat.rendering.rasterization(
            means=g.mean_vectors[0], quats=g.quaternions[0], scales=g.singular_values[0],
            opacities=g.opacities[0], colors=g.colors[0], viewmats=v, Ks=k,
            width=w, height=h, render_mode="RGB+ED" if with_depth else "RGB", rasterize_mode="classic",
            packed=False, eps2d=eps)
        sidecar = b""
        if with_depth:
            # Sample at the centres of a uniform grid. Depth assists only
            # the interim pose warp; RGB retains every native eye pixel.
            d = rgb[..., 3]
            dh, dw = max(1, h // 8), max(1, w // 8)
            iy = ((torch.arange(dh, device="cuda") + .5) * (h / dh)).long()
            ix = ((torch.arange(dw, device="cuda") + .5) * (w / dw)).long()
            depth = d[:, iy[:, None], ix]
            valid = alpha[..., 0][:, iy[:, None], ix] > .03
            if q.get("motionField") is True:
                # Extend the foreground's motion just past its silhouette.
                # Filtering disparity alone keeps photographic RGB untouched.
                disparity = torch.where(valid, depth.clamp_min(.5).reciprocal(), 0.)[:, None]
                disparity = F.max_pool2d(disparity, 3, stride=1, padding=1)
                kernel = torch.arange(-5, 6, device="cuda", dtype=torch.float32)
                kernel = (-.5 * (kernel / 1.6).square()).exp()
                kernel /= kernel.sum()
                disparity = F.conv2d(F.pad(disparity, (5,5,0,0), mode="replicate"), kernel.view(1,1,1,-1))
                disparity = F.conv2d(F.pad(disparity, (0,0,5,5), mode="replicate"), kernel.view(1,1,-1,1))
                grid = (disparity[:, 0] * 127.5).round().clamp(0,255).byte()
                magic = b"VRM1"
            else:
                log_depth = (depth.clamp(1/16, 4096).log2() + 4) * (254/16) + 1
                grid = torch.where(valid, log_depth.round(), 0).byte()
                magic = b"VRD1"
            # Row zero is the top of the image, left and right eyes side by side.
            grid_cpu = grid.contiguous().cpu().numpy()
            rgb = rgb[..., :3]
        packed_pixels = pack_nv12(rgb, meta.color_space == "linearRGB")
        if with_depth:
            aligned = q.get("contourMotion") is True and q.get("motionField") is True
            if aligned:
                if tracker is None:
                    tracker = ContourMotion(w, h)
                base, data = tracker.register(packed_pixels[:h], grid, grid_cpu, v, k, q["sequence"])
            else:
                data = np.concatenate(grid_cpu, axis=1)
                tracker = None
            compressed = zlib.compress(data, level=1)
            if aligned:
                sidecar = struct.pack("!4sHHIQ", b"VRA2", dw, dh, len(compressed), base) + compressed
            else:
                sidecar = struct.pack("!4sHHI", magic, dw, dh, len(compressed)) + compressed
        frame = av.VideoFrame.from_ndarray(packed_pixels.cpu().numpy(), format="nv12")
        frame.pts = pts
        pts += 1
        sessions[signature] = codec, pts, now, tracker
        packets = codec.encode(frame)
        if len(packets) != 1:
            raise RuntimeError("NVENC did not return a complete low-delay access unit")
        packet = packets[0]
        wire.write(struct.pack("!IB",len(sidecar)+packet.size,packet.is_keyframe))
        wire.write(sidecar)
        wire.write(bytes(packet))
        wire.flush()


if __name__ == "__main__":
    run(Path(sys.argv[1]))
