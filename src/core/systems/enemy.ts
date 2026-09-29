// Enemy behaviour, in two layers:
//  - command(): every 0.5s each fire team (EGroup) updates what it knows and picks a state
//    (idle → rally → attack ⇄ withdraw/hold → search → return), and calls for help by radio.
//  - unitStep(): every tick each unit turns its team's state into a movement goal and target.
// Everything iterates in creation order and uses only s.rnd(), so it stays deterministic.
import type { Sim } from '../sim';
import type { EGroup, Entity, Pt, With } from '../ecs';
import { T } from '../map';
import { dist } from '../rng';
import { launchMissile } from './combat';

type EU = With<'enemyAI' | 'mover'>;
/** Radio reach between teams, and via a working radar tower. */
const COMM = 9, RADAR_COMM = 13;
/** How long a contact report stays actionable. */
const FRESH = 10;
const FIX_TYPES = new Set(['gunner', 'heavy', 'sniper', 'launcher', 'mortar']);

const centroid = (m: Entity[]): Pt => ({ x: m.reduce((a, u) => a + u.pos.x, 0) / m.length, y: m.reduce((a, u) => a + u.pos.y, 0) / m.length });
const fresh = (s: Sim, g: EGroup) => !!g.contact && s.time - g.contactT < FRESH;

export function enemySystem(s: Sim, dt: number) {
  const byG = new Map<number, EU[]>();
  for (const u of s.world.alive('enemyAI', 'mover')) { let a = byG.get(u.enemyAI.gid); if (!a) byG.set(u.enemyAI.gid, a = []); a.push(u) }
  if (s.tickN % 15 === 0) for (const g of s.egroups) { const m = byG.get(g.id); if (m?.length) command(s, g, m) }
  for (const [gid, m] of byG) for (let i = 0; i < m.length; i++) unitStep(s, m[i], s.egroups[gid], m, i, dt);
}

// ---------------------------------------------------------------- knowledge & radio
/** Something of ours was spotted/heard by an enemy unit or structure. */
export function reportContact(s: Sim, src: Entity, p: Pt) {
  if (src.enemyAI) { const g = s.egroups[src.enemyAI.gid]; g.contact = { ...p }; g.contactT = s.time; return }
  const k = s.etype(src);
  if (k === 'radar') {
    const st = src.structure!;
    if (!st.alerted) { st.alerted = true; s.log('レーダー塔に探知された！周辺の敵部隊に通報された', 'warning') }
    callSupport(s, src.pos, p, null, true);
  } else callSupport(s, src.pos, p, null, false, 6);
}

function radarUp(s: Sim) {
  return s.world.alive('structure').find(a => a.structure.kind === 'radar' && !s.inCloud('jam', a.pos));
}

/** Radio call: other teams in reach decide by their role whether to come. */
function callSupport(s: Sim, from: Pt, pos: Pt, caller: EGroup | null, viaRadar = false, reach = COMM) {
  if (s.inCloud('jam', from)) return; // jammed: the call doesn't get out
  const radar = radarUp(s);
  let n = 0;
  for (const h of s.egroups) {
    if (h === caller || h.deaf) continue;
    const m = s.world.alive('enemyAI').filter(u => u.enemyAI.gid === h.id);
    if (!m.length) continue;
    const hc = centroid(m);
    if (s.inCloud('jam', hc)) continue; // jammed: can't hear
    const relay = !!radar && dist(radar.pos, hc) <= RADAR_COMM && (viaRadar || dist(radar.pos, from) <= RADAR_COMM);
    if (dist(hc, from) > reach && !relay) continue;
    const d = dist(hc, pos);
    const come = h.role === 'reserve' || h.role === 'hunt' || (h.role === 'patrol' && d <= 12) || (h.role === 'garrison' && dist(h.post, pos) <= h.leash + 2);
    // everyone in reach learns where we are (overwatch uses it for missiles, garrisons get ready)
    if (!fresh(s, h) || s.time - h.contactT > 2) { h.contact = { ...pos }; h.contactT = s.time }
    if (come && (h.state === 'idle' || h.state === 'return' || h.state === 'search')) { startEngage(s, h, m, hc); h.heardFrom = caller?.id ?? -1; n++ }
    else if (!come && h.state === 'idle' && h.role !== 'overwatch') { h.state = 'hold'; h.t = 0 }
  }
  if (n) s.count('radioCalls', n);
  if (n && s.time - s.radioLogT > 12) { s.radioLogT = s.time; s.log(`敵の通信が活発化：${n}隊が移動を開始`, 'warning') }
}

