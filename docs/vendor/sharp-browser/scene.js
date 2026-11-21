// Adapted from SharpRig (MIT). See LICENSE and NOTICE.md.
export function computeStats(scene) {
    const n = scene.count;
    const step = Math.max(1, Math.floor(n / 50000));
    const zs = [];
    for(let i = 0; i < n; i += step){
        const z = scene.positions[i * 3 + 2];
        if (z > 0 && scene.colors[i * 4 + 3] > 20) zs.push(z);
    }
    zs.sort((a, b)=>a - b);
    const q = (t)=>zs.length ? zs[Math.min(zs.length - 1, Math.floor(t * zs.length))] : 1;
    const nearDepth = q(0.1);
    const focusDepth = q(0.5);
    const farDepth = q(0.9);
    const diag = Math.hypot(scene.imageWidth / scene.focalPx, scene.imageHeight / scene.focalPx);
    const lateralUnit = 0.08 * diag * nearDepth;
    const medialUnit = 0.15 * nearDepth;
    return {
        nearDepth,
        focusDepth,
        farDepth,
        lateralUnit,
        medialUnit
    };
}
export function covarianceFromScaleRot(sx, sy, sz, qw, qx, qy, qz, out, o) {
    const l = Math.hypot(qw, qx, qy, qz) || 1;
    qw /= l;
    qx /= l;
    qy /= l;
    qz /= l;
    const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qw * qz), r02 = 2 * (qx * qz + qw * qy);
    const r10 = 2 * (qx * qy + qw * qz), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qw * qx);
    const r20 = 2 * (qx * qz - qw * qy), r21 = 2 * (qy * qz + qw * qx), r22 = 1 - 2 * (qx * qx + qy * qy);
    const m00 = r00 * sx, m01 = r01 * sy, m02 = r02 * sz;
    const m10 = r10 * sx, m11 = r11 * sy, m12 = r12 * sz;
    const m20 = r20 * sx, m21 = r21 * sy, m22 = r22 * sz;
    out[o] = m00 * m00 + m01 * m01 + m02 * m02;
    out[o + 1] = m00 * m10 + m01 * m11 + m02 * m12;
    out[o + 2] = m00 * m20 + m01 * m21 + m02 * m22;
    out[o + 3] = m10 * m10 + m11 * m11 + m12 * m12;
    out[o + 4] = m10 * m20 + m11 * m21 + m12 * m22;
    out[o + 5] = m20 * m20 + m21 * m21 + m22 * m22;
}
export const linearToSrgb = (x)=>x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
export const toByte = (x)=>x <= 0 ? 0 : x >= 1 ? 255 : Math.round(x * 255);
