// Swept movement with a small step: a valid endpoint cannot jump through an obstacle.
export function createMovement(valid, width, height) {
  function nearest(point) {
    if (valid(point.x, point.y)) return {...point};
    for (let radius = 3; radius <= Math.hypot(width, height); radius += 3) {
      const count = Math.max(24, Math.ceil(2 * Math.PI * radius / 3));
      for (let i = 0; i < count; i++) {
        const angle = i * 2 * Math.PI / count;
        const p = {x: point.x + Math.cos(angle) * radius / width, y: point.y + Math.sin(angle) * radius / height};
        if (valid(p.x, p.y)) return p;
      }
    }
    throw new Error('No available water position');
  }
  function move(from, target) {
    let p = nearest(from);
    const count = Math.max(1, Math.ceil(Math.hypot((target.x-p.x)*width, (target.y-p.y)*height)/3));
    const dx = (target.x-p.x)/count, dy = (target.y-p.y)/count;
    for (let i=0; i<count; i++) {
      const q={x:p.x+dx,y:p.y+dy};
      if (valid(q.x,q.y)) {p=q;continue;}
      // Retain the unblocked component so diagonal gestures slide along the edge.
      const candidates=[{x:q.x,y:p.y},{x:p.x,y:q.y}].filter(q=>valid(q.x,q.y));
      candidates.sort((a,b)=>Math.hypot((a.x-target.x)*width,(a.y-target.y)*height)-Math.hypot((b.x-target.x)*width,(b.y-target.y)*height));
      if (candidates.length) p=candidates[0]; else break;
    }
    return p;
  }
  return {nearest,move};
}