/** Our (enemy-side) strength converging on a contact point: members of teams rallying/attacking there, weighted by hp. */
function forceAt(s: Sim, c: Pt, self: EGroup) {
  let f = 0;
  for (const u of s.world.alive('enemyAI')) {
    const h = s.egroups[u.enemyAI.gid];
    const joining = h === self || ((h.state === 'rally' || h.state === 'attack') && !!h.contact && dist(h.contact, c) < 7);
    if (joining && u.health) f += 0.4 + 0.6 * u.health.hp / u.health.maxHp;
  }
  return f;
}
/** Too weak to go in alone: wait in cover and let the radio bring others. */
const outnumbered = (s: Sim, g: EGroup, m: Entity[]) => g.role !== 'hunt' && g.seenN >= 2 && forceAt(s, g.contact!, g) < g.seenN * 0.8;

function startEngage(s: Sim, g: EGroup, m: Entity[], gc: Pt) {
  if (outnumbered(s, g, m)) { g.state = 'withdraw'; g.t = 0; g.fallback = pickFallback(s, g, gc, g.contact!); return }
  const c = g.contact!;
  const d = dist(gc, c);
  // gather out of sight first, then go in together
  g.rally = d > 7 ? s.map.nearestPass(c.x + (gc.x - c.x) / d * 6, c.y + (gc.y - c.y) / d * 6) : { ...gc };
  g.flankSide = s.rnd() < 0.5 ? 1 : -1;
  g.state = m.length > 1 && d > 5 ? 'rally' : 'attack'; g.t = 0;
  if (g.state === 'attack') assignParts(g, m);
}

function assignParts(g: EGroup, m: Entity[]) {
  const fix = m.filter(u => FIX_TYPES.has(u.enemyAI!.etype));
  for (const u of m) u.enemyAI!.part = m.length < 2 || fix.includes(u) ? 'fix' : 'flank';
  if (!fix.length && m.length >= 2) m[0].enemyAI!.part = 'fix';
}

/** Cover to fall back to: hill > forest, near the post, away from the threat. */
function pickFallback(s: Sim, g: EGroup, gc: Pt, threat: Pt): Pt {
  const base = g.role === 'garrison' || g.role === 'overwatch' ? g.post : gc;
  let best: Pt = base, bs = -1e9;
  for (let y = Math.max(0, Math.floor(base.y - 6)); y <= Math.min(27, Math.floor(base.y + 6)); y++)
    for (let x = Math.max(0, Math.floor(base.x - 6)); x <= Math.min(27, Math.floor(base.x + 6)); x++) {
      const t = s.map.at(x + .5, y + .5); if (!s.map.pass(x + .5, y + .5)) continue;
      const p = { x: x + .5, y: y + .5 }, dt = dist(p, threat), dg = dist(p, gc);
      if (dg > 7) continue;
      const sc = (t === T.HILL ? 3 : t === T.FOREST ? 2.2 : 0) + Math.min(dt, 9) * 0.5 - dg * 0.35 - (dt < dist(gc, threat) ? 3 : 0);
      if (sc > bs) { bs = sc; best = p }
    }
  return best;
}

