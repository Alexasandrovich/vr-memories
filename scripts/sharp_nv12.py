"""Pack the full pair of gsplat RGB(A) images directly into one NV12 surface."""
import torch
import triton
import triton.language as tl


@triton.jit
def _channel(x, LINEAR: tl.constexpr):
    x = tl.minimum(tl.maximum(x, 0.), 1.)
    if LINEAR:
        x = tl.where(x <= .0031308, 12.92 * x,
                     1.055 * tl.exp2(tl.log2(tl.maximum(x, .0031308)) / 2.4) - .055)
    return x


@triton.jit
def _nv12(src, out, W: tl.constexpr, H: tl.constexpr, C: tl.constexpr,
          LINEAR: tl.constexpr, BLOCK: tl.constexpr):
    # Each lane owns a 2x2 group and its single pair of chroma samples.
    group = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
    lane = tl.arange(0, 4)
    active = group < W * (H // 2)
    x = (group % W)[:, None] * 2 + (lane % 2)[None, :]
    y = (group // W)[:, None] * 2 + (lane // 2)[None, :]
    src_index = (((x // W) * H + y) * W + x % W) * C
    red = _channel(tl.load(src + src_index, active[:, None], 0), LINEAR)
    green = _channel(tl.load(src + src_index + 1, active[:, None], 0), LINEAR)
    blue = _channel(tl.load(src + src_index + 2, active[:, None], 0), LINEAR)
    luma = .2126 * red + .7152 * green + .0722 * blue
    tl.store(out + y * (2 * W) + x, tl.extra.cuda.libdevice.rint(16 + 219 * luma), active[:, None])
    chroma = out + 2 * W * H + group * 2
    u = tl.sum((blue - luma) / 1.8556, 1) * .25
    v = tl.sum((red - luma) / 1.5748, 1) * .25
    tl.store(chroma, tl.extra.cuda.libdevice.rint(128 + 224 * u), active)
    tl.store(chroma + 1, tl.extra.cuda.libdevice.rint(128 + 224 * v), active)


def pack_nv12(stereo, linear):
    _, h, w, _ = stereo.shape
    pixels = torch.empty((h * 3 // 2, 2 * w), dtype=torch.uint8, device=stereo.device)
    _nv12[(triton.cdiv(w * (h // 2), 128),)](
        stereo, pixels, w, h, stereo.stride(-2), linear, 128, enable_fp_fusion=False)
    return pixels
