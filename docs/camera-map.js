// Coordinates match the SHARP camera: x is right, y is down and z is forward.
export function filmedView(scene, seconds) {
  const index = Math.max(0, scene.views.findLastIndex(view => view.time <= seconds));
  const view = scene.views[index];
  const endTime = scene.views[index+1]?.time ?? scene.seconds;
  const frame = Math.floor(Math.max(0,seconds-view.time)*60);
  const t = Math.min(1,frame/((endTime-view.time)*60-1));
  const eased = t*t*(3-2*t);
  const u = view.smooth ? eased : .65*t+.35*eased;
  return {...view,
    position:view.position.map((v,i)=>(1-u)**2*v+2*u*(1-u)*view.via[i]+u*u*view.end[i]),
    target:view.target.map((v,i)=>v+u*(view.endTarget[i]-v))
  };
}

export function drawMap(canvas, readout, x, y, z, yaw, pitch) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const span = Math.max(4,Math.abs(z)*1.25,Math.abs(x)*1.25);
  const unit = Math.min(w,h)*.42/span;
  const ox = w*.5, oy = h*.5;
  const px = ox+x*unit, py = oy-z*unit;
  ctx.clearRect(0,0,w,h);
  // The fixed outline is the source camera's 60-degree horizontal field of view.
  ctx.fillStyle = '#394c4121';
  ctx.beginPath(); ctx.moveTo(ox,oy);
  ctx.lineTo(ox-.577*oy,0); ctx.lineTo(ox+.577*oy,0); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#31544435'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0,oy+.5); ctx.lineTo(w,oy+.5);
  ctx.moveTo(ox+.5,0); ctx.lineTo(ox+.5,h); ctx.stroke();
  ctx.strokeStyle = '#54695c'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(ox,oy,5,0,Math.PI*2); ctx.stroke();
  ctx.setLineDash([3,4]); ctx.beginPath(); ctx.moveTo(ox,oy); ctx.lineTo(px,py); ctx.stroke(); ctx.setLineDash([]);
  ctx.save(); ctx.translate(px,py); ctx.rotate(-yaw + (Math.cos(pitch)<0 ? Math.PI : 0));
  ctx.fillStyle = '#a64b18'; ctx.beginPath();
  ctx.moveTo(0,-10); ctx.lineTo(6,6); ctx.lineTo(0,3); ctx.lineTo(-6,6); ctx.closePath(); ctx.fill(); ctx.restore();
  const value = Math.hypot(x,y,z).toFixed(1)+' m from the original camera';
  if (readout.textContent !== value) readout.textContent = value;
}