// ---------------------------------------------------------------- team decisions (2 Hz)
function command(s: Sim, g: EGroup, m: EU[]) {
  g.t += 0.5;
  const gc = centroid(m);
  // what the team sees now
  let best: Entity | null = null, bd = 1e9;
  for (const p of s.world.alive()) {
    if (p.team !== 'P' || !s.detP.has(p.id)) continue;
    for (const u of m) { const d = dist(u.pos, p.pos); if (d <= 10 && d < bd) { bd = d; best = p } }
  }
  if (best) {
    g.contact = { ...best.pos }; g.contactT = s.time;
    const bp = best.pos;
    const n = s.world.alive('squad').filter(p => s.detP.has(p.id) && dist(p.pos, bp) <= 5).length;
    // remember the biggest force seen recently, not just what is visible this instant
    if (n >= g.seenN || s.time - g.seenT > 20) { g.seenN = n; g.seenT = s.time }
  }
  else for (const u of m) for (const a of u.enemyAI.aggro ?? []) if (a.pos && a.v > 8) { g.contact = { ...a.pos }; g.contactT = s.time }
  const f = fresh(s, g);
  const hp = m.reduce((a, u) => a + (u.health ? u.health.hp / u.health.maxHp : 1), 0) / m.length;

  if (g.role === 'overwatch') { g.state = f ? 'hold' : 'idle'; if (f && s.time - g.calledT > 8) { g.calledT = s.time; callSupport(s, gc, g.contact!, g) } return }

  if (g.ambush && f && (g.state === 'idle' || g.state === 'hold')) {
    // ambushers stay put and hidden until you walk in close or shoot them
    if (dist(gc, g.contact!) <= 4.5 || s.time - g.lastHurt < 1) { g.ambush = false; startEngage(s, g, m, gc) } else { g.state = 'hold'; return }
  }
  if (f && (g.state === 'idle' || g.state === 'return' || g.state === 'search')) {
    const leashed = g.role === 'garrison' && dist(g.post, g.contact!) > g.leash + 3;
    if (leashed) { g.state = 'hold'; g.t = 0 } else startEngage(s, g, m, gc);
  }
  if (f && s.time - g.calledT > 8 && g.state !== 'idle') { g.calledT = s.time; callSupport(s, gc, g.contact!, g) }
  if (!f && (g.state === 'rally' || g.state === 'attack' || g.state === 'hold' || g.state === 'withdraw')) { g.state = 'search'; g.t = 0 }

  switch (g.state) {
    case 'rally': {
      const r = g.rally!;
      if (outnumbered(s, g, m)) { g.state = 'withdraw'; g.t = 0; g.fallback = pickFallback(s, g, gc, g.contact!) }
      else if (m.every(u => dist(u.pos, r) < 2.6) || g.t > 9 || (best && bd < 4.5)) { g.state = 'attack'; g.t = 0; assignParts(g, m) }
      break;
    }
    case 'attack': {
      if (outnumbered(s, g, m) && g.t > 1) { g.state = 'withdraw'; g.t = 0; g.fallback = pickFallback(s, g, gc, g.contact!); break }
      // out-ranged: charge if we clearly outnumber what we've seen (and aren't tied to a post), otherwise fall back to cover
      const outranged = s.time - g.lastHurt < 2.5 && s.time - g.lastFire > 5 && dist(gc, g.contact!) > 5.5;
      const canCharge = g.role !== 'garrison' && forceAt(s, g.contact!, g) >= Math.max(1, g.seenN) * 1.5;
      if (((outranged && !canCharge) || hp < 0.4) && g.role !== 'hunt') { g.state = 'withdraw'; g.t = 0; g.fallback = pickFallback(s, g, gc, g.contact!) }
      else if (g.role === 'garrison' && dist(g.post, g.contact!) > g.leash + 3) { g.state = 'withdraw'; g.t = 0; g.fallback = pickFallback(s, g, g.post, g.contact!) }
      break;
    }
    case 'withdraw':
      if (m.every(u => dist(u.pos, g.fallback!) < 2.2) || g.t > 12) { g.state = 'hold'; g.t = 0 }
      break;
    case 'hold':
      // regroup at cover, then go again if strong enough and allowed
      if (f && g.t > 8 && hp >= 0.45 && !outnumbered(s, g, m) && !(g.role === 'garrison' && dist(g.post, g.contact!) > g.leash + 3)) startEngage(s, g, m, gc);
      break;
    case 'search':
      if (g.role === 'hunt') break;
      if (g.t > 14 || !g.contact || m.some(u => dist(u.pos, g.contact!) < 1.2)) { g.state = 'return'; g.t = 0 }
      break;
    case 'return':
      if (m.every(u => dist(u.pos, u.enemyAI.home) < 1.5)) { g.state = 'idle'; g.t = 0 }
      break;
  }
}

// ---------------------------------------------------------------- per-unit execution
function chooseTarget(s: Sim, u: EU): Entity | null {
  let best: Entity | null = null, bs = 1e9;
  const ag = u.enemyAI.aggro;
  for (const p of s.world.alive()) {
    if (p.team !== 'P' || !s.detP.has(p.id)) continue;
    const d = dist(u.pos, p.pos); if (d > 10) continue;
    if (p.ephemeral?.kind === 'decoy' && d < 3) continue; // close enough to see it's a dummy
    const a = ag?.find(x => x.id === p.id)?.v ?? 0;
    // closer, weaker, and whoever hurt us most
    const sc = d - (p.ephemeral?.kind === 'decoy' ? 3 : 0) - a * 0.08 - (p.health ? (1 - p.health.hp / p.health.maxHp) * 1.2 : 0) - (p.repairer ? 0.6 : 0) + (p.truck ? -1 : 0);
    if (sc < bs) { bs = sc; best = p }
  }
  return best;
}

