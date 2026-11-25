// A shot owns its actor, reflections, wall and water. All furnishings have alpha.
window.YardArt = (() => {
  const width = 720, height = 1280;
  const dir = 'assets/ink-details/';
  function canvas(w, h) {
    return Object.assign(document.createElement('canvas'), {width:w, height:h});
  }
  const base = canvas(width,height), previous = canvas(width,height), surface = canvas(width,height);
  const bg = base.getContext('2d'), prior = previous.getContext('2d'), g = surface.getContext('2d');
  const swatch = canvas(164,124), fabric = swatch.getContext('2d');
  const fishLayer = canvas(111,101), fish = fishLayer.getContext('2d');
  const pages = new Map(), lastFrames = new Map(), prints = new Map();
  let parts, loading, activeShot, activeVideo, lastTick, elapsed = 0, blendStart;

  function prepare() {
    if (loading) return;
    const json = async file => {
      const response = await fetch(dir + file);
      if (!response.ok) throw Error(file);
      return response.json();
    };
    loading = json('parts.json')
      .then(items => { parts = items; })
      .catch(() => { loading = null; });
  }
  function page(file) {
    let im = pages.get(file);
    if (im) pages.delete(file);
    else { im = new Image(); im.src = dir + file; }
    pages.set(file,im);
    if (pages.size > 28) pages.delete(pages.keys().next().value);
    return im;
  }
  function frame(name, time=elapsed) {
    const def = parts?.[name];
    if (!def) return;
    const i = Math.floor(time * def.fps) % def.count, j = i % def.per;
    const sheet = Math.floor(i / def.per), im = page(def.pages[sheet]);
    if (def.pages.length > 1 && (j >= def.per - 5 || i >= def.count - 5)) {
      page(def.pages[(sheet + 1) % def.pages.length]);
    }
    if (!im.complete || !im.naturalWidth) return lastFrames.get(name);
    const [w,h] = def.size, [x,y] = def.positions?.[i] || def.box;
    const result = {im,sx:(j%def.columns)*w,sy:Math.floor(j/def.columns)*h,w,h,x,y,def};
    lastFrames.set(name,result);
    return result;
  }
  function paint(c,s,x=s.x,y=s.y) {
    c.drawImage(s.im,s.sx,s.sy,s.w,s.h,x,y,s.w,s.h);
  }
  function shadow(s) {
    if (!s.def.shadow) return;
    const [dx,dy,blur,a] = s.def.shadow;
    g.shadowColor = 'rgba(39,27,25,'+a+')';
    g.shadowOffsetX = dx; g.shadowOffsetY = dy; g.shadowBlur = blur;
  }
  function prop(name) {
    const s = frame(name);
    if (!s) return;
    g.save(); shadow(s); paint(g,s); g.restore();
  }
  function cloth(id,time,theme) {
    if (!id) return;
    const indigo = id === 't06', s = frame(indigo ? 'indigo' : 'ivory',time);
    if (!s) return;
    fabric.clearRect(0,0,s.w,s.h);
    paint(fabric,s,0,0);
    if (id !== 't01' && id !== 'ot_white' && !indigo) {
      if (!prints.has(id)) {
        const im = new Image(); im.src = 'assets/p3/'+theme+'/'+id+'.png'; prints.set(id,im);
      }
      const im = prints.get(id), track = clothMotion.lotus;
      if (im.naturalWidth && track?.length) {
        const [a,b,c,d] = track[Math.floor(time*24)%track.length];
        fabric.save(); fabric.translate(-s.x,-s.y);
        fabric.globalCompositeOperation='source-atop'; fabric.globalAlpha=.45;
        for(let n=0;n<16;n++) {
          const u=n/16, x=a[0]+(b[0]-a[0])*u, y=a[1]+(b[1]-a[1])*u;
          fabric.save();
          fabric.transform((b[0]-a[0])/16,(b[1]-a[1])/16,d[0]+(c[0]-d[0])*u-x,d[1]+(c[1]-d[1])*u-y,x,y);
          fabric.drawImage(im,(.20+.57*u)*im.width,.12*im.height,.57*im.width/16,.76*im.height,0,0,1.02,1);
          fabric.restore();
        }
        fabric.restore();
      }
    }
    return s;
  }
  function towel(id,guest) {
    const s=cloth(id,elapsed,'ink'); if(!s)return;
    g.save();
    if (guest) { g.translate(204,280); g.scale(.52,.52); g.translate(-125,-441); }
    shadow(s); g.drawImage(swatch,s.x,s.y); g.restore();
  }
  function lotus() {
    const s=frame('lotus');
    if (s) {
      // The broken reflection contains only reflected petals. Gaps show the live shot.
      g.save();
      for(let n=0;n<31;n+=2) {
        g.globalAlpha=.25*(1-n/31);
        g.drawImage(s.im,s.sx+13,s.sy+74-n,98,2, s.x+13+2*Math.sin(elapsed*2.2+n*.42),1174+n,98,1.5);
      }
      g.restore();
    }
    prop('leaves'); prop('lotus');
  }
  function school(view) {
    for(const name of ['fish0','fish1']) {
      const s=frame(name); if(!s) continue;
      fish.clearRect(0,0,s.w,s.h); paint(fish,s,0,0);
      fish.save(); fish.globalCompositeOperation='source-atop'; fish.globalAlpha=.17;
      fish.drawImage(base,view.left+s.x*view.waterScale,view.waterTop+s.y*view.waterScale,
        s.w*view.waterScale,s.h*view.waterScale,0,0,s.w,s.h);
      fish.restore(); g.drawImage(fishLayer,s.x,s.y);
    }
  }
  function incense() {
    prop('censer'); g.save();
    for(let i=0;i<16;i++) {
      const t=(elapsed*.32+i/16)%1, x=204+6*Math.sin(t*7-elapsed*.66)+12*t*t;
      const y=710-64*t, r=1.1+4*t, a=.085*Math.sin(Math.PI*t);
      const cloud=g.createRadialGradient(x,y,0,x,y,r);
      cloud.addColorStop(0,'rgba(219,208,190,'+a+')');cloud.addColorStop(1,'rgba(219,208,190,0)');
      g.fillStyle=cloud;g.fillRect(x-r,y-r,r*2,r*2);
    }
    g.restore();
  }
  function teaTray() {
    // The occupied pixels (including the shadow) fit on the paving at
    // x=208..300, y=647..687 for the complete exit and return.
    g.save();
    g.translate(211,647); g.scale(.78,.78); g.translate(-249,-675);
    prop('tray'); g.restore();
  }
  let hasBase=false;
  function render(engine,ctx,phase,state) {
    prepare();
    const now=performance.now(), video=engine.cur();
    if(engine.running && !engine.frozen && !document.hidden && lastTick!=null) elapsed+=Math.min(.1,(now-lastTick)/1000);
    lastTick=now;
    if(video?.readyState>=2 && !video.seeking) {
      if(activeShot!==engine.seg || video!==activeVideo) {
        if(hasBase) { prior.drawImage(base,0,0); blendStart=now; }
        activeShot=engine.seg; activeVideo=video;
      }
      bg.drawImage(video,0,0,width,height);
      if(blendStart!=null) {
        const t=Math.min(1,(now-blendStart)/200);
        if(t<1) { bg.globalAlpha=1-t*t*(3-2*t); bg.drawImage(previous,0,0); bg.globalAlpha=1; }
        else blendStart=null;
      }
      hasBase=true;
    }
    if(!hasBase) return;
    g.drawImage(base,0,0);
    const p=state?.placed||{};
    const view=engine.scene.framing(engine);
    prop('plaque');
    g.save();
    g.translate(Math.max(0,view.left+12-94),0);
    if (phase==='idle' && p.wall) prop('title');
    g.restore();
    if (p.willow) prop('bell');
    g.save(); g.translate(Math.max(0,view.left+8-135),0);
    towel(state?.hung,false); g.restore();
    towel(state?.guest_towel,true);
    if (p.lamp_side==='orchid' || p.lamp_side==='stool') {
      g.save(); g.translate(Math.max(0,view.left+4-97),0);
      prop(p.lamp_side); g.restore();
    }
    if (p.floor_mid==='teatray') teaTray();
    if (p.pool_edge) incense();
    g.save(); g.translate(view.left,view.waterTop); g.scale(view.waterScale,view.waterScale);
    if (p.water_near==='lotus') lotus();
    if (p.water_near==='koi') school(view);
    g.restore();
    const [x,y]=engine.map(0,0),[r,b]=engine.map(1,1);
    ctx.drawImage(surface,x,y,r-x,b-y);
    const dim=engine.scene.dim[phase]||0;
    if(dim){ctx.fillStyle='rgba(8,6,4,'+dim+')';ctx.fillRect(x,y,r-x,b-y);}
    window.yardMotion={name:p.water_near||'empty',time:elapsed,surface};
  }
  render.drawOnsenCloth=(ctx,id,time,pinX,pinY,scale)=>{
    prepare();
    const s=cloth(id,time,'onsen'); if(!s)return;
    // Omit the projecting rod ends. The new shot already contains its own fixed rail.
    fabric.clearRect(0,0,59,30); fabric.clearRect(118,0,46,30);
    ctx.save();ctx.translate(pinX,pinY);ctx.scale(scale,scale);
    ctx.filter='brightness(.83) saturate(.78)';
    ctx.shadowColor='rgba(14,20,30,.40)';ctx.shadowBlur=2.3*scale;
    ctx.shadowOffsetX=-1.6*scale;ctx.shadowOffsetY=2*scale;
    ctx.drawImage(swatch,-86,-15);ctx.restore();
  };
  render.pause=()=>{
    lastTick=null;
    if(window.Scene?.scene?.id!=='ink') {
      hasBase=false;
      activeShot=activeVideo=blendStart=null;
      lastFrames.clear();
    }
  };
  return render;
})();
