// Firing, projectiles, explosions and damage.
import type { Sim, Projectile } from '../sim';
import type { Entity } from '../ecs';
import { AMMO, SYSN, TOOLS } from '../data';
import type { SubsystemKey } from '../data';
import { dist } from '../rng';

const armorMul = (armor: number, k = 1) => Math.max(0.3, 1 - armor * 0.07 * k);
/** Damage of one bullet after armour: raw − armour, but never below 15% of raw. */
export const bulletDmg = (raw: number, armor: number) => Math.max(raw * 0.15, raw - armor);

export function fireSystem(s: Sim) {
  for (const u of s.world.alive('weapon')) {
    const w = u.weapon;
    if (w.cd > 0 || w.reloadT > 0) continue;
    const sq = u.squad;
    if (sq && sq.order === 'hide') continue;
    const noFire = !!sq && sq.stance === 'nofire';
    if (noFire && !(sq!.order === 'attack' && sq!.target != null)) continue;
    const r = s.rangeOf(u), min = w.def.min || 0;
    let t: Entity | undefined;
    const cur = s.targetOf(u);
    const fake = (e: Entity, d: number) => u.team === 'E' && e.ephemeral?.kind === 'decoy' && d < 3; // enemies up close recognise a decoy
    if (cur && cur.life.alive && s.canSee(u, cur)) { const d = dist(u.pos, cur.pos); if (d <= r && !(min && d < min) && !fake(cur, d)) t = cur }
    if (!t && !noFire) {
      let bd = 1e9;
      for (const e of s.world.alive()) {
        if (e.team === u.team || !e.health || !s.canSee(u, e)) continue;
        const d = dist(u.pos, e.pos);
        if (d <= r && !(min && d < min) && !fake(e, d)) {
          const score = d + (e.truck ? -1.5 : 0) + (e.structure ? 3 : 0) + (e.ephemeral?.kind === 'decoy' ? -2.5 : 0);
          if (score < bd) { bd = score; t = e }
        }
      }
    }
    if (!t) continue;
    w.cd = w.def.cd * (0.9 + s.rnd() * 0.2) * (u.systems?.fcs ? 1.6 : 1); w.fireT = 1.5;
    u.muzzle = { until: s.time + 2, by: t.id };
    if (u.stealth) u.stealth.revealT = 2.5;
    const am = w.ammoType;
    s.projs.push({ x: u.pos.x, y: u.pos.y, px: u.pos.x, py: u.pos.y, sx: u.pos.x, sy: u.pos.y, tx: t.pos.x, ty: t.pos.y, tgt: t.id, spd: w.def.ps, dmg: w.def.dmg, splash: am === 'he' ? 1 : 0,
      team: u.team, k: w.def.tag, src: u.id, am, acc: s.smokeOn(u.pos, t.pos) ? 0.35 : 1 });
    if (am !== 'std') {
      w[am]--;
      if (w[am] <= 0) { w.nextAmmo = 'std'; w.reloadT = 2.5; if (sq) s.log(`${String(sq.no).padStart(2, '0')} ${sq.pilot}機：${AMMO[am].name}切れ、通常弾へ`) }
    }
    s.emit({ k: 'flash', x: u.pos.x, y: u.pos.y, team: u.team });
    if (u.enemyAI) s.egroups[u.enemyAI.gid].lastFire = s.time;
  }
}

export function launchMissile(s: Sim, u: Entity, t: Entity) {
  const T = TOOLS.missile, tb = u.toolbelt!;
  tb.ammo--; tb.cd = T.cd!;
  if (u.weapon) u.weapon.fireT = 1.5;
  u.muzzle = { until: s.time + 2, by: t.id };
  if (u.stealth) u.stealth.revealT = 2.5;
  s.projs.push({ x: u.pos.x, y: u.pos.y, px: u.pos.x, py: u.pos.y, tx: t.pos.x, ty: t.pos.y, tgt: t.id, spd: 7, dmg: T.dmg!, splash: T.splash!, team: u.team, k: 'MSL', src: u.id, am: 'std', acc: 1 });
  s.emit({ k: 'flash', x: u.pos.x, y: u.pos.y, team: u.team });
  if (u.team === 'E' && (t.squad || t.truck)) s.log(`ミサイル接近！（→ ${t.squad ? t.squad.pilot + '機' : t.name}）`, 'warning');
}

