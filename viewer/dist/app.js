import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import {moveHorizontal, navigate} from './walking.js';
import {batchFullSplats} from './full-splat-batches.js';

const $ = id => document.getElementById(id);
const stage = $('stage');
const walking = document.body.dataset.view === 'gaussian-walk';
const horseScene = walking && new URLSearchParams(location.search).get('scene') === '023-2';
if(horseScene){
  document.title='Верхом · Прогулка SHARP';
  document.querySelector('h1').textContent='Верхом · SHARP';
  document.querySelector('header nav')?.setAttribute('hidden','');
  document.querySelector('main > details')?.setAttribute('hidden','');
}
const quality = () => walking ? 'full' : $('quality').value;
const anchor = new THREE.Vector3(), travel = new THREE.Vector3(), keys = new Set();
let motionTime = null, rigYaw = 0;
const upAxis = new THREE.Vector3(0, 1, 0);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const root = new THREE.Group();
scene.add(root);
const camera = new THREE.PerspectiveCamera(55, 1, .01, 2000);
let renderer, spark, mesh, metadata, busy = false, xrSupported = false;
let yaw = 0, pitch = 0, initialYaw = null;
let previousTime = null, elapsed = 0, frames = 0;
const measurements = [];
const questBrowser = /OculusBrowser|Quest/i.test(navigator.userAgent);
const profiles = {
  full: {splats:1500000, scale:1, radius:Math.sqrt(8), lodPixels:1},
  auto: {splats:120000, scale:.7, radius:Math.sqrt(5), lodPixels:2},
  fast: {splats:60000, scale:.6, radius:Math.sqrt(5), lodPixels:2.5},
  high: {splats:350000, scale:.9, radius:Math.sqrt(8), lodPixels:1.5},
  max: {splats:1500000, scale:1, radius:Math.sqrt(8), lodPixels:1},
};
let stableWindows = 0, adaptAfter = 0, lastVrFps = null;
function resetTiming() { previousTime = null; elapsed = 0; frames = 0; stableWindows = 0; adaptAfter = performance.now()+6000; }
function applyProfile() {
  if (!renderer || !spark) return;
  const profile = profiles[quality()] || profiles.auto;
  spark.lodSplatCount = profile.splats;
  spark.lodRenderScale = profile.lodPixels;
  spark.maxStdDev = profile.radius;
  if (walking && mesh) mesh.enableLod = false;
  if (!renderer.xr.isPresenting) renderer.xr.setFramebufferScaleFactor(profile.scale);
  renderer.xr.setFoveation(quality() === 'full' ? 0 : .8);
  resetTiming();
}

function recordPerformance(time, inVr) {
  const visible = inVr ? renderer.xr.getSession()?.visibilityState === 'visible' : document.visibilityState === 'visible';
  if (!visible) { resetTiming(); return; }
  if (previousTime !== null) { elapsed += time - previousTime; frames++; }
  previousTime = time;
  if (elapsed < 2000) return;
  const fps = Math.round(frames * 1000 / elapsed);
  if (walking) {
    measurements.push({kind:inVr?'vr':'window',frames,elapsed_ms:elapsed,fps,
      quality:quality(),active_splats:spark.activeSplats,instances_per_eye:spark.geometry.instanceCount,
      frame_rate:inVr?renderer.xr.getSession()?.frameRate:null,timestamp:new Date().toISOString()});
    if (measurements.length > 600) measurements.shift();
  }
  if (inVr) lastVrFps = fps;
  $('fps').textContent = `${inVr ? 'VR' : 'Окно'}: ${fps} кадров/с`;
  $('performance').textContent = lastVrFps === null ? 'Частота в шлеме ещё не измерена.' : `Последний замер VR: ${lastVrFps} кадров/с.`;
  if (quality() === 'auto' && time >= adaptAfter) {
    const target = inVr ? (renderer.xr.getSession()?.frameRate || 72) : (questBrowser ? 30 : 60);
    if (fps < target*.8) {
      spark.lodSplatCount = Math.max(40000, Math.round(spark.lodSplatCount*.7));
      stableWindows = 0;
    } else if (fps >= target*.96 && ++stableWindows >= 4) {
      spark.lodSplatCount = Math.min(240000, Math.round(spark.lodSplatCount*1.12));
      stableWindows = 0;
    } else if (fps < target*.96) stableWindows = 0;
  }
  elapsed = 0; frames = 0;
}
const rotationInverse = new THREE.Matrix3();
const headQuaternion = new THREE.Quaternion();
const direction = new THREE.Vector3();
const setStatus = text => { $('status').textContent = text; };

