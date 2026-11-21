import {PhotoGallery} from './album.js';
import {projectionShaders,correctionWeight,correctionDuration} from './reproject.js';
import * as T from 'three';
import {moveHorizontal, navigate} from './walking.js';

const $=id=>document.getElementById(id);
let sceneName=document.body.dataset.scene || 'mountain-memory';
let previewWidth=Number(document.body.dataset.width || 1182);
let previewHeight=Number(document.body.dataset.height || 664);
let previewFov=Number(document.body.dataset.fov || 42);
const stage=$('stage'), scene=new T.Scene(), camera=new T.PerspectiveCamera(document.body.dataset.fov?previewFov:52,1,.02,2000);
const rig=new T.Group();scene.add(rig);rig.add(camera);
const renderer=new T.WebGLRenderer({antialias:false,depth:true,powerPreference:'high-performance'});
renderer.xr.enabled=true;renderer.xr.setReferenceSpaceType('local');renderer.xr.setFramebufferScaleFactor(1);renderer.xr.setFoveation(0);
stage.append(renderer.domElement);
function resize(){
  if(renderer.xr.isPresenting)return;
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(stage.clientWidth,stage.clientHeight,false);
  camera.aspect=stage.clientWidth/stage.clientHeight;camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);resize();
const tex=new T.VideoFrameTexture();
const uniforms={video:{value:tex},depthGrid:{value:null},flowGrid:{value:null},offset:{value:new T.Vector3()},correction:{value:0},pixel:{value:new T.Vector2()},inverseProj:{value:new T.Matrix4()},toVideo:{value:new T.Matrix3()},k:{value:new T.Vector4()},eye:{value:0}};
const material=new T.ShaderMaterial({uniforms,depthTest:false,depthWrite:false,toneMapped:false,
 ...projectionShaders});
