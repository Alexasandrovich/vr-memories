import * as THREE from 'three';
import {FullScreenQuad} from './vendor/Pass.js';

// Copy the four original integer words, in the original blend order, once
// when Spark publishes new positions or sort indices. Both eyes then read
// adjacent records instead of chasing the same indices four times per quad.
function cacheSortedRecords(spark) {
  const uniforms = {indices:{value:null}, records:{value:null}, count:{value:0}};
  const copy = new FullScreenQuad(new THREE.RawShaderMaterial({
    uniforms, glslVersion:THREE.GLSL3, depthTest:false, depthWrite:false,
    vertexShader:'in vec3 position; void main(){gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader:`precision highp float; precision highp int;
      uniform highp usampler2D indices; uniform highp usampler2DArray records;
      uniform int count; out uvec4 record;
      void main() {
        ivec2 pixel=ivec2(gl_FragCoord.xy);
        int i=pixel.y*2048+pixel.x;
        if(i>=count){record=uvec4(0);return;}
        uint j=texelFetch(indices,ivec2((i>>2)&4095,i>>14),0)[i&3];
        if(j==0xffffffffu){record=uvec4(0);return;}
        record=texelFetch(records,ivec3(j&2047u,(j>>11u)&2047u,j>>22u),0);
      }`
  }));
  const target = new THREE.WebGLRenderTarget(2048,1,{
    format:THREE.RGBAIntegerFormat,type:THREE.UnsignedIntType,internalFormat:'RGBA32UI',
    minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false,stencilBuffer:false
  });
  let lastDisplay, lastGeneration, lastOrder, consecutiveUses = 0;
  const viewport = new THREE.Vector4();
  return renderer => {
    const height = Math.ceil(spark.activeSplats / 2048);
    if (!height || height > renderer.capabilities.maxTextureSize) return null;
    const display = spark.display;
    if (display !== lastDisplay || display.generation !== lastGeneration || spark.orderRevision !== lastOrder) {
      lastDisplay=display;lastGeneration=display.generation;lastOrder=spark.orderRevision;
      consecutiveUses=0;
    }
    // During a walk new positions/orders can arrive every frame. In that
    // case draw directly and avoid paying for an extra full-scene GPU pass.
    if (++consecutiveUses <= 4) return null;
    if (consecutiveUses === 5) {
      target.setSize(2048,height);
      uniforms.indices.value=spark.orderingTexture;
      uniforms.records.value=display.getTextures()[0];
      uniforms.count.value=spark.activeSplats;
      const destination=renderer.getRenderTarget(), face=renderer.getActiveCubeFace(), mip=renderer.getActiveMipmapLevel();
      const xr=renderer.xr.enabled, clear=renderer.autoClear;
      renderer.getCurrentViewport(viewport);
      try {
        renderer.xr.enabled=false;renderer.autoClear=false;
        renderer.setRenderTarget(target);copy.render(renderer);
      } finally {
        renderer.setRenderTarget(destination,face,mip);renderer.state.viewport(viewport);
        renderer.xr.enabled=xr;renderer.autoClear=clear;
      }
    }
    return target.texture;
  };
}

// Mobile GPUs can batch more vertex work when an instance contains several
// adjacent quads. Each quad still uses the corresponding original sort entry.
export function batchFullSplats(spark) {
  const batchSize = 32;
  const geometry = spark.geometry;
  const corners = geometry.getAttribute('position').array;
  const quad = geometry.index.array;
  const vertices = new Float32Array(batchSize * corners.length);
  const indices = new Uint16Array(batchSize * quad.length);
  for (let i = 0; i < batchSize; ++i) {
    vertices.set(corners, i * corners.length);
    for (let j = 0; j < quad.length; ++j) indices[i * quad.length + j] = 4 * i + quad[j];
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  const material = spark.material;
  const sortedRecords = cacheSortedRecords(spark);
  material.uniforms.sortedRecords = {value:null};
  material.uniforms.useSortedRecords = {value:false};
  material.uniforms.activeCount = {value:0};
  material.vertexShader = 'uniform int activeCount; uniform highp usampler2D sortedRecords; uniform bool useSortedRecords;\n' + material.vertexShader
    .replaceAll('gl_InstanceID', 'sortIndex')
    .replace('ivec2 orderingCoord =', `
      int sortIndex = gl_InstanceID * ${batchSize} + (gl_VertexID >> 2);
      if (sortIndex >= activeCount) return;
      ivec2 orderingCoord =`)
    .replace('uint splatIndex = texelFetch', 'uint splatIndex = useSortedRecords ? uint(sortIndex) : texelFetch')
    .replace('uvec4 packedData = texelFetch', 'uvec4 packedData = useSortedRecords ? texelFetch(sortedRecords,ivec2(sortIndex & 2047, sortIndex >> 11),0) : texelFetch');
  const prepareEye = spark.onBeforeRender;
  spark.onBeforeRender = function (...args) {
    prepareEye.apply(this, args);
    const texture = sortedRecords(args[0]);
    material.uniforms.sortedRecords.value = texture || this.uniforms.ordering.value;
    material.uniforms.useSortedRecords.value = !!texture;
    material.uniforms.activeCount.value = this.activeSplats;
    geometry.instanceCount = Math.ceil(this.activeSplats / batchSize);
  };
}