function resize() {
  if (!renderer || renderer.xr.isPresenting) return;
  renderer.setSize(stage.clientWidth, stage.clientHeight, false);
  camera.aspect = stage.clientWidth / stage.clientHeight;
  camera.updateProjectionMatrix();
}

const maskMaterial = new THREE.ShaderMaterial({
  uniforms: { inverseProjection: { value: new THREE.Matrix4() }, viewToSource: { value: new THREE.Matrix3() }, halfFov: { value: new THREE.Vector2(1, 1) } },
  vertexShader: `varying vec2 ndc; void main(){ ndc=position.xy; gl_Position=vec4(position.xy,0.,1.); }`,
  fragmentShader: `precision highp float;
    varying vec2 ndc; uniform mat4 inverseProjection; uniform mat3 viewToSource; uniform vec2 halfFov;
    void main(){
      vec4 p=inverseProjection*vec4(ndc,1.,1.);
      vec3 ray=viewToSource*(p.xyz/p.w);
      float forward=-ray.z;
      vec2 uv=abs(ray.xy/max(forward,0.000001))/halfFov;
      float edge=min(1.-uv.x,1.-uv.y);
      float visible=forward>0.?smoothstep(0.,0.05,edge):0.;
      gl_FragColor=vec4(0.,0.,0.,1.-visible);
    }`,
  transparent:true, depthTest:false, depthWrite:false, toneMapped:false,
});
const mask = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), maskMaterial);
mask.frustumCulled = false;
mask.renderOrder = 1000000;
mask.onBeforeRender = (_renderer, _scene, eyeCamera) => {
  maskMaterial.uniforms.inverseProjection.value.copy(eyeCamera.projectionMatrixInverse);
  rotationInverse.setFromMatrix4(root.matrixWorld).transpose();
  maskMaterial.uniforms.viewToSource.value.setFromMatrix4(eyeCamera.matrixWorld).premultiply(rotationInverse);
  maskMaterial.uniformsNeedUpdate = true;
};
mask.visible = false;
scene.add(mask);

function resetView() {
  travel.set(0,0,0);keys.clear();motionTime=null;
  if (renderer.xr.isPresenting) initialYaw = null;
  else { yaw = 0; pitch = 0; camera.quaternion.identity(); }
}

function animate(time, frame) {
  if (!mesh || busy) return;
  const dt = motionTime === null ? 0 : Math.min(.05, (time-motionTime)/1000);
  motionTime = time;
  if (frame) {
    const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
    if (!pose) {motionTime=null;return;}
    const { position, orientation } = pose.transform;
    headQuaternion.copy(orientation);
    direction.set(0, 0, -1).applyQuaternion(headQuaternion);
    const headYaw = Math.atan2(-direction.x, -direction.z);
    if (initialYaw === null) {
      initialYaw = headYaw;
      rigYaw = -headYaw;
      anchor.copy(position);
    }
    if (walking) {
      if (frame.session.visibilityState === 'visible') rigYaw = navigate(travel,frame.session.inputSources,headYaw,rigYaw,position,anchor,dt);
      root.position.copy(travel).applyAxisAngle(upAxis,-rigYaw).negate().add(anchor);
    } else root.position.copy(position);
    root.rotation.set(0, walking ? -rigYaw : initialYaw, 0);
  } else {
    root.position.set(0, 0, 0); root.quaternion.identity();
    if (walking) {
      const down = (a,b) => Number(keys.has(a) || keys.has(b));
      moveHorizontal(travel, down('KeyD','ArrowRight')-down('KeyA','ArrowLeft'),
        down('KeyW','ArrowUp')-down('KeyS','ArrowDown'), yaw, .8*dt);
    }
    camera.position.copy(travel);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }
  renderer.render(scene, camera);
  recordPerformance(time, !!frame);
}

