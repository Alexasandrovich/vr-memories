import * as T from 'three';
import {SparkRenderer, SplatMesh} from './vendor/spark.module.js';

const actions = {
  KeyW:'forward', ArrowUp:'forward', KeyS:'back', ArrowDown:'back',
  KeyA:'left', ArrowLeft:'left', KeyD:'right', ArrowRight:'right'
};

export async function createPlayer(host, pad) {
  const renderer = new T.WebGLRenderer({antialias:false, powerPreference:'high-performance'});
  const scene = new T.Scene();
  scene.background = new T.Color(0x19251b);
  const camera = new T.PerspectiveCamera(29, 1, .02, 240);
  const spark = new SparkRenderer({renderer, enableLod:false, enableDriveLod:false,
    depthTest:false, sortRadial:true, minSortIntervalMs:24});
  scene.add(spark);
  const mesh = new SplatMesh({url:'./walk/scene.spz', enableLod:false, lod:false});
  mesh.rotation.x = Math.PI;
  try { await mesh.initialized; } catch (error) { mesh.dispose(); spark.dispose(); renderer.dispose(); throw error; }
  scene.add(mesh);
  host.replaceChildren(renderer.domElement);
  let active = false, previous = 0, drag = null;
  let yaw = 0, pitch = 0;
  const keys = new Set();
  const step = new T.Vector2();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));

  function resize() {
    if (!host.clientWidth || !host.clientHeight) return;
    camera.aspect = host.clientWidth / host.clientHeight;
    const half = Math.min(Math.tan(T.MathUtils.degToRad(13.684)), Math.tan(T.MathUtils.degToRad(25)) / camera.aspect);
    camera.fov = T.MathUtils.radToDeg(2 * Math.atan(half / 1.35));
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight, false);
  }
  new ResizeObserver(resize).observe(host);

  function move(x, forward) {
    camera.position.x = T.MathUtils.clamp(camera.position.x + x*Math.cos(yaw) - forward*Math.sin(yaw), -.05, .085);
    camera.position.z = T.MathUtils.clamp(camera.position.z - forward*Math.cos(yaw) - x*Math.sin(yaw), -.08, .36);
  }
  function render(time) {
    const dt = previous ? Math.min((time - previous) / 1000, .06) : 0;
    previous = time;
    const held = new Set([...keys].map(k => actions[k]));
    step.set(Number(held.has('right')) - Number(held.has('left')), Number(held.has('forward')) - Number(held.has('back')));
    if (step.lengthSq()) { step.normalize().multiplyScalar(dt*.42); move(step.x,step.y); }
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    renderer.render(scene,camera);
  }
  window.addEventListener('keydown', event => {
    if (!active || !actions[event.code] || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault(); keys.add(event.code);
  });
  window.addEventListener('keyup', event => keys.delete(event.code));
  window.addEventListener('blur', () => keys.clear());
  for (const button of pad.querySelectorAll('button')) {
    button.onpointerdown = event => {
      button.setPointerCapture(event.pointerId);
      keys.add(button.dataset.key);
    };
    button.onlostpointercapture = () => keys.delete(button.dataset.key);
    button.onclick = event => {
      if (event.detail !== 0) return;
      const key = button.dataset.key;
      move(key==='KeyA' ? -.045 : key==='KeyD' ? .045 : 0, key==='KeyW' ? .08 : key==='KeyS' ? -.08 : 0);
    };
  }
  host.onpointerdown = event => {
    if (!event.isPrimary) return;
    host.setPointerCapture(event.pointerId);
    drag = [event.clientX,event.clientY];
  };
  host.onpointermove = event => {
    if (!drag || !event.isPrimary) return;
    yaw = T.MathUtils.clamp(yaw + (event.clientX-drag[0])*.0012,-.075,.075);
    pitch = T.MathUtils.clamp(pitch + (event.clientY-drag[1])*.0012,-.042,.042);
    drag = [event.clientX,event.clientY];
  };
  host.onlostpointercapture = () => { drag=null; };
  return {
    reset() { yaw=-.025; pitch=0; camera.position.set(-.012,0,.36); keys.clear(); },
    setActive(value) {
      active=value; previous=0; keys.clear(); drag=null;
      if (active) resize();
      renderer.setAnimationLoop(active ? render : null);
    }
  };
}
