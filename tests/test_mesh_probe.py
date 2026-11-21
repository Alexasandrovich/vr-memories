"""Regression: depth boundaries must not erase observed source pixels."""
import sys
from pathlib import Path
import unittest
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from build_mesh_probe import source_geometry


class SourceCoverage(unittest.TestCase):
    def test_depth_step_retains_full_image_without_connecting_layers(self):
        depth=np.full((7,11),100.,dtype=np.float32)
        depth[2:6,3:8]=2.
        K=np.array([[.82,0,.5],[0,1.46,.5],[0,0,1]])
        points,uv,faces=source_geometry(depth,K)
        projected=np.column_stack([points[:,0]/-points[:,2]*K[0,0]+.5,
                                   -points[:,1]/-points[:,2]*K[1,1]+.5])
        p=projected[faces];a=p[:,1]-p[:,0];b=p[:,2]-p[:,0]
        area=np.abs(a[:,0]*b[:,1]-a[:,1]*b[:,0]).sum()/2
        self.assertAlmostEqual(float(area),1.,places=6)
        z=-points[faces,2]
        self.assertTrue(np.all(z.max(1)/z.min(1)<1.061))
        self.assertTrue(np.isfinite(points).all())


if __name__=='__main__':unittest.main()
