/* Duration picker: pointer inertia + integer snapping; no mutation until Apply. */
(function () {
'use strict';
let closeActive=null;
window.TimeWheel={open({value,min=1,max=240,title='调整时长',onChange}){
  if(closeActive)closeActive();
  const previous=document.activeElement;
  const overlay=document.createElement('div');overlay.className='time-wheel-overlay';
  overlay.innerHTML='<section class="time-wheel-dialog" role="dialog" aria-modal="true" aria-labelledby="tw-title"><div class="tw-head"><div><small>调整节奏</small><h2 id="tw-title"></h2></div><button class="tw-cancel" type="button">取消</button></div><p class="tw-hint">上下拨动，松手后自动吸附</p><div class="tw-drum" role="spinbutton" tabindex="0" aria-label="分钟"><div class="tw-band"></div><div class="tw-numbers" aria-hidden="true"></div><span class="tw-unit">分钟</span></div><div class="tw-shortcuts"></div><label class="tw-input-label">直接输入 <input type="number" inputmode="numeric" step="1" aria-label="直接输入分钟"> 分钟</label><p class="tw-error" role="status"></p><button class="tw-apply" type="button">确定</button></section>';
  document.body.appendChild(overlay);
  const drum=overlay.querySelector('.tw-drum'),numbers=overlay.querySelector('.tw-numbers'),input=overlay.querySelector('input'),error=overlay.querySelector('.tw-error'),apply=overlay.querySelector('.tw-apply');
  overlay.querySelector('h2').textContent=title;
  const clamp=n=>Math.min(max,Math.max(min,n));
  let position=clamp(Number(value)||min),frame=0,drag=null,velocity=0;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const H=44;
  input.min=min;input.max=max;
  drum.setAttribute('aria-valuemin',min);drum.setAttribute('aria-valuemax',max);
  function draw(){
    const selected=Math.round(position);numbers.replaceChildren();
    for(let n=Math.floor(position)-3;n<=Math.ceil(position)+3;n++){
      if(n<min||n>max)continue;
      const el=document.createElement('span'),distance=n-position;
      el.textContent=n;el.style.transform='translateY('+distance*H+'px) scale('+(1-Math.min(Math.abs(distance),3)*.12)+')';
      el.style.opacity=Math.max(0,1-Math.abs(distance)/3);el.className=n===selected?'selected':'';numbers.appendChild(el);
    }
    input.value=selected;drum.setAttribute('aria-valuenow',selected);drum.setAttribute('aria-valuetext',selected+' 分钟');
    error.textContent='';apply.disabled=false;
  }
  function stop(){cancelAnimationFrame(frame);frame=0;}
  function snap(target,animate=true){
    stop();const from=position,to=clamp(Math.round(target)),begin=performance.now();
    if(reduced||!animate){position=to;draw();return;}
    const duration=reduced||!animate?0:Math.min(650,180+Math.abs(to-from)*32);
    function tick(now){const t=duration?Math.min(1,(now-begin)/duration):1;position=from+(to-from)*(1-Math.pow(1-t,3));draw();if(t<1)frame=requestAnimationFrame(tick);else{position=to;frame=0;draw();}}
    frame=requestAnimationFrame(tick);
  }
  drum.addEventListener('pointerdown',e=>{
    if(e.button!==0)return;e.preventDefault();stop();drum.focus();drum.setPointerCapture(e.pointerId);
    drag={id:e.pointerId,startY:e.clientY,y:e.clientY,t:performance.now(),moved:false};velocity=0;
  });
  drum.addEventListener('pointermove',e=>{
    if(!drag||e.pointerId!==drag.id)return;
    const now=performance.now(),delta=(drag.y-e.clientY)/H,dt=Math.max(1,now-drag.t);
    position=clamp(position+delta);velocity=.65*(delta/dt)+.35*velocity;
    drag.moved ||= Math.abs(e.clientY-drag.startY)>5;drag.y=e.clientY;drag.t=now;draw();
  });
  function release(e,canceled=false){
    if(!drag||e.pointerId!==drag.id)return;
    const d=drag;drag=null;
    if(drum.hasPointerCapture(e.pointerId))drum.releasePointerCapture(e.pointerId);
    if(canceled){snap(position);return;}
    if(!d.moved){const r=drum.getBoundingClientRect();snap(position+Math.round((e.clientY-r.top-r.height/2)/H));return;}
    const speed=performance.now()-d.t>100?0:velocity;
    snap(position+(reduced?0:Math.max(-18,Math.min(18,speed*180))));
  }
  drum.addEventListener('pointerup',e=>release(e));drum.addEventListener('pointercancel',e=>release(e,true));
  drum.addEventListener('lostpointercapture',e=>{if(drag)release(e,true);});
  drum.addEventListener('wheel',e=>{e.preventDefault();snap(position+Math.sign(e.deltaY)*Math.min(5,Math.max(1,Math.abs(e.deltaY)/30)));},{passive:false});
  drum.addEventListener('keydown',e=>{const change={ArrowUp:-1,ArrowDown:1,PageUp:-10,PageDown:10};if(e.key in change){e.preventDefault();snap(Math.round(position)+change[e.key],false);}else if(e.key==='Home'||e.key==='End'){e.preventDefault();snap(e.key==='Home'?min:max,false);}});
  [5,15,25,50].filter(n=>n>=min&&n<=max).forEach(n=>{const b=document.createElement('button');b.type='button';b.textContent=n+' 分';b.onclick=()=>snap(n);overlay.querySelector('.tw-shortcuts').appendChild(b);});
  input.oninput=()=>{stop();const n=Number(input.value),valid=input.value!==''&&Number.isInteger(n)&&n>=min&&n<=max;apply.disabled=!valid;error.textContent=valid?'':'请输入 '+min+'–'+max+' 的整数';if(valid){position=n;const text=input.value;draw();input.value=text;}};
  function close(){stop();drag=null;document.removeEventListener('keydown',keys,true);overlay.remove();closeActive=null;if(previous&&previous.isConnected)previous.focus();}
  function keys(e){
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close();}
    if(e.key==='Tab'){const all=[...overlay.querySelectorAll('button:not(:disabled),input,[tabindex="0"]')],first=all[0],last=all[all.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
  }
  document.addEventListener('keydown',keys,true);closeActive=close;
  overlay.querySelector('.tw-cancel').onclick=close;
  overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
  apply.onclick=()=>{stop();const n=clamp(Math.round(position));close();onChange(n);};
  draw();drum.focus();
}};
})();
