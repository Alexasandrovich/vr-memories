"""Bake the full SHARP Gaussian field for a seated stereo viewer."""
import argparse
from pathlib import Path
import numpy as np
import torch
from PIL import Image
from sharp.utils.gaussians import load_ply
from sharp.utils.gsplat import GSplatRenderer


@torch.inference_mode()
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ply", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    scene, camera = load_ply(args.ply)
    scene = scene.to(torch.device("cuda"))
    width, height = map(int, camera.resolution_px)
    intrinsics = torch.eye(4, device="cuda")
    intrinsics[0, 0] = intrinsics[1, 1] = float(camera.focal_length_px)
    intrinsics[0, 2], intrinsics[1, 2] = width / 2, height / 2
    renderer = GSplatRenderer(color_space=camera.color_space)
    for eye, meters in [("left", -.0315), ("right", .0315), ("center", 0)]:
        view = torch.eye(4, device="cuda")
        view[0, 3] = -meters
        frame = renderer(scene, extrinsics=view[None], intrinsics=intrinsics[None],
                         image_width=width, image_height=height)
        rgb = frame.color[0].permute(1, 2, 0).clamp(0, 1).mul(255).round().byte()
        Image.fromarray(rgb.cpu().numpy()).save(args.output / f"{eye}.png")
        np.save(args.output / f"{eye}-depth.npy", frame.depth.squeeze().cpu().numpy())
        print(eye, width, height, flush=True)


if __name__ == "__main__":
    main()
