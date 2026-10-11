const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');const root=path.resolve(__dirname,'../src-mobile');
const c={window:{}};vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(root,'scene_snow.js'),'utf8'),c);const S=c.window.SCENES.snow;
const catalog=JSON.parse(fs.readFileSync(path.join(root,'assets/rewards_catalog.json')));
test('snow keeps six original reward thresholds and eight cloth tiers',()=>{
 assert.deepEqual(catalog.snow.towels.map(t=>t.n),[0,60,180,360,600,960,1500,2400]);
 const expected={'frost-glass':['rest',30],'seed-case':['rest',90],'frozen-leaf':['days',2],'snow-catcher':['days',7],'echo-shell':['long',1],'moon-stone':['long',5]};
 assert.equal(catalog.snow.props.length,6);
 for(const p of catalog.snow.props){assert.deepEqual([p.line,p.n],expected[p.id]);assert(catalog.snow.slots.some(s=>s.id===p.slot));}
 for(const p of [...catalog.snow.props,...catalog.snow.towels])assert(fs.statSync(path.join(root,'assets/p3/snow',p.id+'.png')).size>0);
});
test('snow stays hidden and paid without inventing a price or SKU',()=>{
 const t=catalog.themes.find(t=>t.id==='snow');assert.equal(t.hidden,true);assert.equal(t.paid,true);assert.equal(t.sku,undefined);assert.equal(t.price_cny,undefined);
});
test('snow routes only cross the pool boundary and preserve approved durations',()=>{
 for(const a of ['idle','work','awaiting'])for(const b of ['shortBreak','longBreak']){assert.equal(S.motion.route(a,b)[0].seg,'exit-web');assert.equal(S.motion.route(b,a)[0].seg,'enter-web');assert.equal(S.motion.route(a,b)[0].ms,6000);}
 assert.equal(S.motion.route('shortBreak','longBreak').length,0);assert.equal(S.motion.route('work','done').length,0);
 for(const seg of Object.values(S.loops))assert(S.assets.names.includes(seg));assert.equal(S.assets.names.length,8);
});
test('all three menu hit areas survive the approved full-screen phone ratios',()=>{
 for(const [w,h] of [[360,800],[390,844],[430,932]]){
  const k=Math.max(w/941,h/1672),off=(w-941*k)/2;
  for(const r of Object.values(S.entries)){assert(off+r.x*941*k>=0);assert(off+r.x2*941*k<=w);assert((r.x2-r.x)*941*k>=44);}
 }
});
