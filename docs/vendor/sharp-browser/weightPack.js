// Adapted from SharpRig (MIT). See LICENSE and NOTICE.md.
const MAGIC = 'MVSQ8\0\0\0';
const CACHE_NAME = 'vr-memories-sharp-v1';
export async function isWeightPackCached(url) {
    try {
        return !!await (await caches.open(CACHE_NAME)).match(new URL(url, location.href).href);
    } catch  {
        return false;
    }
}
function q8Size(c) {
    const n = c.rows * c.cols;
    return n + (4 - n % 4) % 4 + 4 * (c.axis === 0 ? c.rows : c.cols);
}
const F16 = globalThis.Float16Array;
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalfBits(v) {
    f32[0] = v;
    const x = u32[0];
    const sign = x >>> 16 & 0x8000;
    let exp = (x >>> 23 & 0xff) - 127 + 15;
    let mant = x & 0x7fffff;
    if (exp <= 0) {
        if (exp < -10) return sign;
        mant = (mant | 0x800000) >> 1 - exp;
        return sign | mant + 0x1000 >> 13;
    }
    if (exp >= 31) return sign | 0x7c00;
    const half = sign | exp << 10 | mant >> 13;
    return (mant & 0x1fff) > 0x1000 || (mant & 0x1fff) === 0x1000 && half & 1 ? half + 1 : half;
}
function dequantize(c, src, out) {
    const n = c.rows * c.cols;
    const q = new Int8Array(src.buffer, src.byteOffset, n);
    const scaleOff = src.byteOffset + n + (4 - n % 4) % 4;
    const scales = new Float32Array(src.buffer.slice(scaleOff, scaleOff + 4 * (c.axis === 0 ? c.rows : c.cols)));
    const { rows, cols } = c;
    if (F16) {
        const dst = new F16(out.buffer, out.byteOffset + c.off, n);
        if (c.axis === 0) {
            for(let r = 0, i = 0; r < rows; r++){
                const s = scales[r];
                for(let k = 0; k < cols; k++, i++)dst[i] = q[i] * s;
            }
        } else {
            for(let r = 0, i = 0; r < rows; r++)for(let k = 0; k < cols; k++, i++)dst[i] = q[i] * scales[k];
        }
    } else {
        const dst = new Uint16Array(out.buffer, out.byteOffset + c.off, n);
        for(let r = 0, i = 0; r < rows; r++)for(let k = 0; k < cols; k++, i++)dst[i] = toHalfBits(q[i] * scales[c.axis === 0 ? r : k]);
    }
}
async function openStream(url, onProgress) {
    let cache = null;
    try {
        if (/^https?:/.test(url)) cache = await caches.open(CACHE_NAME);
    } catch  {}
    const hit = cache ? await cache.match(url) : undefined;
    let res;
    let cached = false;
    if (hit) {
        res = hit;
        cached = true;
    } else {
        res = await fetch(url);
        if (!res.ok || !res.body) throw new Error(`Could not download ${url} (${res.status})`);
        if (cache) {
            const [a, b] = res.body.tee();
            cache.put(url, new Response(b, {
                headers: res.headers
            })).catch((e)=>console.warn('Model not cached:', e));
            res = new Response(a, {
                headers: res.headers
            });
        }
    }
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    let loaded = 0;
    return {
        async read () {
            const r = await reader.read();
            if (r.value) {
                loaded += r.value.byteLength;
                onProgress(loaded, total, cached);
            }
            return r;
        }
    };
}
export async function loadWeightPack(url, onProgress) {
    const stream = await openStream(url, onProgress);
    let parts = [];
    let available = 0;
    let done = false;
    const pull = async ()=>{
        const r = await stream.read();
        if (r.done) done = true;
        else {
            parts.push(r.value);
            available += r.value.byteLength;
        }
    };
    const take = async (n, into)=>{
        while(available < n){
            if (done) throw new Error('Weight pack is truncated');
            await pull();
        }
        const out = into ?? new Uint8Array(n);
        let filled = 0;
        while(filled < n){
            const p = parts[0];
            const k = Math.min(p.byteLength, n - filled);
            out.set(p.subarray(0, k), filled);
            filled += k;
            if (k === p.byteLength) parts.shift();
            else parts[0] = p.subarray(k);
        }
        available -= n;
        return out;
    };
    const prelude = await take(12);
    if (new TextDecoder().decode(prelude.subarray(0, 8)) !== MAGIC) throw new Error('Not an MVSQ8 weight pack');
    const headerLen = new DataView(prelude.buffer).getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(await take(headerLen)));
    await take((16 - (12 + headerLen) % 16) % 16);
    const out = new Uint8Array(header.dataLength);
    let scratch = new Uint8Array(0);
    for (const c of header.chunks){
        if (c.kind === 'raw') {
            await take(c.len, out.subarray(c.off, c.off + c.len));
        } else {
            const size = q8Size(c);
            if (scratch.byteLength < size) scratch = new Uint8Array(size);
            const src = await take(size, scratch.subarray(0, size));
            dequantize(c, src, out);
        }
    }
    parts = [];
    return {
        path: header.dataFile,
        data: out
    };
}
