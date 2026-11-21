import * as T from 'three';
import {SparkRenderer, SplatMesh} from './vendor/spark.module.js';

const actions = {
  KeyW:'forward', ArrowUp:'forward', KeyS:'back', ArrowDown:'back',
  KeyA:'left', ArrowLeft:'left', KeyD:'right', ArrowRight:'right',
  KeyQ:'turnLeft', KeyE:'turnRight'
};

export async function createPlayer(host, pad, settings, signal) {
  const renderer = new T.WebGLRenderer({antialias:false, powerPreference:'high-performance'});
  const scene = new T.Scene();
  scene.background = new T.Color(0x19251b);
  const camera = new T.PerspectiveCamera(29, 1, .02, 1200);
  const spark = new SparkRenderer({renderer, enableLod:false, enableDriveLod:false,
    depthTest:false, sortRadial:true, minSortIntervalMs:24});
  scene.add(spark);
  const input = settings.fileBytes ? {fileBytes:settings.fileBytes, fileName:'memory.ply'} : {url:'./' + settings.folder + '/scene.spz'};
  const mesh = new SplatMesh({...input, enableLod:false, lod:false});
  mesh.rotation.x = Math.PI;
  try { await mesh.initialized; } catch (error) { mesh.dispose(); spark.dispose(); renderer.dispose(); throw error; }
  scene.add(mesh);
  if (signal?.aborted) { mesh.dispose(); spark.dispose(); renderer.dispose(); throw new Error('Cancelled'); }
  host.replaceChildren(renderer.domElement);
  let active = false, previous = 0, drag = null;
  let yaw = 0, pitch = 0, viewpoint;
  const target = new T.Vector3();
  const keys = new Set();
  const step = new T.Vector2();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));

  function resize() {
    if (!host.clientWidth || !host.clientHeight) return;
    camera.aspect = host.clientWidth / host.clientHeight;
    const half = Math.min(Math.tan(T.MathUtils.degToRad(settings.verticalFov / 2)), Math.tan(T.MathUtils.degToRad(settings.horizontalFov / 2)) / camera.aspect);
    camera.fov = T.MathUtils.radToDeg(2 * Math.atan(half / (viewpoint?.crop ?? settings.crop)));
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight, false);
  }
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  const listeners = new AbortController();

  function gaze() {
    if (!viewpoint) return [settings.yaw, settings.pitch];
    const dx = target.x - camera.position.x;
    const dy = target.y - camera.position.y;
    const forward = camera.position.z - target.z;
    return [-Math.atan2(dx,forward), Math.atan2(dy,Math.hypot(dx,forward))];
  }
  function turn(horizontal, vertical = 0) {
    const [centerYaw,centerPitch] = gaze();
    const yawLimit = settings.turnRange ?? .06;
    const pitchLimit = settings.tiltRange ?? .04;
    yaw = T.MathUtils.clamp(yaw + horizontal, centerYaw - yawLimit, centerYaw + yawLimit);
    pitch = T.MathUtils.clamp(pitch + vertical, centerPitch - pitchLimit, centerPitch + pitchLimit);
  }
  function move(x, forward) {
    const prior = viewpoint && gaze();
    camera.position.x = T.MathUtils.clamp(camera.position.x + x*Math.cos(yaw) - forward*Math.sin(yaw), ...settings.side);
    camera.position.z = T.MathUtils.clamp(camera.position.z - forward*Math.cos(yaw) - x*Math.sin(yaw), ...settings.depth);
    if (prior) {
      const next = gaze();
      yaw += next[0] - prior[0];
      pitch += next[1] - prior[1];
    }
  }
  function render(time) {
    const dt = previous ? Math.min((time - previous) / 1000, .06) : 0;
    previous = time;
    const held = new Set([...keys].map(k => actions[k]));
    step.set(Number(held.has('right')) - Number(held.has('left')), Number(held.has('forward')) - Number(held.has('back')));
    if (step.lengthSq()) { step.normalize().multiplyScalar(dt*settings.speed); move(step.x,step.y); }
    const rotation = Number(held.has('turnLeft')) - Number(held.has('turnRight'));
    if (rotation) turn(rotation * .55 * dt);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    renderer.render(scene,camera);
  }
  window.addEventListener('keydown', event => {
    if (!active || !actions[event.code] || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault(); keys.add(event.code);
  }, {signal:listeners.signal});
  window.addEventListener('keyup', event => keys.delete(event.code), {signal:listeners.signal});
  window.addEventListener('blur', () => keys.clear(), {signal:listeners.signal});
  for (const button of pad.querySelectorAll('button')) {
    button.onpointerdown = event => {
      button.setPointerCapture(event.pointerId);
      keys.add(button.dataset.key);
    };
    button.onlostpointercapture = () => keys.delete(button.dataset.key);
    button.onclick = event => {
      if (event.detail !== 0) return;
      const key = button.dataset.key;
      if (key === 'KeyQ' || key === 'KeyE') { turn(key === 'KeyQ' ? .06 : -.06); return; }
      const stride = settings.speed * .16;
      move(key==='KeyA' ? -stride : key==='KeyD' ? stride : 0, key==='KeyW' ? stride : key==='KeyS' ? -stride : 0);
    };
  }
  host.onpointerdown = event => {
    if (!event.isPrimary) return;
    host.setPointerCapture(event.pointerId);
    drag = [event.clientX,event.clientY];
  };
  host.onpointermove = event => {
    if (!drag || !event.isPrimary) return;
    turn((event.clientX-drag[0])*.0012,(event.clientY-drag[1])*.0012);
    drag = [event.clientX,event.clientY];
  };
  host.onlostpointercapture = () => { drag=null; };
  return {
    dispose() {
      active=false; renderer.setAnimationLoop(null); listeners.abort(); observer.disconnect();
      for (const button of pad.querySelectorAll('button')) button.onclick=button.onpointerdown=button.onlostpointercapture=null;
      host.onpointerdown=host.onpointermove=host.onlostpointercapture=null;
      mesh.dispose(); spark.dispose(); renderer.dispose(); renderer.domElement.remove();
    },
    reset(view) {
      viewpoint = view;
      if (view) {
        const [x,y,z] = view.position;
        const [tx,ty,tz] = view.target;
        camera.position.set(x,-y,-z);
        target.set(tx,-ty,-tz);
      } else {
        camera.position.set(settings.start[0],0,settings.start[1]);
      }
      [yaw,pitch] = gaze();
      keys.clear();
      drag = null;
      if (active) resize();
    },
    setActive(value) {
      active=value; previous=0; keys.clear(); drag=null;
      if (active) resize();
      renderer.setAnimationLoop(active ? render : null);
    }
  };
}
