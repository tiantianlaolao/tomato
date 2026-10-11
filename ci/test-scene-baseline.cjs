// Original scene contract: run with node ci/test-scene-baseline.cjs.
// Browser media quality and native integration require separate acceptance.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
function engine(id) {
  const c = { window: {}, console, performance: { now: () => 0 }, setTimeout: () => 0, clearTimeout() {} };
  vm.createContext(c);
  for (const file of ['scene.js', 'scene_onsen.js', 'scene_ink.js'])
    vm.runInContext(fs.readFileSync(path.join(root, 'src-mobile', file), 'utf8'), c);
  const s = c.window.Scene;
  s.scene = c.window.SCENES[id];
  s.vids = [0, 1].map(() => ({ paused: true, pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } }));
  s.playOn = function(el, seg) { this.vi = this.vids.indexOf(el); this.seg = seg; el.play(); };
  return s;
}
function view(kind, secs, status = 'running') {
  return { status, idx: 0, stages: [{ kind, secs }], remaining_ms: 1000 };
}
for (const id of ['ink', 'onsen']) {
  test(`${id}: native states and 599/600 second boundary`, () => {
    const s = engine(id);
    for (const status of ['idle', 'awaiting', 'done']) {
      const v = { status }; assert.equal(s.segFor(s.phaseOf(v), v), s.scene.loops[status]);
    }
    for (const [kind, secs, loop] of [['work', 1500, 'work'], ['break', 599, 'shortBreak'], ['break', 600, 'longBreak']]) {
      const v = view(kind, secs); assert.equal(s.segFor(s.phaseOf(v), v), s.scene.loops[loop]);
    }
  });
  for (const [kind, secs, loop] of [['work', 1500, 'work'], ['break', 300, 'shortBreak'], ['break', 900, 'longBreak']]) {
    test(`${id}: cold paused ${loop} loads correct frozen pose`, () => {
      const s = engine(id); s.update(view(kind, secs, 'paused'));
      assert.equal(s.seg, s.scene.loops[loop]); assert.equal(s.frozen, true); assert.equal(s.cur().paused, true);
      s.update(view(kind, secs)); assert.equal(s.frozen, false); assert.equal(s.cur().paused, false);
    });
  }
  test(`${id}: cover coordinate center remains centered`, () => {
    const s = engine(id);
    for (const [w, h] of [[360, 800], [390, 844], [430, 932]]) {
      s.W = w; s.H = h; const p = s.map(.5, .5);
      assert.ok(Math.abs(p[0] - w / 2) < 1e-8); assert.ok(Math.abs(p[1] - h / 2) < 1e-8);
    }
  });
  test(`${id}: short break followed by long break updates loop`, () => {
    const s = engine(id); s.update(view('break', 599));
    s.fogSwap = function(seg) { this.seg = seg; };
    s.update({ status: 'running', idx: 1, stages: [{ kind: 'break', secs: 599 }, { kind: 'break', secs: 600 }] });
    assert.equal(s.seg, s.scene.loops.longBreak);
  });
}
test('Original reward catalog preserves eight towels and slot references', () => {
  const c = JSON.parse(fs.readFileSync(path.join(root, 'src-mobile/assets/rewards_catalog.json')));
  for (const id of ['ink', 'onsen']) {
    assert.deepEqual(c[id].towels.map(t => t.n), [0, 60, 180, 360, 600, 960, 1500, 2400]);
    const slots = new Set(c[id].slots.map(s => s.id));
    for (const p of c[id].props) assert.ok(slots.has(p.slot), `${id}/${p.id}`);
    assert.equal(new Set(c[id].props.map(p => p.id)).size, c[id].props.length);
  }
});
