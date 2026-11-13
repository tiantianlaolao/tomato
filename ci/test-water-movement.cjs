const test=require('node:test');
const assert=require('node:assert/strict');
const modulePromise=import('../src-mobile/water-toys/movement.js');
const water=(x,y)=>x>=0&&x<=1&&y>=0&&y<=1;
const disk=(x,y)=>Math.hypot(x-.5,y-.5)<.15;
test('swept drag cannot cross tray even when endpoint is clear',async()=>{
 const {createMovement}=await modulePromise;const m=createMovement((x,y)=>water(x,y)&&!disk(x,y),1000,1000);
 const p=m.move({x:.2,y:.5},{x:.8,y:.5});assert(p.x<=.351);assert(!disk(p.x,p.y));
});
test('diagonal gestures slide and can be taken around the tray',async()=>{
 const {createMovement}=await modulePromise;const m=createMovement((x,y)=>water(x,y)&&!disk(x,y),1000,1000);
 let p=m.move({x:.2,y:.5},{x:.5,y:.5});p=m.move(p,{x:.8,y:.2});assert(p.y<.3);p=m.move(p,{x:.8,y:.5});assert(p.x>.75);
});
test('adding tray relocates overlap nearby; removing it restores the same path',async()=>{
 const {createMovement}=await modulePromise;let placed=false;const m=createMovement((x,y)=>water(x,y)&&(!placed||!disk(x,y)),1000,1000);
 assert(Math.abs(m.move({x:.2,y:.5},{x:.8,y:.5}).x-.8)<1e-9);
 placed=true;const p=m.nearest({x:.5,y:.5});assert(!disk(p.x,p.y));assert(Math.hypot(p.x-.5,p.y-.5)<.154);
 placed=false;assert(Math.abs(m.move({x:.2,y:.5},{x:.8,y:.5}).x-.8)<1e-9);
});
test('shore and obstacle are both respected when restoring an old position',async()=>{
 const {createMovement}=await modulePromise;const valid=(x,y)=>water(x,y)&&!disk(x,y);const m=createMovement(valid,1000,1000);
 assert(valid(...Object.values(m.nearest({x:-.02,y:.5}))));
 const p=m.move({x:.2,y:.5},{x:1.3,y:.5});assert(valid(p.x,p.y));assert(p.x<.351);
});
