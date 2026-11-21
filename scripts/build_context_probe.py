"""Attach a generated, depth-bearing wider camera field to the exact source."""
import hashlib
import json
from pathlib import Path
import cv2
import numpy as np
from build_mesh_probe import geometry


def extend_boundary(residual, rect, shape):
    x,y,w,h=rect;H,W=shape;step=8
    hh,ww=(H+step-1)//step,(W+step-1)//step
    yy,xx=np.mgrid[:hh,:ww]*step
    known=(xx>=x)&(xx<x+w)&(yy>=y)&(yy<y+h)
    values=np.zeros((hh,ww),np.float32)
    values[known]=residual[yy[known]-y,xx[known]-x]
    known[[0,-1],:]=True;known[:,[0,-1]]=True
    field=values.copy();kernel=np.array([[0,.25,0],[.25,0,.25],[0,.25,0]],np.float32)
    for _ in range(2000):
        field=cv2.filter2D(field,-1,kernel);field[known]=values[known]
    return cv2.resize(field,(W,H),interpolation=cv2.INTER_LINEAR)


def main():
    root=Path(__file__).resolve().parents[1]
    r=root/'research/wide-registered-01';m=json.loads((r/'registration.json').read_text())
    out=root/'viewer/dist/probe';W,H=m['width'],m['height'];x,y,w,h=m['source_rect']
    wide=np.load(root/'research/wide-moge2/geometry.npz')
    src=np.load(root/'research/mountain-moge3/geometry.npz')
    valid=cv2.resize(wide['mask'].astype(np.uint8),(W,H),interpolation=cv2.INTER_NEAREST)>0
    raw=np.where(wide['mask'] & np.isfinite(wide['depth']),wide['depth'],1200).clip(.25,1200)
    z=cv2.resize(raw,(W,H),interpolation=cv2.INTER_LINEAR)
    sz=np.where(src['mask'] & np.isfinite(src['depth']),src['depth'],1200).clip(.25,1200)
    crop=z[y:y+h,x:x+w]
    ok=src['mask'] & valid[y:y+h,x:x+w] & (sz<800) & (crop<800)
    a=np.log(crop[ok][::8]);b=np.log(sz[ok][::8]);A=np.column_stack([a,np.ones(len(a))]);weight=np.ones(len(a))
    for _ in range(8):
        fit=np.linalg.lstsq(A*weight[:,None],b*weight,rcond=None)[0]
        error=np.abs(A@fit-b);weight=np.minimum(1,.2/np.maximum(error,1e-5))
    if not .5<fit[0]<2:raise RuntimeError('Depth calibration is not credible')
    logz=np.log(z)*fit[0]+fit[1]
    # Align the outer field to observed metric depths; no changes to the
    # original source geometry. Sky is explicitly assigned a distant surface.
    residual=np.log(sz)-logz[y:y+h,x:x+w]
    correction=extend_boundary(cv2.GaussianBlur(residual,(0,0),8),m['source_rect'],(H,W))
    z=np.exp(np.clip(logz+correction,np.log(.25),np.log(1200))).astype(np.float32)
    z[~valid]=1200;z[y:y+h,x:x+w]=sz
    K=np.array([[m['focal_px']/W,0,.5],[0,m['focal_px']/H,.5],[0,0,1]],np.float32)
    positions,uv,faces=geometry(z,K,6,None)
    # Leave a 32-pixel overlap behind the original edges, but exclude the
    # synthesized person from the central context surface entirely.
    center=uv[faces].mean(1);px=center[:,0]*W;py=(1-center[:,1])*H
    faces=faces[~((px>x+32)&(px<x+w-32)&(py>y+32)&(py<y+h-32))]
    data=positions.tobytes()+uv.tobytes()+faces.tobytes();(out/'context.bin').write_bytes(data)
    image=cv2.imread(str(r/'context-harmonized.png'));cv2.imwrite(str(out/'context.png'),image)
    spec=dict(name='context',vertices=len(positions),triangles=len(faces),bytes=len(data),
              sha256=hashlib.sha256(data).hexdigest(),intrinsics=K.tolist(),
              horizontal_fov_deg=m['horizontal_fov_deg'],vertical_fov_deg=m['vertical_fov_deg'],
              generated=True,depth_log_calibration=fit.tolist(),median_log_error=float(np.median(error)),
              limitations='Generated surroundings; source texture and source geometry remain independent.')
    (out/'context.json').write_text(json.dumps(spec,indent=2)+'\n')
    np.savez_compressed(r/'context-depth-calibrated.npz',depth=z,mask=valid,intrinsics=K)
    print(json.dumps(spec,indent=2))


if __name__=='__main__':main()
