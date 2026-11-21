# WebXR viewer

The Mac serves `dist/` over HTTPS to Quest Browser. The main album uses WebXR to track the headset and controllers, with stereo frames rendered on the GPU host. For the browser demo and setup instructions, see the [project README](../README.md).

The standalone viewer is available at `baseline.html`. Serve the directory over HTTP on localhost or HTTPS on your LAN. It can load a local `.vrmemory` bundle, or a `scene.ply` and `scene.json` pair, using the file picker. A bundle contains camera metadata, the Gaussian PLY and its SHA-256 digest.

The bundled copies of Three.js and Spark include their [Three.js](dist/vendor/LICENSE-three) and [Spark](dist/vendor/LICENSE-spark) licenses.
