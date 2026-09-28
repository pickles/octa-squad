// Per-unit timers, the squad's order execution (incl. tools), enemy behaviour, movement.
import type { Sim } from '../sim';
import type { Entity, With, Pt } from '../ecs';
import { SYSN, TOOLS } from '../data';
import type { SubsystemKey } from '../data';
import { TERR } from '../map';
import { dist } from '../rng';
import { launchMissile } from './combat';

// ---------------------------------------------------------------- status: cooldowns, reload, hiding, repairs, lifetimes
export function statusSystem(s: Sim, dt: number) {
  for (const u of s.world.alive()) {
    if (u.weapon) {
      const w = u.weapon; w.cd -= dt; w.fireT -= dt;
      if (w.reloadT > 0) { w.reloadT -= dt; if (w.reloadT <= 0 && w.nextAmmo) { w.ammoType = w.nextAmmo; w.nextAmmo = null } }
    }
    if (u.stealth) u.stealth.revealT -= dt;
    if (u.mover) u.mover.repathT -= dt;
    if (u.toolbelt) u.toolbelt.cd -= dt;
    if (u.health && u.health.hitT > 0) u.health.hitT -= dt;
    const sq = u.squad;
    if (sq) {
      if (sq.order === 'hide' && !u.mover!.path.length && !sq.hidden) {
        sq.hideT += dt;
        if (sq.hideT >= 2) { sq.hidden = true; s.log(`${String(sq.no).padStart(2, '0')} ${sq.pilot}機、隠蔽完了`) }
      }
      if (sq.hidden && (sq.order !== 'hide' || u.mover!.path.length)) { sq.hidden = false; sq.hideT = 0 }
    }
    const sy = u.systems;
    if (sy && (sy.fcs || sy.legs || sy.sensor)) {
      let rate = u.regen ? 1 / 20 : 0;
      for (const a of s.world.alive('repairer')) if (a.team === u.team && a !== u && dist(a.pos, u.pos) <= a.repairer.radius) rate = Math.max(rate, 1 / 6);
      if (rate) {
        sy.fixP += dt * rate;
        if (sy.fixP >= 1) {
          sy.fixP = 0; const k = (['legs', 'fcs', 'sensor'] as SubsystemKey[]).find(k2 => sy[k2])!; sy[k] = false;
          if (sq) s.log(`${String(sq.no).padStart(2, '0')} ${sq.pilot}機：${SYSN[k]}を修理`, 'info');
        }
      }
    }
    if (u.ephemeral) {
      u.ephemeral.ttl -= dt;
      if (u.ephemeral.ttl <= 0) { u.life.alive = false; u.life.gone = true; if (u.ephemeral.kind === 'decoy') s.log('デコイの効果が切れた'); continue }
    }
    if (u.regen && u.health) u.health.hp = Math.min(u.health.maxHp, u.health.hp + u.regen.rate * dt);
  }
  // field repair
  for (const r of s.world.alive('repairer')) {
    for (const a of s.world.alive('health')) {
      if (a.team !== r.team || a === r || a.structure || a.ephemeral || dist(a.pos, r.pos) > r.repairer.radius || a.health.hp >= a.health.maxHp) continue;
      a.health.hp = Math.min(a.health.maxHp, a.health.hp + r.repairer.rate * dt);
      if ((s.tickN + a.id) % 18 === 0) s.emit({ k: 'heal', x: a.pos.x, y: a.pos.y });
    }
  }
}

// ---------------------------------------------------------------- squad orders
export function squadSystem(s: Sim) {
  for (const u of s.world.alive('squad', 'mover')) {
    const sq = u.squad, mv = u.mover;
    if (u.toolbelt?.pending) { handleTool(s, u); if (u.toolbelt.pending) continue }
    if (sq.order === 'attack') {
      const t = s.world.get(sq.target);
      if (!t || !t.life.alive) { sq.order = 'idle'; sq.target = null; mv.path = [] }
      else if (s.canSee(u, t)) {
        const d = dist(u.pos, t.pos), r = s.rangeOf(u);
        if (d > r * 0.92) { if (mv.repathT <= 0) { mv.path = s.map.findPath(u.pos.x, u.pos.y, t.pos.x, t.pos.y); mv.repathT = 0.6 } } else mv.path = [];
      } else if (!mv.path.length) { sq.order = 'idle'; sq.target = null }
    }
    if (sq.order === 'move' && !mv.path.length) sq.order = 'idle';
    if (sq.order === 'idle' && sq.stance === 'free' && u.weapon) {
      let best: Entity | null = null, bd = (u.sensor?.range || 5) + 2;
      for (const e of s.enemies()) { if (!s.seenE.has(e.id)) continue; const d = dist(u.pos, e.pos); if (d < bd) { bd = d; best = e } }
      if (best) { sq.order = 'attack'; sq.target = best.id; mv.repathT = 0 }
    }
  }
}

