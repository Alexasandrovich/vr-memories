"""Bounded, reproducible geometry probe. Run inside the research MoGe environment."""
import argparse
import hashlib
import json
from pathlib import Path
import time

import numpy as np
from PIL import Image
import torch
from moge.model.v3 import MoGeModel


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--fov', type=float, default=62.63434801377908)
    parser.add_argument('--refine-steps', type=int, default=3)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    im = np.asarray(Image.open(args.image).convert('RGB'))
    model = MoGeModel.from_pretrained(args.checkpoint).cuda().eval()
    print('Model loaded; inference starts', flush=True)
    x = torch.from_numpy(im.copy()).cuda().permute(2, 0, 1).float() / 255
    torch.cuda.reset_peak_memory_stats()
    start = time.monotonic()
    with torch.inference_mode():
        output = model.infer(x, fov_x=args.fov, resolution_level=9,
                             refine_steps=args.refine_steps, use_fp16=True)
    torch.cuda.synchronize()
    elapsed = time.monotonic() - start
    arrays = {k: v.cpu().numpy() for k, v in output.items() if torch.is_tensor(v)}
    np.savez_compressed(args.output / 'geometry.npz', **arrays)
    depth = arrays['depth']
    valid = arrays['mask'] & np.isfinite(depth) & (depth > 0)
    if valid.mean() < .2:
        raise RuntimeError('Too few valid pixels')
    stats = dict(method='MoGe 3 vitl', fov_x=args.fov, refine_steps=args.refine_steps,
                 seconds=elapsed, peak_cuda_gib=torch.cuda.max_memory_allocated()/2**30,
                 valid_fraction=float(valid.mean()), shape=list(im.shape),
                 depth_percentiles=np.percentile(depth[valid], [1, 10, 50, 90, 99]).tolist(),
                 source_sha256=hashlib.sha256(args.image.read_bytes()).hexdigest())
    (args.output / 'metrics.json').write_text(json.dumps(stats, indent=2)+'\n')
    # A scalar depth diagnostic, not an edited source photograph.
    z = np.clip((np.log(np.where(valid, depth, 1)) - np.log(np.percentile(depth[valid], 1))) /
                np.log(np.percentile(depth[valid], 99)/np.percentile(depth[valid], 1)), 0, 1)
    Image.fromarray(np.uint8(z*255)).save(args.output / 'depth.png')
    print(json.dumps(stats), flush=True)


if __name__ == '__main__':
    main()
