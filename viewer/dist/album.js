import * as T from 'three';

const W=1440,H=900,PAGE=6;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const stages={
  queued:'В очереди на RTX…', checking:'Проверяю сохранённую сцену…',
  building:'RTX строит сцену из фотографии…', opening:'Открываю стереосцену…'
};

async function api(path,options){
  const response=await fetch('./album/'+path,{...options,signal:AbortSignal.timeout(20000)});
  if(!response.ok){
    const error=new Error(response.status===429?'Много попыток. Подождите минуту.':response.status===403?'Код не подошёл. Проверьте код на Mac.':'Не удалось получить ответ от альбома на Mac.');
    error.status=response.status;throw error;
  }
  return response.json();
}

export class PhotoGallery {
  constructor(onScene,onCancel){
    this.onScene=onScene;this.onCancel=onCancel;
    this.visible=false;this.opening=false;this.version=0;this.page=0;this.photos=[];
    this.images=new Map();this.buttons=[];this.hover=-1;
    this.canvas=document.createElement('canvas');this.canvas.width=W;this.canvas.height=H;
    this.ctx=this.canvas.getContext('2d',{alpha:false});
    this.dialog=document.createElement('dialog');this.dialog.className='album-dialog';
    this.dialog.setAttribute('aria-label','Фотоальбом');
    this.controls=document.createElement('div');this.controls.className='album-controls';
    this.dialog.append(this.canvas,this.controls);document.body.append(this.dialog);
    this.dialog.oncancel=e=>{e.preventDefault();this.close();};
    this.world=new T.Scene();this.world.background=new T.Color(0x101417);
    this.camera=new T.PerspectiveCamera(60,1,.02,20);
    this.texture=new T.CanvasTexture(this.canvas);this.texture.colorSpace=T.SRGBColorSpace;
    this.texture.generateMipmaps=false;this.texture.minFilter=T.LinearFilter;
    this.board=new T.Mesh(new T.PlaneGeometry(2.16,2.16*H/W),new T.MeshBasicMaterial({map:this.texture,toneMapped:false}));
    this.world.add(this.board);
    this.ray=new T.Raycaster();this.rotation=new T.Quaternion();this.direction=new T.Vector3();
    this.pointers=Array.from({length:2},()=>{
      const geometry=new T.BufferGeometry();
      geometry.setAttribute('position',new T.BufferAttribute(new Float32Array(6),3));
      const line=new T.Line(geometry,new T.LineBasicMaterial({color:0xe2c79d}));
      line.frustumCulled=false;
      const dot=new T.Mesh(new T.SphereGeometry(.008,10,8),new T.MeshBasicMaterial({color:0xffffff}));
      this.world.add(line,dot);return {line,dot};
    });
  }
  async open(immersive){
    const ticket=++this.version;
    this.visible=true;this.opening=false;this.place=true;this.immersive=immersive;
    this.mode='loading';this.message='Загружаю фотографии…';this.hover=-1;
    if(immersive)this.dialog.close();else if(!this.dialog.open)this.dialog.showModal();
    this.draw();
    try{
      const catalog=await api('catalog');
      if(ticket!==this.version)return;
      this.name=catalog.name;this.photos=catalog.photos;
      this.page=Math.min(this.page,Math.max(0,Math.ceil(this.photos.length/PAGE)-1));
      this.showPage();
    }catch(e){
      if(ticket!==this.version)return;
      if(e.status===401){this.mode='pair';this.digits='';this.message='Откройте на Mac 127.0.0.1:8765/vr/album/code';this.draw();}
      else this.error(e.message);
    }
  }
  async digit(key){
    if(key==='Стереть'){this.digits=this.digits.slice(0,-1);this.draw();return;}
    this.digits+=key;this.draw(false);
    if(this.digits.length!==6)return;
    const ticket=this.version;
    const code=this.digits;this.mode='loading';this.message='Подключаю шлем…';this.draw();
    try{
      await api('pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
      if(ticket===this.version)this.open(this.immersive);
    }catch(e){if(ticket===this.version){this.mode='pair';this.digits='';this.message=e.message;this.draw();}}
  }
  close(committed=false){
    if(this.opening && !committed)this.onCancel();
    this.version++;this.visible=false;this.opening=false;this.dialog.close();
  }
  error(message){if(this.opening)this.onCancel();this.opening=false;this.mode='error';this.message=message;this.draw();}
  showPage(){
    if(this.opening)this.onCancel();
    this.version++;this.opening=false;this.mode='list';this.selected=null;this.hover=-1;
    const items=this.photos.slice(this.page*PAGE,(this.page+1)*PAGE);
    for(const id of this.images.keys())if(!items.some(p=>p.id===id))this.images.delete(id);
    for(const photo of items){
      if(this.images.has(photo.id))continue;
      const img=new Image();this.images.set(photo.id,img);
      img.onload=()=>{if(this.visible&&this.images.get(photo.id)===img)this.draw(false);};
      img.src='./album/thumb/'+photo.id;
    }
    this.draw();
  }
  async choose(photo){
    const ticket=++this.version;
    this.selected=photo;this.mode='progress';this.message='Отправляю выбор…';this.draw();
    try{
      let job=await api('select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:photo.id})});
      while(ticket===this.version){
        if(job.state==='error'||job.state==='idle')throw Error(job.message||'Попробуйте выбрать фото ещё раз.');
        if(job.state==='ready'){
          photo.ready=true;this.opening=true;this.message=stages.opening;this.draw();
          this.onScene(photo,job);return;
        }
        this.message=stages[job.state]||'Подготавливаю сцену…';this.draw(false);
        await pause(800);
        if(ticket!==this.version)return;
        job=await api('status/'+photo.id);
      }
    }catch(e){if(ticket===this.version)this.error(e.message);}
  }
  draw(rebuild=true){
    const c=this.ctx;
    c.fillStyle='#19211f';c.fillRect(0,0,W,H);
    const text=(str,x,y,size,color='#f6f3ea',max=W-100)=>{
      c.fillStyle=color;c.font='500 '+size+'px system-ui';c.fillText(str,x,y,max);
    };
    this.buttons=[];
    const button=(label,x,y,w,h,action,card=false)=>{
      const i=this.buttons.length;this.buttons.push({label,x,y,w,h,action});
      c.fillStyle=i===this.hover?'#48564a':'#303c35';c.beginPath();c.roundRect(x,y,w,h,15);c.fill();
      if(!card)text(label,x+20,y+h*.65,29);
    };
    text(this.name||'Фотоальбом',48,73,49);
    button('Закрыть',1210,27,180,62,()=>this.close());
    if(this.mode==='list'){
      const count=Math.ceil(this.photos.length/PAGE);
      const items=this.photos.slice(this.page*PAGE,(this.page+1)*PAGE);
      if(!items.length)text('В папке пока нет поддерживаемых фотографий.',48,320,33);
      items.forEach((photo,i)=>{
        const x=48+(i%3)*454,y=116+Math.floor(i/3)*307,w=434,h=286;
        button(photo.name,x,y,w,h,()=>this.choose(photo),true);
        const image=this.images.get(photo.id);
        if(image?.complete&&image.naturalWidth){
          const scale=Math.min((w-12)/image.width,(h-60)/image.height);
          const iw=image.width*scale,ih=image.height*scale;
          c.drawImage(image,x+(w-iw)/2,y+5+(h-60-ih)/2,iw,ih);
        }
        text(photo.name,x+14,y+h-17,26,'#f3f0e7',w-(photo.ready?90:28));
        if(photo.ready)text('3D',x+w-53,y+h-17,23,'#b9ddb5');
      });
      if(this.page>0)button('Назад',48,762,170,66,()=>{this.page--;this.showPage();});
      if(this.page+1<count)button('Дальше',1220,762,170,66,()=>{this.page++;this.showPage();});
      if(count)text((this.page+1)+' / '+count,646,807,31);
      text('Наведите луч и нажмите курок. Боковая кнопка захвата открывает альбом.',48,869,23,'#bbccbd');
    }else if(this.mode==='pair'){
      text('Введите код с Mac',48,176,42);
      text(this.message,48,235,31);
      text(this.digits.padEnd(6,'·').split('').join('  '),48,327,55);
      ['1','2','3','4','5','6','7','8','9','0','Стереть'].forEach((key,i)=>{
        button(key,48+(i%4)*340,410+Math.floor(i/4)*120,300,94,()=>this.digit(key));
      });
    }else{
      const img=this.images.get(this.selected?.id);
      if(img?.complete&&img.naturalWidth){
        const scale=Math.min(750/img.width,405/img.height);
        c.drawImage(img,(W-img.width*scale)/2,143,img.width*scale,img.height*scale);
      }
      if(this.selected)text(this.selected.name,48,615,36);
      text(this.message,48,this.selected?675:340,32);
      if(this.selected)button('К фотографиям',48,760,286,72,()=>this.showPage());
      if(this.mode==='error')button('Повторить',1000,760,270,72,()=>this.selected?this.choose(this.selected):this.open(this.immersive));
    }
    if(this.hover>=0&&this.buttons[this.hover]){
      const {x,y,w,h}=this.buttons[this.hover];
      c.strokeStyle='#e5ca9e';c.lineWidth=5;c.beginPath();c.roundRect(x,y,w,h,15);c.stroke();
    }
    this.texture.needsUpdate=true;
    if(rebuild&&!this.immersive){
      this.controls.replaceChildren(...this.buttons.map(({label,x,y,w,h,action})=>{
        const b=document.createElement('button');b.type='button';b.setAttribute('aria-label',label);
        Object.assign(b.style,{left:100*x/W+'%',top:100*y/H+'%',width:100*w/W+'%',height:100*h/H+'%'});
        b.onclick=action;return b;
      }));
    }
  }
  point(frame,source,space,pointer){
    const pose=frame.getPose(source.targetRaySpace,space);
    if(!pose)return -1;
    this.ray.ray.origin.copy(pose.transform.position);
    this.ray.ray.direction.set(0,0,-1).applyQuaternion(this.rotation.copy(pose.transform.orientation));
    const hit=this.ray.intersectObject(this.board,false)[0];
    if(pointer){
      const end=hit?.point||this.ray.ray.at(1.4,this.direction);
      const a=pointer.line.geometry.attributes.position;
      a.setXYZ(0,...this.ray.ray.origin.toArray());a.setXYZ(1,end.x,end.y,end.z);a.needsUpdate=true;
      pointer.line.visible=true;pointer.dot.visible=!!hit;pointer.dot.position.copy(end);
    }
    if(!hit)return -1;
    const x=hit.uv.x*W,y=(1-hit.uv.y)*H;
    return this.buttons.findIndex(b=>x>=b.x&&x<=b.x+b.w&&y>=b.y&&y<=b.y+b.h);
  }
  select(event,space){
    if(this.place)return;
    const index=this.point(event.frame,event.inputSource,space);
    this.buttons[index]?.action();
  }
  render(renderer,frame,pose){
    const space=renderer.xr.getReferenceSpace();
    if(this.place){
      this.rotation.copy(pose.transform.orientation);
      const forward=this.direction.set(0,0,-1).applyQuaternion(this.rotation);
      const yaw=Math.atan2(-forward.x,-forward.z);
      this.board.rotation.set(0,yaw,0);
      this.board.position.set(0,-.05,-1.7).applyQuaternion(this.board.quaternion).add(pose.transform.position);
      this.board.updateMatrixWorld(true);this.place=false;
    }
    for(const p of this.pointers)p.line.visible=p.dot.visible=false;
    let hover=-1,i=0;
    for(const source of frame.session.inputSources){
      if(i===2)break;
      const hit=this.point(frame,source,space,this.pointers[i++]);
      if(hit>=0)hover=hit;
    }
    if(hover!==this.hover){this.hover=hover;this.draw(false);}
    renderer.render(this.world,this.camera);
  }
}
