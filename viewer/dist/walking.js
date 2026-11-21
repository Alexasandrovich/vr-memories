// Coordinates are WebXR local-space metres, with forward along negative Z.
export function moveHorizontal(offset, side, forward, yaw, metres) {
  const scale = metres / Math.max(1, Math.hypot(side, forward));
  offset.x += (side * Math.cos(yaw) - forward * Math.sin(yaw)) * scale;
  offset.z -= (side * Math.sin(yaw) + forward * Math.cos(yaw)) * scale;
}

// Quest Touch exposes its thumbstick on axes 2/3. Some runtimes expose
// only that pair. Ignore hand tracking and unassigned controllers.
function thumbstick(sources, hand) {
  for (const source of sources) {
    const axes = source.gamepad?.axes;
    if (source.handedness !== hand || !axes || axes.length < 2) continue;
    const i = axes.length >= 4 ? 2 : 0;
    const x = axes[i], y = axes[i + 1], length = Math.hypot(x, y);
    if (!Number.isFinite(length) || length <= .12) continue;
    const amount = Math.min(1, (length - .12) / .88) ** 1.6;
    return [x * amount / length, -y * amount / length];
  }
  return [0, 0];
}

export function moveWithStick(offset, sources, yaw, seconds) {
  const [side, forward] = thumbstick(sources, 'left');
  moveHorizontal(offset, side, forward, yaw, seconds * .8);
}

// The offset is in scene metres. Turn about the current head, including
// any room-scale displacement since entering VR.
export function navigate(offset, sources, heading, rigYaw, head, anchor, dt) {
  const [right, up] = thumbstick(sources, 'right');
  const turn = -right * (Math.PI / 3) * dt;
  const x = head.x - anchor.x, z = head.z - anchor.z;
  const c = Math.cos(rigYaw) - Math.cos(rigYaw + turn);
  const s = Math.sin(rigYaw) - Math.sin(rigYaw + turn);
  offset.x += c * x + s * z;
  offset.z += c * z - s * x;
  offset.y += up * .45 * dt;
  moveWithStick(offset, sources, heading + rigYaw + turn, dt);
  return rigYaw + turn;
}
