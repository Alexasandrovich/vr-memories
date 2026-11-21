"""Local fallback for generated context geometry; preserves the MoGe 3 source."""
import argparse
import json
from pathlib import Path
import time
import cv2
import numpy as np
import torch
from moge.model.v2 import MoGeModel


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('image',type=Path);p.add_argument('output',type=Path)
    p.add_argument('--checkpoint',type=Path,required=True)
    p.add_argument('--fov',type=float,required=True)
    p.add_argument('--device',choices=['mps','cpu','cuda'],default='mps')
    p.add_argument('--max-edge',type=int,default=1600)
    p.add_argument('--tokens',type=int,default=1800)
    a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False)
    im=cv2.cvtColor(cv2.imread(str(a.image)),cv2.COLOR_BGR2RGB)
    if max(im.shape[:2])>a.max_edge:
        scale=a.max_edge/max(im.shape[:2]);im=cv2.resize(im,(round(im.shape[1]*scale),round(im.shape[0]*scale)),interpolation=cv2.INTER_AREA)
    model=MoGeModel.from_pretrained(a.checkpoint).to(a.device).eval()
    x=torch.from_numpy(im.copy()).to(a.device).permute(2,0,1).float()/255
    print('Model loaded on',a.device,'input',im.shape,flush=True)
    start=time.monotonic()
    with torch.inference_mode():out=model.infer(x,num_tokens=a.tokens,fov_x=a.fov,use_fp16=False)
    if a.device=='mps':torch.mps.synchronize()
    arrays={k:v.cpu().numpy() for k,v in out.items() if torch.is_tensor(v)}
    stats=dict(method='MoGe 2 vitl-normal',device=a.device,seconds=time.monotonic()-start,
               shape=list(im.shape),tokens=a.tokens,fov_x=a.fov,valid_fraction=float(arrays['mask'].mean()))
    np.savez_compressed(a.output/'geometry.npz',**arrays)
    (a.output/'metrics.json').write_text(json.dumps(stats,indent=2)+'\n')
    z=arrays['depth'];valid=arrays['mask'] & np.isfinite(z) & (z>0)
    lo,hi=np.percentile(z[valid],[1,99]);viz=np.clip((np.log(np.where(valid,z,lo))-np.log(lo))/np.log(hi/lo),0,1)
    cv2.imwrite(str(a.output/'depth.png'),np.uint8(viz*255))
    print(json.dumps(stats),flush=True)


if __name__=='__main__':main()
