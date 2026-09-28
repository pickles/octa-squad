// Fog of war and detection, both directions.
import type { Sim } from '../sim';
import type { Entity } from '../ecs';
import { N } from '../map';
import { dist } from '../rng';

export function visionSystem(s: Sim) {
  s.vis.fill(0);
  const mark = (cx: number, cy: number, r: number) => {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(N - 1, Math.floor(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(N - 1, Math.floor(cx + r)); x++)
        if ((x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= r * r) { s.vis[y * N + x] = 1; s.explored[y * N + x] = 1 }
  };
  const lights = s.clouds.filter(c => c.k === 'flare');
  for (const c of lights) mark(c.x, c.y, c.r);
  const ours = s.world.alive('sensor').filter(u => u.team === 'P');
  for (const u of ours) mark(u.pos.x, u.pos.y, s.effSensor(u));

  // what we can see of the enemy
  s.seenE.clear();
  for (const e of s.enemies()) {
    const f = s.inForest(e) && !e.structure ? 0.7 : 1;
    for (const p of ours) { const ff = !s.hasRadar(p) && s.smokeOn(p.pos, e.pos) ? f * 0.4 : f; if (dist(e.pos, p.pos) <= s.effSensor(p) * ff) { s.seenE.add(e.id); break } }
    if (!s.seenE.has(e.id) && e.muzzle) { const v = s.world.get(e.muzzle.by); if (v && v.team === 'P' && s.muzzleSeen(e, v)) s.seenE.add(e.id) }
    if (!s.seenE.has(e.id) && !s.inCloud('smoke', e.pos)) for (const c of lights) if (Math.hypot(e.pos.x - c.x, e.pos.y - c.y) <= c.r) { s.seenE.add(e.id); break }
    if (s.seenE.has(e.id) && e.intel) e.intel.lastSeen = { ...e.pos };
  }

  // what the enemy can see of us
  if (s.detP.size) { const u = s.world.get([...s.detP][0]); if (u && u.life.alive) { s.intel = { ...u.pos }; s.intelT = s.time } }
  s.detP.clear();
  const foes = s.enemies().filter(e => e.sensor);
  for (const p of s.world.alive().filter(x => x.team === 'P')) {
    if (p.exposure) { p.exposure.margin = 99; p.exposure.warnBy = null }
    for (const e of foes) {
      let r = s.detRange(e, p); const d = dist(e.pos, p.pos);
      if (s.muzzleSeen(p, e)) r = Infinity;
      if (p.exposure && s.seenE.has(e.id) && d - r < p.exposure.margin) { p.exposure.margin = d - r; p.exposure.warnBy = e.id }
      if (d <= r) {
        s.detP.add(p.id);
        const ai = e.enemyAI;
        if (ai ? (ai.state === 'guard' || ai.state === 'patrol' || ai.state === 'return') : true) alertFrom(s, e, p);
        if (ai) { ai.lastKnown = { ...p.pos }; ai.lostT = 0 }
      }
    }
  }
}

/** An enemy (or radar tower) that spots us wakes up its neighbours. */
export function alertFrom(s: Sim, src: Entity, p: Entity) {
  const isRadar = s.etype(src) === 'radar';
  const rad = isRadar ? 13 : 5.5; let n = 0;
  for (const e of s.world.alive('enemyAI')) {
    const ai = e.enemyAI;
    if (dist(e.pos, src.pos) <= rad && (ai.state === 'guard' || ai.state === 'patrol' || ai.state === 'return')) { ai.state = 'engage'; ai.lastKnown = { ...p.pos }; ai.lostT = 0; n++ }
  }
  if (src.enemyAI && src.enemyAI.state !== 'engage') src.enemyAI.state = 'engage';
  if (isRadar && src.structure && !src.structure.alerted) { src.structure.alerted = true; s.log('レーダー塔に探知された！守備隊が集結中', 'warning') }
  else if (n && src.enemyAI && !src.enemyAI.alertLogged) { src.enemyAI.alertLogged = true; s.log(`敵に発見された（${src.name}）`, 'warning') }
}
