// Player/AI commands. Everything that changes the simulation from outside goes through here,
// so a battle can be recorded as [tick, command] pairs and replayed exactly.
import type { Sim } from './sim';
import { OFFS } from './sim';
import { AMMO, MMODES, STANCES, TOOLS } from './data';
import type { AmmoType, MoveMode, Stance, ToolKey } from './data';
import { callArty } from './systems/combat';

export type CommandSource = 'human' | 'ai';
export type Command = (
  | { k: 'move'; u: number[]; x: number; y: number }
  | { k: 'attack'; u: number[]; t: number }
  | { k: 'stop'; u: number[] }
  | { k: 'stance'; u: number[]; s: Stance }
  | { k: 'mode'; u: number[]; s: MoveMode }
  | { k: 'hide'; u: number[] }
  | { k: 'radar'; u: number[]; on: boolean }
  | { k: 'ammo'; u: number[]; s: AmmoType }
  | { k: 'tool'; u: number[]; tool: ToolKey; x: number; y: number; t?: number | null }
  | { k: 'convoy'; go: boolean }
  | { k: 'arty'; x: number; y: number }
  | { k: 'abort' }
) & { src?: CommandSource };
export type RecordedCommand = [tick: number, cmd: Command];

export const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function execCommand(s: Sim, c: Command) {
  if (s.replaying || (c.src === 'ai' && c.k !== 'stance' && c.k !== 'mode' && c.k !== 'radar')) s.log(describeCommand(s, c), c.src === 'ai' ? 'ai' : 'note');
  switch (c.k) {
    case 'arty': if (s.arty > 0) callArty(s, c.x, c.y); return;
    case 'abort': s.finish({ win: false, reason: '作戦を放棄して撤退した' }); return;
    case 'convoy': s.convoyGo = c.go; if (!s.replaying) s.log(c.go ? '輸送隊、前進開始' : '輸送隊、停止', 'info'); return;
  }
  const us = c.u.map(id => s.world.get(id)).filter((e): e is NonNullable<typeof e> => !!e && e.life.alive && !!e.squad);
  switch (c.k) {
    case 'move': {
      if (!us.length) return;
      const p = s.map.nearestPass(c.x, c.y);
      // units ordered together move together: nobody outruns the slowest member
      const cap = us.length > 1 ? Math.min(...us.map(u => s.effSpeed(u))) : 0;
      us.forEach((u, i) => {
        u.mover!.cap = cap;
        const o = OFFS[i % OFFS.length]; let d = { x: p.x + o[0] * 0.75, y: p.y + o[1] * 0.75 };
        if (!s.map.pass(d.x, d.y)) d = p;
        u.mover!.path = s.map.findPath(u.pos.x, u.pos.y, d.x, d.y); u.squad!.order = 'move'; u.squad!.target = null;
        if (u.toolbelt) u.toolbelt.pending = null;
      });
      s.emit({ k: 'ping', x: p.x, y: p.y });
      return;
    }
    case 'attack': {
      const t = s.world.get(c.t); if (!t || !t.life.alive) return;
      for (const u of us) { if (!u.weapon) continue; u.mover!.cap = 0; u.squad!.order = 'attack'; u.squad!.target = t.id; u.mover!.repathT = 0; if (u.toolbelt) u.toolbelt.pending = null }
      s.emit({ k: 'ping', x: t.pos.x, y: t.pos.y, red: true });
      return;
    }
    case 'stop': for (const u of us) { u.mover!.path = []; u.squad!.order = 'idle'; u.squad!.target = null; u.squad!.hidden = false; if (u.toolbelt) u.toolbelt.pending = null } return;
    case 'stance': for (const u of us) u.squad!.stance = c.s; return;
    case 'mode': for (const u of us) u.squad!.mmode = c.s; return;
    case 'hide': for (const u of us) { u.mover!.path = []; u.squad!.order = 'hide'; u.squad!.target = null; u.squad!.hideT = 0; if (u.toolbelt) u.toolbelt.pending = null } return;
    case 'radar': for (const u of us) if (u.sensor && u.sensor.radarBonus > 0) u.sensor.off = !c.on; return;
    case 'ammo':
      for (const u of us) {
        const w = u.weapon; if (!w) continue;
        const a = c.s === 'std' || w[c.s] > 0 ? c.s : null;
        if (!a || (a === w.ammoType && !w.nextAmmo)) continue;
        w.nextAmmo = a; w.reloadT = 2.5;
      }
      return;
    case 'tool':
      for (const u of us) {
        const tb = u.toolbelt; if (!tb || tb.tool !== c.tool || tb.ammo <= 0) continue;
        tb.pending = { x: c.x, y: c.y, t: c.t ?? null }; u.squad!.order = 'tool'; u.squad!.target = null; u.mover!.repathT = 0;
      }
      return;
  }
}

export function describeCommand(s: Sim, c: Command): string {
  const who = (c.src === 'ai' ? 'AI' : '操作') + '▶ ';
  const nos = 'u' in c ? c.u.map(id => s.world.get(id)?.squad?.no).filter(Boolean).join(',') : '';
  switch (c.k) {
    case 'move': return `${who}${nos} 移動 (${c.x.toFixed(1)}, ${c.y.toFixed(1)})`;
    case 'attack': return `${who}${nos} 攻撃 → ${s.world.get(c.t)?.name ?? '?'}`;
    case 'stop': return `${who}${nos} 停止`;
    case 'stance': return `${who}${nos} 姿勢：${STANCES[c.s]}`;
    case 'mode': return `${who}${nos} 移動モード：${MMODES[c.s].name}`;
    case 'hide': return `${who}${nos} 隠蔽`;
    case 'radar': return `${who}${nos} レーダー${c.on ? 'ON' : 'OFF'}`;
    case 'ammo': return `${who}${nos} 弾種：${AMMO[c.s].name}`;
    case 'tool': { const t = c.t != null ? s.world.get(c.t) : undefined; return `${who}${nos} ${TOOLS[c.tool].name}${t ? ' → ' + t.name : ` (${c.x.toFixed(1)}, ${c.y.toFixed(1)})`}` }
    case 'convoy': return `${who}輸送隊 ${c.go ? '前進' : '停止'}`;
    case 'arty': return `${who}砲撃支援 (${c.x.toFixed(1)}, ${c.y.toFixed(1)})`;
    case 'abort': return `${who}撤退`;
  }
}
