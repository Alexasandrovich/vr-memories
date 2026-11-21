import * as THREE from 'three';
import {moveHorizontal, moveWithStick} from './walking.js';

const $=id=>document.getElementById(id), stage=$('stage');
const apple = document.body.dataset.scene === 'sharp';
const assetDirectory = apple ? './apple/' : './probe/';
const eyeMaterials = [];
const scene=new THREE.Scene(), root=new THREE.Group(), depthGroup=new THREE.Group();
scene.background=new THREE.Color(0x000000);scene.add(root);root.add(depthGroup);
const walkingGroup = new THREE.Group();
root.add(walkingGroup);
walkingGroup.visible = false;
const anchor = new THREE.Vector3(), travel = new THREE.Vector3(), keys = new Set();
let lastMotion = null, walkSurface;
const isWalking = () => !!walkSurface && $('mode').value === 'walk';
const camera=new THREE.PerspectiveCamera(70,1,.05,2000);
const left=camera.clone(),right=camera.clone();
camera.layers.enable(3); left.layers.enable(1); right.layers.enable(2);
let renderer, manifest, flat, contextMesh, loaded=false, yaw=0,pitch=0,initialYaw=null;
let previous=null, intervals=[], latestVR=null;
const direction=new THREE.Vector3(), quaternion=new THREE.Quaternion();
const timing={window:[],vr:[]};
function resetTiming(){previous=null;intervals=[];}
function center(){yaw=0;pitch=0;initialYaw=null;travel.set(0,0,0);keys.clear();lastMotion=null;}
function resize(){
  if(!renderer || renderer.xr.isPresenting)return;
  renderer.setSize(stage.clientWidth,stage.clientHeight,false);
  camera.aspect=stage.clientWidth/stage.clientHeight;
  camera.fov=Math.min(70,THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(45))/camera.aspect)));
  camera.updateProjectionMatrix();
}
function measure(time,inVR){
  const visible=inVR?renderer.xr.getSession()?.visibilityState==='visible':!document.hidden;
  if(!visible){resetTiming();return;}
  if(previous!==null)intervals.push(time-previous);previous=time;
  if(intervals.length<60)return;
  const elapsed=intervals.reduce((a,b)=>a+b,0);
  if(elapsed<2000)return;
  const sorted=intervals.slice().sort((a,b)=>a-b);
  const hz=inVR?(renderer.xr.getSession().frameRate||72):60;
  const result={kind:inVR?'vr':'window',fps:1000*intervals.length/elapsed,
    p95_ms:sorted[Math.floor(sorted.length*.95)],p99_ms:sorted[Math.floor(sorted.length*.99)],
    late_fraction:intervals.filter(t=>t>1500/hz).length/intervals.length,
    nominal_hz:hz,frames:intervals.length,triangles:renderer.info.render.triangles,
    calls:renderer.info.render.calls,mode:$('mode').value,detail:!!$('detail')?.checked,context:!!contextMesh?.visible,timestamp:new Date().toISOString()};
  timing[result.kind].push(result);if(timing[result.kind].length>120)timing[result.kind].shift();
  if(inVR)latestVR=result;
  $('stats').textContent=`${inVR?'VR':'Окно'}: ${result.fps.toFixed(1)} кадров/с · p95 ${result.p95_ms.toFixed(1)} мс · опоздавших кадров ${(100*result.late_fraction).toFixed(1)}%\n${result.triangles.toLocaleString('ru')} треугольников · ${result.calls} вызовов отрисовки · ${latestVR?`Последний VR: ${latestVR.fps.toFixed(1)} кадров/с`:'VR ещё не измерен'}`;
  try{localStorage.setItem('memory-mesh-probe-metrics',JSON.stringify({version:manifest.version,userAgent:navigator.userAgent,timing}));}catch{}
  intervals=[];
}
function animate(time,frame){
  if(!loaded)return;
  const dt = lastMotion === null ? 0 : Math.min(.05, (time-lastMotion)/1000);
  lastMotion = time;
  if(frame){
    const pose=frame.getViewerPose(renderer.xr.getReferenceSpace());if(!pose){lastMotion=null;return;}
    const {position,orientation}=pose.transform;
    quaternion.copy(orientation);direction.set(0,0,-1).applyQuaternion(quaternion);
    const headYaw=Math.atan2(-direction.x,-direction.z);
    if(initialYaw===null){initialYaw=headYaw;anchor.copy(position);}
    if(isWalking()){
      const session=renderer.xr.getSession();
      if(session.visibilityState==='visible')moveWithStick(travel,session.inputSources,headYaw,dt);
      root.position.copy(anchor).sub(travel);
    }else root.position.copy(position);
    root.rotation.set(0,initialYaw,0);
  }else{
    root.position.set(0,0,0);root.rotation.set(0,0,0);
    if(isWalking()){
      const side = Number(keys.has('KeyD')||keys.has('ArrowRight'))-Number(keys.has('KeyA')||keys.has('ArrowLeft'));
      const forward = Number(keys.has('KeyW')||keys.has('ArrowUp'))-Number(keys.has('KeyS')||keys.has('ArrowDown'));
      moveHorizontal(travel,side,forward,yaw,.8*dt);
      camera.position.copy(travel);
    }else camera.position.set(0,0,0);
    camera.rotation.set(pitch,yaw,0,'YXZ');
  }
  renderer.info.reset();
  if(!frame && $('mode').value==='stereo'){
    const w=stage.clientWidth,h=stage.clientHeight;
    renderer.setScissorTest(true);
    for(const [eye,offset,x] of [[left,-.0315,0],[right,.0315,w/2]]){
      eye.quaternion.copy(camera.quaternion);eye.position.set(offset,0,0);
      eye.aspect=w/2/h;eye.fov=THREE.MathUtils.radToDeg(2*Math.atan(.5/manifest.intrinsics[0][0]/eye.aspect));eye.updateProjectionMatrix();
      renderer.setViewport(x,0,w/2,h);renderer.setScissor(x,0,w/2,h);renderer.render(scene,eye);
    }
    renderer.setScissorTest(false);renderer.setViewport(0,0,w,h);
  }else renderer.render(scene,camera);
  measure(time,!!frame);
}
async function get(url){const r=await fetch(url);if(!r.ok)throw new Error(`${url}: HTTP ${r.status}`);return r;}
async function layer(spec, directory = assetDirectory, existingTexture){
  const [buffer,texture]=await Promise.all([(await get(`${directory}${spec.name}.bin`)).arrayBuffer(),existingTexture || new THREE.TextureLoader().loadAsync(`${directory}${spec.name}.png`)]);
  if(buffer.byteLength!==spec.bytes)throw new Error('Неполная геометрия');
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),x=>x.toString(16).padStart(2,'0')).join('');
  if(digest!==spec.sha256)throw new Error('Повреждён файл геометрии');
  const geo=new THREE.BufferGeometry(),n=spec.vertices;
  geo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(buffer,0,n*3),3));
  geo.setAttribute('uv',new THREE.BufferAttribute(new Float32Array(buffer,n*12,n*2),2));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(buffer,n*20,spec.triangles*3),1));
  texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
  const material=new THREE.MeshBasicMaterial({map:texture,toneMapped:false,side:THREE.DoubleSide});
  // Photograph coordinates are a projection, not ordinary surface UVs.
  // Perspective interpolation of UV alone distorts the photograph when a
  // triangle spans a depth gradient. Project the interpolated 3D point instead.
  material.onBeforeCompile=shader=>{
    const K=spec.intrinsics||manifest.intrinsics;
    shader.uniforms.sourceK={value:new THREE.Vector4(K[0][0],K[1][1],K[0][2],K[1][2])};
    shader.vertexShader='varying vec3 sourcePoint;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nsourcePoint=position;');
    shader.fragmentShader='varying vec3 sourcePoint; uniform vec4 sourceK;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`
      vec2 photoUV=vec2(sourcePoint.x,-sourcePoint.y)/(-sourcePoint.z)*sourceK.xy+sourceK.zw;
      vec4 sampledDiffuseColor=texture2D(map,vec2(photoUV.x,1.-photoUV.y));
      diffuseColor*=sampledDiffuseColor;`);
  };
  const mesh=new THREE.Mesh(geo,material);
  if(spec.name==='repair'||spec.name==='context'){
    // This layer repairs only uncovered pixels. Independent depth predictions
    // and interpolation must never let it replace an observed source surface.
    material.depthWrite=false;mesh.renderOrder=spec.name==='context'?-2:-1;
  }
  if (Object.hasOwn(spec, 'eye_offset')) {
    mesh.position.x = spec.eye_offset;
    mesh.layers.set({left: 1, right: 2, center: 3}[spec.name]);
    eyeMaterials.push({material, native: texture, name: spec.name});
  }
  depthGroup.add(mesh);return mesh;
}
try{
  renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.xr.enabled=true;
  renderer.xr.setReferenceSpaceType('local');renderer.xr.setFramebufferScaleFactor(1);renderer.xr.setFoveation(0);
  renderer.info.autoReset=false;stage.append(renderer.domElement);new ResizeObserver(resize).observe(stage);resize();
  manifest=await (await get(assetDirectory + 'scene.json')).json();
  const meshes=await Promise.all(manifest.layers.map(spec => layer(spec)));
  if (manifest.walk && $('walk-option')) {
    walkSurface = await layer(manifest.walk, assetDirectory, meshes[0].material.map);
    walkingGroup.add(walkSurface);
    if (manifest.walk.repair) {
      const url = new URL(manifest.walk.repair, document.baseURI);
      const pack = await (await get(url)).json();
      const repair = pack.layers.find(item => item.name === 'repair');
      if (repair && pack.source_sha256 === manifest.walk.source_sha256) {
        walkingGroup.add(await layer({...repair, intrinsics:pack.intrinsics}, new URL('.',url).href));
      }
    }
    walkingGroup.visible = true;
    depthGroup.visible = false;
    $('mode').value = 'walk';
  } else if ($('walk-option')) {
    $('walk-option').disabled = true;
    $('mode').value = 'depth';
    $('steps').style.display = 'none';
  }
  const contextPath = apple ? manifest.context : './probe/context.json';
  if (contextPath) {
    const contextURL = new URL(contextPath, document.baseURI);
    const contextSpec = await (await get(contextURL)).json();
    contextMesh = await layer(contextSpec, new URL('.', contextURL).href);
    root.add(contextMesh);
    $('context').disabled = false;
  } else {
    $('context').checked = false;
    $('context').closest('label').hidden = true;
  }
  if (!apple) manifest.version='wide-probe-2';
  const z=2.5,K=manifest.intrinsics;
  flat=new THREE.Mesh(new THREE.PlaneGeometry(z/K[0][0],z/K[1][1]),new THREE.MeshBasicMaterial({map: meshes[0].material.map, toneMapped:false}));flat.position.z=-z;flat.visible=false;root.add(flat);
  if (apple && manifest.detail) {
    for (const eye of eyeMaterials) {
      eye.detail = await new THREE.TextureLoader().loadAsync(assetDirectory + eye.name + '-detail.png');
      eye.detail.colorSpace = THREE.SRGBColorSpace;
      eye.detail.anisotropy = eye.native.anisotropy;
    }
    $('detail').disabled = false;
    $('detail').onchange = () => {
      for (const eye of eyeMaterials) eye.material.map = $('detail').checked ? eye.detail : eye.native;
      flat.material.map = meshes[0].material.map;
      if (walkSurface) walkSurface.material.map = meshes[0].material.map;
      resetTiming();
    };
    $('detail').checked = true;
    $('detail').onchange();
  }
  loaded=true;renderer.setAnimationLoop(animate);
  const supported=!!navigator.xr && await navigator.xr.isSessionSupported('immersive-vr');
  $('enter').disabled=!supported;
  $('status').textContent=supported?'Сцена готова. Можно войти в VR.':'Сцена готова. Для VR откройте эту страницу по HTTPS в браузере Quest.';
  renderer.xr.addEventListener('sessionstart',()=>{center();resetTiming();document.body.classList.add('xr');});
  renderer.xr.addEventListener('sessionend',()=>{document.body.classList.remove('xr');center();resetTiming();resize();});
}catch(e){$('status').textContent=`Не удалось открыть сцену: ${e.message}`;console.error(e);}
$('enter').onclick=async()=>{
  try{
    const session=await navigator.xr.requestSession('immersive-vr');
    session.addEventListener('select',center);await renderer.xr.setSession(session);
    const space=renderer.xr.getReferenceSpace();
    space.addEventListener('reset',center);
    session.addEventListener('end',()=>space.removeEventListener('reset',center),{once:true});
    if(session.supportedFrameRates?.includes(72))await session.updateTargetFrameRate(72).catch(()=>{});
  }catch(e){$('status').textContent=`Не удалось войти в VR: ${e.message}`;}
};
$('center').onclick=center;
$('context').onchange=()=>{if(contextMesh)contextMesh.visible=$('context').checked;resetTiming();};
$('mode').onchange=()=>{if(!loaded)return;center();flat.visible=$('mode').value==='photo';walkingGroup.visible=isWalking();depthGroup.visible=!flat.visible&&!isWalking();if($('steps'))$('steps').style.display=isWalking()?'':'none';resetTiming();};
$('report').onclick=()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify({version:manifest?.version,userAgent:navigator.userAgent,timing},null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='memory-quest-metrics.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
$('capture').onclick=()=>{
  if(!loaded||renderer.xr.isPresenting)return;
  const w=manifest.width,h=manifest.height;
  const target=new THREE.WebGLRenderTarget(w,h,{colorSpace:THREE.SRGBColorSpace});
  const qa=new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2*Math.atan(.5/manifest.intrinsics[1][1])),w/h,.05,2000);
  const oldPos=root.position.clone(),oldQ=root.quaternion.clone();
  root.position.set(0,0,0);root.quaternion.identity();
  const offsets=$('mode').value==='stereo'?[-.0315,.0315]:[0];
  const canvas=document.createElement('canvas');canvas.width=w*offsets.length;canvas.height=h;
  const ctx=canvas.getContext('2d'),data=ctx.createImageData(w,h);
  offsets.forEach((offset,i)=>{
    qa.layers.set(0); qa.layers.enable(offset < 0 ? 1 : offset > 0 ? 2 : 3);
    qa.position.set(offset,0,0);
    if(isWalking()){qa.position.add(travel);qa.rotation.set(pitch,yaw,0,'YXZ');}
    renderer.setRenderTarget(target);renderer.render(scene,qa);
    const pixels=new Uint8Array(w*h*4);renderer.readRenderTargetPixels(target,0,0,w,h,pixels);
    for(let y=0;y<h;y++)data.data.set(pixels.subarray((h-1-y)*w*4,(h-y)*w*4),y*w*4);
    ctx.putImageData(data,i*w,0);
  });
  renderer.setRenderTarget(null);target.dispose();root.position.copy(oldPos);root.quaternion.copy(oldQ);resize();
  let preview=document.getElementById('qa-preview');
  if(!preview){preview=document.createElement('img');preview.id='qa-preview';preview.alt='Контрольный кадр исходной камеры';preview.style.maxWidth='100%';document.querySelector('main').append(preview);}
  preview.src=canvas.toDataURL('image/png');
};
let pointer=null;stage.onpointerdown=e=>{pointer=[e.clientX,e.clientY];stage.setPointerCapture(e.pointerId);};
if ($('walk-option')) {
  const codes = new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowLeft','ArrowDown','ArrowRight']);
  window.addEventListener('keydown', e=>{
    if(!isWalking() || e.altKey || e.ctrlKey || e.metaKey || !codes.has(e.code) || e.target.closest?.('select,input,textarea'))return;
    e.preventDefault();keys.add(e.code);
  });
  window.addEventListener('keyup',e=>keys.delete(e.code));
  window.addEventListener('blur',()=>keys.clear());
  document.addEventListener('visibilitychange',()=>{keys.clear();lastMotion=null;});
  document.querySelectorAll('[data-step]').forEach(button=>button.onclick=()=>{
    if(!isWalking()||renderer.xr.isPresenting)return;
    const [side,forward]=button.dataset.step.split(',').map(Number);
    moveHorizontal(travel,side,forward,yaw,.25);
  });
}
stage.onpointermove=e=>{if(!pointer||renderer?.xr.isPresenting)return;yaw+=(e.clientX-pointer[0])*.003;pitch=Math.max(-1.45,Math.min(1.45,pitch+(e.clientY-pointer[1])*.003));pointer=[e.clientX,e.clientY];};
stage.onpointerup=stage.onpointercancel=()=>{pointer=null;};
