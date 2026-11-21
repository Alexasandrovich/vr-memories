// Adapted from SharpRig (MIT). See LICENSE and NOTICE.md.
import * as ort from './ort/ort.webgpu.min.mjs';
import { covarianceFromScaleRot, linearToSrgb, toByte } from './scene.js';
import { loadWeightPack } from './weightPack.js';
import { computeStats } from './scene.js';
import { writePly } from './writePly.js';
const SHARP_INTERNAL = 1536;
let session = null;
let backend = 'wasm';
let lastLoad = null;
async function createSession(msg, providers) {
    const opts = {
        executionProviders: providers,
        graphOptimizationLevel: 'all'
    };
    if (msg.externalData) opts.externalData = [
        msg.externalData
    ];
    if (session) await session.release();
    session = await ort.InferenceSession.create(msg.model, opts);
    backend = providers[0];
}
let currentId = 0;
const post = (m, transfer = [])=>self.postMessage({
        ...m,
        id: currentId
    }, transfer);
let chain = Promise.resolve();
self.onmessage = (e)=>{
    chain = chain.then(()=>handle(e.data));
};
async function handle(req) {
    currentId = req.id;
    let msg = req;
    try {
        if (msg.type === 'load') {
            const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
            const providers = msg.preferWebGpu && hasWebGpu ? [
                'webgpu',
                'wasm'
            ] : [
                'wasm'
            ];
            ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
            post({
                type: 'progress',
                stage: 'Downloading and compiling SHARP…'
            });
            if (msg.weightPack) {
                const mb = (b)=>(b / 1e6).toFixed(0);
                let lastPercent = -1;
                const expanded = await loadWeightPack(msg.weightPack, (loaded, total, cached)=>{
                    const percent = total ? Math.floor(loaded / total * 100) : Math.floor(loaded / 5e6);
                    if (percent === lastPercent) return;
                    lastPercent = percent;
                    const pct = total ? ` ${Math.round(loaded / total * 100)}%` : '';
                    post({
                        type: 'progress',
                        stage: `${cached ? 'Loading cached' : 'Downloading'} SHARP weights${pct} (${mb(loaded)}${total ? ` / ${mb(total)}` : ''} MB)…`
                    });
                });
                post({
                    type: 'progress',
                    stage: 'Compiling SHARP for the GPU…'
                });
                msg = {
                    ...msg,
                    externalData: {
                        path: expanded.path,
                        data: expanded.data
                    }
                };
            }
            lastLoad = msg;
            await createSession(msg, providers);
            post({
                type: 'loaded',
                backend
            });
            return;
        }
        if (msg.type === 'run') {
            if (!session) throw new Error('SHARP model is not loaded');
            const t0 = performance.now();
            const S = SHARP_INTERNAL;
            const chw = new Float32Array(3 * S * S);
            const px = msg.pixels;
            for(let i = 0; i < S * S; i++){
                chw[i] = px[i * 4] / 255;
                chw[S * S + i] = px[i * 4 + 1] / 255;
                chw[2 * S * S + i] = px[i * 4 + 2] / 255;
            }
            post({
                type: 'progress',
                stage: 'Running SHARP inference…'
            });
            const feeds = {
                image: new ort.Tensor('float32', chw, [
                    1,
                    3,
                    S,
                    S
                ]),
                disparity_factor: new ort.Tensor('float32', new Float32Array([
                    msg.focalPx / msg.width
                ]), [
                    1
                ])
            };
            let out;
            try {
                out = await session.run(feeds);
            } catch (err) {
                if (backend !== 'webgpu' || !lastLoad) throw err;
                console.warn('SHARP WebGPU run failed, falling back to WASM', err);
                post({
                    type: 'progress',
                    stage: 'WebGPU failed; retrying on CPU (WASM)…'
                });
                await createSession(lastLoad, [
                    'wasm'
                ]);
                out = await session.run(feeds);
            }
            post({
                type: 'progress',
                stage: 'Unprojecting Gaussians…'
            });
            const means = await out.mean_vectors.getData();
            const scales = await out.singular_values.getData();
            const quats = await out.quaternions.getData();
            const cols = await out.colors.getData();
            const opac = await out.opacities.getData();
            const n = opac.length;
            const sx = msg.width / (2 * msg.focalPx);
            const sy = msg.height / (2 * msg.focalPx);
            const positions = new Float32Array(n * 3);
            const covariances = new Float32Array(n * 6);
            const colors = new Uint8Array(n * 4);
            const cov = new Float32Array(6);
            for(let i = 0; i < n; i++){
                positions[i * 3] = means[i * 3] * sx;
                positions[i * 3 + 1] = means[i * 3 + 1] * sy;
                positions[i * 3 + 2] = means[i * 3 + 2];
                covarianceFromScaleRot(scales[i * 3], scales[i * 3 + 1], scales[i * 3 + 2], quats[i * 4], quats[i * 4 + 1], quats[i * 4 + 2], quats[i * 4 + 3], cov, 0);
                covariances[i * 6] = cov[0] * sx * sx;
                covariances[i * 6 + 1] = cov[1] * sx * sy;
                covariances[i * 6 + 2] = cov[2] * sx;
                covariances[i * 6 + 3] = cov[3] * sy * sy;
                covariances[i * 6 + 4] = cov[4] * sy;
                covariances[i * 6 + 5] = cov[5];
                colors[i * 4] = toByte(linearToSrgb(Math.max(0, cols[i * 3])));
                colors[i * 4 + 1] = toByte(linearToSrgb(Math.max(0, cols[i * 3 + 1])));
                colors[i * 4 + 2] = toByte(linearToSrgb(Math.max(0, cols[i * 3 + 2])));
                colors[i * 4 + 3] = toByte(opac[i]);
            }
            for (const t of Object.values(out))t.dispose();
            const scene = {
                count: n,
                positions,
                covariances,
                colors,
                imageWidth: msg.width,
                imageHeight: msg.height,
                focalPx: msg.focalPx
            };
            const file = writePly(scene);
            post({
                type: 'result',
                count: n,
                file,
                stats: computeStats(scene),
                ms: performance.now() - t0,
                backend
            }, []);
        }
    } catch (err) {
        post({
            type: 'error',
            message: err instanceof Error ? err.message : String(err)
        });
    }
}
