"""Render stereo probes with head rotations; report holes without certifying quality."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def rotation(yaw_deg, pitch_deg):
    """Camera-to-world orientation, OpenCV convention. Positive yaw looks right."""
    import numpy as np
    y, p = math.radians(yaw_deg), math.radians(pitch_deg)
    ry = np.array([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    return ry @ rx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scene", type=Path)
    parser.add_argument("--max-width", type=int, default=1600)
    parser.add_argument("--ipd-mm", type=float, default=63)
    args = parser.parse_args()
    if not 50 <= args.ipd_mm <= 80 or args.max_width < 128:
        parser.error("Invalid IPD or resolution")
    import numpy as np
    import torch
    from PIL import Image
    from sharp.utils.gaussians import load_ply
    from sharp.utils.gsplat import GSplatRenderer

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA required")
    gaussians, metadata = load_ply(args.scene / "scene.ply")
    gaussians = gaussians.to(torch.device("cuda"))
    original_width, original_height = map(int, metadata.resolution_px)
    scale = min(1, args.max_width / original_width)
    width, height = round(original_width * scale), round(original_height * scale)
    focal = float(metadata.focal_length_px) * scale
    k = np.eye(4, dtype=np.float32)
    k[0, 0] = k[1, 1] = focal
    # SHARP saves principal point at width/2, height/2; raster pixels have
    # centers at integer+0.5. Keep the mask and the renderer in that convention.
    k[0, 2], k[1, 2] = width / 2, height / 2
    renderer = GSplatRenderer(color_space=metadata.color_space)
    outdir = args.scene / f"qa-{args.ipd_mm:g}mm"
    outdir.mkdir(exist_ok=True)
    yy, xx = np.mgrid[:height, :width]
    camera_rays = np.stack(((xx+.5-k[0, 2])/focal, (yy+.5-k[1, 2])/focal, np.ones_like(xx)), axis=-1)
    half_x, half_y = original_width/(2*metadata.focal_length_px), original_height/(2*metadata.focal_length_px)
    reports = []
    center = None
    poses = [("center", 0, 0, [0]), ("front", 0, 0, [-1, 1]),
             ("left", -20, 0, [-1, 1]), ("right", 20, 0, [-1, 1]),
             ("up", 0, 15, [-1, 1]), ("down", 0, -15, [-1, 1])]
    with torch.inference_mode():
        for label, yaw, pitch, eyes in poses:
            orientation = rotation(yaw, pitch)
            world_rays = camera_rays @ orientation.T
            forward = world_rays[..., 2] > 0
            projected = world_rays[..., :2] / np.maximum(world_rays[..., 2:], 1e-8)
            margin = np.minimum(1-np.abs(projected[..., 0])/half_x, 1-np.abs(projected[..., 1])/half_y)
            interior = (margin > .08) & forward
            # This is a direction-domain mask: translations never enlarge known coverage.
            t = np.clip(margin/.05, 0, 1)
            fade = (t*t*(3-2*t))*forward
            pair = []
            for eye in eyes:
                position = orientation @ np.array([eye*args.ipd_mm/2000, 0, 0])
                view = np.eye(4, dtype=np.float32)
                view[:3, :3] = orientation.T
                view[:3, 3] = -orientation.T @ position
                result = renderer(gaussians,
                    extrinsics=torch.tensor(view[None], device="cuda"),
                    intrinsics=torch.tensor(k[None], device="cuda"), image_width=width, image_height=height)
                color = result.color[0].permute(1, 2, 0).cpu().numpy()
                alpha = result.alpha[0, 0].cpu().numpy()
                if not np.isfinite(color).all() or not np.isfinite(alpha).all():
                    raise ValueError("Non-finite rendered pixels")
                if label == "center":
                    center = color.copy()
                name = f"{label}-{'L' if eye < 0 else 'R' if eye > 0 else 'C'}"
                rgb = (np.clip(color*fade[..., None], 0, 1)*255).round().astype(np.uint8)
                Image.fromarray(rgb).save(outdir / f"{name}.png")
                Image.fromarray((alpha.clip(0, 1)*255).round().astype(np.uint8)).save(outdir / f"{name}-alpha.png")
                pair.append(rgb)
                reports.append({"view": name, "yaw_deg": yaw, "pitch_deg": pitch,
                    "eye_position_m": position.tolist(), "evaluated_pixels": int(interior.sum()),
                    "interior_fraction_alpha_below_098": float((alpha[interior] < .98).mean()) if interior.any() else None,
                    "interior_min_alpha": float(alpha[interior].min()) if interior.any() else None})
            if len(pair) == 2:
                Image.fromarray(np.concatenate(pair, axis=1)).save(outdir / f"{label}-stereo.png")
    source = Image.open(args.scene / "source.png").convert("RGB").resize((width, height), Image.Resampling.LANCZOS)
    source_array = np.asarray(source).astype(float)/255
    mse = float(np.mean((source_array-center)**2))
    center_u8 = (center.clip(0, 1)*255).round().astype(np.uint8)
    Image.fromarray(np.concatenate([np.asarray(source), center_u8], axis=1)).save(outdir / "source-vs-center.png")
    report = {"ipd_mm": args.ipd_mm, "render_size": [width, height], "views": reports,
        "source_center_psnr_db": -10*math.log10(max(mse, 1e-12)),
        "status": "requires_visual_and_headset_review",
        "caveat": "High opacity does not prove correct geometry or absence of floating/blurred edges. No automatic quality certification."}
    (outdir / "report.json").write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
