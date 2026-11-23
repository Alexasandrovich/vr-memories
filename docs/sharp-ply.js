// Read Apple's camera calibration from a binary SHARP export.
export function cameraFromPly(bytes) {
  const head = new TextDecoder('ascii').decode(bytes.subarray(0, 8192));
  const end = /^end_header\r?\n/m.exec(head);
  const invalid = () => new Error('Choose the original .PLY downloaded from the SHARP Space.');
  if (!end || !/^ply\r?\nformat binary_little_endian 1\.0\r?\n/.test(head)) throw invalid();
  const sections = [];
  const widths = {float:4, uint:4, int:4, uchar:1};
  for (const line of head.slice(0, end.index).trim().split(/\r?\n/)) {
    const [kind, name, value] = line.split(/\s+/);
    if (kind === 'element') {
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count < 0) throw invalid();
      sections.push({name, count, stride:0, fields:[]});
    } else if (kind === 'property') {
      const section = sections.at(-1);
      if (!section || !Object.hasOwn(widths, name)) throw invalid();
      section.stride += widths[name];
      section.fields.push([name, value]);
    }
  }
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = end.index + end[0].length;
  let width, height, fx, fy, splats = 0;
  for (const {name, count, stride, fields} of sections) {
    const next = offset + count * stride;
    if (!stride || !Number.isSafeInteger(next) || next > bytes.length) throw invalid();
    if (name === 'vertex' && fields.some(([,field]) => field === 'rot_3')) splats = count;
    if (name === 'intrinsic' && count === 9 && stride === 4 && fields[0][0] === 'float') {
      fx = data.getFloat32(offset, true);
      fy = data.getFloat32(offset + 16, true);
    }
    if (name === 'image_size' && count === 2 && stride === 4 && fields[0][0] === 'uint') {
      width = data.getUint32(offset, true);
      height = data.getUint32(offset + 4, true);
    }
    offset = next;
  }
  if (!splats || ![width,height,fx,fy].every(v => Number.isFinite(v) && v > 0)) throw invalid();
  const fov = (size, focal) => 2 * Math.atan(size / (2*focal)) * 180 / Math.PI;
  return {horizontalFov:fov(width,fx), verticalFov:fov(height,fy)};
}
