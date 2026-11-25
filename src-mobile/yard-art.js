/* All samples, including the clean courtyard used when withdrawing an item,
   come from playing footage. Default furnished idle is one full-frame take. */
window.YardArt=(()=>{
 const media=new Map(), masks=new Map();
 const rects={
  plaque:[.875,.207,.989,.446],bell:[.584,.141,.696,.263],
  title:[.123,.278,.46,.354],cloth:[.163,.34,.426,.47],
  shore:[.12,.421,.313,.557],smoke:[.23,.495,.351,.602],
  tray:[.326,.51,.53,.586],water:[0,.792,1,1],
  actor:[.202,.601,.832,.822],route:[.185,.472,.861,.83],
 };
 const mint=(w,h)=>Object.assign(document.createElement('canvas'),{width:w,height:h});
 function film(name){
  if(!media.has(name)){
   const v=document.createElement('video');v.muted=true;v.defaultMuted=true;v.playsInline=true;v.loop=true;v.preload='auto';
   AS.setVideoSource(v,'assets/ink-courtyard/'+name+'-loop.mp4',true);media.set(name,v);
  }
  const v=media.get(name);
  if(Scene.running && !document.hidden && !Scene.frozen && v.paused && !v.pendingPlay){
   v.pendingPlay=true;v.play().catch(()=>{}).finally(()=>{v.pendingPlay=false});
  }else if(Scene.frozen && !v.paused)v.pause();
  return v
 }
 function pause(){for(const v of media.values())v.pause()}
 // Each replacement retains full motion and uses a soft, stationary join.
 function patch(key,source,c){
  if(!source||source.readyState<2)return;
  const [x,y,r,b]=rects[key];
  if(!masks.has(key)){
   const w=Math.ceil((r-x)*720),h=Math.ceil((b-y)*1280),mask=mint(w,h),m=mask.getContext('2d');
   const edge=key==='route'||key==='actor'?20:10;
   m.filter='blur('+edge/2+'px)';m.fillRect(x===0?-edge:edge,y===0?-edge:edge,w+(x===0?edge:0)+(r===1?edge:0)-(x===0?0:edge)-(r===1?0:edge),h+(b===1?edge:0)-edge-(b===1?0:edge));
   masks.set(key,{mask,scratch:mint(w,h)})
  }
  const {mask,scratch}=masks.get(key),s=scratch.getContext('2d'),w=scratch.width,h=scratch.height;
  s.globalCompositeOperation='copy';s.drawImage(source,x*source.videoWidth,y*source.videoHeight,(r-x)*source.videoWidth,(b-y)*source.videoHeight,0,0,w,h);
  s.globalCompositeOperation='destination-in';s.drawImage(mask,0,0);
  c.drawImage(scratch,x*720,y*1280,(r-x)*720,(b-y)*1280)
 }
 const surface=mint(720,1280),painter=surface.getContext('2d'),prints={};
 function threadwork(id,time){
  if(!id||id==='t01'||id==='t06')return;
  if(!prints[id]){const img=new Image();img.src='assets/p3/ink/'+id+'.png';prints[id]=img}
  const img=prints[id];if(!img.naturalWidth)return;
  const frames=clothMotion.lotus;if(!frames?.length)return;
  const q=frames[Math.min(frames.length-1,Math.floor(film('lotus').currentTime*24))],[a,b,c,d]=q;
  painter.save();painter.beginPath();for(const [x,y] of q)painter.lineTo(x,y);
  painter.closePath();painter.clip();painter.globalCompositeOperation='multiply';painter.globalAlpha=.58;
  for(let i=0;i<20;i++){
   const u=i/20,top=[a[0]+u*(b[0]-a[0]),a[1]+u*(b[1]-a[1])],base=[d[0]+u*(c[0]-d[0]),d[1]+u*(c[1]-d[1])];
   painter.save();painter.transform((b[0]-a[0])/20,(b[1]-a[1])/20,base[0]-top[0],base[1]-top[1],...top);
   painter.drawImage(img,(.2+.57*u)*img.width,.12*img.height,.57*img.width/20,.76*img.height,0,0,1.02,1);painter.restore()
  }painter.restore()
 }
 function render(engine,ctx,phase,state){
  const p=state?.placed||{},water=p.water_near,native=water==='koi'||(!water&&p.floor_mid==='teatray')?'koi':'lotus';
  const room=film(native),clean=engine.cur(),ready=v=>v?.readyState>=2;
  if(!ready(room))return;
  painter.drawImage(room,0,0,720,1280);
  if(phase!=='idle'||!p.wall)patch('title',clean,painter);
  if(!p.willow)patch('bell',clean,painter);
  if(!p.pool_edge)patch('smoke',clean,painter);
  if(!p.lamp_side)patch('shore',clean,painter);
  else if((p.lamp_side==='orchid')!==(native==='lotus'))patch('shore',film(native==='lotus'?'koi':'lotus'),painter);
  if(native==='koi'&&!p.floor_mid)patch('tray',clean,painter);
  if(native==='lotus'&&p.floor_mid==='teatray')patch('tray',film('koi'),painter);
  if(!state?.hung)patch('cloth',clean,painter);
  else if((state.hung==='t06')!==(native==='koi'))patch('cloth',film(native==='lotus'?'koi':'lotus'),painter);
  if(state?.hung)threadwork(state.hung,room.currentTime);
  if(state?.guest_towel){
   painter.save();painter.translate(204,280);painter.scale(.52,.52);painter.translate(-125,-441);
   patch('cloth',film(state.guest_towel==='t06'?'koi':'lotus'),painter);threadwork(state.guest_towel,room.currentTime);painter.restore()
  }
  if(!water)patch('water',clean,painter);
  if(phase!=='idle'&&ready(clean)){
   const bath=['loop_soak','loop_work','loop_urge'].includes(engine.seg);
   patch(bath?'actor':'route',clean,painter)
  }
  const [x,y]=engine.map(0,0),[r,b]=engine.map(1,1);
  ctx.drawImage(surface,x,y,r-x,b-y);
  const dim=engine.scene.dim[phase]||0;if(dim){ctx.fillStyle='rgba(8,6,4,'+dim+')';ctx.fillRect(x,y,r-x,b-y)}
  window.yardMotion={name:native,time:room.currentTime,surface}
 }
 render.pause=pause;return render;
})();
