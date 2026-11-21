"""Measure the small image correction left after the viewer's depth reprojection."""
import cv2
import numpy as np
import torch
import torch.nn.functional as F

cv2.setNumThreads(2)


class ContourMotion:
    def __init__(self, width, height):
        self.w, self.h = width, height
        sw, sh = (width + 3) // 4, (height + 3) // 4
        self.size = sh, sw
        self.scale = np.array([sw / width, sh / height], np.float32)
        self.extent = torch.tensor([width, height], device="cuda")
        y, x = torch.meshgrid(
            torch.arange(sh, device="cuda"),
            torch.arange(sw, device="cuda"),
            indexing="ij",
        )
        self.uv = (
            (torch.stack((x, y), -1) + 0.5)
            * (self.extent / self.extent.new_tensor([sw, sh]))
        ).view(1, -1, 2)
        self.engine = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_ULTRAFAST)
        self.engine.setFinestScale(0)
        self.previous = None

    def register(self, luma, field, grid_cpu, views, intrinsics, sequence):
        dh, dw = grid_cpu.shape[1:]
        fw, fh = (dw + 1) // 2, (dh + 1) // 2
        output = np.full((fh, 2 * fw, 2), 128, dtype=np.uint8)
        depth_bytes = np.concatenate(grid_cpu, axis=1).tobytes()
        # Convert to a small luminance pair for registration only.
        eyes = luma.view(self.h, 2, self.w).permute(1, 0, 2).unsqueeze(1)
        images = F.interpolate(eyes.float(), size=self.size, mode="area")
        previous = self.previous
        self.previous = (
            sequence,
            images,
            field[:, None].float() * (2 / 255),
            views,
            intrinsics,
        )
        if previous is None:
            return 0, depth_bytes + output.tobytes()
        base, old_images, old_depth, old_views, old_k = previous
        relative = old_views @ torch.linalg.inv_ex(views).inverse
        k = intrinsics.diagonal(dim1=-2, dim2=-1)[:, :2].unsqueeze(1)
        rays = (self.uv - intrinsics[:, :2, 2].unsqueeze(1)) / k
        rotated = torch.bmm(rays, relative[:, :3, :2].transpose(1, 2)) + relative[
            :, :3, 2
        ].unsqueeze(1)
        slope = rotated[:, :, :2] / rotated[:, :, 2:].clamp_min(0.01)
        old_focal = old_k.diagonal(dim1=-2, dim2=-1)[:, :2].unsqueeze(1)
        origin = slope * old_focal + old_k[:, :2, 2].unsqueeze(1)
        shift = (
            relative[:, :2, 3].unsqueeze(1) - slope * relative[:, 2:3, 3].unsqueeze(1)
        ) * old_focal
        # Normalised pixel-centre coordinates are identical for image and depth.
        origin = (2 * origin / self.extent - 1).view(2, *self.size, 2)
        shift = (2 * shift / self.extent).view_as(origin)
        uv = origin
        for _ in range(4):
            d = F.grid_sample(old_depth, uv, padding_mode="border", align_corners=False)
            uv = origin + shift * d.permute(0, 2, 3, 1)
        old = F.grid_sample(old_images - 16, uv, align_corners=False) + 16
        samples = (
            torch.cat((old, images), dim=1).round().clamp(0, 255).byte().cpu().numpy()
        )
        for eye, (before, after) in enumerate(samples):
            x, y, w, h = cv2.boundingRect(
                (np.maximum(before, after) > 21).astype(np.uint8)
            )
            x0, y0 = max(0, x - 12), max(0, y - 12)
            x1, y1 = min(self.size[1], x + w + 12), min(self.size[0], y + h + 12)
            if not w or min(x1 - x0, y1 - y0) < 16:
                continue
            region = np.s_[y0:y1, x0:x1]
            flow = np.zeros((*self.size, 2), dtype=np.float32)
            flow[region] = self.engine.calc(
                np.ascontiguousarray(before[region]),
                np.ascontiguousarray(after[region]),
                None,
            )
            flow = cv2.resize(flow, (fw, fh), interpolation=cv2.INTER_AREA) / self.scale
            output[:, eye * fw : (eye + 1) * fw] = np.rint(
                128 + 4 * np.clip(flow, -16, 16)
            ).astype(np.uint8)
        return base, depth_bytes + output.tobytes()