export function projectileSystem(s: Sim, dt: number) {
  for (const p of s.projs) {
    const t = s.world.get(p.tgt)!;
    if (p.k === 'MSL' && !p.lost && (s.inCloud('chaff', p) || (t.life.alive && s.inCloud('chaff', t.pos)))) {
      p.lost = true; if (p.team === 'E') s.count('chaffMissile'); const hx = p.tx - p.x, hy = p.ty - p.y, hl = Math.hypot(hx, hy) || 1; p.tx = p.x + hx / hl * 2.5; p.ty = p.y + hy / hl * 2.5;
      if (t.team === 'P' || p.team === 'P') s.log('ミサイルがチャフで誘導を失った', p.team === 'P' ? 'warning' : 'info');
    }
    if (t.life.alive && !p.lost) { p.tx = t.pos.x; p.ty = t.pos.y }
    const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy), step = p.spd * dt;
    if (p.k === 'MSL' && s.tickN % 3 === 0) s.emit({ k: 'smoke', x: p.x, y: p.y });
    if (p.k === 'MSL' && !p.lost) {
      p.tried = p.tried || [];
      for (const o of s.world.alive('weapon')) {
        if (o.team === p.team || o.weapon.def.tag !== 'MG' || o.weapon.reloadT > 0 || o.squad?.hidden || p.tried.includes(o.id)) continue;
        if (Math.hypot(o.pos.x - p.x, o.pos.y - p.y) <= 2.2) {
          p.tried.push(o.id);
          if (s.rnd() < (o.systems?.fcs ? 0.15 : 0.35)) {
            p.done = true; s.emit({ k: 'boom', x: p.x, y: p.y, r: .4 });
            s.log(`${o.squad ? o.squad.pilot + '機が' : o.name + 'が'}ミサイルを迎撃`, o.team === 'P' ? 'info' : 'warning'); break;
          }
        }
      }
      if (p.done) continue;
    }
    if (d <= step) { p.done = true; impact(s, p) } else { p.px = p.x; p.py = p.y; p.x += dx / d * step; p.y += dy / d * step }
  }
  s.projs = s.projs.filter(p => !p.done);
}

function impact(s: Sim, p: Projectile) {
  const tgt = s.world.get(p.tgt)!;
  if (p.k === 'MSL') {
    if (p.lost) s.emit({ k: 'boom', x: p.tx, y: p.ty, r: .5 });
    else {
      if (p.team === 'E' && tgt.ephemeral?.kind === 'decoy') s.count('decoyMissile');
      if (p.team === 'E' && tgt.squad) s.count('mslOnUs');
      s.cause = 'missile'; blast(s, p.tx, p.ty, p.team, p.dmg, p.splash, tgt.life.alive ? tgt : null, p.src); s.cause = 'bullet';
    }
    return;
  }
  if (p.acc < 1 && s.rnd() > p.acc) { s.emit({ k: 'miss', x: p.tx + .3, y: p.ty - .2 }); if (p.team === 'E') s.count('smokeMiss'); return }
  // body-blocking: a friend of the target standing in the line of fire (closer to the shooter) may take the round instead.
  // Heavies are big: that is what makes a shield work.
  let victim = tgt;
  if (p.sx != null && tgt.life.alive) {
    const ax = p.sx, ay = p.sy!, dx = tgt.pos.x - ax, dy = tgt.pos.y - ay, L2 = dx * dx + dy * dy;
    let best: Entity | null = null, bt = 1;
    if (L2 > 1) for (const o of s.world.alive()) {
      if (o === tgt || o.team !== tgt.team || !o.health || o.ephemeral || o.structure) continue;
      const t = ((o.pos.x - ax) * dx + (o.pos.y - ay) * dy) / L2; if (t < 0.1 || t > 0.92) continue;
      const off = Math.hypot(ax + dx * t - o.pos.x, ay + dy * t - o.pos.y);
      const size = o.shape === 'hex' ? 0.6 : 0.4;
      if (off <= size && t < bt) { bt = t; best = o }
    }
    if (best && s.rnd() < (best.shape === 'hex' ? 0.6 : 0.3)) { victim = best; if (best.squad) s.count('blocked') }
  }
  const am = p.am, ak = am === 'ap' ? 0.3 : am === 'he' ? 1.3 : 1;
  const hitOne = (t: Entity, m: number) => {
    if (!t.life.alive || !t.health) return;
    // bullets: armour is subtracted per hit, so light rounds (MG) barely scratch heavy armour, big rounds (sniper, AP) punch through
    const raw = p.dmg * (am === 'ap' ? 0.9 : 1) * (am === 'he' && t.structure ? 1.6 : 1);
    let v = (p.team === 'E' ? s.diffMul().dmg : 1) * m * bulletDmg(raw, t.health.armor * ak);
    if (s.inForest(t) && !t.structure && am !== 'he') v *= 0.75;
    if (p.team === 'P' && am === 'ap' && t.health.armor >= 5) s.count('apHeavy', v);
    if (p.team === 'P' && am === 'he' && s.inForest(t)) s.count('heForest', v);
    damage(s, t, v, s.world.get(p.src) || null);
  };
  hitOne(victim, 1);
  if (p.splash) {
    s.emit({ k: 'boom', x: p.tx, y: p.ty, r: p.splash });
    for (const o of s.world.alive()) if (o !== victim && o.team !== p.team && Math.hypot(o.pos.x - p.tx, o.pos.y - p.ty) <= p.splash) hitOne(o, 0.5);
  } else s.emit({ k: 'hit', x: p.tx, y: p.ty });
}