try {
  // Three's XR projection layer constructs a DepthTexture on Quest even
  // when the splat material itself does not test or write depth.
  renderer = new THREE.WebGLRenderer({ antialias:false, depth:true, powerPreference:'high-performance' });
  renderer.setPixelRatio(questBrowser ? 1 : Math.min(window.devicePixelRatio, 1.5));
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  spark = new SparkRenderer({ renderer, sortRadial:true, lodSplatCount:120000,
    enableLod:!walking, enableDriveLod:!walking, depthTest:!walking,
    maxStdDev:Math.sqrt(5), lodRenderScale:2, lodRaycast:0, minSortIntervalMs:33 });
  if (walking) {
    batchFullSplats(spark);
    // Submit the async depth read immediately; the GPU fence still gates the sort.
    spark.readPause = 0;
    spark.sortPollInterval = 1;
  }
  applyProfile();
  scene.add(spark);
  stage.append(renderer.domElement);
  resize();
  new ResizeObserver(resize).observe(stage);
  renderer.setAnimationLoop(animate);
  renderer.xr.addEventListener('sessionstart', () => { initialYaw = null; resetView(); resetTiming(); document.body.classList.add('vr'); });
  renderer.xr.addEventListener('sessionend', () => { document.body.classList.remove('vr'); resetTiming(); resetView(); resize(); });
  xrSupported = !!navigator.xr && await navigator.xr.isSessionSupported('immersive-vr');
  if (!xrSupported) $('details').textContent = 'Здесь доступен просмотр на экране. Для VR откройте эту страницу по HTTPS в браузере Quest 2.';
} catch (error) {
  setStatus(`Не удалось запустить просмотрщик: ${error.message}`);
  $('files').disabled = true;
}

function validateMetadata(data) {
  if (data.schema_version !== 1 || data.method !== 'SHARP') throw new Error('Нужен scene.json из этого процесса реконструкции.');
  for (const key of ['width','height','focal_px']) if (!Number.isFinite(data[key]) || data[key] <= 0) throw new Error(`Некорректное поле ${key}.`);
  if (data.width > 50000 || data.height > 50000) throw new Error('Некорректный размер снимка.');
  data.vertical_fov_deg = THREE.MathUtils.radToDeg(2 * Math.atan(data.height/(2*data.focal_px)));
  if (typeof data.calibration !== 'string') data.calibration = 'unknown';
  return data;
}

