"""Camera invariants that matter for fixed-position stereo viewing."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from qa_stereo import rotation


class StereoCameraTests(unittest.TestCase):
    def test_physical_eye_separation_under_head_rotation(self):
        for ipd in (.058, .063, .068):
            for yaw in (-40, 0, 40, 90, 180):
                for pitch in (-20, 0, 20):
                    r = rotation(yaw, pitch)
                    left, right = (r @ np.array([x, 0, 0]) for x in (-ipd / 2, ipd / 2))
                    np.testing.assert_allclose((left + right) / 2, 0, atol=1e-12)
                    self.assertAlmostEqual(np.linalg.norm(right - left), ipd)
                    np.testing.assert_allclose(r.T @ r, np.eye(3), atol=1e-12)

    def test_disparity_sign_and_metric_baseline(self):
        # A frontal point must lie farther right in the left-eye image.
        f, z, ipd = 1300, 3, .063
        eyes = [rotation(0, 0) @ np.array([x, 0, 0]) for x in (-ipd/2, ipd/2)]
        pixels = [f * (np.array([0., 0., z]) - eye)[0] / z for eye in eyes]
        self.assertGreater(pixels[0], pixels[1])
        self.assertAlmostEqual(pixels[0] - pixels[1], f * ipd / z)

    def test_head_turn_rotates_stereo_baseline(self):
        baseline = rotation(90, 0) @ np.array([.063, 0, 0])
        np.testing.assert_allclose(baseline, [0, 0, -.063], atol=1e-12)

    def test_rear_view_points_outside_source_half_space(self):
        ray = rotation(180, 0) @ np.array([0, 0, 1])
        self.assertLess(ray[2], 0)


if __name__ == "__main__":
    unittest.main()