const screen=new T.Mesh(new T.PlaneGeometry(2,2),material);
screen.frustumCulled=false;screen.visible=false;scene.add(screen);
let displayed,frameToClose,decoder,needKey=true,serial=0,configKey='',lastSent='',nextSend=0,errors=0;
let pending=new Map();
const orientation=new T.Matrix3();
screen.onBeforeRender=(_r,_s,eyeCamera)=>{
  const eye=renderer.xr.isPresenting && eyeCamera===renderer.xr.getCamera().cameras[1]?1:0;
  const view=displayed.views[eye];uniforms.eye.value=eye;
  uniforms.inverseProj.value.copy(eyeCamera.projectionMatrixInverse);
  uniforms.toVideo.value.copy(view.inverseRotation).multiply(orientation.setFromMatrix4(eyeCamera.matrixWorld));
  uniforms.offset.value.setFromMatrixPosition(eyeCamera.matrixWorld).sub(view.position).applyMatrix3(view.inverseRotation);
  uniforms.offset.value.clampLength(0,.075);
  uniforms.k.value.copy(view.uv);material.uniformsNeedUpdate=true;
};
let depthTexture,flowTexture;
let transportDelay=65,pairInterval=50,lastPairAt=0,xrStats=null;
const displayGaps=[],pairGaps=[];
function p95(values){
  if(!values.length)return 0;
  const sorted=values.slice().sort((a,b)=>a-b);
  return Math.round(sorted[Math.ceil(sorted.length*.95)-1]);
}
let shown=0,callbacks=0,elapsedAt=0,lastMetrics='',lastVR='',lastDelay=0;
// Decode and presentation have different clocks. Schedule by capture time
// so Wi-Fi bursts never turn into two visible camera corrections in one tick.
const decoded=[];
let latencyDeviation=10,correctionAt=0,correctionMs=0;
const targetAge=()=>Math.min(155,transportDelay+Math.min(28,1.3*latencyDeviation));
function acceptFrame(frame){
  const data=pending.get(frame.timestamp);pending.delete(frame.timestamp);
  if(!data){frame.close();return;}
  const delay=performance.now()-data.sent;
  if(delay<350){
    latencyDeviation+=.12*(Math.abs(delay-transportDelay)-latencyDeviation);
    transportDelay+=.16*(delay-transportDelay);
  }
  decoded.push({frame,data});
  if(decoded.length>3)decoded.shift().frame.close();
}
function presentFrame(time){
  let selected;
  while(decoded.length && (!displayed || decoded[0].data.presentAt<=time)){
    selected?.frame.close();
    selected=decoded.shift();
  }
  uniforms.correction.value=correctionWeight(time-correctionAt,correctionMs);
  if(!selected)return;
  const {frame,data}=selected;
  if(!depthTexture || depthTexture.image.width!==2*data.dw || depthTexture.image.height!==data.dh){
    depthTexture?.dispose();
    depthTexture=new T.DataTexture(data.depth,2*data.dw,data.dh,T.RedFormat);
    flowTexture?.dispose();
    flowTexture=new T.DataTexture(data.flow,2*data.fw,data.fh,T.RGFormat);
    flowTexture.magFilter=flowTexture.minFilter=T.LinearFilter;
    uniforms.flowGrid.value=flowTexture;
    depthTexture.magFilter=T.LinearFilter;depthTexture.minFilter=T.LinearFilter;
    uniforms.depthGrid.value=depthTexture;
  }
  flowTexture.image.data=data.flow;flowTexture.needsUpdate=true;
  depthTexture.image.data=data.depth;depthTexture.needsUpdate=true;
  const matches=data.base!==0 && data.base===displayed?.timestamp && time-lastPairAt<180 && data.views[0].position.distanceToSquared(displayed.views[0].position)<.18**2;
  correctionMs=matches?correctionDuration(pairInterval):0;
  correctionAt=time;
  uniforms.correction.value=matches?1:0;
  uniforms.pixel.value.set(1/data.w,-1/data.h);
  frameToClose?.close();
  frameToClose=frame;displayed=data;tex.setFrame(frame);screen.visible=true;shown++;
  const gap=time-lastPairAt;
  if(lastPairAt && gap>4 && gap<500){
    pairInterval+=.15*(gap-pairInterval);
    if(renderer.xr.isPresenting)pairGaps.push(gap);
  }
  lastPairAt=time;lastDelay=performance.now()-data.sent;errors=0;
  if($('status').textContent!=='Подключено к RTX')$('status').textContent='Подключено к RTX';
  $('enter').disabled=!xrAvailable;
  if(gallery.opening){previousScene=null;gallery.close(true);}
}
let xrAvailable=false, inflight=0, generation=0, nextCaptureAt=0;
let streamId=crypto.randomUUID();
const delivery=new Map();
function resetDecoder(){
  generation++;
  for(const entry of decoded.splice(0))entry.frame.close();
  streamId=crypto.randomUUID();
  if(decoder && decoder.state!=='closed')decoder.close();
  decoder=null;pending.clear();delivery.clear();needKey=true;lastSent='';nextCaptureAt=0;
}
function failStream(e){
  resetDecoder();errors++;retryAt=performance.now()+Math.min(4000,errors*600);
  $('status').textContent='Соединение с RTX: '+e.message;
  if(gallery.opening)gallery.error('Не удалось открыть стереопару. Можно повторить.');
}
function decodeReady(){
  for(const [timestamp,slot] of delivery){
    if(!slot.complete)break;
    delivery.delete(timestamp);
    if(slot.skipped)continue;
    if(needKey&&!slot.isKey)throw Error('Ожидается ключевой кадр');
    pending.set(timestamp,slot.view);
    decoder.decode(new EncodedVideoChunk({type:slot.isKey?'key':'delta',timestamp,data:slot.video}));
    needKey=false;
  }
}
async function send(view){
  const size=view.w+'x'+view.h;
  if(configKey!==size){resetDecoder();configKey=size;}
  const epoch=generation;
  try{
    if(!decoder){
      decoder=new VideoDecoder({output:acceptFrame,error:e=>{if(epoch===generation)failStream(e);}});
      decoder.configure({codec:'avc1.640034',codedWidth:2*view.w,codedHeight:view.h,optimizeForLatency:true,hardwareAcceleration:'prefer-hardware'});
    }
    const sent=performance.now(),timestamp=Math.max(serial+1,Math.round(sent*1000));
    const q={id:streamId,scene:sceneName,sequence:timestamp,w:view.w,h:view.h,v:view.views.flatMap(v=>v.v),k:view.views.flatMap(v=>v.k),key:needKey,depth:true,motionField:true,contourMotion:true,xrStats};
    const key=JSON.stringify([q.w,q.h,q.v,q.k]);
    if(key===lastSent && displayed && !needKey && sent<nextSend)return;
    serial=timestamp;lastSent=key;nextSend=sent+1500;
    nextCaptureAt=sent+Math.max(12,Math.min(50,transportDelay*.43));
    const presentAt=sent+targetAge();
    const slot={complete:false};
    delivery.set(timestamp,slot);
    inflight++;
    try{
      const response=await fetch('./frame',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(q),signal:AbortSignal.timeout(45000)});
      if(!response.ok)throw Error('HTTP '+response.status);
      if(epoch!==generation){await response.body?.cancel();return;}
      if(response.status===204){slot.skipped=true;}
      else{
        const bytes=await response.arrayBuffer(),header=new DataView(bytes);
        if(header.getUint32(0)!==0x56524132)throw Error('Неверный формат кадра RTX');
        const dw=header.getUint16(4),dh=header.getUint16(6),end=20+header.getUint32(8),base=Number(header.getBigUint64(12));
        if(dw!==(view.w>>3)||dh!==(view.h>>3)||end>=bytes.byteLength)throw Error('Повреждён кадр глубины');
        const stream=new Blob([new Uint8Array(bytes,20,end-20)]).stream().pipeThrough(new DecompressionStream('deflate'));
        const payload=new Uint8Array(await new Response(stream).arrayBuffer());
        if(epoch!==generation)return;
        const fw=Math.ceil(dw/2),fh=Math.ceil(dh/2);
        const depth=payload.subarray(0,2*dw*dh),flow=payload.subarray(2*dw*dh);
        if(flow.length!==fw*fh*4)throw Error('Неверный размер карты глубины');
        slot.view={...view,base,timestamp,sent,presentAt,dw,dh,depth,fw,fh,flow};
        slot.video=new Uint8Array(bytes,end);slot.isKey=response.headers.get('X-Keyframe')==='1';
      }
      slot.complete=true;
      decodeReady();
    }finally{inflight--;}
  }catch(e){if(epoch===generation)failStream(e);}
}
const keys=new Set(),travel=new T.Vector3(),anchor=new T.Vector3(),headEuler=new T.Euler(0,0,0,'YXZ');
const gaze=new T.Quaternion(), axisY=new T.Vector3(0,1,0), world=new T.Matrix4();
const previousHead=new T.Vector3(),currentHead=new T.Vector3(),velocity=new T.Vector3(),sampleVelocity=new T.Vector3(),prediction=new T.Vector3();
let hasHeadSample=false;
let firstYaw=null,rigYaw=0,drag=null,yaw=0,pitch=0,last=0,retryAt=0,enabled=false;
function recenter(){firstYaw=null;hasHeadSample=false;velocity.set(0,0,0);prediction.set(0,0,0);travel.set(0,0,0);yaw=pitch=0;keys.clear();lastSent='';}
$('center').onclick=recenter;
for(const b of document.querySelectorAll('[data-dx],[data-dz]'))b.onclick=()=>moveHorizontal(travel,Number(b.dataset.dx||0),Number(b.dataset.dz||0),yaw,.25);
const codes=new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight']);
window.addEventListener('keydown',e=>{if(codes.has(e.code)&&!e.ctrlKey&&!e.metaKey){e.preventDefault();keys.add(e.code);}});
window.addEventListener('keyup',e=>keys.delete(e.code));window.addEventListener('blur',()=>keys.clear());
stage.onpointerdown=e=>{drag=[e.clientX,e.clientY];stage.setPointerCapture(e.pointerId);};
stage.onpointermove=e=>{if(drag){yaw+=(e.clientX-drag[0])*.004;pitch=T.MathUtils.clamp(pitch+(e.clientY-drag[1])*.004,-1.5,1.5);drag=[e.clientX,e.clientY];}};
stage.onpointerup=stage.onpointercancel=()=>{drag=null;};
function makeView(position,rotation,projection,w,h){
  const pose=new T.Matrix4().makeRotationFromQuaternion(rotation).setPosition(position);
  const inv=pose.clone().invert(), basis=new T.Matrix3().setFromMatrix4(inv);
  // OpenGL world to original SHARP (OpenCV) world and camera axes.
  const f=new T.Matrix4().makeScale(1,-1,-1);
  const v=f.clone().multiply(inv).multiply(f).transpose().toArray();
  const p=projection.elements, fx=p[0]*w/2,fy=p[5]*h/2,cx=(1-p[8])*w/2,cy=(1+p[9])*h/2;
  return {position:position.clone(),v,k:[fx,0,cx,0,fy,cy,0,0,1],inverseRotation:basis,uv:new T.Vector4(fx/w,fy/h,cx/w,1-cy/h)};
}
let previousScene=null,albumAvailable=false;
function switchScene(config){
  sceneName=config.scene;previewWidth=config.width;previewHeight=config.height;previewFov=config.fov;
  camera.fov=previewFov;camera.updateProjectionMatrix();
  document.querySelector('h1').textContent=config.title;
  document.title=config.title;stage.setAttribute('aria-label',config.title);
  const local=document.querySelector('a[href*="gaussian-walk"]');
  if(local)local.hidden=sceneName.startsWith('album-');
  if(local&&!local.hidden)local.href='./gaussian-walk.html'+(sceneName==='023-2'?'?scene=023-2':'');
  resetDecoder();displayed=null;screen.visible=false;frameToClose?.close();frameToClose=null;
  configKey='';retryAt=0;errors=0;lastPairAt=0;xrStats=null;recenter();
}
const gallery=new PhotoGallery((photo,job)=>{
  previousScene={scene:sceneName,width:previewWidth,height:previewHeight,fov:previewFov,title:document.querySelector('h1').textContent};
  const scale=Math.min(1,1632/Math.max(job.width,job.height));
  const even=n=>Math.max(64,2*Math.round(n*scale/2));
  switchScene({scene:job.scene,width:even(job.width),height:even(job.height),fov:job.fov,title:photo.name});
},()=>{
  if(previousScene)switchScene(previousScene);
  previousScene=null;
});
fetch('./local-scene.json').then(r=>r.json()).then(config=>{
  albumAvailable=!!config.album;
  if($('photos'))$('photos').hidden=!albumAvailable;
  if(albumAvailable&&renderer.xr.isPresenting&&!gallery.visible)gallery.open(true);
}).catch(()=>{});
if($('photos'))$('photos').onclick=()=>gallery.open(renderer.xr.isPresenting);
function frame(time,xrFrame){
 presentFrame(time);
 const dt=last?Math.min(.06,(time-last)/1000):0;
 if(xrFrame?.session.visibilityState==='visible' && last && time>last)displayGaps.push(time-last);
 last=time;
 let pose;
 if(xrFrame){
  pose=xrFrame.getViewerPose(renderer.xr.getReferenceSpace());if(!pose)return;
  gaze.copy(pose.transform.orientation);const angle=headEuler.setFromQuaternion(gaze,'YXZ').y;
  if(firstYaw===null){firstYaw=angle;rigYaw=-angle;anchor.copy(pose.transform.position);}
  if(!gallery.visible && xrFrame.session.visibilityState==='visible')rigYaw=navigate(travel,xrFrame.session.inputSources,angle,rigYaw,pose.transform.position,anchor,dt);
  rig.rotation.y=rigYaw;
  rig.position.copy(anchor).negate().applyAxisAngle(axisY,rigYaw).add(travel);rig.updateMatrixWorld(true);
  currentHead.copy(pose.transform.position).applyMatrix4(rig.matrixWorld);
  if(hasHeadSample && dt>.001 && dt<.06){
   sampleVelocity.subVectors(currentHead,previousHead).divideScalar(dt).clampLength(0,1.5);
   velocity.lerp(sampleVelocity,1-Math.exp(-dt/.03));
  }else velocity.set(0,0,0);
  previousHead.copy(currentHead);hasHeadSample=true;
  // Aim the full render at its display time. Both eyes share one translation.
  prediction.copy(velocity).multiplyScalar(Math.min(.14,(targetAge()+.5*pairInterval)/1000)).clampLength(0,.11);

 }else{
  rig.position.set(0,0,0);rig.rotation.y=0;
  const down=(a,b)=>Number(keys.has(a)||keys.has(b));
  moveHorizontal(travel,down('KeyD','ArrowRight')-down('KeyA','ArrowLeft'),down('KeyW','ArrowUp')-down('KeyS','ArrowDown'),yaw,.8*dt);
  camera.position.copy(travel);camera.rotation.set(pitch,yaw,0,'YXZ');rig.updateMatrixWorld(true);
 }
 if(enabled && (!gallery.visible||gallery.opening) && inflight<(needKey?1:2) && delivery.size<2 && pending.size<5 && time>=nextCaptureAt && time>=retryAt && (!document.hidden || xrFrame || !displayed) && (!xrFrame || xrFrame.session.visibilityState==='visible')){
  const views=[];let w=previewWidth,h=previewHeight;
  if(pose){
   for(const eye of pose.views){
    if(eye.eye!=='left'&&eye.eye!=='right')continue;
    const target=renderer.xr.getCamera().cameras[eye.eye==='left'?0:1];
    w=2*Math.round((target?.viewport?.z||1440)/2);h=2*Math.round((target?.viewport?.w||1584)/2);
    world.fromArray(eye.transform.matrix).premultiply(rig.matrixWorld);
    const rot=new T.Quaternion().setFromRotationMatrix(world);
    views[eye.eye==='left'?0:1]=makeView(new T.Vector3().setFromMatrixPosition(world).add(prediction),rot,new T.Matrix4().fromArray(eye.projectionMatrix),w,h);
   }
  }else{
   const ref=new T.PerspectiveCamera(previewFov,w/h,.02,2000);
   for(const offset of [-.0315,.0315]){
    const pos=new T.Vector3(offset,0,0).applyQuaternion(camera.quaternion).add(travel);
    views.push(makeView(pos,camera.quaternion,ref.projectionMatrix,w,h));
   }
  }
  if(views[0]&&views[1])send({w,h,views});
 }
 if(xrFrame&&gallery.visible)gallery.render(renderer,xrFrame,pose);
 else renderer.render(scene,camera);
 callbacks++;
 if(time-elapsedAt>=2000){
   const seconds=(time-elapsedAt)/1000;
   lastMetrics=(xrFrame?'VR':'Окно')+' '+Math.round(callbacks/seconds)+' кадров/с · новых стереопар '+(shown/seconds).toFixed(1)+'/с · последний кадр за '+Math.round(lastDelay)+' мс';
   if(xrFrame && xrFrame.session.visibilityState==='visible'){
     lastVR=lastMetrics;
     xrStats=[Math.round(callbacks/seconds),Math.round(shown/seconds),Math.round(lastDelay),p95(displayGaps),p95(pairGaps)];
   }
   $('stats').textContent=xrFrame||!lastVR?lastMetrics:lastMetrics+' · Последний '+lastVR;
   callbacks=shown=0;displayGaps.length=pairGaps.length=0;elapsedAt=time;
 }
}
renderer.xr.addEventListener('sessionstart',()=>{resetDecoder();recenter();document.body.classList.add('vr');if(albumAvailable)gallery.open(true);shown=callbacks=0;elapsedAt=performance.now();});
renderer.xr.addEventListener('sessionend',()=>{if(gallery.visible)gallery.close();resetDecoder();xrStats=null;recenter();document.body.classList.remove('vr');resize();});
$('enter').onclick=async()=>{let session;try{session=await navigator.xr.requestSession('immersive-vr');session.addEventListener('select',event=>{
  if(gallery.visible)gallery.select(event,renderer.xr.getReferenceSpace());else recenter();
 });session.addEventListener('squeeze',()=>{
  if(!albumAvailable)return;
  if(gallery.visible)gallery.close();else gallery.open(true);
 });await renderer.xr.setSession(session);renderer.xr.getReferenceSpace().addEventListener('reset',()=>{recenter();gallery.place=true;});}catch(e){await session?.end().catch(()=>{});$('status').textContent=e.message;}};
try{
 if(typeof VideoDecoder==='undefined')throw Error('Браузер не поддерживает аппаратное декодирование WebCodecs');
 $('status').textContent='Запрашиваю первую стереопару…';
 enabled=true;renderer.setAnimationLoop(frame);frame(performance.now(),null);
 xrAvailable=!!navigator.xr && await navigator.xr.isSessionSupported('immersive-vr');
 $('enter').disabled=!xrAvailable;
}catch(e){$('status').textContent=e.message;}
