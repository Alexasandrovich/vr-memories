const cableCar = {
  title: 'Above the snowline', folder: 'walk', seconds: 8,
  description: 'A cable stretches past the window frame toward a snowy mountain peak.',
  caption: 'Step toward the window and follow the ridge with your eyes.',
  horizontalFov: 50, verticalFov: 27.368, crop: 1.35,
  start: [-.012, .36], yaw: -.025, pitch: 0,
  speed: .42
};
const canyon = {
  title: 'The canyon at dusk', folder: 'canyon', seconds: 12,
  description: 'Warm light catches the gaps between a dark foreground slope and distant desert ridges.',
  caption: 'Move along the near slope and watch the sunlit gap between the distant ridges open.',
  horizontalFov: 46, verticalFov: 28.349, crop: 1.15,
  start: [-.45, 2.2], yaw: -.02, pitch: -.05,
  speed: 1.65
};

const firstRide = {
  title: 'The first ride', folder: 'first-ride', seconds: 22,
  description: 'A grandfather steadies the handlebars as a child smiles on a bicycle.',
  caption: 'My grandfather has one hand on the handlebars. I’m grinning at the camera. Pull back from our faces and you can see where we stood in the yard that day.',
  horizontalFov: 60, verticalFov: 46.826, crop: 1.11,
  start: [0, 0], yaw: 0, pitch: .025,
  speed: .8,
  // Camera positions and gaze targets use SHARP image coordinates, with +Z forward.
  views: [
    {name:'Pull back into the yard', time:0, position:[.18,-.31,.90], via:[.45,-.54,-1.7], end:[2.45,-1.65,-5.95], target:[-.16,-.40,2.48], endTarget:[0,-.03,2.7], crop:1.54, smooth:true},
    {name:'Beside the bicycle', time:7, position:[0,-.02,.04], via:[-.24,-.08,.18], end:[-.43,-.12,.26], target:[.02,-.06,2.5], endTarget:[.025,-.06,2.5], crop:1.12},
    {name:'At the handlebars', time:10.5, position:[-.36,.36,.62], via:[-.18,.34,.76], end:[.02,.19,.82], target:[-.25,.24,2.43], endTarget:[-.16,-.075,2.43], crop:1.65},
    {name:'From Grandpa’s side', time:14, position:[.43,.075,.40], via:[.46,-.11,.61], end:[.28,-.21,.79], target:[-.10,.01,2.5], endTarget:[.16,-.38,2.5], crop:1.22},
    {name:'Face to face', time:18, position:[-.23,-.21,.66], via:[-.10,-.30,.85], end:[.18,-.31,.90], target:[.23,-.52,2.48], endTarget:[-.16,-.40,2.48], crop:1.54}
  ]
};
const scenes = {'cable-car':cableCar, canyon, 'first-ride':firstRide};
const selected = new URLSearchParams(location.search).get('scene');
export const sceneKey = Object.hasOwn(scenes,selected) ? selected : 'first-ride';
export const scene = scenes[sceneKey];
