// Gradio's public HTTP API. The image and scene travel directly between the
// visitor and the selected SHARP Space; this static site never stores them.
const space = 'https://notaneimu-ml-sharp-3d-viewer.hf.space';
const api = space + '/gradio_api';
const maxScene = 160 * 1024 * 1024;

async function checked(url, options) {
  const response = await fetch(url, {...options, credentials:'omit', referrerPolicy:'no-referrer'});
  if (!response.ok) {
    if (response.status === 429) throw new Error('The shared SHARP queue is full. Please try again later.');
    throw new Error('The cloud service is unavailable (HTTP ' + response.status + '). Please retry.');
  }
  return response;
}

async function resultFile(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) throw new Error('The connection to the shared server ended. Please retry.');
      pending += value;
      if (pending.length > 1024 * 1024) throw new Error('Unexpected cloud response.');
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(pending))) {
        const event = pending.slice(0,separator.index).split(/\r?\n/);
        pending = pending.slice(separator.index + separator[0].length);
        if (event.includes('event: error')) throw new Error('Cloud reconstruction failed. Please try again later or choose on-device processing.');
        if (!event.includes('event: complete')) continue;
        const data = JSON.parse(event.filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n'));
        const file = data[0]?.value ?? data[0];
        const url = new URL(file?.url || '', space);
        if (url.origin !== space || !url.pathname.startsWith('/gradio_api/file=') || !url.pathname.endsWith('.ply'))
          throw new Error('The cloud service did not return a SHARP scene.');
        return url;
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function reconstructInCloud(file, signal, status) {
  const payload = new FormData();
  payload.append('files', file, 'photo.' + (file.type === 'image/jpeg' ? 'jpg' : file.type.split('/')[1]));
  status('Uploading your photo to the SHARP service…');
  const [path] = await (await checked(api+'/upload', {method:'POST', body:payload, signal})).json();
  if (typeof path !== 'string') throw new Error('Photo upload failed.');
  const ticket = await (await checked(api+'/call/run_sharp', {method:'POST', signal,
    headers:{'Content-Type':'application/json'}, body:JSON.stringify({data:[{path, meta:{_type:'gradio.FileData'}},35]})})).json();
  if (!/^[a-zA-Z0-9-]+$/.test(ticket.event_id)) throw new Error('The cloud queue could not start.');
  status('Reconstructing on the shared server. Keep this tab open; this can take several minutes.');
  const url = await resultFile(await checked(api+'/call/run_sharp/'+ticket.event_id,{signal}));
  status('Loading your 3D scene…');
  const response = await checked(url,{signal});
  if (Number(response.headers.get('content-length')) > maxScene) throw new Error('Scene exceeds the supported size.');
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const {value,done} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxScene) throw new Error('Scene exceeds the supported size.');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part,offset); offset += part.length; }
  return bytes;
}
