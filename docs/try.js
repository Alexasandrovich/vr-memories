import {loadImage, rasterize} from './vendor/sharp-browser/image.js';

const el = id => document.getElementById(id);
const model = 'https://huggingface.co/sm079/sharp-onnx-webgpu/resolve/1edfee8b806dec15daab30ef2c461de454bf5d79/';
let photo, preview, player, running, revision = 0;

function status(message) { el('status').textContent = message; }

function stop() {
  revision++;
  running?.abort();
  running = null;
  el('cancel').hidden = true;
  el('create').disabled = !photo;
}

function showPhoto() {
  player?.dispose();
  player = null;
  for (const id of ['gpu','pad','reset']) el(id).hidden = true;
  el('photo').hidden = !photo;
  el('empty').hidden = !!photo;
}

el('file').onchange = async () => {
  stop();
  const id = revision;
  photo?.bitmap.close();
  photo = null;
  showPhoto();
  el('photo').removeAttribute('src');
  if (preview) URL.revokeObjectURL(preview);
  el('create').disabled = true;
  const file = el('file').files[0];
  if (!file) return status('Choose a photograph to begin.');
  if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 32 * 1024 * 1024)
    return status('Choose a JPEG, PNG or WebP under 32 MB.');
  try {
    const decoded = await loadImage(file);
    if (id !== revision) { decoded.bitmap.close(); return; }
    if (Math.min(decoded.width, decoded.height) < 128) {
      decoded.bitmap.close();
      return status('Choose a photo at least 128 pixels wide and tall.');
    }
    photo = decoded;
    preview = URL.createObjectURL(file);
    el('photo').src = preview;
    showPhoto();
    el('create').disabled = false;
    status('Ready to reconstruct on this device.');
  } catch {
    if (id === revision) status('This image could not be decoded. Try another photograph.');
  }
};

function request(worker, message, signal, transfer = []) {
  return new Promise((resolve, reject) => {
    let timeout;
    const done = (callback, value) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      callback(value);
    };
    const cancel = () => done(reject, new Error('Cancelled'));
    const arm = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => done(reject, new Error('The model stopped responding. Try again with other GPU-intensive tabs closed.')), 5 * 60 * 1000);
    };
    signal.addEventListener('abort', cancel, {once:true});
    worker.onerror = e => done(reject, new Error(e.message || 'The model worker could not start.'));
    worker.onmessageerror = () => done(reject, new Error('The model worker disconnected.'));
    worker.onmessage = ({data}) => {
      if (data.type === 'progress') { status(data.stage); arm(); }
      else if (data.type === 'error') done(reject, new Error(data.message));
      else done(resolve, data);
    };
    arm();
    worker.postMessage(message, transfer);
  });
}

el('create').onclick = async () => {
  if (!photo || running) return;
  const id = ++revision;
  const control = new AbortController();
  running = control;
  let worker;
  el('create').disabled = true;
  el('cancel').hidden = false;
  showPhoto();
  try {
    status('Checking this device’s GPU…');
    const adapter = await navigator.gpu?.requestAdapter();
    if (id !== revision) return;
    if (!adapter || !adapter.features.has('shader-f16'))
      throw new Error('This device needs WebGPU with 16-bit shaders. Try desktop Chrome or Edge, or open the first ride above.');
    worker = new Worker(new URL('./vendor/sharp-browser/worker.js', import.meta.url), {type:'module'});
    await request(worker, {id:1,type:'load',model:model+'sharp.onnx',weightPack:model+'sharp.int8.bin',preferWebGpu:true}, control.signal);
    const pixels = rasterize(photo.bitmap, 1536, 1536);
    const {width,height,focalPx} = photo;
    const result = await request(worker, {id:2,type:'run',pixels,width,height,focalPx}, control.signal,[pixels.buffer]);
    worker.terminate();
    worker = null;
    status('Opening your 3D scene…');
    const {createPlayer} = await import('./walk.js');
    if (id !== revision) return;
    const {medialUnit} = result.stats;
    const fov = pixels => 2 * Math.atan(pixels / (2*focalPx)) * 180 / Math.PI;
    const settings = { fileBytes:new Uint8Array(await result.file.arrayBuffer()),
      horizontalFov:fov(width), verticalFov:fov(height), crop:1.10, start:[0,0], yaw:0, pitch:0,
      speed:Math.max(.03,medialUnit*.8) };
    if (id !== revision) return;
    const view = await createPlayer(el('gpu'),el('pad'),settings,control.signal);
    if (id !== revision) { view.dispose(); return; }
    player = view;
    el('gpu').hidden = el('pad').hidden = el('reset').hidden = false;
    el('photo').hidden = true;
    player.reset();
    player.setActive(true);
    el('stage').focus({preventScroll:true});
    status('Drag or use Q/E to turn. Scroll, pinch or use W/S to move closer or farther.');
  } catch (error) {
    if (id === revision) status(error.message || 'The scene could not be created on this device.');
  } finally {
    worker?.terminate();
    if (id === revision) { running = null; el('cancel').hidden = true; el('create').disabled = false; }
  }
};
el('cancel').onclick = () => { stop(); status('Cancelled. You can try again.'); };
el('reset').onclick = () => { player?.reset(); el('stage').focus({preventScroll:true}); };

el('file').disabled = false;
if (el('file').files.length) el('file').onchange();
