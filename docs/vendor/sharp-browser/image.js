// Adapted from SharpRig (MIT). See LICENSE and NOTICE.md.
export async function loadImage(file, name = 'image') {
    const buf = await file.arrayBuffer();
    const exif = readExifFocal(buf);
    const bitmap = await createImageBitmap(file, {
        imageOrientation: 'from-image'
    });
    let f35 = exif.f35 ?? exif.f ?? null;
    const fromExif = f35 !== null && f35 >= 1;
    if (!fromExif) f35 = 30;
    else if (f35 < 10) f35 = f35 * 8.4;
    const focalPx = convertFocalLength(bitmap.width, bitmap.height, f35);
    return {
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
        focalPx,
        focal35mm: f35,
        focalFromExif: fromExif,
        name
    };
}
export function convertFocalLength(width, height, f35) {
    return f35 * Math.hypot(width, height) / Math.hypot(36, 24);
}
function readExifFocal(buf) {
    const dv = new DataView(buf);
    if (dv.byteLength < 4 || dv.getUint16(0) !== 0xffd8) return {};
    let off = 2;
    while(off + 4 < dv.byteLength){
        const marker = dv.getUint16(off);
        const len = dv.getUint16(off + 2);
        if (marker === 0xffe1 && dv.getUint32(off + 4) === 0x45786966) {
            return parseTiff(dv, off + 10);
        }
        if ((marker & 0xff00) !== 0xff00) break;
        off += 2 + len;
    }
    return {};
}
function parseTiff(dv, tiff) {
    try {
        const le = dv.getUint16(tiff) === 0x4949;
        const u16 = (o)=>dv.getUint16(o, le);
        const u32 = (o)=>dv.getUint32(o, le);
        const out = {};
        const readIfd = (ifd, depth)=>{
            if (depth > 2 || ifd <= 0 || tiff + ifd + 2 > dv.byteLength) return;
            const n = u16(tiff + ifd);
            for(let i = 0; i < n; i++){
                const e = tiff + ifd + 2 + i * 12;
                const tag = u16(e);
                const type = u16(e + 2);
                if (tag === 0x8769) readIfd(u32(e + 8), depth + 1);
                else if (tag === 0xa405) out.f35 = type === 3 ? u16(e + 8) : u32(e + 8);
                else if (tag === 0x920a && type === 5) {
                    const vo = tiff + u32(e + 8);
                    const den = u32(vo + 4);
                    if (den) out.f = u32(vo) / den;
                }
            }
        };
        readIfd(u32(tiff + 4), 0);
        return out;
    } catch  {
        return {};
    }
}
export function rasterize(bitmap, width, height) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', {
        willReadFrequently: true
    });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
}
