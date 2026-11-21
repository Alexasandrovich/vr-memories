"""Export camera-calibrated textured geometry; never repaint the source texture."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

import numpy as np


def geometry(depth, intrinsics, stride, cut_ratio=None):
    h, w = depth.shape
    ys = np.unique(np.r_[np.arange(0, h, stride), h-1])
    xs = np.unique(np.r_[np.arange(0, w, stride), w-1])
    y, x = np.meshgrid(ys, xs, indexing='ij')
    # Pixel centers, normalized intrinsics, OpenCV -> Three coordinate system.
    u, v = (x+.5)/w, (y+.5)/h
    z = depth[y, x]
    positions = np.stack([(u-intrinsics[0, 2])/intrinsics[0, 0]*z,
                          -(v-intrinsics[1, 2])/intrinsics[1, 1]*z, -z], -1)
    uv = np.stack([u, 1-v], -1)
    ids = np.arange(x.size).reshape(x.shape)
    a,b,c,d = ids[:-1,:-1],ids[:-1,1:],ids[1:,:-1],ids[1:,1:]
    faces = np.concatenate([np.stack([a,c,b],-1).reshape(-1,3),
                            np.stack([b,c,d],-1).reshape(-1,3)])
    if cut_ratio is not None:
        depths=z.ravel()[faces]
        faces=faces[np.max(depths,axis=1)/np.min(depths,axis=1)<cut_ratio]
    return positions.astype('<f4').reshape(-1,3),uv.astype('<f4').reshape(-1,2),faces.astype('<u4')


def source_geometry(depth, intrinsics, stride=2):
    """Continuous cells plus separate pixel footprints at depth discontinuities.

    Dropping crossing triangles loses observed pixels. Stretching them creates
    curtains in stereo. Pixel footprints retain every observed sample without
    connecting foreground to background. The repair layer fills disocclusions.
    """
    h,w=depth.shape
    ys=np.unique(np.r_[np.arange(0,h,stride),h]);xs=np.unique(np.r_[np.arange(0,w,stride),w])
    y,x=np.meshgrid(ys,xs,indexing='ij')
    z=depth[np.minimum(y,h-1),np.minimum(x,w-1)]
    u,v=x/w,y/h
    pos=np.stack([(u-.5)/intrinsics[0,0]*z,-(v-.5)/intrinsics[1,1]*z,-z],-1).reshape(-1,3)
    uv=np.stack([u,1-v],-1).reshape(-1,2)
    ids=np.arange(x.size).reshape(x.shape)
    quads=np.stack([ids[:-1,:-1],ids[1:,:-1],ids[:-1,1:],ids[1:,1:]],-1)
    dz=z.ravel()[quads]
    split=np.max(dz,axis=-1)/np.min(dz,axis=-1)>1.06
    q=quads[~split]
    faces=np.concatenate([q[:,[0,1,2]],q[:,[2,1,3]]])
    px=[];py=[]
    for cy,cx in np.argwhere(split):
        yy,xx=np.mgrid[ys[cy]:ys[cy+1],xs[cx]:xs[cx+1]]
        px.extend(xx.ravel());py.extend(yy.ravel())
    px=np.asarray(px);py=np.asarray(py)
    zz=depth[py,px,None]
    uu=(px[:,None]+np.array([0,0,1,1]))/w
    vv=(py[:,None]+np.array([0,1,0,1]))/h
    tiles=np.stack([(uu-.5)/intrinsics[0,0]*zz,-(vv-.5)/intrinsics[1,1]*zz,-np.broadcast_to(zz,uu.shape)],-1).reshape(-1,3)
    tileuv=np.stack([uu,1-vv],-1).reshape(-1,2)
    ti=np.arange(len(tiles)).reshape(-1,4)+len(pos)
    faces=np.concatenate([faces,ti[:,[0,1,2]],ti[:,[2,1,3]]])
    return np.concatenate([pos,tiles]).astype('<f4'),np.concatenate([uv,tileuv]).astype('<f4'),faces.astype('<u4')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1])
    a=p.parse_args(); root=a.root
    src=np.load(root/'research/mountain-moge3/geometry.npz')
    bg=np.load(root/'research/background-moge3/geometry.npz')
    source=root/'outputs/mountain-memory/source.png'
    out=root/'viewer/dist/probe';out.mkdir(exist_ok=True)
    z=np.where(src['mask'] & np.isfinite(src['depth']),src['depth'],1200).clip(.25,1200)
    bz=np.where(bg['mask'] & np.isfinite(bg['depth']),bg['depth'],1200).clip(.25,1200)
    # Two independently inferred metric maps can disagree. Only the original
    # controls visible geometry; ensure the repair layer remains behind it.
    bz=np.maximum(bz,z*1.005)
    layers=[]
    for name,depth,stride,cut in [('source',z,2,1.08),('repair',bz,4,None)]:
        pos,uv,indices=source_geometry(depth,src['intrinsics']) if name=='source' else geometry(depth,src['intrinsics'],stride,cut)
        assert np.isfinite(pos).all()
        data=pos.tobytes()+uv.tobytes()+indices.tobytes()
        (out/f'{name}.bin').write_bytes(data)
        layers.append(dict(name=name,vertices=len(pos),triangles=len(indices),bytes=len(data),
                           sha256=hashlib.sha256(data).hexdigest()))
    shutil.copyfile(source,out/'source.png')
    shutil.copyfile(root/'research/hidden-background-registered.png',out/'repair.png')
    manifest=dict(version='mesh-probe-1',width=z.shape[1],height=z.shape[0],
                  intrinsics=src['intrinsics'].tolist(),layers=layers,
                  source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                  source_texture_unchanged=True,headset_verified=False,
                  generated_content='repair layer only; full surroundings pending')
    (out/'scene.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps(manifest,indent=2))


if __name__=='__main__':
    main()
