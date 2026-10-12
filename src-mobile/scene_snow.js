// Approved snow v9 footage; state and rewards come from the existing app.
(function(){
'use strict';
const box=(x,y,x2,y2)=>({x:x/941,y:y/1672,x2:x2/941,y2:y2/1672});
const entries={start:box(222,437,385,526),settings:box(389,437,552,526),stats:box(556,437,719,526)};
const pool=new Set(['idle','work','awaiting']),shore=new Set(['shortBreak','longBreak']);
const spots={'snow-catcher':[628,507,782,705],'moon-stone':[384,766,556,848],'frost-glass':[130,1338,265,1450],'frozen-leaf':[670,1380,803,1477],'seed-case':[135,644,312,747],'echo-shell':[730,1167,872,1286]};
const S={id:'snow',name:'雪山温泉',frame:[941,1672],poster:'assets/p3/snow/poster.jpg',
 hint:'木牌上：入浴＝开始 · 调汤＝设置 · 沐录＝记录',entries,
 assets:{base:'snow-v1',dir:'assets/video-snow',names:['idle-web','work-web','shortBreak-web','longBreak-web','awaiting-web','environment-web','exit-web','enter-web']},
 loops:{idle:'idle-web',work:'work-web',shortBreak:'shortBreak-web',longBreak:'longBreak-web',awaiting:'awaiting-web',done:'environment-web'},
 swimOut:'exit-web',swimIn:'enter-web',readVideoPixels:true,
 motion:{route(from,to){if(pool.has(from)&&shore.has(to))return [{seg:'exit-web',ms:6000,to}];if(shore.has(from)&&pool.has(to))return [{seg:'enter-web',ms:6000,to}];return [];}},
 dim:{idle:0,work:0,break:0,awaiting:0,done:0,paused:.24},
 pixelOverlay(seg){return seg==='enter-web'||seg==='exit-web';},
 image(id,E){const cache=this._images||(this._images={});if(!cache[id]){const im=cache[id]=new Image();im.onload=()=>{im.ok=true;E.draw();};im.onerror=()=>{im.failed=true;};im.src='assets/p3/snow/'+id+'.png';}return cache[id];},
 drawGarden(E,c){
  const R=window.RW;if(!R||R.theme!=='snow'||!R.view?.state)return;
  const st=R.view.state,jobs=[];
  for(const [slot,id] of Object.entries(st.placed||{})){const p=R.cat('props',id);if(p&&p.slot===slot&&spots[id])jobs.push([id,spots[id]]);}
  if(st.hung&&R.cat('towels',st.hung))jobs.push([st.hung,[434,1368,618,1464]]);
  const ims=jobs.map(([id])=>this.image(id,E));if(ims.some(im=>!im.ok&&!im.failed))return;
  jobs.forEach(([id,b],i)=>{if(!ims[i].ok)return;const im=id==='moon-stone'&&this.pixelOverlay(E.seg)?this.maskStone(E,ims[i]):ims[i];if(!im)return;const [x,y]=E.map(b[0]/941,b[1]/1672),[x2,y2]=E.map(b[2]/941,b[3]/1672);c.drawImage(im,x,y,x2-x,y2-y);});
 },
 maskStone(E,im){
  const v=E.cur();if(v.readyState<2)return null;
  const roi=this._roi||(this._roi=document.createElement('canvas'));if(roi.width!==172){roi.width=172;roi.height=82;}
  const r=roi.getContext('2d',{willReadFrequently:true});
  try{r.clearRect(0,0,172,82);r.drawImage(v,384/941*v.videoWidth,766/1672*v.videoHeight,172/941*v.videoWidth,82/1672*v.videoHeight,0,0,172,82);const d=r.getImageData(0,0,172,82);
   for(let i=0;i<d.data.length;i+=4){const a=d.data[i],g=d.data[i+1],b=d.data[i+2];d.data[i]=d.data[i+1]=d.data[i+2]=255;d.data[i+3]=a>70&&a>g*1.18&&a>b*1.45?255:0;}r.putImageData(d,0,0);
   const layer=this._stone||(this._stone=document.createElement('canvas'));if(layer.width!==172){layer.width=172;layer.height=82;}const l=layer.getContext('2d');l.globalCompositeOperation='source-over';l.clearRect(0,0,172,82);l.drawImage(im,0,0);l.globalCompositeOperation='destination-out';l.filter='blur(1px)';l.drawImage(roi,0,0);l.filter='none';return layer;
  }catch(e){E.noteErr('snow stone mask',e);return null;}
 },
 drawSpring(E,c){
  if(E.motionState?.moving||!['shortBreak','longBreak','done'].includes(E.motionState?.target))return;
  const [x,y]=E.map(0,0),k=(E.map(1,0)[0]-x)/941,t=E.cur().currentTime||0;c.save();c.translate(x,y);c.scale(k,k);
  for(let i=0;i<7;i++){const p=(t*.6+i*.147)%1;c.strokeStyle=`rgba(224,248,244,${.56*Math.sin(p*Math.PI)})`;c.lineWidth=1.4;c.beginPath();c.ellipse(185+Math.sin(i*2.3+t*.7)*17,1048-p*17,2+p*2,1.7+p*1.5,0,0,Math.PI*2);c.stroke();}
  c.filter='blur(3px)';for(let i=0;i<3;i++){c.strokeStyle='rgba(228,242,238,.14)';c.lineWidth=4;c.beginPath();c.moveTo(181+i*7,1043);c.bezierCurveTo(174+i*7,1029,192+i*7+Math.sin(t+i)*5,1015,181+i*7,1004);c.stroke();}c.restore();
 },
 drawUI(E,c,v){
  this.drawSpring(E,c);this.drawGarden(E,c);c.save();c.textAlign='center';c.textBaseline='middle';c.fillStyle='#492b1a';const EN=window.I18N?.lang==='en';
  if(E.phase==='idle'){const labels=EN?['Soak','Tune','Log']:['入浴','调汤','沐录'];Object.values(entries).forEach((r,i)=>{const b=E.rect(r);c.font=Math.round(Math.min(b.h*.48,b.w*.32))+'px '+E.brush;c.fillText(labels[i],b.x+b.w/2,b.y+b.h/2);});}
  else if(['work','break','paused'].includes(E.phase)){const b=E.rect(box(230,431,710,530)),sec=Math.max(0,Math.round((v?.remaining_ms||0)/1000));c.font=Math.round(b.h*.57)+'px '+E.brush;c.fillText(String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0'),b.x+b.w/2,b.y+b.h*.4);c.font=Math.round(b.h*.23)+'px '+E.brush;c.fillText(E.phase==='paused'?(EN?'Paused':'休止'):E.phase==='break'?(EN?'Rest':'小憩'):(EN?'Focus':'静心'),b.x+b.w/2,b.y+b.h*.83);}
  c.restore();
 }
};window.SCENES=window.SCENES||{};window.SCENES.snow=S;
})();
