export const cableCar = new URLSearchParams(location.search).get('scene') === 'cable-car';

export const scene = cableCar ? {
  title: 'Above the snowline', folder: 'walk', seconds: 8,
  description: 'A cable stretches past the window frame toward a snowy mountain peak.',
  caption: 'Step toward the window and follow the ridge with your eyes.',
  horizontalFov: 50, verticalFov: 27.368, crop: 1.35,
  start: [-.012, .36], yaw: -.025, pitch: 0,
  side: [-.05, .085], depth: [-.08, .36], speed: .42
} : {
  title: 'The canyon at dusk', folder: 'canyon', seconds: 12,
  description: 'Warm light catches the gaps between a dark foreground slope and distant desert ridges.',
  caption: 'Move along the near slope and watch the sunlit gap between the distant ridges open.',
  horizontalFov: 46, verticalFov: 28.349, crop: 1.15,
  start: [-.45, 2.2], yaw: -.02, pitch: -.05,
  side: [-1.3, 1.65], depth: [-4.2, 2.2], speed: 1.65
};
