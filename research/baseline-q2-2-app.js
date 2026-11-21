import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

const $ = id => document.getElementById(id);
const stage = $('stage');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const root = new THREE.Group();
scene.add(root);
const camera = new THREE.PerspectiveCamera(55, 1, .01, 2000);
let renderer, spark, mesh, metadata, busy = false, xrSupported = false;
let yaw = 0, pitch = 0, initialYaw = null;
let previousTime = null, elapsed = 0, frames = 0;
const questBrowser = /OculusBrowser|Quest/i.test(navigator.userAgent);
const profiles = {
  auto: {splats:120000, scale:.7, radius:Math.sqrt(5), lodPixels:2},
  fast: {splats:60000, scale:.6, radius:Math.sqrt(5), lodPixels:2.5},
  high: {splats:350000, scale:.9, radius:Math.sqrt(8), lodPixels:1.5},
  max: {splats:1500000, scale:1, radius:Math.sqrt(8), lodPixels:1},
};
let stableWindows = 0, adaptAfter = 0, lastVrFps = null;
function resetTiming() { previousTime = null; elapsed = 0; frames = 0; stableWindows = 0; adaptAfter = performance.now()+6000; }
function applyProfile() {
  if (!renderer || !spark) return;
  const profile = profiles[$('quality').value] || profiles.auto;
  spark.lodSplatCount = profile.splats;
  spark.lodRenderScale = profile.lodPixels;
  spark.maxStdDev = profile.radius;
  if (!renderer.xr.isPresenting) renderer.xr.setFramebufferScaleFactor(profile.scale);
  renderer.xr.setFoveation(.8);
  resetTiming();
}

function recordPerformance(time, inVr) {
  const visible = inVr ? renderer.xr.getSession()?.visibilityState === 'visible' : document.visibilityState === 'visible';
  if (!visible) { resetTiming(); return; }
  if (previousTime !== null) { elapsed += time - previousTime; frames++; }
  previousTime = time;
  if (elapsed < 2000) return;
  const fps = Math.round(frames * 1000 / elapsed);
  if (inVr) lastVrFps = fps;
  $('fps').textContent = `${inVr ? 'VR' : 'Окно'}: ${fps} кадров/с`;
  $('performance').textContent = `Q2-2 · ${lastVrFps === null ? 'VR ещё не измерен' : `Последний замер VR: ${lastVrFps} кадров/с`}.`;
  if ($('quality').value === 'auto' && time >= adaptAfter) {
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
  if (renderer.xr.isPresenting) initialYaw = null;
  else { yaw = 0; pitch = 0; camera.quaternion.identity(); }
}

function animate(time, frame) {
  if (!mesh || busy) return;
  if (frame) {
    const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
    if (!pose) return;
    const { position, orientation } = pose.transform;
    // Translate the entire scene with the head center: eye separation and eye
    // rotation remain physical, while room-scale locomotion cannot expose holes.
    root.position.set(position.x, position.y, position.z);
    if (initialYaw === null) {
      headQuaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
      direction.set(0, 0, -1).applyQuaternion(headQuaternion);
      initialYaw = Math.atan2(-direction.x, -direction.z);
    }
    root.rotation.set(0, initialYaw, 0);
  } else {
    root.position.set(0, 0, 0); root.quaternion.identity();
    camera.position.set(0, 0, 0);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }
  renderer.render(scene, camera);
  recordPerformance(time, !!frame);
}

try {
  renderer = new THREE.WebGLRenderer({ antialias:false, powerPreference:'high-performance' });
  renderer.setPixelRatio(questBrowser ? 1 : Math.min(window.devicePixelRatio, 1.5));
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  spark = new SparkRenderer({ renderer, sortRadial:true, lodSplatCount:120000,
    maxStdDev:Math.sqrt(5), lodRenderScale:2, lodRaycast:0, minSortIntervalMs:33 });
  applyProfile();
  scene.add(spark);
  stage.append(renderer.domElement);
  resize();
  new ResizeObserver(resize).observe(stage);
  renderer.setAnimationLoop(animate);
  renderer.xr.addEventListener('sessionstart', () => { initialYaw = null; resetTiming(); document.body.classList.add('vr'); });
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
    next = new SplatMesh({ fileBytes:loaded.bytes, fileName:'scene.ply', lod:true, nonLod:false });
    next.rotation.x = Math.PI; // OpenCV (+y down, +z forward) -> Three.js.
    await next.initialized;
    if (!(next.numSplats || next.packedSplats?.numSplats || next.packedSplats?.lodSplats?.numSplats)) throw new Error('В файле нет точек сцены.');
    metadata = nextMetadata; mesh = next; root.add(mesh);
    maskMaterial.uniforms.halfFov.value.set(metadata.width/(2*metadata.focal_px), metadata.height/(2*metadata.focal_px));
    mask.visible = true;
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
}).catch(() => {});

$('load-local').addEventListener('click', async () => {
  if (busy || renderer?.xr.isPresenting) return;
  busy = true; $('load-local').disabled = true; $('files').disabled = true; $('enter').disabled = true;
  setStatus('Загружаю сцену с Mac по вашей Wi-Fi сети…');
  try {
    const response = await fetch('./scene.vrmemory');
    if (!response.ok) throw new Error(`Mac вернул ошибку ${response.status}`);
    const file = new File([await response.blob()], 'scene.vrmemory');
    busy = false;
    await openSceneFiles([file]);
  } catch(error) { setStatus(`Не удалось загрузить сцену: ${error.message}`); }
  finally { busy = false; $('load-local').disabled = false; $('files').disabled = false; $('enter').disabled = !mesh || !xrSupported; }
});

$('enter').addEventListener('click', async () => {
  if (!mesh || busy) return;
  try {
    applyProfile();
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures:['local-floor'] });
    session.addEventListener('select', resetView);
    await renderer.xr.setSession(session);
  } catch(error) { setStatus(`Не удалось войти в VR: ${error.message}`); }
});
$('recenter').addEventListener('click', resetView);
$('quality').addEventListener('change', applyProfile);
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
