// Fog of war and detection, both directions.
import type { Sim } from '../sim';
import { N } from '../map';
import { dist } from '../rng';
import { reportContact } from './enemy';

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
    const amb = e.enemyAI?.hidden && !(e.weapon && e.weapon.fireT > 0) ? 0.35 : 1; // ambushers lying in wait
    for (const p of ours) {
      const ff = (!s.hasRadar(p) && s.smokeOn(p.pos, e.pos) ? f * 0.4 : f) * amb;
      if (dist(e.pos, p.pos) <= s.effSensor(p) * ff) {
        s.seenE.add(e.id);
        if (p.ephemeral?.kind === 'probe' && !s.flags['probe:' + e.id]) { s.flags['probe:' + e.id] = true; s.count('probeSpot') }
        break;
      }
    }
    if (!s.seenE.has(e.id) && e.muzzle) { const v = s.world.get(e.muzzle.by); if (v && v.team === 'P' && s.muzzleSeen(e, v)) s.seenE.add(e.id) }
    if (!s.seenE.has(e.id) && !s.inCloud('smoke', e.pos)) for (const c of lights) if (Math.hypot(e.pos.x - c.x, e.pos.y - c.y) <= c.r) { s.seenE.add(e.id); if (!s.flags['flare:' + e.id]) { s.flags['flare:' + e.id] = true; s.count('flareSpot') } break }
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
        if (!s.detP.has(p.id) && e.enemyAI && !e.enemyAI.alertLogged) { e.enemyAI.alertLogged = true; s.log(`敵に発見された（${e.name}）`, 'warning') }
        s.detP.add(p.id); if (p.squad) s.everDetected.add(p.id);
        reportContact(s, e, p.pos);
        if (e.enemyAI) e.enemyAI.lastKnown = { ...p.pos };
      }
    }
  }
  // training counters
  for (const p of s.world.alive('squad')) if (p.squad.hidden && !s.detP.has(p.id))
    for (const e of foes) if (e.enemyAI && dist(e.pos, p.pos) < 4 && !s.flags['hid:' + e.id]) { s.flags['hid:' + e.id] = true; s.count('hidePass') }
  if (s.world.alive('structure').some(a => a.structure.kind === 'radar' && s.inCloud('jam', a.pos))) s.count('towerJam', 0.15);
}