function moveTo(s: Sim, u: EU, goal: Pt | null) {
  const ai = u.enemyAI, mv = u.mover;
  if (!goal) { mv.path = []; ai.goalAt = null; return }
  if (dist(u.pos, goal) < 0.5) { mv.path = []; return }
  if (mv.repathT > 0) return;
  if (!ai.goalAt || dist(goal, ai.goalAt) > 0.8 || !mv.path.length) { mv.path = s.map.findPath(u.pos.x, u.pos.y, goal.x, goal.y); ai.goalAt = { ...goal }; mv.repathT = 0.7 }
}

const leash = (g: EGroup, p: Pt): Pt => {
  if (g.role !== 'garrison') return p;
  const d = dist(g.post, p); if (d <= g.leash) return p;
  return { x: g.post.x + (p.x - g.post.x) / d * g.leash, y: g.post.y + (p.y - g.post.y) / d * g.leash };
};

function unitStep(s: Sim, u: EU, g: EGroup, m: EU[], i: number, dt: number) {
  const ai = u.enemyAI;
  if (ai.aggro) {
    const k = Math.exp(-dt / 8);
    for (const a of ai.aggro) { a.v *= k; const e = s.world.get(a.id); if (!e || !e.life.alive) a.v = 0 }
    ai.aggro = ai.aggro.filter(a => a.v > 4);
  }
  if (ai.hidden && !g.ambush) ai.hidden = false;
  const tgt = chooseTarget(s, u);
  ai.target = tgt?.id ?? null;
  const c = g.contact, r = s.rangeOf(u);
  let goal: Pt | null = null;

  switch (g.state) {
    case 'idle':
      if (g.role === 'patrol' && g.patrol) {
        if (i === 0) { const p = g.patrol[g.pi]; if (dist(u.pos, p) < 0.8) g.pi = (g.pi + 1) % g.patrol.length; goal = g.patrol[g.pi] }
        else goal = dist(u.pos, m[0].pos) > 1.8 ? m[0].pos : null;
      } else goal = dist(u.pos, ai.home) > 1 ? ai.home : null;
      ai.state = g.role === 'patrol' ? 'patrol' : 'guard';
      break;
    case 'rally':
      goal = { x: g.rally!.x + (i % 2 ? .8 : -.8) * Math.ceil(i / 2) * 0.7, y: g.rally!.y + (i % 2 ? .4 : -.4) };
      ai.state = 'rally';
      break;
    case 'attack': {
      ai.state = ai.part === 'flank' ? 'flank' : 'engage';
      const gc = centroid(m);
      if (ai.part === 'flank' && c && g.t < 12) {
        // swing wide around the contact (and around any smoke) to hit it from the side
        const dx = c.x - gc.x, dy = c.y - gc.y, L = Math.hypot(dx, dy) || 1;
        const F = s.map.nearestPass(c.x + (-dy / L) * 3.8 * g.flankSide - dx / L * 0.8, c.y + (dx / L) * 3.8 * g.flankSide - dy / L * 0.8);
        if (dist(u.pos, F) > 1.2 && !(tgt && dist(u.pos, tgt.pos) <= r && !s.smokeOn(u.pos, tgt.pos))) { goal = F; break }
      }
      if (tgt) {
        const d = dist(u.pos, tgt.pos);
        if (s.smokeOn(u.pos, tgt.pos) && s.inCloud('smoke', tgt.pos)) {
          // don't walk into smoke: hold at the edge (fix) or keep circling (flank)
          goal = ai.part === 'flank' && c ? { x: tgt.pos.x + (u.pos.x - tgt.pos.x) * 0.3 + g.flankSide * 2.5, y: tgt.pos.y + (u.pos.y - tgt.pos.y) * 0.3 - g.flankSide * 2.5 } : null;
        } else goal = d > r * 0.9 ? tgt.pos : null;
      } else goal = c;
      break;
    }
    case 'withdraw':
      goal = { x: g.fallback!.x + (i % 2 ? .7 : -.7) * Math.ceil(i / 2), y: g.fallback!.y };
      ai.state = 'withdraw';
      // scouts leave a mine on the way out when chased
      if (u.toolbelt?.tool === 'mine' && u.toolbelt.ammo > 0 && u.toolbelt.cd <= 0 && tgt && dist(u.pos, tgt.pos) < 6 && dist(u.pos, g.fallback!) > 2) {
        u.toolbelt.ammo--; u.toolbelt.cd = 6;
        s.mines.push({ x: u.pos.x, y: u.pos.y, team: 'E', arm: 1.5, revealed: s.seenE.has(u.id), disarm: 0, src: u.id });
        if (s.seenE.has(u.id)) s.log(`${u.name}が地雷を置いた`, 'warning');
      }
      break;
    case 'hold':
      goal = tgt && !g.ambush && dist(u.pos, tgt.pos) > r && dist(u.pos, tgt.pos) < r + 1.5 && g.role !== 'overwatch' ? tgt.pos : (g.role === 'overwatch' && dist(u.pos, ai.home) > 1 ? ai.home : null);
      ai.state = 'hold';
      break;
    case 'search':
      if (g.role === 'hunt') {
        // no fixed goal (training waves): head for the last report, else straight at the squad
        const sq = s.livingSquad(), sc = sq.length ? { x: sq.reduce((a, q) => a + q.pos.x, 0) / sq.length, y: sq.reduce((a, q) => a + q.pos.y, 0) / sq.length } : c;
        const hg = s.huntGoal ? ((s.intel && s.time - s.intelT < 12 && !s.pickup) ? s.intel : s.huntGoal) : ((s.intel && s.time - s.intelT < 12) ? s.intel : sc);
        goal = tgt ? (dist(u.pos, tgt.pos) > r * 0.9 ? tgt.pos : null) : hg;
        ai.state = 'hunt';
      } else { goal = c; ai.state = 'search' }
      break;
    case 'return':
      goal = ai.home; ai.state = 'return';
      break;
  }
  if (goal && g.state !== 'withdraw') goal = leash(g, goal);
  moveTo(s, u, goal);

  // missiles: radar-guided lock (see Sim.canLock)
  const tb = u.toolbelt;
  if (tb && tb.tool === 'missile' && tb.ammo > 0 && tb.cd <= 0 && g.state !== 'idle') {
    let best: Entity | null = null, bd = 1e9;
    for (const p of s.world.alive()) if (p.team === 'P' && s.canLock(u, p)) { const d = dist(u.pos, p.pos) + (p.ephemeral?.kind === 'decoy' ? -3 : 0); if (d < bd) { bd = d; best = p } }
    // locking on takes time: 1.5s on something it sees, 3s when homing on radar emissions only.
    // A radar that is only switched on briefly can't be hit; a warning tells the target it is being locked.
    if (!best) ai.lock = undefined;
    else {
      if (ai.lock?.id !== best.id) {
        ai.lock = { id: best.id, t: 0 };
        if (best.squad) s.log(`ロックオン警報：${best.squad.pilot}機が${u.name}に狙われている`, 'warning');
      }
      ai.lock.t += dt;
      const sees = s.detP.has(best.id) && dist(u.pos, best.pos) <= s.effSensor(u);
      if (ai.lock.t >= (sees || best.ephemeral ? 1.5 : 3)) { launchMissile(s, u, best); tb.cd = ai.etype === 'launcher' ? 6 : 9; ai.lock = undefined }
    }
  } else if (ai.lock) ai.lock = undefined;
  // mortars: shell any tight cluster of ours they know about
  if (ai.etype === 'mortar') {
    ai.cd = (ai.cd ?? 4) - dt;
    if (ai.cd <= 0 && g.state !== 'idle') {
      const seen = s.world.alive().filter(p => p.team === 'P' && p.squad && s.detP.has(p.id));
      for (const p of seen) {
        const near = seen.filter(q => dist(q.pos, p.pos) <= 2.2).length;
        if (near < 3 || dist(u.pos, p.pos) > 15) continue;
        if (s.world.alive('enemyAI').some(e => dist(e.pos, p.pos) < 2.5)) continue;
        const at = s.time + 4;
        for (let k = 0; k < 4; k++) { const a = s.rnd() * Math.PI * 2, rr = Math.sqrt(s.rnd()) * 1.6; s.shells.push({ x: p.pos.x + Math.cos(a) * rr, y: p.pos.y + Math.sin(a) * rr, at: at + k * 0.4, cx: p.pos.x, cy: p.pos.y, light: true }) }
        s.log('迫撃砲の発射音！密集している機体は散開せよ', 'warning');
        ai.cd = 16; break;
      }
    }
  }
}
