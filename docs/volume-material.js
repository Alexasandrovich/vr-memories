import * as THREE from 'three';

export function referenceCamera(pose, textures) {
  if (!pose.photoAnchor) return null;
  const {color, depth, focal} = pose.photoAnchor;
  const eye = new THREE.Vector3().fromArray(pose.eye);
  const forward = new THREE.Vector3().fromArray(pose.target).sub(eye).normalize();
  const up = new THREE.Vector3().fromArray(pose.cameraUp).normalize();
  return {
    original: {value: textures[color]}, visibility: {value: textures[depth]},
    focal: {value: new THREE.Vector2(...focal)}, origin: {value: eye},
    forward: {value: forward}, right: {value: forward.clone().cross(up).normalize()}, sourceUp: {value: up}
  };
}

const anchorVertex = `
  uniform vec2 focal;
  uniform vec3 origin, forward, right, sourceUp;
  varying highp vec3 sourceView;
`;
const projectSource = `
  vec3 relative = position - origin;
  float z = dot(relative, forward);
  sourceView = vec3(vec2(dot(relative,right), -dot(relative,sourceUp)) * focal + .5 * z, z);
`;
const anchorFragment = `
  uniform sampler2D original, visibility;
  uniform float objectId;
  varying highp vec3 sourceView;

  float sourceVisibility(ivec2 pixel, float z) {
    ivec2 limit = textureSize(visibility, 0) - ivec2(1);
    vec3 code = floor(texelFetch(visibility, clamp(pixel, ivec2(0), limit), 0).rgb * 255. + .5);
    if (abs(code.b - objectId) > .25) return 0.;
    float depth = dot(code.rg, vec2(.256, .001));
    float tolerance = max(.004, z * .002);
    return 1. - smoothstep(tolerance, tolerance * 2.5, abs(depth - z));
  }
`;
const restoreOriginal = `
  vec2 sourceUV = sourceView.xy / sourceView.z;
  vec3 originalColor = texture2D(original, sourceUV).rgb;
  if (sourceView.z > 0. && all(greaterThanEqual(sourceUV, vec2(0.))) && all(lessThanEqual(sourceUV, vec2(1.)))) {
    vec2 p = sourceUV * vec2(textureSize(visibility, 0)) - .5;
    ivec2 ij = ivec2(floor(p));
    vec2 frac = fract(p);
    float top = mix(sourceVisibility(ij, sourceView.z), sourceVisibility(ij + ivec2(1,0), sourceView.z), frac.x);
    float bottom = mix(sourceVisibility(ij + ivec2(0,1), sourceView.z), sourceVisibility(ij + ivec2(1,1), sourceView.z), frac.x);
    diffuseColor.rgb = mix(diffuseColor.rgb, originalColor, mix(top, bottom, frac.y));
  }
`;

// All blend factors are attached to surfaces in the capture camera. Both eyes
// see the same material when a previously hidden part comes into view.
export function mapPhotograph(material, texture, anchor, objectId, fullyTextured = false, shallowBackdrop = false) {
  material.customProgramCacheKey = () => 'photo-' + Boolean(anchor) + '-' + fullyTextured + '-' + shallowBackdrop;
  material.onBeforeCompile = shader => {
    shader.uniforms.sourcePhoto = {value: texture};
    if (anchor) Object.assign(shader.uniforms, anchor, {objectId: {value: objectId}});
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 photoProjection;
        ${fullyTextured ? '' : 'attribute float photoWeight; varying highp float weight;'}
        varying highp vec3 projected;
        ${shallowBackdrop ? 'varying highp float captureSide;' : ''}
        ${anchor ? anchorVertex : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        projected = photoProjection;
        ${fullyTextured ? '' : 'weight = photoWeight;'}
        ${anchor ? projectSource : ''}
        ${shallowBackdrop ? 'captureSide = dot((modelMatrix * vec4(position, 1.)).xyz - cameraPosition, mat3(modelMatrix) * forward);' : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D sourcePhoto;
        varying highp vec3 projected;
        ${shallowBackdrop ? 'varying highp float captureSide;' : ''}
        ${fullyTextured ? '' : 'varying highp float weight;'}
        ${anchor ? anchorFragment : ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        ${shallowBackdrop ? 'if (captureSide <= 0.) discard;' : ''}
        vec3 detail = texture2D(sourcePhoto, projected.xy / projected.z).rgb;
        ${fullyTextured ? 'diffuseColor.rgb = detail;' : 'diffuseColor.rgb = mix(diffuseColor.rgb, detail, clamp(weight, 0.0, 1.0));'}
        ${anchor ? restoreOriginal : ''}`);
  };
}