/** Area damage to the other team (missiles, mines). */
export function blast(s: Sim, x: number, y: number, team: 'P' | 'E', dmg: number, splash: number, primary: Entity | null, srcId: number | null) {
  s.emit({ k: 'boom', x, y, r: splash });
  const src = s.world.get(srcId) || null;
  for (const o of s.world.alive()) {
    if (o.team === team || !o.health) continue;
    const d = Math.hypot(o.pos.x - x, o.pos.y - y);
    if (o !== primary && d > splash) continue;
    let v = (team === 'E' ? s.diffMul().dmg : 1) * dmg * (o === primary || (!primary && d <= 0.8) ? 1 : 0.5) * armorMul(o.health.armor);
    if (s.inForest(o) && !o.structure) v *= 0.75;
    damage(s, o, v, src);
  }
}

/** Artillery shell: hits everyone, friend or foe. */
/** Artillery shell: hits everyone, friend or foe. Tree bursts: forest gives no protection. Mortar rounds (`light`) are smaller. */
export function artyHit(s: Sim, x: number, y: number, light = false) {
  s.cause = 'arty';
  const R = light ? 1.1 : 1.35, D = light ? 50 : 65;
  s.emit({ k: 'boom', x, y, r: R });
  for (const o of s.world.alive()) {
    if (!o.health) continue;
    const d = Math.hypot(o.pos.x - x, o.pos.y - y); if (d > R) continue;
    const v = D * (d < 0.7 ? 1 : 0.65) * armorMul(o.health.armor);
    damage(s, o, v, null);
  }
}

export function callArty(s: Sim, x: number, y: number) {
  s.arty--; const at = s.time + 8;
  for (let i = 0; i < 6; i++) { const a = s.rnd() * Math.PI * 2, r = Math.sqrt(s.rnd()) * 1.3; s.shells.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, at: at + i * 0.45, cx: x, cy: y }) }
  s.log(`砲撃支援を要請：8秒後に着弾（残り${s.arty}回）`, 'info');
}

export function damage(s: Sim, t: Entity, d: number, src: Entity | null) {
  const h = t.health; if (!h || !t.life.alive) return;
  h.hp -= d; h.hitT = 0.15;
  if (t.squad) s.count('taken:' + t.squad.cfg.chassis, d);
  if (src?.squad && src.weapon && s.cause === 'bullet' && t.team === 'E') s.count('dmg:w:' + src.weapon.key + ':' + (s.etype(t) ?? ''), Math.min(d, Math.max(0, h.hp + d)));
  const sy = t.systems;
  if (h.hp > 0 && sy && d >= 8 && s.rnd() < 0.10 + 0.25 * (1 - h.hp / h.maxHp)) {
    const ks = (['fcs', 'legs', 'sensor'] as SubsystemKey[]).filter(k => !sy[k]);
    if (ks.length) {
      const k = ks[Math.floor(s.rnd() * ks.length)]; sy[k] = true; sy.fixP = 0;
      if (t.squad) s.log(`${String(t.squad.no).padStart(2, '0')} ${t.squad.pilot}機：${SYSN[k]}損傷`, 'warning');
    }
  }
  const ai = t.enemyAI;
  if (ai) s.egroups[ai.gid].lastHurt = s.time;
  // remember the attacker. It knows roughly where the shot came from only if it saw the muzzle flash.
  if (ai && src && src.life.alive && src.team !== t.team && !src.ephemeral) {
    const knows = s.detP.has(src.id) || s.muzzleSeen(src, t);
    const ag = (ai.aggro ??= []); let a = ag.find(x => x.id === src.id);
    if (!a) { a = { id: src.id, v: 0, pos: null }; ag.push(a) }
    a.v += d; if (knows) { a.pos = { ...src.pos }; const g = s.egroups[ai.gid]; g.contact = { ...src.pos }; g.contactT = s.time }
  }
  if (h.hp <= 0) {
    t.life.alive = false; h.hp = 0;
    s.emit({ k: 'boom', x: t.pos.x, y: t.pos.y, r: t.structure ? 1.6 : 1 });
    if (t.team === 'E') {
      s.kills++; s.count('kill:' + s.cause);
      if (src?.weapon && s.cause === 'bullet') s.count('kill:w:' + src.weapon.key + ':' + (s.etype(t) ?? ''));
      if (t.structure) { s.count('kill:struct:' + s.cause); s.log(`${t.name}を破壊`, 'info') }
    }
    else if (t.truck) s.log(`${t.name}が撃破された`, 'warning');
    else if (t.ephemeral?.kind === 'decoy') s.log('デコイが破壊された', 'info');
    else if (t.squad) { s.lost++; s.log(`${String(t.squad.no).padStart(2, '0')} ${t.squad.pilot}機、大破`, 'warning') }
  }
}

export { armorMul };
