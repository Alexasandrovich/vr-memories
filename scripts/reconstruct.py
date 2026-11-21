"""Create a SHARP scene and explicit camera metadata from one photograph."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--horizontal-fov", type=float, help="Measured horizontal field of view in degrees")
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--stream-only", action="store_true", help="Keep just the PLY and camera metadata for the album renderer")
    args = parser.parse_args()
    if args.horizontal_fov is not None and not 5 < args.horizontal_fov < 150:
        parser.error("Horizontal field of view must be between 5 and 150 degrees")
    if args.output.exists():
        parser.error("Use a new output directory to preserve previous results")

    import numpy as np
    import torch
    from PIL import Image, ImageCms, ImageOps
    from sharp.cli.predict import DEFAULT_MODEL_URL, predict_image
    from sharp.models import PredictorParams, create_predictor
    from sharp.utils.gaussians import save_ply

    if not torch.cuda.is_available():
        raise RuntimeError("This workflow expects the remote CUDA GPU")
    image = Image.open(args.image)
    focal_35 = image.getexif().get_ifd(0x8769).get(41989)
    image = ImageOps.exif_transpose(image)
    if image.info.get("icc_profile"):
        image = ImageCms.profileToProfile(
            image, ImageCms.ImageCmsProfile(io.BytesIO(image.info["icc_profile"])),
            ImageCms.createProfile("sRGB"), outputMode="RGB")
    else:
        image = image.convert("RGB")
    width, height = image.size
    if min(width, height) < 128:
        raise ValueError("Image is too small for a meaningful reconstruction")
    if args.horizontal_fov is not None:
        focal = width / (2 * math.tan(math.radians(args.horizontal_fov / 2)))
        calibration = "user_horizontal_fov"
    elif focal_35 and float(focal_35) > 0:
        focal = float(focal_35) * math.hypot(width, height) / math.hypot(36, 24)
        calibration = "exif_35mm_equivalent"
    else:
        focal = width / (2 * math.tan(math.radians(30)))
        calibration = "assumed_60_degree_horizontal_fov"
        print("WARNING: No 35mm-equivalent focal length. Assuming 60 degrees; scale is unverified.", flush=True)
    args.output.mkdir(parents=True)
    if not args.stream_only:
        image.save(args.output / "source.png")
    predictor = create_predictor(PredictorParams())
    weights = (torch.load(args.checkpoint, weights_only=True, map_location="cpu")
               if args.checkpoint else torch.hub.load_state_dict_from_url(DEFAULT_MODEL_URL, map_location="cpu"))
    predictor.load_state_dict(weights)
    del weights
    predictor.eval().to("cuda")
    torch.cuda.reset_peak_memory_stats()
    start = time.monotonic()
    with torch.inference_mode():
        gaussians = predict_image(predictor, np.asarray(image), focal, torch.device("cuda"))
    torch.cuda.synchronize()
    for name, values in zip(gaussians._fields, gaussians):
        if not torch.isfinite(values).all():
            raise ValueError(f"Non-finite values in {name}; scene rejected")
    save_ply(gaussians, focal, (height, width), args.output / "scene.ply")
    metadata = {
        "schema_version": 1, "method": "SHARP", "headset": "Meta Quest 2",
        "source_sha256": hashlib.sha256(args.image.read_bytes()).hexdigest(),
        "width": width, "height": height, "focal_px": focal,
        "horizontal_fov_deg": math.degrees(2 * math.atan(width / (2 * focal))),
        "vertical_fov_deg": math.degrees(2 * math.atan(height / (2 * focal))),
        "calibration": calibration, "coordinates": "OpenCV: +x right, +y down, +z forward; meters (estimated)",
        "head_center_m": [0, 0, 0], "locomotion": False,
        "outside_source_frustum": "black_with_soft_edge", "back_view": False,
        "gaussian_count": int(gaussians.mean_vectors.shape[1]),
        "inference_and_export_seconds": time.monotonic() - start,
        "peak_cuda_allocated_gib": torch.cuda.max_memory_allocated() / 2**30,
        "quality_status": "unreviewed", "headset_verified": False,
    }
    (args.output / "scene.json").write_text(json.dumps(metadata, indent=2) + "\n")
    if not args.stream_only:
        from scene_bundle import pack_scene
        print(f"VR memory: {pack_scene(args.output)}", flush=True)
    print(json.dumps(metadata, indent=2), flush=True)


if __name__ == "__main__":
    main()
