// The system pipeline. Order matters and is fixed so that the simulation is deterministic.
import type { Sim } from '../sim';
import { visionSystem } from './vision';
import { statusSystem, squadSystem, movementSystem, separationSystem } from './units';
import { enemySystem } from './enemy';
import { advisorSystem } from './advisor';
import { fireSystem, projectileSystem } from './combat';
import { fieldSystem } from './fields';

function missionSystem(s: Sim, dt: number) {
  for (const site of s.sites) {
    const st = site.structure!;
    if (!st.scanned && s.seenE.has(site.id)) { st.scan += dt / 2; if (st.scan >= 1) { st.scanned = true; s.log(`敵野営地 ${st.label} を特定`, 'info') } }
  }
  if (s.m.road) for (const u of s.world.alive('truck')) if (!u.mover!.path.length) { u.life.alive = false; u.life.gone = true; s.arrived++; s.log(`${u.name} 到達`, 'info') }
  let r = s.m.check(s);
  if (!r && s.countP() === 0) r = { win: false, reason: '全機を失った' };
  if (!r && s.m.limit && s.time >= s.m.limit) r = { win: false, reason: '作戦時間切れ' };
  if (r) s.finish(r);
}

export const runSystems = {
  vision: visionSystem,
  all(s: Sim, dt: number) {
    s.time += dt;
    s.visTimer -= dt;
    if (s.visTimer <= 0) { s.visTimer = 0.15; visionSystem(s) }
    for (const ev of s.events) if (!ev.done && s.time >= ev.t) { ev.done = true; ev.fn(s) }
    statusSystem(s, dt);
    squadSystem(s);
    enemySystem(s, dt);
    movementSystem(s, dt);
    fireSystem(s);
    separationSystem(s);
    fieldSystem(s, dt);
    advisorSystem(s);
    projectileSystem(s, dt);
    missionSystem(s, dt);
  },
};
