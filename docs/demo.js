import {scene, sceneKey} from './scenes.js';
const el = id => document.getElementById(id);
const film = el('film');
document.title = scene.title + ' · VR Memories';
el('name').textContent = scene.title;
el('caption').textContent = scene.caption;
film.poster = './' + scene.folder + '/poster.webp';
film.src = './' + scene.folder + '/tour.mp4';
el('photo').src = './' + scene.folder + '/photo.webp';
el('photo').alt = scene.description;
for (const link of document.querySelectorAll('[data-scene]')) {
  if (link.dataset.scene === sceneKey) link.setAttribute('aria-current','page');
  else link.removeAttribute('aria-current');
}
document.body.dataset.scene = sceneKey;
let mode = 'tour';
let beforePhoto = 'tour';
let player;
let loading;
let ticket = 0;
let localTour;
let seekingAngle = false;
async function seekTour(view, id) {
  const playing = !film.paused;
  seekingAngle = true;
  try {
    // Static servers without range support need a complete local copy to seek.
    const seekable = film.seekable;
    if (view.time > 0 && (!seekable.length || seekable.end(seekable.length-1) < view.time)) {
      localTour ??= fetch('./' + scene.folder + '/tour.mp4?complete=1').then(async response => {
        if (!response.ok) throw new Error('Video download failed');
        return URL.createObjectURL(await response.blob());
      }).catch(error => { localTour = null; throw error; });
      const url = await localTour;
      if (id !== ticket) return;
      if (film.src !== url) film.src = url;
    }
    film.currentTime = view.time;
    if (playing) await film.play().catch(syncTour);
  } catch {
    if (id === ticket) el('status').textContent = 'Could not open this camera angle. Try again.';
  } finally {
    if (id === ticket) seekingAngle = false;
  }
}
const angles = el('angle');
if (scene.views) {
  el('angles').hidden = false;
  for (const button of el('pad').querySelectorAll('[aria-label^="Turn"]')) button.hidden = false;
  for (const view of scene.views) angles.add(new Option(view.name));
  film.addEventListener('timeupdate', () => {
    if (mode === 'tour' && !seekingAngle) angles.selectedIndex = scene.views.findLastIndex(view => view.time <= film.currentTime);
  });
  angles.onchange = () => {
    const id = ++ticket;
    const view = scene.views[angles.selectedIndex];
    if (mode === 'walk') {
      player.reset(view);
      el('stage').focus({preventScroll:true});
    } else {
      show('tour');
      seekTour(view,id);
    }
  };
}

function selectedView() { return scene.views?.[angles.selectedIndex]; }

function show(modeName) {
  seekingAngle = false;
  mode = modeName;
  const walk = mode === 'walk';
  const source = mode === 'photo';
  film.hidden = walk || source;
  el('photo').hidden = !source;
  el('gpu').hidden = !walk;
  el('pad').hidden = !walk;
  el('source').setAttribute('aria-pressed', String(source));
  el('source').textContent = source ? 'Back to scene' : 'Original photo';
  el('explore').textContent = walk ? 'Reset position' : 'Walk here ↗';
  if (mode !== 'tour') film.pause();
  player?.setActive(walk);
  syncTour();
}

function syncTour() {
  el('tour').textContent = mode === 'tour' && !film.paused ? 'Pause tour' : 'Play tour';
  if (mode === 'walk') el('status').textContent = scene.views ? 'WASD to walk · Q/E to turn · Drag to look' : 'WASD or arrows to walk · Drag to look';
  if (mode === 'tour') el('status').textContent = 'Guided walk · ' + scene.seconds + ' seconds';
  if (mode === 'photo') el('status').textContent = 'Source photograph';
}

async function walk() {
  const id = ++ticket;
  if (mode === 'walk') { player.reset(selectedView()); el('stage').focus({preventScroll:true}); return; }
  el('status').textContent = 'Opening the 3D scene…';
  try {
    loading ??= import('./walk.js').then(m => m.createPlayer(el('gpu'), el('pad'), scene));
    player = await loading;
    if (id !== ticket) return;
    player.reset(selectedView());
    show('walk');
    el('stage').focus({preventScroll:true});
  } catch (error) {
    console.error('Unable to open the 3D scene', error);
    loading = null;
    if (id !== ticket) return;
    show('tour');
    el('status').textContent = 'The live view needs WebGL 2. You can still play the guided walk.';
  }
}

el('explore').onclick = walk;
el('tour').onclick = () => {
  ticket++;
  seekingAngle = false;
  if (mode === 'tour' && !film.paused) { film.pause(); return; }
  show('tour');
  film.play().catch(syncTour);
};
el('source').onclick = () => {
  ticket++;
  if (mode === 'photo') {
    show(beforePhoto);
    if (beforePhoto === 'tour' && wasPlaying) film.play().catch(syncTour);
    return;
  }
  beforePhoto = mode;
  wasPlaying = !film.paused;
  show('photo');
};
let wasPlaying = false;
film.addEventListener('play', syncTour);
film.addEventListener('pause', syncTour);
syncTour();
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) film.play().catch(syncTour);