function handleTool(s: Sim, u: With<'squad' | 'mover'>) {
  const tb = u.toolbelt!, P = tb.pending!, T = TOOLS[tb.tool];
  if (tb.ammo <= 0) { tb.pending = null; u.squad.order = 'idle'; return }
  let tx = P.x, ty = P.y, tgt: Entity | undefined;
  if (T.target === 'enemy' || T.target === 'struct') {
    tgt = s.world.get(P.t);
    if (!tgt || !tgt.life.alive) { tb.pending = null; u.squad.order = 'idle'; u.mover.path = []; return }
    if (s.seenE.has(tgt.id)) { tx = tgt.pos.x; ty = tgt.pos.y; P.x = tx; P.y = ty }
  }
  const d = Math.hypot(tx - u.pos.x, ty - u.pos.y);
  const ok = T.target === 'enemy' ? s.canLock(u, tgt) : T.target === 'struct' ? (d <= T.range! + 0.6 && s.seenE.has(tgt!.id)) : d <= T.range!;
  if (ok) { u.mover.path = []; if (tb.cd > 0) return; useTool(s, u, tx, ty, tgt); tb.pending = null; u.squad.order = 'idle'; return }
  if (tgt && !s.seenE.has(tgt.id) && d < 1) { tb.pending = null; u.squad.order = 'idle'; return }
  if (u.mover.repathT <= 0) { u.mover.path = s.map.findPath(u.pos.x, u.pos.y, tx, ty); u.mover.repathT = 0.6 }
}

function useTool(s: Sim, u: Entity, x: number, y: number, t: Entity | undefined) {
  const tb = u.toolbelt!, T = TOOLS[tb.tool];
  if (tb.tool === 'missile') { launchMissile(s, u, t!); return }
  tb.ammo--; tb.cd = T.cd || 1;
  const p = s.map.nearestPass(x, y);
  if (T.radius) {
    const k = tb.tool === 'jammer' ? 'jam' : tb.tool as 'chaff' | 'smoke' | 'flare';
    s.clouds.push({ k, x, y, r: T.radius, t: T.dur!, dur: T.dur!, team: u.team }); s.emit({ k: 'puff', x, y, r: T.radius });
  } else if (tb.tool === 'decoy' || tb.tool === 'probe') s.spawnPlaced(tb.tool, p, T.dur!);
  else if (tb.tool === 'mine') s.mines.push({ x: p.x, y: p.y, team: u.team, arm: 1.5, revealed: false, disarm: 0, src: u.id });
  else if (tb.tool === 'charge') s.charges.push({ x: t ? t.pos.x : x, y: t ? t.pos.y : y, t: 5, team: u.team, src: u.id });
  if (u.stealth && tb.tool !== 'mine') u.stealth.revealT = Math.max(u.stealth.revealT, 1);
  if (u.squad) s.log(`${String(u.squad.no).padStart(2, '0')} ${u.squad.pilot}機：${T.name}（残り${tb.ammo}）`, 'info');
}

