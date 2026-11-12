// Local, optional garden decorations. They never grant theme entitlements or affect the timer.
(function(){
'use strict';
const KEY='capy_water_toys_v1';
const specs={onsen:{file:'duck',name:'小鸭子',note:'日系温泉泡汤时出现，离池时收起。'},glasshouse:{file:'oranges',name:'双橘子',note:'花房长休泡汤时出现，回房间时收起。'}};
let saved={};try{const value=JSON.parse(localStorage.getItem(KEY)||'{}');if(value&&typeof value==='object'&&!Array.isArray(value))saved=value;}catch(_){}
const records={},loading={},errors={};let canvas,engine,active=null,lastTick=0,saveAt=0,suppressClick=0,started=false;
function pref(id){const p=saved[id];return p&&typeof p==='object'?p:{};}
function write(){try{localStorage.setItem(KEY,JSON.stringify(saved));return true;}catch(_){return false;}}
function snapshot(){if(active){const p=pref(active.id);saved[active.id]={enabled:!!p.enabled,points:active.api.state()};write();}}
function suspend(){if(!active)return;snapshot();const old=active;active=null;old.api.suspend();for(const id of old.pointers){if(canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);}old.pointers.clear();engine.root.classList.remove('water-toy-active');clear();}
function clear(){if(canvas)canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);}
function dimensions(W,H){const r=canvas.getBoundingClientRect(),k=Math.max(canvas.width/W,canvas.height/H);return{r,k,x:(canvas.width-W*k)/2,y:(canvas.height-H*k)/2};}
function resize(){const r=engine.root.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,1.5),w=Math.round(r.width*d),h=Math.round(r.height*d);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}}
function allowed(id){
 if(document.hidden||document.body.classList.contains('sheeton')||engine.frozen||!engine.running||!engine.ready||engine.fog?.classList.contains('on')||engine.motionState?.moving)return false;
 if(performance.now()-(engine.swapAt||0)<550)return false;
 return id==='onsen'?['loop_soak','loop_work','loop_urge'].includes(engine.seg):id==='glasshouse'&&engine.seg==='bath-loop';
}
async function load(id){
 if(records[id]||loading[id]||errors[id])return;
 loading[id]=true;const handlers={},pointers=new Set();
 try{
  const module=await import('./water-toys/'+specs[id].file+'.js');
  const env={canvas,engine,clear,resize,video:()=>engine.cur(),on:(name,fn)=>{(handlers[name]||(handlers[name]=[])).push(fn);},error:e=>{errors[id]=true;console.warn('water toy unavailable',id);},
   setup(c,W,H){c.setTransform(1,0,0,1,0,0);c.clearRect(0,0,c.canvas.width,c.canvas.height);const d=dimensions(W,H);c.setTransform(d.k,0,0,d.k,d.x,d.y);},
   pointer(e,W,H){const d=dimensions(W,H);return{x:((e.clientX-d.r.left)*canvas.width/d.r.width-d.x)/d.k/W,y:((e.clientY-d.r.top)*canvas.height/d.r.height-d.y)/d.k/H};},
   screen(x,y,W,H){const d=dimensions(W,H);return{x:d.r.left+(d.x+x*W*d.k)/canvas.width*d.r.width,y:d.r.top+(d.y+y*H*d.k)/canvas.height*d.r.height};},
   clampPoint(x,y,W,H,margin){const d=dimensions(W,H);return{x:Math.max((-d.x/d.k+margin)/W,Math.min((canvas.width-d.x)/d.k/W-margin/W,x)),y};},
   inView(x,y,W,H,margin){const p=this.clampPoint(x,y,W,H,margin);return Math.abs(p.x-x)<.00001;}
  };
  const api=module.create(env);api.restore(pref(id).points);records[id]={id,api,handlers,pointers};
 }catch(e){errors[id]=true;console.warn('water toy could not load',id);}finally{loading[id]=false;}
}
function sync(){
 const id=engine.scene?.id;
 if(!specs[id]||!pref(id).enabled||!allowed(id)||errors[id]){suspend();return;}
 if(active?.id!==id){suspend();if(!records[id]){load(id);return;}active=records[id];active.api.restore(pref(id).points);engine.root.classList.add('water-toy-active');}
}
function frame(now){
 requestAnimationFrame(frame);if(!engine)return;sync();if(!active||now-lastTick<1000/30)return;
 lastTick=now;
 try{active.api.tick(now);}catch(e){errors[active.id]=true;console.warn('water toy rendering unavailable',active.id);suspend();}
 if(saveAt&&now>=saveAt){saveAt=0;snapshot();}
}
function mount(E){
 if(started)return;started=true;engine=E;canvas=document.createElement('canvas');canvas.id='waterToyCanvas';canvas.setAttribute('aria-hidden','true');engine.root.insertBefore(canvas,engine.cv);resize();
 for(const name of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'])engine.root.addEventListener(name,e=>{
  sync();if(!active)return;const record=active,captured=record.pointers.has(e.pointerId);
  if(!captured&&!record.api.ready())return;
  for(const fn of record.handlers[name]||[])fn(e);
  if(name==='pointerdown'&&e.defaultPrevented)record.pointers.add(e.pointerId);
  if(captured||record.pointers.has(e.pointerId)){suppressClick=performance.now()+650;e.stopImmediatePropagation();if(name==='pointerup'||name==='pointercancel'||name==='lostpointercapture'){record.pointers.delete(e.pointerId);snapshot();saveAt=performance.now()+1800;}}
 },true);
 engine.root.addEventListener('click',e=>{if(performance.now()<suppressClick){e.stopImmediatePropagation();e.preventDefault();}},true);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)suspend();});window.addEventListener('pagehide',suspend);
 requestAnimationFrame(frame);
}
function garden(body){
 const id=engine.scene?.id,spec=specs[id],section=document.createElement('section');section.className='water-toy-garden';
 const title=document.createElement('h3');title.textContent='水面小物';section.appendChild(title);
 const note=document.createElement('p');note.className='tip';note.textContent=spec?spec.note:'小鸭子适用于日系温泉，双橘子适用于雨夜花房。';section.appendChild(note);
 if(spec){
  const row=document.createElement('div');row.className='water-toy-options';
  for(const [enabled,label] of [[false,'不放小物'],[true,spec.name]]){const b=document.createElement('button');b.className='btn';b.dataset.toy=enabled?spec.file:'none';b.setAttribute('aria-pressed',String(!!pref(id).enabled===enabled));b.textContent=label;b.onclick=()=>{suspend();saved[id]={...pref(id),enabled};const ok=write();section.replaceWith(render());if(!ok)note.textContent='本机存储不可用，布置暂时无法保存。';};row.appendChild(b);}
  section.appendChild(row);
  const reset=document.createElement('button');reset.className='btn water-toy-reset';reset.textContent='小物归位';reset.disabled=!pref(id).enabled;reset.onclick=()=>{suspend();saved[id]={enabled:!!pref(id).enabled};records[id]?.api.reset();write();section.replaceWith(render());};section.appendChild(reset);
  const detail=document.createElement('p');detail.className='tip';detail.textContent=errors[id]?'小物暂时无法加载，请重新打开 App。':'免费使用 · 布置保存在本机；收起面板后可拖动。';section.appendChild(detail);
 }
 function render(){const holder=document.createElement('div');garden(holder);return holder.firstChild;}
 body.appendChild(section);
}
window.WaterToys={mount,garden,debug:()=>({scene:engine?.scene?.id,active:active?.id||null,ready:!!active?.api.ready(),points:active?.api.state(),screen:active?.api.screen(),saved,errors,canvas:[canvas?.width,canvas?.height],lastTick})};
})();
