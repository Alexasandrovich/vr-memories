import {immersiveWalk} from './immersive.js';
import * as T from 'three';
import {loadVolume, disposeStage, alignToPhoto} from './volume-loader.js';

const actions = {
  KeyW:'forward', ArrowUp:'forward', KeyS:'back', ArrowDown:'back',
  KeyA:'left', ArrowLeft:'left', KeyD:'right', ArrowRight:'right',
  KeyQ:'turnLeft', KeyE:'turnRight'
};

export async function createPlayer(host, pad, settings, signal, onCamera) {
  const useVolume = !!settings.walkVolume && !!await navigator.xr?.isSessionSupported('immersive-vr').catch(() => false);
  const renderer = new T.WebGLRenderer({antialias:useVolume, powerPreference:'high-performance'});
  if(useVolume && /\bQuest 2\b/.test(navigator.userAgent)){
    renderer.xr.setFramebufferScaleFactor(1.12);
    renderer.xr.setFoveation(0);
  }
  const scene = new T.Scene();
  scene.background = new T.Color(0x19251b);
  const camera = new T.PerspectiveCamera(29, 1, .02, 1200);
  let disposeContent;
  try {
    if (useVolume) {
      const {group, pose} = await loadVolume(settings.walkVolume, renderer, signal);
      disposeContent = () => disposeStage(group);
      // Keep the tour, headset and sticks in the original photograph's camera coordinates.
      alignToPhoto({group, pose});
      scene.add(group);
    } else {
      const {SparkRenderer, SplatMesh} = await import('./vendor/spark.module.js');
      const spark = new SparkRenderer({renderer, enableLod:false, enableDriveLod:false,
        depthTest:false, sortRadial:true, minSortIntervalMs:24});
      scene.add(spark);
      const input = settings.fileBytes ? {fileBytes:settings.fileBytes, fileName:'memory.ply'} : {url:'./' + settings.folder + '/scene.spz'};
      const mesh = new SplatMesh({...input, enableLod:false, lod:false});
      disposeContent = () => { mesh.dispose(); spark.dispose(); };
      mesh.rotation.x = Math.PI;
      await mesh.initialized;
      scene.add(mesh);
    }
    signal?.throwIfAborted();
  } catch (error) {
    disposeContent?.(); renderer.dispose(); throw error;
  }
  host.replaceChildren(renderer.domElement);
  let active = false, previous = 0;
  const pointers = new Map();
  let yaw = 0, pitch = 0, viewpoint;
  const target = new T.Vector3();
  const keys = new Set();
  const step = new T.Vector2();
  const travel = new T.Vector3();
  const orientation = new T.Euler(0,0,0,'YXZ');
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));

  function resize() {
    if (renderer.xr.isPresenting || !host.clientWidth || !host.clientHeight) return;
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
    yaw += horizontal;
    pitch += vertical;
  }
  function travelSpeed() {
    return settings.speed + .45 * camera.position.length();
  }
  function move(x, forward) {
    orientation.set(pitch,yaw,0,'YXZ');
    travel.set(x,0,-forward).applyEuler(orientation);
    camera.position.add(travel);
  }
  const immersive = immersiveWalk(renderer, camera, scene, document.getElementById('enter-vr'), (y,p) => {
    yaw = y; pitch = p;
    camera.rotation.set(pitch,yaw,0,'YXZ');
    resize();
  });
  function render(time, xrFrame) {
    const dt = previous ? Math.min((time - previous) / 1000, .06) : 0;
    previous = time;
    if (xrFrame && renderer.xr.isPresenting) {
      const head = immersive.frame(xrFrame,dt);
      if (head) {
        renderer.render(scene,camera);
      }
      return;
    }
    const held = new Set([...keys].map(k => actions[k]));
    step.set(Number(held.has('right')) - Number(held.has('left')), Number(held.has('forward')) - Number(held.has('back')));
    if (step.lengthSq()) { step.normalize().multiplyScalar(dt*travelSpeed()); move(step.x,step.y); }
    const rotation = Number(held.has('turnLeft')) - Number(held.has('turnRight'));
    if (rotation) turn(rotation * 1.1 * dt);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    const reach = camera.position.length() + 1200;
    if (reach > camera.far) {
      camera.far = 2 * reach;
      camera.updateProjectionMatrix();
    }
    renderer.render(scene,camera);
    onCamera?.(camera.position.x,-camera.position.y,-camera.position.z,yaw,pitch);

  }
  window.addEventListener('keydown', event => {
    if (event.target.closest?.('input,select,textarea')) return;
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
      const stride = travelSpeed() * .24;
      move(key==='KeyA' ? -stride : key==='KeyD' ? stride : 0, key==='KeyW' ? stride : key==='KeyS' ? -stride : 0);
    };
  }
  function pinchSpan() {
    const [a,b] = pointers.values();
    return Math.hypot(a[0]-b[0], a[1]-b[1]);
  }
  host.onpointerdown = event => {
    if (pointers.size >= 2 || event.button !== 0) return;
    host.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId,[event.clientX,event.clientY]);
  };
  host.onpointermove = event => {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    const oldSpan = pointers.size === 2 ? pinchSpan() : 0;
    pointers.set(event.pointerId,[event.clientX,event.clientY]);
    if (pointers.size === 1) {
      turn((event.clientX-last[0])*.0035,(event.clientY-last[1])*.0035);
    } else if (oldSpan > 1 && pinchSpan() > 1) {
      move(0, 3 * travelSpeed() * Math.log(pinchSpan()/oldSpan));
    }
  };
  host.onlostpointercapture = event => pointers.delete(event.pointerId);
  host.addEventListener('wheel', event => {
    if (!active) return;
    event.preventDefault();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1;
    move(0,-event.deltaY * units * .006 * travelSpeed());
  }, {passive:false, signal:listeners.signal});
  return {
    dispose() {
      immersive.dispose();
      active=false; renderer.setAnimationLoop(null); listeners.abort(); observer.disconnect();
      for (const button of pad.querySelectorAll('button')) button.onclick=button.onpointerdown=button.onlostpointercapture=null;
      host.onpointerdown=host.onpointermove=host.onlostpointercapture=null;
      disposeContent(); renderer.dispose(); renderer.domElement.remove();
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
      pointers.clear();
      if (active) resize();
    },
    setActive(value) {
      immersive.setActive(value);
      active=value; previous=0; keys.clear(); pointers.clear();
      if (active) resize();
      renderer.setAnimationLoop(active ? render : null);
    }
  };
}
