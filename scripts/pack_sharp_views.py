"""Package native SHARP eye renders with optional Depth Pro 2 detail registration."""
import argparse
import json
from pathlib import Path
import hashlib
import cv2
import numpy as np
from build_mesh_probe import geometry


def walking_geometry(z, K, stride=6):
    """Refine silhouette cells on a two-pixel grid and leave occlusions open."""
    h, w = z.shape
    inverse = 1 / z
    # Only silhouette cells need denser sampling; textures stay full resolution.
    grid = np.arange(h * w, dtype=np.uint32).reshape(h, w)
    ys = np.unique(np.r_[np.arange(0, h, stride), h - 1])
    xs = np.unique(np.r_[np.arange(0, w, stride), w - 1])
    def corners(nodes):
        return np.stack([nodes[:-1,:-1], nodes[1:,:-1], nodes[:-1,1:], nodes[1:,1:]], -1)

    spread = np.maximum.reduceat(np.maximum.reduceat(inverse, ys, axis=0), xs, axis=1)
    low = np.minimum.reduceat(np.minimum.reduceat(inverse, ys, axis=0), xs, axis=1)
    coarse = corners(grid[np.ix_(ys, xs)])
    disparities = inverse.ravel()[coarse]
    refine = (np.maximum(spread[:-1,:-1], disparities.max(-1)) -
              np.minimum(low[:-1,:-1], disparities.min(-1))) > .035
    dense = np.repeat(np.repeat(refine, np.diff(ys), axis=0), np.diff(xs), axis=1)
    fy = np.unique(np.r_[np.arange(0, h, 2), h - 1])
    fx = np.unique(np.r_[np.arange(0, w, 2), w - 1])
    fine = corners(grid[np.ix_(fy,fx)])
    quads = np.concatenate([coarse[~refine], fine[dense[np.ix_(fy[:-1],fx[:-1])]]])
    faces = np.concatenate([quads[:,[0,1,2]], quads[:,[2,1,3]]])
    faces = faces[np.ptp(inverse.ravel()[faces], axis=1) < .035]
    samples, indices = np.unique(faces, return_inverse=True)
    y, x = np.divmod(samples, w)
    u, v = (x + .5) / w, (y + .5) / h
    d = z.ravel()[samples]
    positions = np.column_stack([(u - .5) / K[0,0] * d, -(v - .5) / K[1,1] * d, -d])
    return (positions.astype('<f4'), np.column_stack([u, 1-v]).astype('<f4'),
            indices.reshape(-1,3).astype('<u4'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scene", type=Path)
    parser.add_argument("renders", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--depth-pro", type=Path)
    parser.add_argument("--context", help="Browser-relative URL of a context manifest made for this photograph")
    parser.add_argument("--repair", help="Browser-relative URL of the source-matched background layer manifest")
    args = parser.parse_args()
    meta = json.loads((args.scene / "scene.json").read_text())
    src = cv2.imread(str(args.scene / "source.png"))
    height, width = src.shape[:2]
    f = meta["focal_px"]
    K = np.array([[f / width, 0, .5], [0, f / height, .5], [0, 0, 1]])
    dst = args.destination
    dst.mkdir(exist_ok=True, parents=True)
    dp = np.load(args.depth_pro) if args.depth_pro else None
    if dp is not None and dp.shape != (height, width):
        raise ValueError("Depth Pro 2 camera size differs from the source")
    if dp is not None:
        inverse = np.divide(1., dp, out=np.full_like(dp, np.nan), where=np.isfinite(dp) & (dp > 0))
        source = src.astype(np.float32)
        detail = source - cv2.GaussianBlur(source, (0, 0), 1)
    yy, xx = np.indices((height, width), dtype=np.float32)
    layers = []
    for eye, offset in [("center", 0), ("left", -.0315), ("right", .0315)]:
        rgb = cv2.imread(str(args.renders / f"{eye}.png"))
        z = np.load(args.renders / f"{eye}-depth.npy")
        valid = np.isfinite(z) & (z > .05)
        z = np.where(valid, z, 1500).clip(.1, 1500)
        pos, uv, faces = geometry(z, K, 8)
        data = pos.tobytes() + uv.tobytes() + faces.tobytes()
        (dst / f"{eye}.bin").write_bytes(data)
        cv2.imwrite(str(dst / f"{eye}.png"), rgb)
        spec = dict(name=eye, eye_offset=offset, vertices=len(pos), triangles=len(faces),
                    bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        if dp is not None:
            # Project the visible SHARP surface back into the source camera.
            # Replace only high spatial frequencies where both depths predict
            # compatible horizontal disparities. Preserve SHARP disocclusions.
            sx = (xx + f * offset / z).astype(np.float32)
            sampled = cv2.remap(inverse, sx, yy, cv2.INTER_NEAREST)
            error = np.nan_to_num(f * .0315 * np.abs(sampled - 1 / z), nan=np.inf)
            weight = np.clip(1 - error / .8, 0, 1) * valid * (sx >= 1) * (sx < width - 2)
            observed = cv2.remap(detail, sx, yy, cv2.INTER_LINEAR)
            native = rgb.astype(np.float32)
            corrected = native + weight[..., None] * (observed - (native - cv2.GaussianBlur(native, (0, 0), 1)))
            cv2.imwrite(str(dst / f"{eye}-detail.png"), np.uint8(np.clip(corrected.round(), 0, 255)))
            spec["detail_fraction"] = float((weight > 0).mean())
        layers.append(spec)
    manifest = dict(version="apple-sharp", width=width, height=height,
                    intrinsics=K.tolist(), layers=layers, detail=dp is not None,
                    context=args.context)
    if dp is not None:
        z = np.where(np.isfinite(dp) & (dp > 0), dp, 1500).clip(.1, 1500)
        pos, uv, faces = walking_geometry(z, K)
        data = pos.tobytes() + uv.tobytes() + faces.tobytes()
        (dst / "walk.bin").write_bytes(data)
        manifest["walk"] = dict(name="walk", vertices=len(pos), triangles=len(faces),
                                bytes=len(data), sha256=hashlib.sha256(data).hexdigest(),
                                repair=args.repair, source_sha256=hashlib.sha256((args.scene / "source.png").read_bytes()).hexdigest())
    (dst / "scene.json").write_text(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
