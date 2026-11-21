// Adapted from SharpRig (MIT). See LICENSE and NOTICE.md.
const SH_C0 = 0.28209479177387814;
export function writePly(scene) {
    const n = scene.count;
    const props = [
        'x',
        'y',
        'z',
        'f_dc_0',
        'f_dc_1',
        'f_dc_2',
        'opacity',
        'scale_0',
        'scale_1',
        'scale_2',
        'rot_0',
        'rot_1',
        'rot_2',
        'rot_3'
    ];
    let header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n`;
    for (const p of props)header += `property float ${p}\n`;
    header += 'element intrinsic 9\nproperty float intrinsic\n';
    header += 'element image_size 2\nproperty uint image_size\n';
    header += 'element color_space 1\nproperty uchar color_space\n';
    header += 'end_header\n';
    const headerBytes = new TextEncoder().encode(header);
    const body = new ArrayBuffer(n * props.length * 4 + 9 * 4 + 2 * 4 + 1);
    const dv = new DataView(body);
    let o = 0;
    const w = (x)=>{
        dv.setFloat32(o, x, true);
        o += 4;
    };
    const eig = new Float64Array(12);
    for(let i = 0; i < n; i++){
        w(scene.positions[i * 3]);
        w(scene.positions[i * 3 + 1]);
        w(scene.positions[i * 3 + 2]);
        for(let c = 0; c < 3; c++)w((scene.colors[i * 4 + c] / 255 - 0.5) / SH_C0);
        const a = Math.min(0.9999, Math.max(1e-4, scene.colors[i * 4 + 3] / 255));
        w(Math.log(a / (1 - a)));
        symmetricEigen(scene.covariances, i * 6, eig);
        for(let c = 0; c < 3; c++)w(Math.log(Math.sqrt(Math.max(eig[c], 1e-14))));
        const q = rotationToQuatWxyz(eig);
        w(q[0]);
        w(q[1]);
        w(q[2]);
        w(q[3]);
    }
    const intr = [
        scene.focalPx,
        0,
        scene.imageWidth / 2,
        0,
        scene.focalPx,
        scene.imageHeight / 2,
        0,
        0,
        1
    ];
    for (const x of intr)w(x);
    dv.setUint32(o, scene.imageWidth, true);
    o += 4;
    dv.setUint32(o, scene.imageHeight, true);
    o += 4;
    dv.setUint8(o, 0);
    return new Blob([
        headerBytes,
        body
    ], {
        type: 'application/octet-stream'
    });
}
function symmetricEigen(cov, o, out) {
    const a = [
        [
            cov[o],
            cov[o + 1],
            cov[o + 2]
        ],
        [
            cov[o + 1],
            cov[o + 3],
            cov[o + 4]
        ],
        [
            cov[o + 2],
            cov[o + 4],
            cov[o + 5]
        ]
    ];
    const v = [
        [
            1,
            0,
            0
        ],
        [
            0,
            1,
            0
        ],
        [
            0,
            0,
            1
        ]
    ];
    for(let sweep = 0; sweep < 12; sweep++){
        const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
        if (off < 1e-20) break;
        for(let p = 0; p < 2; p++)for(let q = p + 1; q < 3; q++){
            if (Math.abs(a[p][q]) < 1e-30) continue;
            const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c;
            for(let k = 0; k < 3; k++){
                const akp = a[k][p], akq = a[k][q];
                a[k][p] = c * akp - s * akq;
                a[k][q] = s * akp + c * akq;
            }
            for(let k = 0; k < 3; k++){
                const apk = a[p][k], aqk = a[q][k];
                a[p][k] = c * apk - s * aqk;
                a[q][k] = s * apk + c * aqk;
            }
            for(let k = 0; k < 3; k++){
                const vkp = v[k][p], vkq = v[k][q];
                v[k][p] = c * vkp - s * vkq;
                v[k][q] = s * vkp + c * vkq;
            }
        }
    }
    out[0] = a[0][0];
    out[1] = a[1][1];
    out[2] = a[2][2];
    const det = v[0][0] * (v[1][1] * v[2][2] - v[1][2] * v[2][1]) - v[0][1] * (v[1][0] * v[2][2] - v[1][2] * v[2][0]) + v[0][2] * (v[1][0] * v[2][1] - v[1][1] * v[2][0]);
    if (det < 0) for(let k = 0; k < 3; k++)v[k][2] = -v[k][2];
    for(let c = 0; c < 3; c++)for(let r = 0; r < 3; r++)out[3 + c * 3 + r] = v[r][c];
}
function rotationToQuatWxyz(e) {
    const m = (r, c)=>e[3 + c * 3 + r];
    const tr = m(0, 0) + m(1, 1) + m(2, 2);
    let w, x, y, z;
    if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        w = 0.25 * s;
        x = (m(2, 1) - m(1, 2)) / s;
        y = (m(0, 2) - m(2, 0)) / s;
        z = (m(1, 0) - m(0, 1)) / s;
    } else if (m(0, 0) > m(1, 1) && m(0, 0) > m(2, 2)) {
        const s = Math.sqrt(1 + m(0, 0) - m(1, 1) - m(2, 2)) * 2;
        w = (m(2, 1) - m(1, 2)) / s;
        x = 0.25 * s;
        y = (m(0, 1) + m(1, 0)) / s;
        z = (m(0, 2) + m(2, 0)) / s;
    } else if (m(1, 1) > m(2, 2)) {
        const s = Math.sqrt(1 + m(1, 1) - m(0, 0) - m(2, 2)) * 2;
        w = (m(0, 2) - m(2, 0)) / s;
        x = (m(0, 1) + m(1, 0)) / s;
        y = 0.25 * s;
        z = (m(1, 2) + m(2, 1)) / s;
    } else {
        const s = Math.sqrt(1 + m(2, 2) - m(0, 0) - m(1, 1)) * 2;
        w = (m(1, 0) - m(0, 1)) / s;
        x = (m(0, 2) + m(2, 0)) / s;
        y = (m(1, 2) + m(2, 1)) / s;
        z = 0.25 * s;
    }
    return [
        w,
        x,
        y,
        z
    ];
}
