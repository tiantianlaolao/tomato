// One theme, two places. The core snapshot owns all timing and accounting.
(function(){
'use strict';
const box=(x,y,x2,y2)=>({x:x/941,y:y/1672,x2:x2/941,y2:y2/1672});
const clips={idle:'idle-loop',work:'reading-loop',shortBreak:'orange-loop',longBreak:'bath-loop',awaiting:'awaiting-loop',done:'empty-loop-candidate'};
const step=(seg,ms,to)=>({seg,ms,to});
const S={
 id:'glasshouse',name:'雨夜花房',frame:[941,1672],poster:'assets/p3/glasshouse/poster.jpg',
 hint:'木牌上：开始 · 设置 · 记录',
 menu:[{key:'start',label:'开始'},{key:'settings',label:'设置'},{key:'stats',label:'记录'}],
 entries:{start:box(280,260,405,386),settings:box(407,260,532,386),stats:box(534,260,659,386)},
 assets:{base:'glasshouse-v1',dir:'assets/video-glasshouse',names:[...Object.values(clips),'shortbreak-out','shortbreak-return','orange-nibble','longbreak-out','longbreak-return']},
 loops:clips,dim:{idle:0,work:0,break:0,awaiting:0,done:0,paused:.24},
 motion:{route(from,to){
  if(from===to)return [];
  const route=[];
  if(from==='shortBreak')route.push(step('shortbreak-return',8250,'work'));
  if(from==='longBreak')route.push(step('longbreak-return',16000,'work'));
  if(to==='shortBreak')route.push(step('shortbreak-out',8000,'shortBreak'),step('orange-nibble',1750,'shortBreak'));
  if(to==='longBreak')route.push(step('longbreak-out',16000,'longBreak'));
  return route;
 }},
 roomAt(seg,t){return seg==='longbreak-out'?t<8:seg==='longbreak-return'?t>=8:seg!=='bath-loop';},
 // Every decoded transition frame carries its own room/board coordinates.
 pixelOverlay(seg){return seg==='longbreak-out'||seg==='longbreak-return';},
 image(id,E){const cache=this._images||(this._images={});if(!cache[id]){const im=cache[id]=new Image();im.onload=()=>{im.ok=true;E.draw();};im.onerror=()=>{im.failed=true;};im.src='assets/p3/glasshouse/'+id+'.png';}return cache[id];},
 drawGarden(E,c){
  const R=window.RW;if(!R||R.theme!==this.id||!R.view?.state)return;
  const state=R.view.state,ids=[];
  for(const [slot,id]of Object.entries(state.placed||{})){const p=R.cat('props',id);if(p&&p.slot===slot)ids.push(id);}
  if(state.hung&&R.cat('towels',state.hung))ids.push(state.hung);
  const images=ids.map(id=>this.image(id,E));if(images.some(im=>!im.ok&&!im.failed))return;
  ids.forEach((id,i)=>{const a=window.GLASSHOUSE_PLACEMENT[id]?.at;if(!a||!images[i].ok)return;const [x,y]=E.map(a[0]/941,a[1]/1672),[x2,y2]=E.map((a[0]+a[2])/941,(a[1]+a[3])/1672);c.drawImage(images[i],x,y,x2-x,y2-y);});
 },
 drawUI(E,c,v){
  const room=this.roomAt(E.seg,E.cur().currentTime||0);if(room)this.drawGarden(E,c);
  c.save();c.textAlign='center';c.textBaseline='middle';c.fillStyle='#49301d';const EN=window.I18N?.lang==='en';
  if(E.phase==='idle'&&room){for(const [i,r]of Object.values(this.entries).entries()){const b=E.rect(r);c.font=Math.round(Math.min(b.h*.4,b.w*(EN?.2:.33)))+'px '+E.brush;c.fillText((EN?['Start','Settings','Log']:['开始','设置','记录'])[i],b.x+b.w/2,b.y+b.h/2);}}
  else if(['work','break','paused'].includes(E.phase)){
   const r=E.rect(room?box(285,252,655,388):box(295,210,647,330)),sec=Math.max(0,Math.round((v?.remaining_ms||0)/1000));
   c.font=Math.round(r.h*.47)+'px '+E.brush;c.fillText(String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0'),r.x+r.w/2,r.y+r.h*.38);
   c.font=Math.round(r.h*.22)+'px '+E.brush;c.fillText(E.phase==='paused'?(EN?'Paused':'暂停'):E.phase==='break'?(EN?'Rest':'休息时光'):(EN?'Reading':'读书时光'),r.x+r.w/2,r.y+r.h*.82);
  }c.restore();
 }
};window.SCENES=window.SCENES||{};window.SCENES.glasshouse=S;
})();
