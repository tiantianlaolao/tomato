const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');const root=path.resolve(__dirname,'../src-mobile');
test('new theme names, props, cloths, slots and hints have English translations',()=>{
 const c={window:{},URLSearchParams,location:{search:'?lang=en'},localStorage:{getItem:()=>null},navigator:{language:'en'},document:{documentElement:{},body:{nodeType:1,childNodes:[]},addEventListener(){}},MutationObserver:class{observe(){}disconnect(){}}};vm.createContext(c);
 vm.runInContext(fs.readFileSync(path.join(root,'i18n.js'),'utf8'),c);
 const all=JSON.parse(fs.readFileSync(path.join(root,'assets/rewards_catalog.json')));
 for(const id of ['snow','glasshouse']){
  const cat=all[id],items=[all.themes.find(t=>t.id===id),...cat.props,...cat.towels,...cat.slots,cat.rack];
  for(const item of items)assert(!/[一-鿿]/.test(c.window.I18N.t(item.name)),item.name);
 }
});
