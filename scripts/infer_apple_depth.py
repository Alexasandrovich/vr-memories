"""Estimate metric depth for the exact source camera used by SHARP."""
import argparse
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from depth_pro_2 import DepthPro2
from depth_pro_2.model import to_normalized_tensor


@torch.inference_mode()
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scene", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    focal = json.loads((args.scene / "scene.json").read_text())["focal_px"]
    image = np.array(Image.open(args.scene / "source.png").convert("RGB"))
    model = DepthPro2.from_pretrained("apple/DepthPro2-H", precision=torch.bfloat16).eval().cuda()
    rgb = to_normalized_tensor(image, device=torch.device("cuda"))
    depth = model.infer(rgb, f_px=focal)["depth"].squeeze().float().cpu().numpy()
    if depth.shape != image.shape[:2]:
        raise ValueError("Output depth does not match the source camera resolution")
    np.save(args.output, depth)


if __name__ == "__main__":
    main()
