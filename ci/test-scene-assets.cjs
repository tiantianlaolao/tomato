const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');const root=path.resolve(__dirname,'../src-mobile');
const flush=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));};
function assetEnv(records){
 const store=new Map(Object.entries(records)),requests=[],blobs=new Map();let serial=0;
 const req=value=>{const r={};queueMicrotask(()=>{r.result=value;r.onsuccess?.();});return r;};
 const db={transaction:()=>({objectStore:()=>({get:k=>req(store.get(k)),put:(v,k)=>{store.set(k,v);return req(k);}})})};
 const c={window:{__TAURI__:{core:{}}},Blob,URL:{createObjectURL:b=>{const u='blob:test'+(++serial);blobs.set(u,b);return u;}},indexedDB:{open:()=>req(db)},document:{body:{appendChild(){}},createElement:()=>({style:{},remove(){}})},location:{origin:'http://tauri.localhost'},fetch:async url=>{requests.push(url);return {ok:true,json:async()=>({frames:[],sheets:['s.webp']}),blob:async()=>new Blob(['sheet'])};}};
 vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(root,'assets.js'),'utf8'),c);return {AS:c.window.AS,store,requests,blobs};
}
test('cached videos still fetch missing matte JSON and sheets',async()=>{
 const e=assetEnv({'a/loop':{blob:new Blob(['video'])}});e.AS.configure({base:'a',dir:'a',names:['loop']});await flush();
 assert(e.requests.some(u=>u.endsWith('/matte/loop.json')));assert(e.requests.some(u=>u.endsWith('/matte/s.webp')));assert(!e.requests.some(u=>u.endsWith('.mp4')));
 assert(e.AS.matteUrl('loop.json').startsWith('blob:'));assert(e.AS.matteUrl('s.webp').startsWith('blob:'));
});
test('fully cached video and matte restore without network',async()=>{
 const e=assetEnv({'a/loop':{blob:new Blob(['video'])},'a/matte/loop.json':{frames:[],sheets:['s.webp']},'a/matte/s.webp':{blob:new Blob(['sheet'])}});
 e.AS.configure({base:'a',dir:'a',names:['loop']});await flush();assert.deepEqual(e.requests,[]);const meta=e.blobs.get(e.AS.matteUrl('loop.json'));assert.deepEqual(JSON.parse(await meta.text()).sheets,['s.webp']);
});
test('late matte response cannot overwrite a switched scene, even for same segment name',async()=>{
 const pending=[];const c={window:{},Image:class{},fetch:url=>new Promise(resolve=>pending.push({url,resolve})),AS:{matteUrl:(name,a)=>a.base+'/'+name}};c.window.AS=c.AS;vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(root,'scene.js'),'utf8'),c);
 const E=c.window.Scene;E.scene={assets:{base:'a'}};E.matteLoad(['loop']);E.scene={assets:{base:'b'}};E.matteLoad(['loop']);
 pending[1].resolve({ok:true,json:async()=>({frames:[],sheets:['b.webp']})});await flush();pending[0].resolve({ok:true,json:async()=>({frames:[],sheets:['a.webp']})});await flush();
 assert.equal(E.matte.loop.sheets[0].src,'b/b.webp');
});
