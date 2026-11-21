export const projectionShaders={
vertexShader:'varying vec2 ndc; void main(){ndc=position.xy; gl_Position=vec4(ndc,0.,1.);}',
 fragmentShader:`varying vec2 ndc;uniform sampler2D video;uniform mat4 inverseProj;uniform mat3 toVideo;
 uniform float correction;uniform vec2 pixel;
 uniform vec4 k;uniform float eye;uniform sampler2D depthGrid;uniform sampler2D flowGrid;uniform vec3 offset;
 vec2 atlasUV(vec2 uv, vec2 size){
   vec2 margin=vec2(1./size.x,.5/size.y);
   vec2 sampleUV=clamp(vec2(uv.x,1.-uv.y),margin,1.-margin);
   return vec2((eye+sampleUV.x)*.5,sampleUV.y);
 }
 float invDepth(vec2 uv){return 2.*texture2D(depthGrid,atlasUV(uv,vec2(textureSize(depthGrid,0)))).r;}
 void main(){
   vec4 nearPoint=inverseProj*vec4(ndc,0.,1.);
   vec3 direction=toVideo*nearPoint.xyz;
   vec2 slope=direction.xy/max(-direction.z,.00001);
   vec2 initial=k.xy*slope+k.zw;
   vec2 shift=k.xy*(offset.xy+slope*offset.z);
   vec2 uv=initial+shift*invDepth(initial);
   for(int i=0;i<3;i++)uv=initial+shift*invDepth(uv);
   vec2 residual=(texture2D(flowGrid,atlasUV(uv,vec2(textureSize(flowGrid,0)))).rg*255.-128.)*.25;
   uv+=residual*pixel*correction;
   if(direction.z>=0. || any(lessThan(uv,vec2(0.))) || any(greaterThan(uv,vec2(1.)))) {
     gl_FragColor=vec4(0.,0.,0.,1.);return;
   }
   gl_FragColor=vec4(texture2D(video,vec2((eye+uv.x)*.5,uv.y)).rgb,1.);
 }`
};

export function correctionDuration(pairInterval){return Math.min(44,Math.max(18,.7*pairInterval));}
export function correctionWeight(elapsed,duration){
  if(!duration)return 0;
  const t=Math.min(1,Math.max(0,elapsed/duration));
  return 1-t*t*(3-2*t);
}
