import {Euler, Group, Quaternion, Vector3} from 'three';

// The rig maps the headset's local tracking origin to the current photo viewpoint.
// Head rotation and translation stay in the XR runtime's coordinate system.
export function immersiveWalk(renderer, camera, scene, button, onExit) {
  const rig = new Group();
  scene.add(rig);
  rig.add(camera);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  const local = new Vector3(), world = new Vector3(), motion = new Vector3();
  const head = new Quaternion(), angles = new Euler(0,0,0,'YXZ');
  let active = false, supported = false, entering = false, centered = false;
  let yaw = 0, pitch = 0, turnHeld = false, reset = false, disposed = false;
  let startYaw = 0;
  const start = new Vector3();
  const updateButton = () => {
    if (disposed) return;
    button.hidden = !(active && supported);
    button.disabled = entering;
    button.textContent = renderer.xr.isPresenting ? 'Exit VR' : 'Enter VR';
  };
  const support = () => navigator.xr?.isSessionSupported('immersive-vr').then(ok => {
    supported = ok; updateButton();
  }).catch(() => {});
  support();
  navigator.xr?.addEventListener('devicechange', support);
  const recenter = () => { reset = true; };
  const ended = () => {
    rig.position.set(0,0,0);
    rig.rotation.set(0,0,0);
    camera.position.copy(centered ? world : start);
    onExit(centered ? yaw : startYaw, centered ? pitch : 0);
    centered = false;
    updateButton();
  };
  renderer.xr.addEventListener('sessionend', ended);
  async function toggle() {
    const current = renderer.xr.getSession();
    if (current) { await current.end(); return; }
    if (entering || !active) return;
    entering = true;
    start.copy(camera.position);
    startYaw = camera.rotation.y;
    centered = turnHeld = reset = false;
    updateButton();
    let session;
    try {
      session = await navigator.xr.requestSession('immersive-vr');
      if (disposed || !active) { await session.end(); return; }
      session.addEventListener('select', recenter);
      await renderer.xr.setSession(session);
    } catch (error) {
      if (session) await session.end().catch(() => {});
      document.getElementById('status').textContent = 'Could not enter VR: ' + error.message;
    } finally { entering = false; updateButton(); }
  }
  button.addEventListener('click',toggle);
  return {
    frame(frame, dt) {
      const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
      if (!pose) return;
      local.copy(pose.transform.position);
      head.copy(pose.transform.orientation);
      angles.setFromQuaternion(head);
      if (!centered || reset) {
        rig.rotation.y = (reset ? 0 : startYaw) - angles.y;
        world.copy(reset ? motion.set(0,0,0) : start);
        centered = true;
        reset = false;
      } else {
        world.copy(local).applyQuaternion(rig.quaternion).add(rig.position);
      }
      let x = 0, z = 0, turn = 0;
      for (const input of frame.session.inputSources) {
        const axes = input.gamepad?.axes;
        if (!axes || axes.length < 2) continue;
        const offset = axes.length >= 4 ? 2 : 0;
        if (input.handedness === 'left') { x = axes[offset]; z = axes[offset+1]; }
        if (input.handedness === 'right') turn = axes[offset];
      }
      if (Math.abs(turn) > .7 && !turnHeld) {
        rig.rotation.y -= Math.sign(turn) * Math.PI/6;
        turnHeld = true;
      } else if (Math.abs(turn) < .35) turnHeld = false;
      yaw = rig.rotation.y + angles.y;
      pitch = angles.x;
      if (Math.hypot(x,z) > .15) {
        motion.set(x,0,z).clampLength(0,1).multiplyScalar(1.4 * dt);
        world.x += motion.x*Math.cos(yaw) + motion.z*Math.sin(yaw);
        world.z += motion.z*Math.cos(yaw) - motion.x*Math.sin(yaw);
      }
      rig.position.copy(local).applyQuaternion(rig.quaternion).negate().add(world);
      rig.updateMatrixWorld(true);
      return world;
    },
    get yaw() { return yaw; },
    get pitch() { return pitch; },
    setActive(value) {
      active = value; updateButton();
      if (!active) renderer.xr.getSession()?.end().catch(() => {});
    },
    dispose() {
      disposed = true;
      button.hidden = true;
      button.removeEventListener('click',toggle);
      navigator.xr?.removeEventListener('devicechange',support);
      renderer.xr.removeEventListener('sessionend',ended);
      renderer.xr.getSession()?.end().catch(() => {});
    }
  };
}
