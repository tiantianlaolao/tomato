// Optional whole-frame routes for new scene packages. Core view remains authoritative.
(function () {
'use strict';
const E = window.Scene;
E.resetMotion = function () {
  if (this.motionState) this.motionState.epoch++;
  this.motionState = null;
  this.motionNeedsSync = false;
  for (const v of this.vids || []) v.onended = null;
};
E.updateMotion = function (view) {
  const S = this.scene, M = S.motion, old = this.view, ph = this.phaseOf(view);
  const underlying = ph === 'paused' ? this.phaseOf({...view, status:'running'}) : ph;
  const target = underlying === 'break'
    ? (view.stages?.[view.idx]?.secs >= 600 ? 'longBreak' : 'shortBreak') : underlying;
  const key = [view.started_ms || 0, view.idx || 0, target].join(':');
  const command = this.motionCommand; this.motionCommand = null;
  this.view = view; this.phase = ph;
  this.frozen = ph === 'paused';
  let state = this.motionState;
  const resync = this.motionNeedsSync; this.motionNeedsSync = false;
  const interrupted = command && !['pause','resume','start_next'].includes(command);
  if (state && key === state.key && !resync && !interrupted) {
    if (this.frozen || !this.running) this.cur().pause();
    else if (state.pendingNext) { state.pendingNext = false; state.next(); }
    else if (this.cur().paused) this.cur().play().catch(e => this.noteErr('resume', e));
    return;
  }
  const previousTarget = state?.target;
  const wasMoving = !!state?.moving;
  if (state) state.epoch++;
  for (const v of this.vids) v.onended = null;
  this.swapToken++; this.fog?.classList.remove('on');
  state = this.motionState = {key, target, epoch:0, moving:false, queue:[], pendingNext:false};
  const sameSession = old && old.started_ms === view.started_ms;
  const natural = sameSession && old.status === 'running' &&
    ((view.idx === old.idx + 1 && old.remaining_ms <= 1500) ||
     (view.status === 'awaiting' && view.idx === old.idx && old.remaining_ms <= 1500));
  const nextConfirmed = sameSession && old.status === 'awaiting' && view.status === 'running' && view.idx === old.idx + 1;
  let route = !resync && !wasMoving && !interrupted && !this.frozen &&
    (natural || nextConfirmed) && !['idle','done'].includes(target)
    ? M.route(previousTarget, target) : [];
  // A 5-second stage cannot wait behind a 6/16-second story. The clock never waits.
  if (view.status === 'running' && route.reduce((n, x) => n + x.ms, 0) + 500 > view.remaining_ms) route = [];
  state.queue = [...route, {seg:S.loops[target], loop:true}];
  const token = state.epoch;
  state.next = () => {
    if (this.motionState !== state || token !== state.epoch) return;
    if (this.frozen || !this.running) { state.pendingNext = true; return; }
    const step = state.queue.shift(); if (!step) return;
    const hard = state.moving || !step.loop;
    state.moving = !step.loop; state.clip = step.seg;
    const el = this.seg ? this.spare() : this.cur();
    this.playOn(el, step.seg, !!step.loop, hard);
    el.onended = step.loop ? null : () => state.next();
  };
  // Cold paused snapshots must load the correct stable pose, without advancing it.
  if (this.frozen || !this.running) {
    const el = this.seg ? this.spare() : this.cur();
    state.queue = []; state.clip = S.loops[target];
    this.playOn(el, state.clip, true); el.pause();
  } else state.next();
};
const stop = E.stop;
E.stop = function () {
  if (this.scene?.motion) this.motionNeedsSync = true;
  return stop.call(this);
};
})();
