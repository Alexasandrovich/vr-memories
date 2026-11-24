import * as THREE from 'three';
import {mapPhotograph, referenceCamera} from './volume-material.js';

export async function loadVolume(url, renderer, signal) {
  const response = await fetch(url, {signal});
  if (!response.ok) throw Error('Не удалось загрузить объём фотографии');
  const buffer = await response.arrayBuffer();
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./volume-worker.js',import.meta.url),{type:'module'});
  let abort;
  const prepared = await new Promise((resolve,reject)=>{
    abort=()=>reject(signal.reason);
    signal?.addEventListener('abort',abort,{once:true});
    worker.onmessage=({data})=>data.error ? reject(Error(data.error)) : resolve(data);
    worker.onerror=event=>reject(Error(event.message || 'Не удалось подготовить геометрию'));
    worker.onmessageerror=()=>reject(Error('Не удалось прочитать сцену'));
    worker.postMessage(buffer,[buffer]);
  }).finally(()=>{signal?.removeEventListener('abort',abort);worker.terminate();});
  return createStage(prepared,renderer,signal);
}

export function alignToPhoto({group, pose}) {
  const eye = new THREE.Vector3().fromArray(pose.eye);
  const rotation = new THREE.Matrix4().lookAt(eye, new THREE.Vector3().fromArray(pose.target), new THREE.Vector3().fromArray(pose.cameraUp));
  group.quaternion.setFromRotationMatrix(rotation).invert();
  group.position.copy(eye).negate().applyQuaternion(group.quaternion);
}

async function createStage(prepared,renderer,signal) {
  const group=new THREE.Group();
  const textures=prepared.textures.map(({bitmap,depth})=>{
    const texture=new THREE.Texture(bitmap);
    texture.flipY=false;
    if(depth){
      texture.generateMipmaps=false;
      texture.minFilter=texture.magFilter=THREE.NearestFilter;
    }else{
      texture.colorSpace=THREE.SRGBColorSpace;
      texture.anisotropy=renderer.capabilities.getMaxAnisotropy();
    }
    texture.needsUpdate=true;
    return texture;
  });
  group.userData.textures=textures;
  try {
    const anchor=referenceCamera(prepared.pose,textures);
    for(const s of prepared.surfaces){
      const g=new THREE.BufferGeometry(), buffer=new THREE.InterleavedBuffer(s.vertices,s.stride);
      let offset=0;
      for(const [name,size] of s.layout){
        g.setAttribute(name,new THREE.InterleavedBufferAttribute(buffer,size,offset));
        offset+=size;
      }
      g.setIndex(new THREE.BufferAttribute(s.indices,1));
      const material=new THREE.MeshBasicMaterial({vertexColors:!s.fullyTextured,side:s.doubleSided?THREE.DoubleSide:THREE.FrontSide});
      if(Number.isInteger(s.sourcePhoto))mapPhotograph(material,textures[s.sourcePhoto],anchor,s.anchorId,s.fullyTextured,s.shallowBackdrop);
      const mesh=new THREE.Mesh(g,material);
      if(s.sourcePhoto===0)mesh.renderOrder=1;
      group.add(mesh);
    }
    for(const texture of textures){
      signal?.throwIfAborted();
      renderer.initTexture(texture);
      // Leave time for the album and head tracking between large uploads.
      if(renderer.xr.isPresenting)await new Promise(resolve=>setTimeout(resolve,14));
    }
    signal?.throwIfAborted();
    return {group,pose:prepared.pose};
  }catch(error){disposeStage(group);throw error;}
}

export function disposeStage(group) {
  group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  for (const texture of group.userData.textures) {
    texture.dispose();
    texture.image.close();
  }
}
