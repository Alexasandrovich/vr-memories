"""Register generated context to a calibrated source; do not repaint the source."""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np


def calibrate_context(context, source, rect):
    """Fit generated colors and extend a smooth correction outside the source.

    Texture is never low-pass filtered. The low-pass operation estimates an
    additive color correction; original pixels remain an independent anchor.
    """
    x,y,w,h=rect
    generated=context.astype(np.float32)/255
    original=source.astype(np.float32)/255
    s=cv2.GaussianBlur(original,(0,0),2)[::4,::4].reshape(-1,3)
    g=cv2.GaussianBlur(generated[y:y+h,x:x+w],(0,0),2)[::4,::4].reshape(-1,3)
    X=np.column_stack([g,np.ones(len(g))]);weights=np.ones(len(g))
    for _ in range(10):
        A=np.linalg.lstsq(X*weights[:,None],s*weights[:,None],rcond=None)[0]
        error=np.linalg.norm(X@A-s,axis=1);weights=np.minimum(1,.04/np.maximum(error,1e-5))
    calibrated=np.clip(generated@A[:3]+A[3],0,1)*255
    residual=cv2.GaussianBlur(source.astype(np.float32)-calibrated[y:y+h,x:x+w].astype(np.float32),(0,0),16)
    H,W=context.shape[:2];step=8;hh,ww=(H+step-1)//step,(W+step-1)//step
    yy,xx=np.mgrid[:hh,:ww]*step
    fixed=(xx>=x)&(xx<x+w)&(yy>=y)&(yy<y+h)
    field=np.zeros((hh,ww,3),np.float32)
    field[fixed]=residual[yy[fixed]-y,xx[fixed]-x]
    fixed[[0,-1],:]=True;fixed[:,[0,-1]]=True;values=field.copy()
    kernel=np.array([[0,.25,0],[.25,0,.25],[0,.25,0]],np.float32)
    for _ in range(2000):
        field=cv2.filter2D(field,-1,kernel);field[fixed]=values[fixed]
    field=cv2.resize(field,(W,H),interpolation=cv2.INTER_LINEAR)
    output=np.clip(calibrated+field,0,255).astype(np.uint8)
    return output,dict(bgr_matrix=A.tolist(),median_fit_error_255=float(np.median(error)*255),
                       correction='smooth additive color field; source pixels unchanged')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('source',type=Path);p.add_argument('outpaint',type=Path)
    p.add_argument('output',type=Path);p.add_argument('--focal-px',type=float,default=971.3682140491096)
    a=p.parse_args();a.output.mkdir(exist_ok=False,parents=True)
    src=cv2.imread(str(a.source));wide=cv2.imread(str(a.outpaint))
    assert src is not None and wide is not None
    sift=cv2.SIFT_create(nfeatures=12000)
    ks,ds=sift.detectAndCompute(src,None);kw,dw=sift.detectAndCompute(wide,None)
    matches=cv2.BFMatcher().knnMatch(ds,dw,k=2)
    good=[x for x,y in matches if x.distance<.72*y.distance]
    sp=np.float32([ks[m.queryIdx].pt for m in good]);wp=np.float32([kw[m.trainIdx].pt for m in good])
    H,mask=cv2.findHomography(sp,wp,cv2.RANSAC,2.0)
    if H is None or mask.sum()<40:raise RuntimeError('Insufficient source registration support')
    keep=mask[:,0]>0
    errors=np.linalg.norm(cv2.perspectiveTransform(sp[:,None],H)[:,0]-wp,axis=1)
    inverse=np.linalg.inv(H)
    h,w=src.shape[:2];wh,ww=wide.shape[:2]
    corners=np.float32([[0,0],[ww-1,0],[ww-1,wh-1],[0,wh-1]])
    poly=cv2.perspectiveTransform(corners[:,None],inverse)[:,0]
    c=np.array([w/2,h/2])
    half=np.minimum(c-poly.min(0),poly.max(0)-c)
    # Inscribe a source-centered crop, with a margin to avoid border replication.
    while True:
        target=c+np.array([[-1,-1],[1,-1],[1,1],[-1,1]])*half
        if all(cv2.pointPolygonTest(poly,tuple(map(float,q)),True)>3 for q in target):break
        half*=.99
    W,Hh=(np.floor(half*2/16)*16).astype(int)
    if W<=w or Hh<=h:raise RuntimeError('No useful camera-consistent expansion')
    shift=np.array([[1,0,W/2-c[0]],[0,1,Hh/2-c[1]],[0,0,1]])
    registered=cv2.warpPerspective(wide,shift@inverse,(W,Hh),flags=cv2.INTER_LANCZOS4)
    cv2.imwrite(str(a.output/'context.png'),registered)
    x,y=int(W/2-w/2),int(Hh/2-h/2)
    # Diagnostic source comparison only. Never feed the generator's person back
    # as the original. The viewer will keep the independent source texture.
    cv2.imwrite(str(a.output/'registered-center.png'),registered[y:y+h,x:x+w])
    harmonized,color_stats=calibrate_context(registered,src,[x,y,w,h])
    cv2.imwrite(str(a.output/'context-harmonized.png'),harmonized)
    harmonized[y:y+h,x:x+w]=src
    cv2.imwrite(str(a.output/'anchor-harmonized-preview.png'),harmonized)
    (a.output/'color-calibration.json').write_text(json.dumps(color_stats,indent=2)+'\n')
    manifest=dict(source_to_generated=H.tolist(),generated_to_registered=(shift@inverse).tolist(),
                  matches=len(good),inliers=int(keep.sum()),median_error_generated_px=float(np.median(errors[keep])),
                  p95_error_generated_px=float(np.percentile(errors[keep],95)),
                  width=int(W),height=int(Hh),source_rect=[x,y,w,h],focal_px=a.focal_px,
                  horizontal_fov_deg=float(np.rad2deg(2*np.arctan(W/(2*a.focal_px)))),
                  vertical_fov_deg=float(np.rad2deg(2*np.arctan(Hh/(2*a.focal_px)))),
                  inlier_source_bounds=[sp[keep].min(0).tolist(),sp[keep].max(0).tolist()],
                  source_unchanged=True,context_is_generated=True,quality_status='unreviewed')
    (a.output/'registration.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps(manifest,indent=2))


if __name__=='__main__':main()
