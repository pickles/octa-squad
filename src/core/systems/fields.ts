// Area effects on the ground: clouds, mines, incoming shells, demolition charges.
import type { Sim } from '../sim';
import { TOOLS } from '../data';
import { artyHit, blast, damage, armorMul } from './combat';

export function fieldSystem(s: Sim, dt: number) {
  for (const c of s.clouds) c.t -= dt;
  s.clouds = s.clouds.filter(c => c.t > 0);

  for (const m of s.mines) {
    if (m.arm > 0) { m.arm -= dt; continue }
    if (m.team === 'E') {
      for (const u of s.world.alive('squad')) {
        if (u.squad.mmode !== 'careful') continue;
        const d = Math.hypot(u.pos.x - m.x, u.pos.y - m.y);
        if (d <= 2.5 && !m.revealed) { m.revealed = true; s.log('地雷を発見', 'info') }
        if (m.revealed && d <= 1.2 && !u.mover!.path.length) { m.disarm += dt / 2; if (m.disarm >= 1) { m.done = true; s.count('disarm'); s.log(`${u.squad.pilot}機が地雷を処理`, 'info') } }
      }
      if (m.done) continue;
    }
    const vic = s.world.alive().find(e => e.team !== m.team && e.mover && Math.hypot(e.pos.x - m.x, e.pos.y - m.y) <= (m.team === 'E' ? 0.6 : 0.8) && !(m.team === 'E' && m.revealed && e.squad?.mmode === 'careful'));
    if (vic) {
      m.done = true; s.cause = 'mine'; blast(s, m.x, m.y, m.team, TOOLS.mine.dmg!, TOOLS.mine.splash!, null, m.src); s.cause = 'bullet';
      if (m.team === 'E') s.count('mineHit');
      // a mine always takes the legs of whoever stepped on it (slows the chase)
      if (vic.life.alive && vic.systems && !vic.systems.legs) { vic.systems.legs = true; vic.systems.fixP = 0; if (m.team === 'P') s.count('mineLegs'); else if (vic.squad) s.log(`${vic.squad.pilot}機：脚部損傷`, 'warning') }
      if (m.team === 'E') s.log(`地雷を踏んだ！（${vic.squad ? vic.squad.pilot + '機' : vic.name}）`, 'warning'); else s.log('地雷が起爆', 'info');
    }
  }
  s.mines = s.mines.filter(m => !m.done);

  for (const sh of s.shells) if (s.time >= sh.at) { sh.done = true; artyHit(s, sh.x, sh.y); s.cause = 'bullet' }
  s.shells = s.shells.filter(x => !x.done);

  for (const c of s.charges) {
    c.t -= dt; if (c.t > 0) continue;
    c.done = true; s.emit({ k: 'boom', x: c.x, y: c.y, r: 1.8 }); s.cause = 'charge';
    const src = s.world.get(c.src) || null;
    for (const o of s.world.alive()) {
      if (o.team === c.team || !o.health || Math.hypot(o.pos.x - c.x, o.pos.y - c.y) > 1.5 + (o.structure ? 0.6 : 0)) continue;
      damage(s, o, o.structure ? TOOLS.charge.dmg! : 100 * armorMul(o.health.armor), src);
    }
    s.cause = 'bullet'; s.log('爆薬が爆発', 'info');
  }
  s.charges = s.charges.filter(c => !c.done);
}
