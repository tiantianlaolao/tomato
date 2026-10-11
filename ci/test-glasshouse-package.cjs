const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');const root=path.resolve(__dirname,'../src-mobile'),c={window:{}};vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(root,'scene_glasshouse.js'),'utf8'),c);const S=c.window.SCENES.glasshouse;
const catalog=JSON.parse(fs.readFileSync(path.join(root,'assets/rewards_catalog.json')));
test('glasshouse has approved six reward thresholds, eight cloths and isolated slots',()=>{
 const expected={fruit:['rest',30],mug:['rest',90],throw:['rest',180],chime:['days',2],plant:['days',4],snail:['long',1]};assert.equal(catalog.glasshouse.props.length,6);
 for(const p of catalog.glasshouse.props){assert.deepEqual([p.line,p.n],expected[p.id]);assert(catalog.glasshouse.slots.some(s=>s.id===p.slot));}
 assert.deepEqual(catalog.glasshouse.towels.map(t=>t.n),[0,60,180,360,600,960,1500,2400]);
 for(const p of [...catalog.glasshouse.props,...catalog.glasshouse.towels])assert(fs.statSync(path.join(root,'assets/p3/glasshouse',p.id+'.png')).size>0);
 const t=catalog.themes.find(t=>t.id==='glasshouse');assert.equal(t.hidden,true);assert.equal(t.paid,true);assert.equal(t.sku,undefined);
});
test('short rest includes leaving chair and nibbling; returning waits on chair',()=>{
 assert.deepEqual(Array.from(S.motion.route('work','shortBreak'),x=>x.seg),['shortbreak-out','orange-nibble']);
 assert.deepEqual(Array.from(S.motion.route('shortBreak','awaiting'),x=>x.seg),['shortbreak-return']);
 assert.equal(S.motion.route('work','awaiting').length,0);
});
test('long rest retains accepted complete routes and room visibility boundary',()=>{
 assert.equal(S.motion.route('work','longBreak')[0].ms,16000);assert.equal(S.motion.route('longBreak','work')[0].seg,'longbreak-return');
 assert.equal(S.roomAt('longbreak-out',7.99),true);assert.equal(S.roomAt('longbreak-out',8),false);
 assert.equal(S.roomAt('longbreak-return',7.99),false);assert.equal(S.roomAt('longbreak-return',8),true);
 assert.equal(S.roomAt('bath-loop',1),false);assert.equal(S.roomAt('orange-loop',1),true);
});
test('each referenced video is declared; menu targets survive phone cover cropping',()=>{
 for(const seg of [...Object.values(S.loops),...S.motion.route('shortBreak','longBreak').map(s=>s.seg)])assert(S.assets.names.includes(seg));
 for(const [w,h] of [[360,800],[390,844],[430,932]]){const k=Math.max(w/941,h/1672),off=(w-941*k)/2;for(const r of Object.values(S.entries)){assert(off+r.x*941*k>=0);assert(off+r.x2*941*k<=w);assert((r.x2-r.x)*941*k>=44);assert((r.y2-r.y)*1672*k>=44);}}
});
