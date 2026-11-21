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

function show(modeName) {
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
  if (mode === 'walk') el('status').textContent = 'WASD or arrows to walk · Drag to look';
  if (mode === 'tour') el('status').textContent = 'Guided walk · ' + scene.seconds + ' seconds';
  if (mode === 'photo') el('status').textContent = 'Source photograph';
}

async function walk() {
  const id = ++ticket;
  if (mode === 'walk') { player.reset(); el('stage').focus({preventScroll:true}); return; }
  el('status').textContent = 'Opening the 3D scene…';
  try {
    loading ??= import('./walk.js').then(m => m.createPlayer(el('gpu'), el('pad'), scene));
    player = await loading;
    if (id !== ticket) return;
    player.reset();
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
