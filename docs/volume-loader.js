import * as THREE from 'three';
import {mapPhotograph, referenceCamera} from './volume-material.js';

export async function loadVolume(url, renderer, signal) {
  const response = await fetch(url, {signal});
  if (!response.ok) throw Error('Не удалось загрузить объём фотографии');
  const stage = await readStage(await response.arrayBuffer(), renderer);
  if (signal?.aborted) {
    disposeStage(stage.group);
    signal.throwIfAborted();
  }
  return stage;
}

export function alignToPhoto({group, pose}) {
  const eye = new THREE.Vector3().fromArray(pose.eye);
  const rotation = new THREE.Matrix4().lookAt(eye, new THREE.Vector3().fromArray(pose.target), new THREE.Vector3().fromArray(pose.cameraUp));
  group.quaternion.setFromRotationMatrix(rotation).invert();
  group.position.copy(eye).negate().applyQuaternion(group.quaternion);
}

// The walk volume exporter writes indexed triangle primitives with position and linear RGB.
async function readStage(buffer, renderer) {
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2) throw Error('Файл сцены повреждён');
  const length = header.getUint32(12, true);
  const doc = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)));
  const base = 28 + length;
  const attribute = index => {
    const a = doc.accessors[index], view = doc.bufferViews[a.bufferView];
    const size = {SCALAR: 1, VEC3: 3}[a.type];
    const Type = {5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array}[a.componentType];
    const data = new Type(buffer, base + (view.byteOffset || 0) + (a.byteOffset || 0), size * a.count);
    return new THREE.BufferAttribute(data, size);
  };
  const group = new THREE.Group();
  const textures = [];
  group.userData.textures = textures;
  try {
    for (const definition of doc.textures || []) {
      const image = doc.images[definition.source];
      const view = doc.bufferViews[image.bufferView];
      const bytes = new Uint8Array(buffer, base + (view.byteOffset || 0), view.byteLength);
      const bitmap = await createImageBitmap(new Blob([bytes], {type: image.mimeType}), {colorSpaceConversion: 'none'});
      const texture = new THREE.Texture(bitmap);
      texture.flipY = false;
      if (definition.extras?.role === 'depth') {
        texture.colorSpace = THREE.NoColorSpace;
        texture.generateMipmaps = false;
        texture.minFilter = texture.magFilter = THREE.NearestFilter;
      } else {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      }
      texture.needsUpdate = true;
      textures.push(texture);
    }
    const anchor = referenceCamera(doc.extras, textures);
    for (const mesh of doc.meshes) for (const p of mesh.primitives) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', attribute(p.attributes.POSITION));
      g.setAttribute('color', attribute(p.attributes.COLOR_0));
      const index = attribute(p.indices);
      // Keep the indexed order and release the original GLB, including all PNG data.
      // WebGL 2 reserves the largest index of each type for primitive restart.
      const IndexType = g.attributes.position.count <= 65535 ? Uint16Array : index.array.constructor;
      g.setIndex(new THREE.BufferAttribute(new IndexType(index.array), 1));
      const material = new THREE.MeshBasicMaterial({vertexColors: true, side: doc.materials[p.material].doubleSided ? THREE.DoubleSide : THREE.FrontSide});
      if (Number.isInteger(p.extras?.sourcePhoto)) {
        g.setAttribute('photoProjection', attribute(p.attributes._PHOTO_PROJECTION));
        g.setAttribute('photoWeight', attribute(p.attributes._PHOTO_WEIGHT));
        const fullyTextured = g.attributes.photoWeight.array.every(value => value === 1);
        material.vertexColors = !fullyTextured;
        if (fullyTextured) {
          g.deleteAttribute('color');
          g.deleteAttribute('photoWeight');
        }
        // A shallow background is an open relief. Small depth ripples can otherwise
        // expose the photograph from inside the sheet as the viewer passes behind it.
        let shallowBackdrop = false;
        if (anchor && doc.extras.backgroundModel === 'depth-mesh' && p.extras.sourcePhoto === 0) {
          const projection = g.attributes.photoProjection;
          let near = Infinity, far = 0;
          for (let i = 0; i < projection.count; i++) {
            const depth = projection.getZ(i);
            near = Math.min(near, depth);
            far = Math.max(far, depth);
          }
          shallowBackdrop = near > 0 && far < near * 1.5;
        }
        mapPhotograph(material, textures[p.extras.sourcePhoto], anchor, p.extras.anchorId, fullyTextured, shallowBackdrop);
      }
      interleaveAttributes(g);
      group.add(new THREE.Mesh(g, material));
    }
  } catch (error) {
    disposeStage(group);
    throw error;
  }
  return {group, pose: doc.extras};
}
// Positions, colours and photographic coordinates retain their original Float32 values.
// A single vertex buffer serves both eyes and all full-resolution passes.
function interleaveAttributes(geometry) {
  const attributes = Object.entries(geometry.attributes);
  const stride = attributes.reduce((sum, [, attribute]) => sum + attribute.itemSize, 0);
  const vertexCount = geometry.attributes.position.count;
  const buffer = new THREE.InterleavedBuffer(new Float32Array(vertexCount * stride), stride);
  let offset = 0;
  for (const [name, attribute] of attributes) {
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const src = vertex * attribute.itemSize;
      const dst = vertex * stride + offset;
      for (let channel = 0; channel < attribute.itemSize; channel++) {
        buffer.array[dst + channel] = attribute.array[src + channel];
      }
    }
    geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(buffer, attribute.itemSize, offset));
    offset += attribute.itemSize;
  }
}

export function disposeStage(group) {
  group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  for (const texture of group.userData.textures) {
    texture.dispose();
    texture.image.close();
  }
}
