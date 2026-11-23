import {cameraFromPly} from './sharp-ply.js';
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
      throw new Error('Local reconstruction needs WebGPU with 16-bit shaders. Use the Hugging Face link above to create a scene on a cloud GPU.');
    worker = new Worker(new URL('./vendor/sharp-browser/worker.js', import.meta.url), {type:'module'});
    await request(worker, {id:1,type:'load',model:model+'sharp.onnx',weightPack:model+'sharp.int8.bin',preferWebGpu:true}, control.signal);
    const pixels = rasterize(photo.bitmap, 1536, 1536);
    const {width,height,focalPx} = photo;
    const result = await request(worker, {id:2,type:'run',pixels,width,height,focalPx}, control.signal,[pixels.buffer]);
    worker.terminate();
    worker = null;
    const {medialUnit} = result.stats;
    const fov = pixels => 2 * Math.atan(pixels / (2*focalPx)) * 180 / Math.PI;
    const settings = { fileBytes:new Uint8Array(await result.file.arrayBuffer()),
      horizontalFov:fov(width), verticalFov:fov(height), crop:1.10, start:[0,0], yaw:0, pitch:0,
      speed:Math.max(.03,medialUnit*.8) };
    await openScene(settings, id, control);
  } catch (error) {
    if (id === revision) status(error.message || 'The scene could not be created on this device.');
  } finally {
    worker?.terminate();
    if (id === revision) { running = null; el('cancel').hidden = true; el('create').disabled = false; }
  }
};
async function openScene(settings, id, control) {
  if (id !== revision) return;
  status('Opening your 3D scene…');
  const {createPlayer} = await import('./walk.js');
  if (id !== revision) return;
  const view = await createPlayer(el('gpu'),el('pad'),settings,control.signal);
  if (id !== revision) { view.dispose(); return; }
  player = view;
  el('empty').hidden = true;
  el('gpu').hidden = el('pad').hidden = el('reset').hidden = false;
  el('photo').hidden = true;
  player.reset();
  player.setActive(true);
  el('stage').focus({preventScroll:true});
  status('Drag or use Q/E to turn. Scroll, pinch or use W/S to move closer or farther.');
}

el('cloud-file').onchange = async () => {
  const file = el('cloud-file').files[0];
  if (!file) return;
  el('cloud-file').value = '';
  stop();
  showPhoto();
  const id = revision;
  const control = new AbortController();
  running = control;
  el('create').disabled = true;
  el('cancel').hidden = false;
  try {
    if (!file.name.toLowerCase().endsWith('.ply') || file.size > 160 * 1024 * 1024)
      throw new Error('Choose a SHARP .PLY file under 160 MB.');
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    if (id !== revision) return;
    await openScene({...cameraFromPly(fileBytes), fileBytes, crop:1.1, start:[0,0], yaw:0, pitch:0, speed:.8}, id, control);
  } catch (error) {
    if (id === revision) status(error.message || 'Could not open this scene.');
  } finally {
    if (id === revision) { running = null; el('cancel').hidden = true; el('create').disabled = !photo; }
  }
};
el('cancel').onclick = () => { stop(); status('Cancelled. You can try again.'); };
el('reset').onclick = () => { player?.reset(); el('stage').focus({preventScroll:true}); };

async function checkDevice() {
  let adapter;
  try { adapter = await navigator.gpu?.requestAdapter(); } catch {}
  if (!adapter?.features.has('shader-f16')) {
    if (revision === 0) status('Local reconstruction is unavailable in this browser. Create on Hugging Face above, or walk through the first ride.');
    return;
  }
  el('file').disabled = false;
  if (revision === 0) status('Choose a photograph to begin.');
  if (el('file').files.length) el('file').onchange();
}
checkDevice();
