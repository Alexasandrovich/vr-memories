import {MeshoptEncoder} from './vendor/meshopt-encoder.js';

async function prepare(buffer) {
  const header = new DataView(buffer);
  if (header.getUint32(0,true)!==0x46546c67 || header.getUint32(4,true)!==2) throw Error('Файл сцены повреждён');
  const length = header.getUint32(12,true);
  const doc = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,length)));
  const base = 28+length;
  function attribute(index) {
    const a = doc.accessors[index], view = doc.bufferViews[a.bufferView];
    const size = {SCALAR:1, VEC3:3}[a.type];
    const Type = {5126:Float32Array,5125:Uint32Array,5123:Uint16Array}[a.componentType];
    return new Type(buffer, base+(view.byteOffset||0)+(a.byteOffset||0), size*a.count);
  }
  const optimize = MeshoptEncoder.supported && await MeshoptEncoder.ready.then(()=>true,()=>false);
  const surfaces = [];
  for (const mesh of doc.meshes) for (const p of mesh.primitives) {
    const positions = attribute(p.attributes.POSITION);
    const count = positions.length/3;
    const triangles = Uint32Array.from(attribute(p.indices));
    const remap = optimize ? MeshoptEncoder.reorderMesh(triangles,true,false)[0] : null;
    const sourcePhoto = p.extras?.sourcePhoto;
    const coordinates = Number.isInteger(sourcePhoto) ? attribute(p.attributes._PHOTO_PROJECTION) : null;
    const weights = coordinates && attribute(p.attributes._PHOTO_WEIGHT);
    const fullyTextured = !!weights && weights.every(value => value===1);
    const attrs = [['position',3,positions]];
    if (!fullyTextured) attrs.push(['color',3,attribute(p.attributes.COLOR_0)]);
    if (coordinates) attrs.push(['photoProjection',3,coordinates]);
    if (weights && !fullyTextured) attrs.push(['photoWeight',1,weights]);
    const stride = attrs.reduce((sum,[,size])=>sum+size,0);
    const vertices = new Float32Array(count*stride);
    let offset = 0;
    for (const [,size,data] of attrs) {
      for (let v=0; v<count; v++) {
        const slot=remap ? remap[v] : v;
        if (slot===undefined || slot===0xffffffff) continue;
        for (let c=0;c<size;c++) vertices[slot*stride+offset+c]=data[v*size+c];
      }
      offset+=size;
    }
    let shallowBackdrop=false;
    if (sourcePhoto===0 && doc.extras.photoAnchor && doc.extras.backgroundModel==='depth-mesh') {
      let near=Infinity,far=0;
      for(let i=2;i<coordinates.length;i+=3){near=Math.min(near,coordinates[i]);far=Math.max(far,coordinates[i]);}
      shallowBackdrop=near>0 && far<near*1.5;
    }
    const indices = count<=65535 ? Uint16Array.from(triangles) : triangles;
    surfaces.push({vertices,indices,stride,layout:attrs.map(([name,size])=>[name,size]),
      sourcePhoto,anchorId:p.extras?.anchorId,fullyTextured,shallowBackdrop,doubleSided:doc.materials[p.material].doubleSided});
  }
  const textures=[];
  for (const texture of doc.textures||[]) {
    const image=doc.images[texture.source],view=doc.bufferViews[image.bufferView];
    const bytes=new Uint8Array(buffer,base+(view.byteOffset||0),view.byteLength);
    const bitmap=await createImageBitmap(new Blob([bytes],{type:image.mimeType}),{colorSpaceConversion:'none'});
    textures.push({bitmap,depth:texture.extras?.role==='depth'});
  }
  return {pose:doc.extras,textures,surfaces};
}

self.onmessage=async ({data})=>{
  try {
    const scene=await prepare(data);
    self.postMessage(scene,[...scene.textures.map(t=>t.bitmap),...scene.surfaces.flatMap(s=>[s.vertices.buffer,s.indices.buffer])]);
  } catch(error){ self.postMessage({error:error.message}); }
};
