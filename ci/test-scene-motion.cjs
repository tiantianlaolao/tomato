const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {test} = require('node:test');
const assert = require('node:assert/strict');
function setup(theme) {
  const c = {window:{},console,setTimeout:()=>0,clearTimeout(){},requestAnimationFrame:()=>1,cancelAnimationFrame(){},performance:{now:()=>0}};
  vm.createContext(c);
  for (const name of ['scene.js','scene_motion.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../src-mobile',name),'utf8'),c);
  const e=c.window.Scene;
  e.scene={loops:{idle:'idle',work:'work',shortBreak:'rest',longBreak:'eat',awaiting:'wave',done:'empty'},motion:{route:(a,b)=>a==='work'&&b==='shortBreak'?[{seg:'exit',ms:6000}]:[]}};
  if (theme) {
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../src-mobile',`scene_${theme}.js`),'utf8'),c);
    e.scene=c.window.SCENES[theme];
  }
  e.running=true; e.vi=0; e.calls=[];
  e.vids=[0,1].map(()=>({paused:true,pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();}}));
  e.playOn=function(el,seg,loop){this.vi=this.vids.indexOf(el);this.seg=seg;this.calls.push(seg);el.loop=loop;el.play();};
  return e;
}
const stages=[{kind:'work',secs:1500},{kind:'break',secs:300},{kind:'work',secs:1500}];
const view=(idx=0,status='running',remaining_ms=1000)=>({started_ms:123,idx,status,remaining_ms,stages});
test('natural completion plays route then stable loop without changing core view',()=>{
  const e=setup();e.update(view());const v=view(1,'running',300000);e.update(v);
  assert.equal(e.seg,'exit');assert.equal(e.view,v);e.cur().onended();assert.equal(e.seg,'rest');
});
test('pause and resume preserve an in-progress route',()=>{
  const e=setup();e.update(view());e.update(view(1,'running',300000));const n=e.calls.length;
  e.motionCommand='pause';e.update(view(1,'paused',299000));assert.equal(e.cur().paused,true);
  e.motionCommand='resume';e.update(view(1,'running',299000));assert.equal(e.calls.length,n);assert.equal(e.seg,'exit');assert.equal(e.cur().paused,false);
});
test('skip cancels stale ended callbacks',()=>{
  const e=setup();e.update(view());e.update(view(1,'running',300000));const stale=e.cur().onended;
  e.motionCommand='skip';e.update(view(2,'running',1500000));stale();assert.equal(e.seg,'work');
});
test('reset in the same stage cancels its route',()=>{
  const e=setup();e.update(view());e.update(view(1,'running',300000));const stale=e.cur().onended;
  e.motionCommand='reset_stage';e.update(view(1,'running',300000));stale();assert.equal(e.seg,'rest');
});
test('short stages bypass a route longer than remaining time',()=>{
  const e=setup();e.update(view());e.update(view(1,'running',5000));assert.equal(e.seg,'rest');
});
test('done immediately cancels a route',()=>{
  const e=setup();e.update(view());e.update(view(1,'running',300000));const stale=e.cur().onended;
  e.update(view(1,'done',0));stale();assert.equal(e.seg,'empty');
});
test('background resync uses current stable state',()=>{
  const e=setup();e.update(view());e.update(view(1,'running',300000));e.motionNeedsSync=true;e.update(view(1,'running',250000));assert.equal(e.seg,'rest');
});
test('foreground waits for authoritative snapshot instead of resuming stale route',()=>{
  const e=setup();e.update(view());e.update(view(1,'running',300000));e.stop();e.start();
  assert.equal(e.cur().paused,true);e.update(view(2,'running',1500000));assert.equal(e.seg,'work');assert.equal(e.cur().paused,false);
});
for(const [idx,secs,seg] of [[0,1500,'work'],[1,599,'rest'],[1,600,'eat']])test(`cold paused ${seg} chooses a frozen stable frame`,()=>{
  const e=setup();const v=view(idx,'paused');v.stages=stages.map(s=>({...s}));v.stages[idx].secs=secs;e.update(v);assert.equal(e.seg,seg);assert.equal(e.cur().paused,true);
});

for (const theme of ['snow','glasshouse']) {
  const out=theme==='snow'?'exit-web':'shortbreak-out';
  const back=theme==='snow'?'enter-web':'shortbreak-return';
  test(`${theme}: skip and prev use movement without changing timer snapshot`,()=>{
    for(const [from,to,cmd,clip] of [[0,1,'skip',out],[1,0,'prev',back],[2,1,'prev',out],[1,2,'skip',back]]) {
      const e=setup(theme);e.update(view(from,'running',100000));e.motionCommand=cmd;
      const v=view(to,'running',100000);e.update(v);assert.equal(e.seg,clip);assert.equal(e.view,v);
    }
  });
  test(`${theme}: foreground boundary does not depend on last tick being under 1.5 seconds`,()=>{
    const e=setup(theme);e.update(view(0,'running',2500));e.update(view(1,'running',100000));assert.equal(e.seg,out);
  });
  test(`${theme}: confirming next while returning finishes current video without restarting`,()=>{
    const e=setup(theme);e.update(view(1));e.update(view(1,'awaiting',0));assert.equal(e.seg,back);
    const stale=e.cur().onended,n=e.calls.length;e.cur().currentTime=2;
    e.motionCommand='start_next';e.update(view(2,'running',100000));
    assert.equal(e.calls.length,n);assert.equal(e.seg,back);assert.equal(e.cur().currentTime,2);
    stale();assert.equal(e.seg,back);e.cur().onended();assert.equal(e.seg,e.scene.loops.work);
  });
  test(`${theme}: repeated skip keeps current movement and only the newest destination`,()=>{
    const e=setup(theme);e.update(view(0,'running',100000));e.motionCommand='skip';e.update(view(1,'running',100000));
    const stale=e.cur().onended;e.motionCommand='skip';e.update(view(2,'running',100000));assert.equal(e.seg,out);
    stale();assert.equal(e.seg,out);e.cur().onended();assert.equal(e.seg,back);
    e.cur().onended();assert.equal(e.seg,e.scene.loops.work);
  });
}
