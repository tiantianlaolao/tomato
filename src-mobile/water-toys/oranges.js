// Adapted from the accepted glasshouse v2, with its corrected water boundary.
export function create(env){
const W=941,H=1672,canvas=env.canvas,ctx=canvas.getContext('2d'),hint={textContent:''};let video=env.video();
const make=(w=1,h=1)=>{let c=document.createElement('canvas');c.width=w;c.height=h;return {c,x:c.getContext('2d',{willReadFrequently:true})}};
const effect=make(),mask=make(220,180),sample=make(220,180),sprite=make(160,160),patch=make(192,80),patchSrc=make(192,80);
let t=0,last=performance.now(),mediaTime=0,maskTime=-1,ready=false,close=false,hidden=false,drag=null,crop=0,cropH=H;
const fruits=[{id:0,x:.76,y:.77,r:29,leaf:true,phase:.7},{id:1,x:.80,y:.735,r:26,leaf:false,phase:3}].map(a=>({...a,vx:0,vy:0,height:0,vh:0,mode:'float',route:[],splashes:0}));
const poolTest=make().x;const ripples=[],drops=[];const P=new Path2D();
// Trace the water-facing rock edge, including the foreground protrusions.
const bank=[[.145,.684],[.18,.665],[.25,.651],[.34,.636],[.43,.624],[.57,.617],[.70,.618],[.82,.625],[.98,.637],[.985,.823],[.91,.816],[.85,.820],[.79,.812],[.74,.814],[.70,.804],[.67,.797],[.60,.795],[.55,.795],[.51,.786],[.46,.777],[.41,.776],[.36,.776],[.32,.764],[.29,.746],[.26,.735],[.22,.732],[.20,.719],[.16,.708]];
bank.forEach(([x,y],i)=>i?P.lineTo(x*W,y*H):P.moveTo(x*W,y*H));P.closePath();
function valid(x,y,r=28){if(!env.inView(x,y,W,H,r+8))return false;if(!poolTest.isPointInPath(P,x*W,y*H))return false;for(let i=0;i<24;i++){let angle=i*Math.PI/12,rx=r*1.2+7,ry=r*.62+5;if(!poolTest.isPointInPath(P,x*W+Math.cos(angle)*rx,y*H+Math.sin(angle)*ry))return false}return true}
function fit(x,y,old,r=28){if(!valid(old.x,old.y,r))old=env.clampPoint(.77,.745,W,H,r+8);if(valid(x,y,r))return {x,y};let a=0,b=1;for(let i=0;i<20;i++){let q=(a+b)/2;if(valid(old.x+(x-old.x)*q,old.y+(y-old.y)*q,r))a=q;else b=q}return{x:old.x+(x-old.x)*a,y:old.y+(y-old.y)*a}}
function size(a){return a.mode==='held'?drag.radius:a.r*(.80+(a.y-.65)*1.9)}
function bob(a){return a.mode==='held'?drag.bob:Math.sin(t*1.8+a.phase)*1.0}
function screen(a){return env.screen(a.x,(a.y*H-a.height*H-size(a)*.44+bob(a))/H,W,H);}
// Limit segmentation to the original animal's region; retain only the largest
// connected warm-fur component so gold water reflections cannot occlude fruit.
const roi={x:.365*W,y:.582*H,w:.35*W,h:.135*H};
function updateMask(){if(maskTime===mediaTime)return;maskTime=mediaTime;let w=220,h=180;sample.x.drawImage(video,roi.x*video.videoWidth/W,roi.y*video.videoHeight/H,roi.w*video.videoWidth/W,roi.h*video.videoHeight/H,0,0,w,h);let d=sample.x.getImageData(0,0,w,h),a=d.data,seen=new Uint8Array(w*h),best=[];
for(let i=0;i<w*h;i++){let k=i*4;seen[i]=(a[k]>a[k+1]*1.18&&a[k]>a[k+2]*1.32&&a[k]-a[k+1]>18)?1:0}
for(let i=0;i<w*h;i++){if(seen[i]!==1)continue;let q=[i];seen[i]=2;for(let j=0;j<q.length;j++){let n=q[j],x=n%w;for(let v of [x>0?n-1:-1,x<w-1?n+1:-1,n-w,n+w])if(v>=0&&v<w*h&&seen[v]===1){seen[v]=2;q.push(v)}}if(q.length>best.length)best=q}
let keep=new Uint8Array(w*h);for(let i of best)keep[i]=1;
for(let i=0;i<w*h;i++){a[i*4]=a[i*4+1]=a[i*4+2]=0;a[i*4+3]=keep[i]?255:0}mask.x.putImageData(d,0,0)}
function cut(c){c.save();c.globalCompositeOperation='destination-out';c.drawImage(mask.c,roi.x,roi.y,roi.w,roi.h);c.restore()}
function waterClip(c){c.save();c.globalCompositeOperation='destination-in';c.fillStyle='#fff';c.fill(P);c.restore();cut(c)}
function drawOrange(c,a,x,y,r,submerged=true){c.save();c.translate(x,y);c.rotate(Math.sin(t*.9+a.phase)*.055);if(submerged){c.beginPath();c.rect(-r*1.3,-r*1.4,r*2.6,r*1.95);c.clip()}
c.scale(1,.90);let g=c.createRadialGradient(-r*.3,-r*.38,r*.05,r*.07,r*.08,r*1.1);g.addColorStop(0,a.id?'#edb655':'#f1bd62');g.addColorStop(.38,a.id?'#d99035':'#e3a044');g.addColorStop(.76,'#bd702c');g.addColorStop(1,'#755638');c.fillStyle=g;c.beginPath();c.arc(0,0,r,0,Math.PI*2);c.fill();c.save();c.clip();
// Fixed pores are attached to the peel, not random pixels changing per frame.
for(let i=0;i<210;i++){let angle=i*2.399963,rr=Math.sqrt((i+.5)/210)*r,px=Math.cos(angle)*rr,py=Math.sin(angle)*rr;c.fillStyle=i%3?'rgba(107,65,28,.15)':'rgba(255,221,139,.22)';c.beginPath();c.ellipse(px,py,.45+rr/r*.22,.45,0,0,7);c.fill()}c.restore();
c.fillStyle='#735535';c.beginPath();c.ellipse(-r*.04,-r*.70,r*.10,r*.045,-.2,0,7);c.fill();c.strokeStyle='#69623b';c.lineWidth=r*.065;c.beginPath();c.moveTo(0,-r*.70);c.lineTo(r*.025,-r*.84);c.stroke();if(a.leaf){c.fillStyle='#6b7944';c.beginPath();c.moveTo(0,-r*.77);c.quadraticCurveTo(r*.35,-r*1.04,r*.46,-r*.73);c.quadraticCurveTo(r*.23,-r*.60,0,-r*.77);c.fill();c.strokeStyle='#969768';c.lineWidth=.7;c.beginPath();c.moveTo(0,-r*.77);c.lineTo(r*.35,-r*.77);c.stroke()}
if(submerged){c.globalCompositeOperation='source-atop';let wet=c.createLinearGradient(0,r*.22,0,r*.67);wet.addColorStop(0,'rgba(65,109,99,0)');wet.addColorStop(1,'rgba(65,109,99,.45)');c.fillStyle=wet;c.fillRect(-r,r*.2,r*2,r*.55)}c.restore()}
function ring(c,x,y,r,alpha){c.strokeStyle=`rgba(229,211,153,${alpha})`;c.lineWidth=1.25;for(let j=0;j<4;j++){c.beginPath();c.ellipse(x,y,r,r*.30,0,j*1.57+.12,j*1.57+1.15);c.stroke()}}
function water(a){let c=effect.x,r=size(a),x=a.x*W,y=a.y*H;setup(c);
// A small feathered warp samples the original water only, away from the capy.
if(a.mode==='float'&&(a.x>.76||a.y>.735)){let ww=r*4,hh=r*1.7;patchSrc.x.drawImage(video,(x-ww/2)*video.videoWidth/W,(y-hh/2)*video.videoHeight/H,ww*video.videoWidth/W,hh*video.videoHeight/H,0,0,192,80);patch.x.clearRect(0,0,192,80);for(let row=0;row<80;row+=4)patch.x.drawImage(patchSrc.c,0,row,192,4,Math.sin(row*.2-t*2)*1.2,row,192,4);patch.x.save();patch.x.globalCompositeOperation='destination-in';patch.x.translate(96,40);patch.x.scale(1,.42);let g=patch.x.createRadialGradient(0,0,18,0,0,94);g.addColorStop(0,'#fff');g.addColorStop(1,'#fff0');patch.x.fillStyle=g;patch.x.fillRect(-96,-96,192,192);patch.x.restore();c.drawImage(patch.c,x-ww/2,y-hh/2,ww,hh)}
c.save();c.translate(x,y);c.scale(1,.30);let sh=c.createRadialGradient(0,0,2,0,0,r*1.25);sh.addColorStop(0,`rgba(33,65,56,${a.mode==='held'?.1:.27})`);sh.addColorStop(1,'#21413800');c.fillStyle=sh;c.fillRect(-r*1.3,-r*1.3,r*2.6,r*2.6);c.restore();
if(a.height<.035){c.save();c.globalAlpha=.19*(1-a.height/.035);c.translate(x,y+3);c.scale(1,-.34);c.filter='blur(1px)';drawOrange(c,a,0,-r*.44,r,false);c.restore()}
if(a.mode==='float'){ring(c,x,y+bob(a)+1,r*.95,.30);ring(c,x,y+3,r*1.55,.11)}waterClip(c);ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(effect.c,0,0)}
function splash(a){if(!valid(a.x,a.y,a.r))return;a.splashes++;ripples.push({x:a.x*W,y:a.y*H,born:t});for(let i=0;i<14;i++){let angle=i*2.4;drops.push({x:a.x*W,y:a.y*H,z:0,vx:Math.cos(angle)*50,vy:Math.sin(angle)*15,vz:85+(i%4)*14,life:.6})}}
function reset(){drag=null;for(let [i,a] of fruits.entries())Object.assign(a,{x:i?.80:.76,y:i?.735:.77,height:0,vh:0,vx:0,vy:0,mode:'float',route:[]});hint.textContent='两颗橙子都可以拿起，松手落水'}
env.on('pointerdown',e=>{video.play().catch(()=>{});if(!ready||hidden||drag)return;let hits=fruits.map(a=>({a,s:screen(a)})).map(o=>({...o,d:Math.hypot(e.clientX-o.s.x,e.clientY-o.s.y)})).sort((a,b)=>a.d-b.d),a=hits[0].a;if(hits[0].d>32)return;let q=pointer(e);drag={id:e.pointerId,a,dx:a.x-q.x,dy:a.y-q.y,radius:size(a),bob:bob(a),last:{x:a.x,y:a.y},at:performance.now()};a.mode='held';a.vx=a.vy=a.vh=0;a.route=[];canvas.setPointerCapture(e.pointerId);e.preventDefault();hint.textContent='按住的位置不变，松手放回水里'});
env.on('pointermove',e=>{if(!drag||e.pointerId!==drag.id)return;e.preventDefault();let a=drag.a,q=pointer(e),v=fit(q.x+drag.dx,q.y+drag.dy,a,a.r),now=performance.now(),dt=Math.max(.016,(now-drag.at)/1000);a.vx=Math.max(-.08,Math.min(.08,(v.x-drag.last.x)/dt*.16));a.vy=Math.max(-.045,Math.min(.045,(v.y-drag.last.y)/dt*.16));Object.assign(a,v);drag.last=v;drag.at=now});
function release(e){if(!drag||drag.id!==e.pointerId)return;let a=drag.a;if(performance.now()-drag.at>100||e.type!=='pointerup')a.vx=a.vy=0;drag=null;Object.assign(a,fit(a.x,a.y,{x:.77,y:.745},a.r));a.mode='air';a.vh=-.06;if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId)}for(let n of ['pointerup','pointercancel','lostpointercapture'])env.on(n,release);
function frame(now){let dt=Math.min(.035,(now-last)/1000);last=now;t+=dt;if(!ready)return;if(!video.requestVideoFrameCallback)mediaTime=video.currentTime;
for(let a of fruits){if(a.mode==='held'){let requested=(.03-a.height)*Math.min(1,dt*12),ground=fit(a.x,a.y+requested,a,a.r),lift=ground.y-a.y;a.height+=lift;a.y=ground.y;drag.dy+=lift;drag.last.y+=lift;continue}if(a.mode==='air'){a.vh-=.8*dt;a.height+=a.vh*dt;if(a.height<=0){a.height=-.002;a.mode='float';a.vh=-a.vh*.14;splash(a)}}else{a.vh+=(-a.height*50-a.vh*9)*dt;a.height+=a.vh*dt;if(a.route.length){let q=a.route[0],dx=q.x-a.x,dy=q.y-a.y,d=Math.hypot(dx,dy);if(d<dt*.05){a.x=q.x;a.y=q.y;a.route.shift();a.vx=a.vy=0}else{a.vx=dx/d*.05;a.vy=dy/d*.05}}else{a.vx=(a.vx+Math.sin(t*.7+a.phase)*dt*.0004)*Math.exp(-dt*2.5);a.vy=(a.vy+Math.cos(t*.9+a.phase)*dt*.0002)*Math.exp(-dt*2.5)}}Object.assign(a,fit(a.x+a.vx*dt,a.y+a.vy*dt,a,a.r))}
let [a,b]=fruits;if(a.mode==='float'&&b.mode==='float'){let dx=(b.x-a.x)*W,dy=(b.y-a.y)*H*2.2,d=Math.hypot(dx,dy),min=(size(a)+size(b))*.95;if(d<min){let nx=d>0?dx/d:1,ny=d>0?dy/d:0,move=Math.min(min-d,60*dt)*.5;Object.assign(a,fit(a.x-nx*move/W,a.y-ny*move/H/2.2,a,a.r));Object.assign(b,fit(b.x+nx*move/W,b.y+ny*move/H/2.2,b,b.r))}}
setup(ctx);if(hidden)return;updateMask();for(let a of fruits)water(a);
setup(effect.x);for(let i of ripples){let age=t-i.born;if(age<3)ring(effect.x,i.x,i.y,10+age*60,(1-age/3)*.34)}waterClip(effect.x);ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(effect.c,0,0);while(ripples.length&&t-ripples[0].born>3)ripples.shift();
for(let a of [...fruits].sort((a,b)=>(a.mode==='held'?2:a.y)-(b.mode==='held'?2:b.y))){setup(effect.x);drawOrange(effect.x,a,a.x*W,a.y*H-a.height*H-size(a)*.44+bob(a),size(a),a.mode==='float');if(a.mode!=='held'&&a.y<.697)cut(effect.x);ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(effect.c,0,0)}
setup(effect.x);for(let d of drops){d.life-=dt;if(d.life<=0)continue;d.vz-=360*dt;d.z+=d.vz*dt;d.x+=d.vx*dt;d.y+=d.vy*dt;effect.x.fillStyle=`rgba(235,222,173,${Math.min(.8,d.life*2)})`;effect.x.beginPath();effect.x.ellipse(d.x,d.y-d.z,1.5,2.7,0,0,7);effect.x.fill()}waterClip(effect.x);ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(effect.c,0,0);while(drops.length&&drops[0].life<=0)drops.shift()}


function setup(c){env.setup(c,W,H);}
function pointer(e){return env.pointer(e,W,H);}
function resize(){env.resize();if(effect.c.width!==canvas.width||effect.c.height!==canvas.height){effect.c.width=canvas.width;effect.c.height=canvas.height;}}
function state(){return fruits.map(a=>({x:a.x,y:a.y-(a.mode==='held'?a.height:0)}));}
function restore(points){drag=null;fruits.forEach((a,i)=>{const p=points?.[i]||a;if(p&&Number.isFinite(p.x)&&Number.isFinite(p.y)){const q=fit(p.x,p.y,{x:i?.80:.76,y:i?.735:.77},a.r);Object.assign(a,q);}a.height=a.vh=a.vx=a.vy=0;a.mode='float';if(a.route)a.route=[];a.target=null;});}
return {tick(now){video=env.video();resize();ready=video?.readyState>=2;if(!ready){env.clear();return;}mediaTime=env.engine.vt>=0?env.engine.vt:video.currentTime;;frame(now);},ready:()=>ready,state,restore,reset,screen:()=>fruits.map(screen),valid,
 suspend(){restore(state());ripples.length=drops.length=0;last=performance.now();maskTime=-1;},dispose(){}};
}
