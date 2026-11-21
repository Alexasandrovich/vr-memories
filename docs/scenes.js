const cableCar = {
  title: 'Above the snowline', folder: 'walk', seconds: 8,
  description: 'A cable stretches past the window frame toward a snowy mountain peak.',
  caption: 'Step toward the window and follow the ridge with your eyes.',
  horizontalFov: 50, verticalFov: 27.368, crop: 1.35,
  start: [-.012, .36], yaw: -.025, pitch: 0,
  side: [-.05, .085], depth: [-.08, .36], speed: .42
};
const canyon = {
  title: 'The canyon at dusk', folder: 'canyon', seconds: 12,
  description: 'Warm light catches the gaps between a dark foreground slope and distant desert ridges.',
  caption: 'Move along the near slope and watch the sunlit gap between the distant ridges open.',
  horizontalFov: 46, verticalFov: 28.349, crop: 1.15,
  start: [-.45, 2.2], yaw: -.02, pitch: -.05,
  side: [-1.3, 1.65], depth: [-4.2, 2.2], speed: 1.65
};

const firstRide = {
  title: 'The first ride', folder: 'first-ride', seconds: 15,
  description: 'A grandfather steadies the handlebars as a child smiles on a bicycle.',
  caption: 'My grandfather was teaching me to ride. His hand is still on the handlebars. Take a step sideways and watch the bicycle shift against the blue car behind us.',
  horizontalFov: 60, verticalFov: 46.826, crop: 1.11,
  start: [0, 0], yaw: 0, pitch: .025,
  side: [-.43,.45], depth: [-.92,.04], speed: .33,
  // Camera positions and gaze targets use SHARP image coordinates, with +Z forward.
  views: [
    {name:'Beside the bicycle', time:0, position:[0,-.02,.04], target:[.02,-.06,2.5], crop:1.12},
    {name:'At the handlebars', time:3.5, position:[-.36,.36,.62], target:[-.25,.24,2.43], crop:1.65},
    {name:'From Grandpa’s side', time:7, position:[.43,.075,.40], target:[.015,-.10,2.5], crop:1.21},
    {name:'Face to face', time:11, position:[-.23,-.21,.66], target:[.018,-.40,2.48], crop:1.49}
  ]
};
const scenes = {'cable-car':cableCar, canyon, 'first-ride':firstRide};
const selected = new URLSearchParams(location.search).get('scene');
export const sceneKey = Object.hasOwn(scenes,selected) ? selected : 'first-ride';
export const scene = scenes[sceneKey];