async function readMemory(file) {
  const head = new Uint8Array(await file.slice(0,12).arrayBuffer());
  if (head.length !== 12 || new TextDecoder().decode(head.slice(0,8)) !== 'VRMEM01\n') throw new Error('Файл воспоминания повреждён или имеет другой формат.');
  const length = new DataView(head.buffer).getUint32(8,true);
  if (length < 1 || length > 1048576 || file.size < 12+length) throw new Error('Некорректный заголовок воспоминания.');
  const data = validateMetadata(JSON.parse(await file.slice(12,12+length).text()));
  if (file.size-12-length !== data.ply_bytes) throw new Error('Файл скачан не полностью.');
  const bytes = new Uint8Array(await file.slice(12+length).arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  const hex = Array.from(digest, value => value.toString(16).padStart(2,'0')).join('');
  if (hex !== data.ply_sha256) throw new Error('Файл изменён или повреждён. Скачайте его повторно.');
  return {metadata:data,bytes};
}

async function openSceneFiles(files) {
  if (busy || renderer?.xr.isPresenting) return;
  const memory = files.find(file => file.name.toLowerCase().endsWith('.vrmemory'));
  const ply = files.find(file => file.name.toLowerCase().endsWith('.ply'));
  const json = files.find(file => file.name.toLowerCase().endsWith('.json'));
  if (!memory && (!ply || !json)) { setStatus('Выберите файл .vrmemory. Для старого формата нужны вместе scene.ply и scene.json.'); return; }
  busy = true; $('enter').disabled = true; $('files').disabled = true;
  setStatus('Открываю сцену и подготавливаю детализацию. Это может занять несколько минут.');
  let next;
  try {
    const loaded = memory ? await readMemory(memory) : {metadata:validateMetadata(JSON.parse(await json.text())),bytes:new Uint8Array(await ply.arrayBuffer())};
    const nextMetadata = loaded.metadata;
    if (mesh) { root.remove(mesh); mesh.dispose(); mesh = null; }
    next = new SplatMesh({ fileBytes:loaded.bytes, fileName:'scene.ply', lod:true, nonLod:walking,
      enableLod:!walking });
    next.rotation.x = Math.PI; // OpenCV (+y down, +z forward) -> Three.js.
    await next.initialized;
    if (!(next.numSplats || next.packedSplats?.numSplats || next.packedSplats?.lodSplats?.numSplats)) throw new Error('В файле нет точек сцены.');
    metadata = nextMetadata; mesh = next; root.add(mesh);
    spark.staticRadialSort = walking && !mesh.splats.hasRgbDir();
    if (walking) $('capture').disabled = false;
    maskMaterial.uniforms.halfFov.value.set(metadata.width/(2*metadata.focal_px), metadata.height/(2*metadata.focal_px));
    mask.visible = !walking;
    camera.fov = Math.min(90, metadata.vertical_fov_deg || 55); camera.updateProjectionMatrix();
    $('empty').hidden = true; $('view-label').hidden = false; $('fps').hidden = false;
    $('recenter').disabled = false; $('enter').disabled = !xrSupported;
    resetView();
    resetTiming();
    setStatus(`Сцена открыта. ${metadata.width} × ${metadata.height}. ${metadata.calibration.startsWith('assumed') ? 'Угол исходной камеры приблизительный.' : 'Параметры камеры загружены.'}`);
  } catch (error) {
    if (next && next !== mesh) next.dispose();
    setStatus(`Не удалось открыть сцену: ${error.message}`);
    if (!mesh) { $('empty').hidden = false; $('recenter').disabled = true; mask.visible = false; }
  } finally { busy = false; $('files').disabled = false; $('enter').disabled = !mesh || !xrSupported; }
}

$('files').addEventListener('change', async event => {
  await openSceneFiles([...event.target.files]);
  event.target.value = '';
});

// Only the self-hosted server exposes this same-origin endpoint. No external services.
fetch('./local-scene.json').then(async response => {
  if (!response.ok) return;
  const config = await response.json();
  if (config.available !== true || !renderer) return;
  $('load-local').hidden = false;
  setStatus('Готовая сцена находится на вашем Mac. Нажмите кнопку выше, чтобы открыть её.');
  if (walking) $('load-local').click();
}).catch(() => {});

$('load-local').addEventListener('click', async () => {
  if (busy || renderer?.xr.isPresenting) return;
  busy = true; $('load-local').disabled = true; $('files').disabled = true; $('enter').disabled = true;
  setStatus('Загружаю сцену с Mac по вашей Wi-Fi сети…');
  try {
    const response = await fetch(horseScene?'./scene.vrmemory?scene=023-2':'./scene.vrmemory');
    if (!response.ok) throw new Error(`Mac вернул ошибку ${response.status}`);
    const file = new File([await response.blob()], 'scene.vrmemory');
    busy = false;
    await openSceneFiles([file]);
  } catch(error) { setStatus(`Не удалось загрузить сцену: ${error.message}`); }
  finally { busy = false; $('load-local').disabled = false; $('files').disabled = false; $('enter').disabled = !mesh || !xrSupported; }
});

$('enter').addEventListener('click', async () => {
  if (!mesh || busy) return;
  let session;
  try {
    applyProfile();
    session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures:['local-floor'] });
    session.addEventListener('select', resetView);
    await renderer.xr.setSession(session);
    const space = renderer.xr.getReferenceSpace();
    space.addEventListener('reset',resetView);
    session.addEventListener('end',()=>space.removeEventListener('reset',resetView),{once:true});
  } catch(error) {
    if (session) await session.end().catch(()=>{});
    setStatus(`Не удалось войти в VR: ${error.message}`);
    console.error('SHARP XR session setup',error);
  }
});
$('recenter').addEventListener('click', resetView);
$('quality')?.addEventListener('change', applyProfile);
if (walking) {
  $('report').onclick = () => {
    const blob = new Blob([JSON.stringify({renderer:'SHARP / Spark',measurements},null,2)],{type:'application/json'});
    const link = document.createElement('a');
    link.href=URL.createObjectURL(blob);link.download='sharp-walk-metrics.json';link.click();
    setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  };
  $('capture').onclick = () => {
    if(!mesh || busy || renderer.xr.isPresenting)return;
    const {width,height,vertical_fov_deg} = metadata;
    const snapshot = camera.clone();
    snapshot.position.copy(travel);
    snapshot.aspect = width/height;snapshot.fov = vertical_fov_deg;snapshot.updateProjectionMatrix();
    const target = new THREE.WebGLRenderTarget(width,height,{colorSpace:THREE.SRGBColorSpace});
    const pixels = new Uint8Array(width*height*4);
    const lastTarget = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(target);renderer.render(scene,snapshot);
      renderer.readRenderTargetPixels(target,0,0,width,height,pixels);
    } finally {renderer.setRenderTarget(lastTarget);target.dispose();}
    const canvas = document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d'), data=ctx.createImageData(width,height);
    for(let y=0;y<height;y++)data.data.set(pixels.subarray((height-y-1)*width*4,(height-y)*width*4),y*width*4);
    ctx.putImageData(data,0,0);
    let image = $('snapshot');
    if(!image){image=document.createElement('img');image.id='snapshot';image.alt='Контрольный кадр SHARP';image.style.maxWidth='100%';document.querySelector('main').append(image);}
    image.src=canvas.toDataURL();
  };
  const codes = new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowLeft','ArrowDown','ArrowRight']);
  window.addEventListener('keydown', e => {
    if(!mesh || e.metaKey || e.ctrlKey || e.altKey || !codes.has(e.code) || e.target.closest?.('input,select,textarea'))return;
    e.preventDefault();keys.add(e.code);
  });
  window.addEventListener('keyup',e=>keys.delete(e.code));
  window.addEventListener('blur',()=>keys.clear());
  document.addEventListener('visibilitychange',()=>{keys.clear();motionTime=null;});
  document.querySelectorAll('[data-step]').forEach(button=>button.onclick=()=>{
    if(!mesh || busy || renderer.xr.isPresenting)return;
    const [side,forward]=button.dataset.step.split(',').map(Number);
    moveHorizontal(travel,side,forward,yaw,.25);
  });
}
let pointer = null;
stage.addEventListener('pointerdown', e => { if (!mesh) return; pointer = [e.clientX,e.clientY]; stage.setPointerCapture(e.pointerId); });
stage.addEventListener('pointermove', e => {
  if (!pointer || renderer.xr.isPresenting) return;
  yaw += (e.clientX-pointer[0])*.004;
  pitch = Math.max(-Math.PI/2+.01, Math.min(Math.PI/2-.01, pitch+(e.clientY-pointer[1])*.004));
  pointer = [e.clientX,e.clientY];
});
stage.addEventListener('pointerup', () => { pointer = null; });
stage.addEventListener('pointercancel', () => { pointer = null; });