// ---------------------------------------------------------------- enemy behaviour
export function enemySystem(s: Sim, dt: number) {
  const ours = s.world.alive().filter(p => p.team === 'P');
  const nearestDetected = (u: Entity, lim: number) => {
    let best: Entity | null = null, bd = lim;
    for (const p of ours) if (s.detP.has(p.id)) { const d = dist(u.pos, p.pos); if (d < bd) { bd = d; best = p } }
    return { best, bd };
  };
  for (const u of s.world.alive('enemyAI', 'mover')) {
    const ai = u.enemyAI, mv = u.mover;
    const chase = (t: Entity, d: number, re: number) => { const r = s.rangeOf(u); if (d > r * 0.9) { if (mv.repathT <= 0) { mv.path = s.map.findPath(u.pos.x, u.pos.y, t.pos.x, t.pos.y); mv.repathT = re } } else mv.path = [] };
    if (ai.state === 'patrol' && !mv.path.length && ai.patrol) { ai.pi = (ai.pi + 1) % ai.patrol.length; const p = ai.patrol[ai.pi]; mv.path = s.map.findPath(u.pos.x, u.pos.y, p.x, p.y) }
    if (ai.state === 'hunt' && s.huntGoal) {
      const { best, bd } = nearestDetected(u, 10);
      if (best) { ai.target = best.id; chase(best, bd, 0.8) }
      else if (mv.repathT <= 0) {
        ai.target = null;
        const goal = (s.intel && s.time - s.intelT < 12 && !s.pickup) ? s.intel : s.huntGoal;
        if (dist(u.pos, goal) > 1.8) mv.path = s.map.findPath(u.pos.x, u.pos.y, goal.x + (s.rnd() - .5) * 2, goal.y + (s.rnd() - .5) * 2);
        mv.repathT = 1.5;
      }
    } else if (ai.state === 'hunt') {
      if (mv.repathT <= 0) {
        let best: Entity | null = null, bd = 1e9;
        for (const p of ours) { const d = dist(u.pos, p.pos); if (d < bd) { bd = d; best = p } }
        if (best) { if (bd > s.rangeOf(u) * 0.9 || !s.detP.has(best.id)) mv.path = s.map.findPath(u.pos.x, u.pos.y, best.pos.x, best.pos.y); else mv.path = [] }
        mv.repathT = 1;
      }
    }
    // a unit being shot goes after its attacker rather than the nearest foe (so a heavy in front can't absorb all attention)
    let th: { id: number; v: number; pos: Pt | null } | undefined, thE: Entity | undefined;
    if (ai.aggro) {
      const k = Math.exp(-dt / 8);
      for (const a of ai.aggro) { a.v *= k; const e = s.world.get(a.id); if (!e || !e.life.alive) a.v = 0 }
      ai.aggro = ai.aggro.filter(a => a.v > 4);
      for (const a of ai.aggro) if (a.pos && (!th || a.v > th.v)) th = a;
      if (th) thE = s.world.get(th.id);
    }
    if (ai.state === 'engage' && th && thE) {
      if (s.detP.has(thE.id)) { th.pos = { ...thE.pos }; ai.lastKnown = { ...thE.pos }; ai.lostT = 0; ai.target = thE.id; chase(thE, dist(u.pos, thE.pos), 0.8) }
      else {
        const near = nearestDetected(u, s.rangeOf(u)); ai.target = near.best ? near.best.id : null;
        const p = th.pos!;
        if (dist(u.pos, p) <= 0.8) th.pos = null;
        else if (mv.repathT <= 0) { mv.path = s.map.findPath(u.pos.x, u.pos.y, p.x, p.y); mv.repathT = 1.2 }
      }
    } else if (ai.state === 'engage') {
      const { best, bd } = nearestDetected(u, 10);
      if (best) { ai.lastKnown = { ...best.pos }; ai.lostT = 0; ai.target = best.id; chase(best, bd, 0.8) }
      else {
        ai.lostT += dt; ai.target = null;
        if (ai.lastKnown && mv.repathT <= 0 && !mv.path.length && dist(u.pos, ai.lastKnown) > 0.8) { mv.path = s.map.findPath(u.pos.x, u.pos.y, ai.lastKnown.x, ai.lastKnown.y); mv.repathT = 1.5 }
        if (ai.lostT > 9) { ai.state = 'return'; mv.path = s.map.findPath(u.pos.x, u.pos.y, ai.home.x, ai.home.y); ai.alertLogged = false }
      }
    }
    if (ai.state === 'return' && !mv.path.length) ai.state = ai.patrol ? 'patrol' : 'guard';
    const tb = u.toolbelt;
    if (tb && tb.tool === 'missile' && tb.ammo > 0 && tb.cd <= 0 && (ai.state === 'engage' || ai.state === 'hunt')) {
      let best: Entity | null = null, bd = 1e9;
      for (const p of ours) if (s.canLock(u, p)) { const d = dist(u.pos, p.pos) + (p.ephemeral?.kind === 'decoy' ? -3 : 0); if (d < bd) { bd = d; best = p } }
      if (best) launchMissile(s, u, best);
    }
  }
}

// ---------------------------------------------------------------- movement
export function movementSystem(s: Sim, dt: number) {
  if (s.m.road) {
    const trucks = s.world.alive('truck');
    trucks.forEach((u, i) => { u.truck.hold = !s.convoyGo || (i > 0 && dist(u.pos, trucks[i - 1].pos) < 1.3) });
  }
  for (const u of s.world.alive('mover')) {
    if (u.truck?.hold) continue;
    const mv = u.mover; if (!mv.path.length) continue;
    const w = mv.path[0], dx = w.x - u.pos.x, dy = w.y - u.pos.y, d = Math.hypot(dx, dy);
    let spd = s.effSpeed(u);
    if (mv.cap && u.squad?.order === 'move') spd = Math.min(spd, mv.cap);
    const step = spd * dt / TERR[s.map.at(u.pos.x, u.pos.y)].move;
    if (d <= step) { u.pos.x = w.x; u.pos.y = w.y; mv.path.shift() } else { u.pos.x += dx / d * step; u.pos.y += dy / d * step }
    // unstick: barely moved for a second while trying to move (two units blocking head-on) -> sidestep
    mv.stT += dt;
    if (mv.stT >= 1) {
      const moved = mv.stP ? Math.hypot(u.pos.x - mv.stP.x, u.pos.y - mv.stP.y) : 9; mv.stT = 0; mv.stP = { ...u.pos };
      if (moved < 0.15 && d > 0.3) { const side = (u.id % 2 ? 1 : -1) * 0.45, px = -dy / d * side, py = dx / d * side; if (s.map.pass(u.pos.x + px, u.pos.y + py)) { u.pos.x += px; u.pos.y += py } }
    }
  }
}

export function separationSystem(s: Sim) {
  const us = s.world.alive('mover');
  for (let i = 0; i < us.length; i++) for (let j = i + 1; j < us.length; j++) {
    const a = us[i].pos, b = us[j].pos, dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
    if (d < 0.5) {
      const push = (0.5 - d) / 2, nx = dx / d * push, ny = dy / d * push;
      if (s.map.pass(a.x - nx, a.y - ny)) { a.x -= nx; a.y -= ny }
      if (s.map.pass(b.x + nx, b.y + ny)) { b.x += nx; b.y += ny }
    }
  }
}
