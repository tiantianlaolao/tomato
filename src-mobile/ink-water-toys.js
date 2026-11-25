(() => {
 const prefKey='capy_ink_companion_v1';
 let saved='';try{saved=localStorage.getItem(prefKey)||''}catch{}
 let kind=['boat','turtle'].includes(saved)?saved:'', prop,engine,held=false,dir=1,x=.6,y=.91,t=0,previous=0;
 // Reserve space for the entire rotating toy, reflection and drift on each side.
 const footprint=.10;
 function limits(){
  const item=window.RW?.view?.state?.placed?.water_near;
  const occupied=item==='lotus'?.41:item==='koi'?.425:0;
  return {left:occupied+footprint+.015,right:1-footprint-.012}
 }
 function bounded(value){const b=limits();return Math.max(b.left,Math.min(b.right,value))}
 function reset(){x=.62;y=.91;t=0;dir=-1}
 function frameRect(){
  const [left,top]=engine.map(0,0),[right,bottom]=engine.map(1,1),d=engine.DPR;
  return {left:left/d,top:top/d,width:(right-left)/d,height:(bottom-top)/d};
 }
 function mount(scene){
  engine=scene;prop=document.createElement('canvas');prop.width=340;prop.height=260;engine.root.append(prop);prop.hidden=true;prop.setAttribute('role','img');
  prop.style.cssText='position:absolute;z-index:2;width:16%;transform-origin:50% 85%;touch-action:none;user-select:none;cursor:grab';
  prop.onpointerdown=e=>{e.preventDefault();e.stopPropagation();held=true;prop.setPointerCapture(e.pointerId)};
  prop.onpointermove=e=>{if(!held)return;const r=engine.root.getBoundingClientRect();const f=frameRect();x=bounded((e.clientX-r.left-f.left)/f.width);y=Math.max(.855,Math.min(.946,(e.clientY-r.top-f.top)/f.height));t=0};
  prop.onpointerup=prop.onpointercancel=()=>held=false;prop.onlostpointercapture=()=>held=false;
  prop.onclick=e=>e.stopPropagation();requestAnimationFrame(frame);
 }
 function frame(now){
  requestAnimationFrame(frame);const dt=Math.min(.05,(now-previous)/1000);previous=now;
  prop.hidden=!kind||!engine.running||engine.scene?.id!=='ink'||document.hidden||engine.fog.classList.contains('on')||document.body.classList.contains('sheeton')||!['loop_soak','loop_work','loop_nap','loop_eat','loop_empty','loop_urge'].includes(engine.seg);
  if(prop.hidden)return;
  prop.dataset.kind=kind;prop.setAttribute('aria-label',kind==='turtle'?'小草龟':'柳叶舟');
  paintToy(prop,kind,now/1000,x,y);
  x=bounded(x);if(!held){t+=dt;if(kind==='turtle'){const next=x+dt*dir*.040;x=bounded(next);if(x!==next)dir=-dir}}
  const f=frameRect();prop.style.width=f.width*.16+'px';
  prop.style.left=f.left+f.width*bounded(x+(kind==='boat'?.018*Math.sin(t*.45):0))+'px';
  prop.style.top=f.top+f.height*(y+.003*Math.sin(t))+'px';
  prop.style.transform='translate(-50%,-64%) rotate('+Math.sin(t*1.5)*2+'deg) scaleX('+(kind==='turtle'?-dir:1)+')';
 }
 const bodies={},images={};
 for(const name of ['boat','turtle']){
  const im=new Image();images[name]=im;
  im.onload=()=>{
   // Trace only the hull and head/shell: no surrounding original pool pixels.
   const path=name==='boat'?[[56,177],[63,177],[85,188],[111,184],[139,183],[160,176],[187,175],[185,160],[157,158],[121,170],[129,150],[132,133],[145,103],[171,72],[192,45],[197,26],[202,27],[203,39],[210,83],[211,106],[205,138],[197,160],[192,173],[220,169],[251,168],[276,159],[291,157],[288,162],[277,178],[265,195],[247,209],[217,215],[164,220],[107,217],[86,208]]:[[76,67],[81,45],[93,39],[109,41],[126,47],[145,48],[155,57],[167,44],[194,32],[215,25],[244,23],[267,26],[291,35],[314,51],[329,64],[345,69],[335,79],[285,89],[228,91],[164,86],[119,86],[90,82]];
   const c=document.createElement('canvas');c.width=im.width;c.height=im.height;
   const g=c.getContext('2d');g.beginPath();for(const [x,y] of path)g.lineTo(x,y);g.closePath();g.clip();g.drawImage(im,0,0);bodies[name]=c
  };im.src='assets/ink-courtyard/'+name+'.webp'
 }
 function paintToy(canvas,name,time,x,y){
  const body=bodies[name],g=canvas.getContext('2d'),surface=window.yardMotion?.surface;
  g.clearRect(0,0,340,260);if(!body)return;
  const turtle=name==='turtle',src=turtle?[73,21,276,72]:[54,25,242,196];
  const width=turtle?227:186,height=turtle?58:149,cx=170,line=161+2*Math.sin(time*1.8),left=cx-width/2;
  // Reflect the exposed body into the local moving water. Successive ripples
  // break the reflection horizontally; its opacity falls off with depth.
  for(let j=0;j<height*.55;j+=2){
   const u=j/(height*.55),shift=(2+9*u)*Math.sin(time*2.2-j*.28);
   g.globalAlpha=(turtle?.23:.37)*(1-u)*(.55+.45*Math.sin(time*2+j*.37)**2);
   g.drawImage(body,src[0],src[1]+(1-u)*(src[3]-3),src[2],2,left+shift,line+j,width,2.25)
  }
  g.globalAlpha=1;g.drawImage(body,...src,left,line-height,width,height);
  if(surface){
   for(let j=0;j<5;j++){
    const wave=Math.sin(time*1.9+j*.9),yrow=line-4+j*1.25+wave;
    g.globalAlpha=.15+.10*j;
    g.drawImage(surface,Math.max(0,x*720-43),y*1280+wave*2+j,86,1,left+2*Math.sin(j+time),yrow,width,1.5)
   }
  }
  g.globalAlpha=1;
  for(let i=0;i<2;i++){const f=(time*.43+i*.5)%1;g.strokeStyle='rgba(238,212,152,'+(.18*(1-f))+')';g.lineWidth=1.15;g.beginPath();g.ellipse(cx,line+2,width*(.47+f*.22),4+f*13,-.015,.08,Math.PI-.18);g.stroke()}
 }

 function garden(body){
  const section=document.createElement('section');section.className='water-toy-garden';
  const h=document.createElement('h3');h.textContent='水面小陪伴';section.append(h);const row=document.createElement('div');row.className='water-toy-options';section.append(row);
  for(const [value,title] of [['','不放小物'],['turtle','小草龟'],['boat','柳叶舟']]){
   const b=document.createElement('button');b.className='btn';b.textContent=title;b.setAttribute('aria-pressed',kind===value);
   b.onclick=()=>{kind=value;try{localStorage.setItem(prefKey,kind)}catch{}reset();for(const v of row.children)v.setAttribute('aria-pressed',v===b)};row.append(b)
  }body.append(section)
 }
 window.InkWaterToys={mount,garden};
})();
