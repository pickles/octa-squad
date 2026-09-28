// The AI-facing interface over a Sim: fog-respecting observations, a text rendering for LLMs,
// and validated high-level actions. Used by window.octa in the browser and by Node tools/tests.
import type { Sim } from './sim';
import type { Entity } from './ecs';
import { AMMO, CHASSIS, DIFFS, EQUIP, MMODES, STANCES, TOOLS, WEAPONS, loadoutStats } from './data';
import type { AmmoType, Difficulty, Loadout, MoveMode, Stance, SubsystemKey, ToolKey } from './data';
import { MISSIONS } from './missions';
import type { MissionId } from './missions';
import { N } from './map';
import { clamp } from './rng';
import { r3 } from './commands';

const TCH = '.FH#~=';
const r2 = (v: number) => Math.round(v * 100) / 100;
const TNAME = ['plain', 'forest', 'hill', 'rock', 'water', 'road'];

export type Action =
  | { cmd: 'move'; units?: number[] | 'all'; x: number; y: number }
  | { cmd: 'attack'; units?: number[] | 'all'; target: string }
  | { cmd: 'stop' | 'hide'; units?: number[] | 'all' }
  | { cmd: 'stance'; units?: number[] | 'all'; stance: Stance }
  | { cmd: 'mode'; units?: number[] | 'all'; mode: MoveMode }
  | { cmd: 'ammo'; units?: number[] | 'all'; ammo: AmmoType }
  | { cmd: 'tool'; units?: number[] | 'all'; tool?: ToolKey; target?: string; x?: number; y?: number }
  | { cmd: 'convoy'; go: boolean }
  | { cmd: 'artillery'; x: number; y: number }
  | { cmd: 'abort' };
export interface ActResult { ok: boolean; error?: string; warning?: string }

export class AgentPort {
  private logCursor = 0;
  constructor(public s: Sim) {}

  private squadObs(u: Entity) {
    const sq = u.squad!, w = u.weapon, tb = u.toolbelt, mv = u.mover!, t = this.s.world.get(sq.target);
    return {
      id: sq.no, pilot: sq.pilot, alive: u.life.alive, extracted: u.life.gone, x: r2(u.pos.x), y: r2(u.pos.y),
      hp: Math.ceil(u.health!.hp), maxHp: u.health!.maxHp, chassis: sq.cfg.chassis, weapon: sq.cfg.weapon, equip: sq.cfg.equip,
      armor: u.health!.armor, speed: mv.speed, sensor: r2(this.s.effSensor(u)), range: this.s.rangeOf(u), minRange: w?.def.min || 0,
      repairRadius: u.repairer ? u.repairer.radius : 0, stance: sq.stance, order: sq.order, target: t && t.life.alive ? 'e' + t.id : null,
      moving: mv.path.length > 0, dest: mv.path.length ? { x: r2(mv.path[mv.path.length - 1].x), y: r2(mv.path[mv.path.length - 1].y) } : null,
      cooldown: r2(Math.max(0, w?.cd || 0)), terrain: TNAME[this.s.map.at(u.pos.x, u.pos.y)], detected: this.s.detP.has(u.id),
      detectionMultiplier: r2(this.s.detMul(u)), radarEmission: u.sensor?.emit || 0, stealthBroken: !!(u.stealth && u.stealth.revealT > 0),
      nearestEnemyAlertMargin: u.exposure && u.exposure.margin < 99 ? r2(u.exposure.margin) : null,
      moveMode: sq.mmode, hidden: sq.hidden, hiding: sq.order === 'hide', ammoType: w?.ammoType || 'std', apRounds: w?.ap || 0, heRounds: w?.he || 0, reloading: !!w && w.reloadT > 0,
      damaged: (['fcs', 'legs', 'sensor'] as SubsystemKey[]).filter(k => u.systems?.[k]),
      tool: tb?.tool || 'none', ammo: tb?.ammo || 0, toolRange: tb ? TOOLS[tb.tool].range || 0 : 0, toolReady: !tb || tb.cd <= 0, pendingTool: !!tb?.pending,
      inCloud: this.s.clouds.filter(c => Math.hypot(u.pos.x - c.x, u.pos.y - c.y) <= c.r).map(c => c.k),
      lockable: u.life.alive && tb?.tool === 'missile' && tb.ammo > 0 ? this.s.enemies().filter(e => this.s.canLock(u, e)).map(e => 'e' + e.id) : [] as string[],
    };
  }
  private enemyObs(e: Entity) {
    const s = this.s;
    const o: Record<string, unknown> = {
      id: 'e' + e.id, type: s.etype(e), name: e.name, structure: !!e.structure, x: r2(e.pos.x), y: r2(e.pos.y), hp: Math.ceil(e.health!.hp), maxHp: e.health!.maxHp,
      armor: e.health!.armor, weapon: e.weapon ? e.weapon.def.tag : null, range: s.rangeOf(e), minRange: e.weapon?.def.min || 0,
      sensor: r2(s.effSensor(e)), terrain: TNAME[s.map.at(e.pos.x, e.pos.y)],
    };
    if (e.enemyAI) o.state = e.enemyAI.state;
    if (e.toolbelt?.tool === 'missile') o.missiles = e.toolbelt.ammo;
    const dm = (['fcs', 'legs', 'sensor'] as SubsystemKey[]).filter(k => e.systems?.[k]); if (dm.length) o.damaged = dm;
    if (e.structure?.objective) o.objective = true;
    if (e.structure?.kind === 'site') { o.label = e.structure.label; o.scanned = e.structure.scanned; o.scanProgress = r2(Math.min(1, e.structure.scan)) }
    return o as { id: string; type: string; name: string; structure: boolean; x: number; y: number; hp: number; maxHp: number; weapon: string | null; range: number; state?: string; missiles?: number; objective?: boolean; label?: string; scanned?: boolean; scanProgress?: number };
  }

  /** Everything the player side currently knows. `peek` leaves new log events unread. */
  observe(opt: { peek?: boolean } = {}) {
    const s = this.s, m = s.m;
    const events = s.logs.slice(this.logCursor);
    if (!opt.peek) this.logCursor = s.logs.length;
    const shellsBy = new Map<string, typeof s.shells[number]>(); for (const sh of s.shells) { const k = sh.cx + ',' + sh.cy; if (!shellsBy.has(k)) shellsBy.set(k, sh) }
    return {
      mission: m.id, type: m.type, name: m.name, difficulty: s.diff, time: r2(s.time), timeLimit: m.limit || null,
      status: s.over ? (s.over.win ? 'win' : 'lose') : 'running' as 'win' | 'lose' | 'running', result: s.over ? s.over.reason : null, objective: m.objective(s),
      squad: s.squad.map(u => this.squadObs(u)),
      enemies: s.enemies().filter(e => s.seenE.has(e.id)).map(e => this.enemyObs(e)),
      lastSeen: s.enemies().filter(e => !s.seenE.has(e.id) && e.intel?.lastSeen && !e.structure).map(e => ({ id: 'e' + e.id, type: s.etype(e), x: r2(e.intel!.lastSeen!.x), y: r2(e.intel!.lastSeen!.y) })),
      zones: s.zones.map(z => ({ kind: z.kind, label: z.label, x: r2(z.x), y: r2(z.y), r: z.r })),
      events,
      convoy: m.road ? { moving: s.convoyGo, arrived: s.arrived, trucks: s.world.with('truck').map((u, i) => ({ id: 't' + (i + 1), alive: u.life.alive, arrived: u.life.gone, x: r2(u.pos.x), y: r2(u.pos.y), hp: Math.ceil(u.health!.hp), maxHp: u.health!.maxHp })) } : undefined,
      sites: s.sites.length ? s.sites.map(x => ({ label: x.structure!.label, scanned: x.structure!.scanned, scanProgress: r2(Math.min(1, x.structure!.scan)), ...((x.structure!.scanned || s.seenE.has(x.id)) ? { x: r2(x.pos.x), y: r2(x.pos.y) } : {}) } as { label: string; scanned: boolean; scanProgress: number; x?: number; y?: number })) : undefined,
      extraction: m.id === 'm5' ? { need: s.need, pickupRequested: !!s.pickup, pickupIn: s.pickup ? r2(Math.max(0, s.pickup - s.time)) : null, extracted: s.extracted } : undefined,
      hq: s.hq ? { alive: s.hq.life.alive, hpPct: Math.ceil(s.hq.health!.hp / s.hq.health!.maxHp * 100), radarTowerAlive: !!s.radar?.life.alive } : undefined,
      clouds: s.clouds.map(c => ({ kind: c.k, x: r2(c.x), y: r2(c.y), r: c.r, ttl: r2(c.t) })),
      mines: s.mines.filter(x => x.team === 'P').map(x => ({ x: r2(x.x), y: r2(x.y), armed: x.arm <= 0 })),
      enemyMines: s.mines.filter(x => x.team === 'E' && x.revealed).map(x => ({ x: r2(x.x), y: r2(x.y), disarm: r2(x.disarm) })),
      artillery: { left: s.arty, incoming: [...shellsBy.values()].map(sh => ({ x: r2(sh.cx), y: r2(sh.cy), in: r2(sh.at - s.time) })) },
      probes: s.world.alive('ephemeral').filter(u => u.ephemeral.kind === 'probe').map(u => ({ x: r2(u.pos.x), y: r2(u.pos.y), ttl: r2(u.ephemeral.ttl) })),
      decoys: s.world.alive('ephemeral').filter(u => u.ephemeral.kind === 'decoy').map(u => ({ x: r2(u.pos.x), y: r2(u.pos.y), hp: Math.ceil(u.health!.hp), ttl: r2(u.ephemeral.ttl) })),
      charges: s.charges.map(c => ({ x: r2(c.x), y: r2(c.y), t: r2(c.t) })),
      incomingMissiles: s.projs.filter(p => p.k === 'MSL' && p.team === 'E' && !p.lost).map(p => { const t = s.world.get(p.tgt)!; return { x: r2(p.x), y: r2(p.y), target: t.squad ? t.squad.no : t.ephemeral ? 'decoy' : t.truck ? 'truck' : null } }),
    };
  }

  map() {
    const s = this.s, rows: string[] = [], explored: string[] = [], visible: string[] = [];
    for (let y = 0; y < N; y++) {
      let a = '', b = '', c = '';
      for (let x = 0; x < N; x++) { const i = y * N + x; a += TCH[s.map.grid[i]]; b += s.explored[i] ? '1' : '0'; c += s.vis[i] ? '1' : '0' }
      rows.push(a); explored.push(b); visible.push(c);
    }
    return {
      size: N, note: 'rows[y][x]. tile (x,y) covers x..x+1, y..y+1; its center is (x+0.5,y+0.5). Terrain is known in advance; explored/visible are fog masks.',
      legend: { '.': 'plain (move x1)', F: 'forest (move x1.7, cover)', H: 'hill (move x1.35, +1 sensor/range)', '#': 'rock (impassable)', '~': 'water (impassable)', '=': 'road (move x0.8)' },
      rows, explored, visible,
    };
  }

  /** Compact text rendering (ASCII map + lists), convenient as an LLM prompt. */
  text() {
    const s = this.s, o = this.observe();
    const g: string[][] = [];
    for (let y = 0; y < N; y++) { const r: string[] = []; for (let x = 0; x < N; x++) { const i = y * N + x, ch = TCH[s.map.grid[i]]; r.push(s.vis[i] ? ch : s.explored[i] ? ch.toLowerCase().replace('.', ',').replace('=', '-') : '?') } g.push(r) }
    const put = (x: number, y: number, ch: string) => { const X = Math.floor(x), Y = Math.floor(y); if (X >= 0 && Y >= 0 && X < N && Y < N) g[Y][X] = ch };
    o.zones.filter(z => z.kind !== 'hint').forEach(z => put(z.x, z.y, 'Z'));
    o.lastSeen.forEach(e => put(e.x, e.y, 'e')); o.enemies.forEach(e => put(e.x, e.y, e.structure ? 'S' : 'E'));
    (o.convoy?.trucks || []).filter(t => t.alive).forEach(t => put(t.x, t.y, 'T')); o.squad.filter(u => u.alive).forEach(u => put(u.x, u.y, String(u.id)));
    let t = `[${o.mission} ${o.type} ${o.name}] t=${o.time}s${o.timeLimit ? ' / limit ' + o.timeLimit + 's' : ''} status=${o.status}${o.result ? ' (' + o.result + ')' : ''}\nOBJECTIVE: ${o.objective}\n`;
    t += 'MAP (x→ 0..27, y↓ 0..27). visible: . plain F forest H hill # rock ~ water = road | explored-but-not-visible lowercase (, f h # ~ -) | ? unexplored\n   digits=your units  E=enemy  S=enemy structure  e=last seen enemy  T=truck  Z=LZ/goal center\n';
    t += '    ' + Array.from({ length: N }, (_, x) => x % 10).join('') + '\n' + g.map((r, y) => String(y).padStart(3) + ' ' + r.join('')).join('\n') + '\n';
    t += 'SQUAD:\n' + o.squad.map(u => u.alive
      ? `  ${u.id} ${u.pilot} ${u.chassis}/${u.weapon}/${u.equip} (${u.x},${u.y}) HP${u.hp}/${u.maxHp} range${u.range} sensor${u.sensor} ${u.stance} ${u.order}${u.target ? '→' + u.target : ''}${u.tool !== 'none' ? ' ' + u.tool + 'x' + u.ammo : ''}${u.moveMode !== 'normal' ? ' mode:' + u.moveMode : ''}${u.hidden ? ' HIDDEN' : ''}${u.ammoType !== 'std' ? ' ammo:' + u.ammoType : ''}${u.damaged.length ? ' dmg:' + u.damaged.join('/') : ''}${u.detected ? ' DETECTED' : ''}${u.terrain !== 'plain' ? ' [' + u.terrain + ']' : ''}`
      : `  ${u.id} ${u.pilot} ${u.extracted ? 'EXTRACTED' : 'DESTROYED'}`).join('\n') + '\n';
    t += 'VISIBLE ENEMIES:\n' + (o.enemies.map(e => `  ${e.id} ${e.type} (${e.x},${e.y}) HP${e.hp}/${e.maxHp} ${e.weapon ? e.weapon + ' range' + e.range : 'unarmed'}${e.state ? ' ' + e.state : ''}${e.missiles ? ' missiles' + e.missiles : ''}${e.objective ? ' OBJECTIVE' : ''}${e.label ? ' site ' + e.label + (e.scanned ? ' scanned' : ' scan ' + Math.round((e.scanProgress || 0) * 100) + '%') : ''}`).join('\n') || '  (none)') + '\n';
    if (o.convoy) t += `CONVOY: ${o.convoy.moving ? 'moving' : 'halted'} arrived ${o.convoy.arrived}; ` + o.convoy.trucks.map(x => `${x.id} ${x.alive ? `(${x.x},${x.y}) HP${x.hp}` : x.arrived ? 'arrived' : 'destroyed'}`).join(', ') + '\n';
    if (o.sites) t += 'SITES: ' + o.sites.map(x => `${x.label}:${x.scanned ? 'scanned' : Math.round(x.scanProgress * 100) + '%'}`).join(' ') + '\n';
    t += `ARTILLERY: ${o.artillery.left} left${o.artillery.incoming.length ? '; incoming ' + o.artillery.incoming.map(a => `(${a.x},${a.y}) in ${a.in}s`).join(', ') : ''}\n`;
    if (o.enemyMines.length) t += 'KNOWN ENEMY MINES: ' + o.enemyMines.map(m => `(${m.x},${m.y})`).join(' ') + '\n';
    if (o.clouds.length) t += 'CLOUDS: ' + o.clouds.map(c => `${c.kind} (${c.x},${c.y}) r${c.r} ${Math.ceil(c.ttl)}s`).join(', ') + '\n';
    if (o.incomingMissiles.length) t += 'INCOMING ENEMY MISSILES: ' + o.incomingMissiles.map(m => `(${m.x},${m.y})→${m.target}`).join(', ') + '\n';
    if (o.extraction) t += `EXTRACTION: need ${o.extraction.need}, ${o.extraction.pickupRequested ? 'pickup in ' + o.extraction.pickupIn + 's' : 'not requested (enter LZ to request)'}\n`;
    const hints = o.zones.filter(z => z.kind === 'hint'); if (hints.length) t += 'SEARCH AREAS: ' + hints.map(z => `${z.label} (${z.x},${z.y}) r${z.r}`).join(', ') + '\n';
    if (o.events.length) t += 'EVENTS:\n' + o.events.map(e => `  [${e.t}s] ${e.text}`).join('\n') + '\n';
    return t;
  }

  private unitsOf(ids: number[] | 'all' | undefined) {
    const all = this.s.livingSquad();
    if (ids == null || ids === 'all') return all;
    return (Array.isArray(ids) ? ids : [ids]).map(i => all.find(u => u.squad.no === +i)).filter((u): u is typeof all[number] => !!u);
  }

  /** Validate and issue high-level actions (squad ids are slot numbers 1..8, enemy ids are 'e<ID>'). */
  act(actions: Action | Action[]): ActResult[] {
    const s = this.s;
    if (s.over) return [{ ok: false, error: 'battle is over' }];
    if (s.replaying) return [{ ok: false, error: 'replay is playing' }];
    const list = Array.isArray(actions) ? actions : [actions];
    return list.map(c => {
      try {
        if (s.over) throw new Error('battle is over');
        const us = 'units' in c ? this.unitsOf(c.units) : this.unitsOf('all');
        if (c.cmd !== 'convoy' && c.cmd !== 'artillery' && c.cmd !== 'abort' && !us.length) return { ok: false, error: 'no living units matched ' + JSON.stringify((c as { units?: unknown }).units) };
        const ids = us.map(u => u.id); let res: ActResult = { ok: true };
        const enemyById = (ref: string | undefined) => { const id = +String(ref).replace(/^e/, ''); return s.enemies().find(e => e.id === id) };
        switch (c.cmd) {
          case 'move': {
            if (typeof c.x !== 'number' || typeof c.y !== 'number') throw new Error('move needs numeric x,y');
            s.issue({ k: 'move', u: ids, x: r3(clamp(c.x, 0, N - .01)), y: r3(clamp(c.y, 0, N - .01)) }, 'ai');
            const bad = us.filter(u => !u.mover!.path.length); if (bad.length) res = { ok: true, warning: 'no path for units ' + bad.map(u => u.squad.no).join(',') };
            break;
          }
          case 'attack': {
            const t = enemyById(c.target); if (!t) throw new Error('unknown or dead target ' + c.target);
            if (!s.seenE.has(t.id)) throw new Error('target ' + c.target + ' is not currently visible');
            s.issue({ k: 'attack', u: ids, t: t.id }, 'ai'); break;
          }
          case 'stop': s.issue({ k: 'stop', u: ids }, 'ai'); break;
          case 'hide': s.issue({ k: 'hide', u: ids }, 'ai'); break;
          case 'stance': if (!(c.stance in STANCES)) throw new Error("stance must be 'hold' | 'free' | 'nofire'"); s.issue({ k: 'stance', u: ids, s: c.stance }, 'ai'); break;
          case 'mode': if (!(c.mode in MMODES)) throw new Error("mode must be 'normal'|'fast'|'careful'"); s.issue({ k: 'mode', u: ids, s: c.mode }, 'ai'); break;
          case 'ammo': if (!(c.ammo in AMMO)) throw new Error("ammo must be 'std'|'ap'|'he'"); s.issue({ k: 'ammo', u: ids, s: c.ammo }, 'ai'); break;
          case 'convoy': if (!s.m.road) throw new Error('this mission has no convoy'); s.issue({ k: 'convoy', go: !!c.go }, 'ai'); break;
          case 'abort': s.issue({ k: 'abort' }, 'ai'); break;
          case 'artillery': {
            if (s.arty <= 0) throw new Error('no artillery left');
            const X = Math.floor(c.x), Y = Math.floor(c.y);
            if (!(X >= 0 && Y >= 0 && X < N && Y < N) || !s.vis[Y * N + X]) throw new Error('artillery target must be inside your current vision');
            s.issue({ k: 'arty', x: r3(c.x), y: r3(c.y) }, 'ai'); break;
          }
          case 'tool': {
            const tool = c.tool || us.find(u => u.toolbelt)?.toolbelt?.tool;
            if (!tool || tool === 'none' || !(tool in TOOLS)) throw new Error('units have no tool');
            const car = us.filter(u => u.toolbelt?.tool === tool && u.toolbelt.ammo > 0); if (!car.length) throw new Error('no unit with ammo for ' + tool);
            const T = TOOLS[tool];
            if (T.target === 'enemy' || T.target === 'struct') {
              const t = enemyById(c.target); if (!t || (T.target === 'struct' && !t.structure)) throw new Error(tool + ' needs a live enemy ' + (T.target === 'struct' ? 'structure ' : '') + 'target');
              if (!s.seenE.has(t.id)) throw new Error('target not visible');
              s.issue({ k: 'tool', tool, u: car.map(u => u.id), t: t.id, x: r3(t.pos.x), y: r3(t.pos.y) }, 'ai');
              if (tool === 'missile' && !car.some(u => s.canLock(u, t))) res = { ok: true, warning: 'no lock yet: units will close in until the target is inside their own sensor or a radar ally sees it' };
            } else {
              if (typeof c.x !== 'number' || typeof c.y !== 'number') throw new Error(tool + ' needs numeric x,y');
              const x = r3(clamp(c.x, 0, N - .01)), y = r3(clamp(c.y, 0, N - .01));
              const u = [...car].sort((a, b) => Math.hypot(a.pos.x - x, a.pos.y - y) - Math.hypot(b.pos.x - x, b.pos.y - y))[0];
              s.issue({ k: 'tool', tool, u: [u.id], x, y }, 'ai');
              if (Math.hypot(u.pos.x - x, u.pos.y - y) > T.range!) res = { ok: true, warning: `out of range (${T.range}); unit ${u.squad.no} will move closer first` };
            }
            break;
          }
          default: throw new Error('unknown cmd ' + (c as { cmd: string }).cmd);
        }
        return res;
      } catch (e) { return { ok: false, error: (e as Error).message } }
    });
  }
}

export type Observation = ReturnType<AgentPort['observe']>;

/** Build slot/deploy arrays from an AI loadout description, validating budget and unit cap. */
export function buildLoadout(mission: MissionId, base: Loadout[], spec?: ({ slot: number; deploy?: boolean } & Partial<Loadout>)[], baseDeploy?: boolean[]) {
  const m = MISSIONS.find(x => x.id === mission); if (!m) throw new Error('unknown mission ' + mission);
  const slots = base.map(x => ({ ...x }));
  let deploy = baseDeploy ? [...baseDeploy] : slots.map(() => false);
  if (spec) {
    deploy = Array(8).fill(false);
    for (const l of spec) {
      const i = (l.slot || 0) - 1; if (i < 0 || i > 7) throw new Error('slot must be 1..8');
      const tables = { chassis: CHASSIS, weapon: WEAPONS, equip: EQUIP, tool: TOOLS } as const;
      for (const k of ['chassis', 'weapon', 'equip', 'tool'] as const) {
        const v = l[k]; if (v == null) continue;
        if (!(v in tables[k])) throw new Error(`unknown ${k} '${v}' (options: ${Object.keys(tables[k]).join(', ')})`);
        (slots[i] as unknown as Record<string, string>)[k] = v;
      }
      deploy[i] = l.deploy !== false;
    }
  }
  const cost = slots.reduce((a, x, i) => a + (deploy[i] ? loadoutStats(x).cost : 0), 0), n = deploy.filter(Boolean).length;
  if (!n) throw new Error('no units deployed');
  if (n > m.max) throw new Error(`too many units: ${n} > max ${m.max}`);
  if (cost > m.budget) throw new Error(`over budget: ${cost} > ${m.budget}`);
  return { slots, deploy, cost };
}

export function rulesText() {
  return `# OCTA SQUAD — rules for an AI player
Real-time tactics on a ${N}x${N} tile grid. Coordinates are continuous (x,y); you can reason on the plain grid (map()).
Time advances only when you call step(seconds). 30 simulation ticks per second.

## Loadout (before battle)
Each mission has a budget and a max unit count. Unit cost = chassis + weapon + equip + tool.
Chassis: ${Object.entries(CHASSIS).map(([k, v]) => `${k}(hp${v.hp} armor${v.armor} speed${v.speed} sensor${v.sensor} cost${v.cost}${v.repair ? ' repairs allies within 2.5 at ' + v.repair + 'hp/s' : ''})`).join('; ')}
Weapons: ${Object.entries(WEAPONS).map(([k, v]) => `${k}(range${v.range} dmg${v.dmg} every${v.cd}s cost${v.cost}${v.min ? ' minRange' + v.min : ''})`).join('; ')}
Equip: ${Object.entries(EQUIP).map(([k, v]) => `${k}(cost${v.cost}${v.sensor ? ' sensor+' + v.sensor : ''}${v.emit ? ' enemies detect you ' + v.emit + ' farther' : ''}${v.hp ? ' hp+' + v.hp : ''}${v.armor ? ' armor+' + v.armor : ''}${v.speed ? ' speed' + (v.speed > 0 ? '+' : '') + v.speed : ''}${v.stealth ? ' detection x0.5, broken for 2.5s after firing' : ''}${v.regen ? ' regen' + v.regen + '/s' : ''})`).join('; ')}
Tools (limited uses): ${Object.entries(TOOLS).filter(([k]) => k !== 'none').map(([k, v]) => `${k}(uses${v.ammo} cost${v.cost}${v.range ? ' range' + v.range : ''}${v.radius ? ' radius' + v.radius : ''}${v.dur ? ' ' + v.dur + 's' : ''})`).join('; ')}
Difficulty scales enemy damage and hp: ${Object.entries(DIFFS).map(([k, v]) => `${k} dmg x${v.dmg} hp x${v.hp}`).join(', ')}.

## Combat & detection
- Damage = dmg × max(0.3, 1 − 0.07×armor) × (0.75 if the target stands in forest).
- You only see enemies within some unit's sensor radius (0.7× for enemies in forest, 0.4× when smoke is on or across the line of sight, unless the viewer has working radar). You can only shoot what you see.
- Hills: +1 sensor and +1 range. Enemies detect you at enemySensor × mult + radarEmission (+1.5 when moving fast); mult: stealth 0.5 (unless it fired in the last 2.5s), forest 0.7, hidden 0.35, careful 0.85, smoke 0.4.
- Muzzle flash: a unit that fires is visible, for 2s, to the unit it shot at, at any distance (both sides), unless smoke lies between them. Out-ranged victims cannot shoot back but will know where you are and close in.
- Enemy aggro: an enemy that takes damage goes after whoever has hurt it most recently (decays over ~8s), even past closer targets; if it lost sight it heads to where it last saw the attacker.
- A detecting enemy alerts others within 5.5 (radar tower: 13). Alerted enemies chase ~10 tiles and give up ~9s after losing sight.
- Stances: hold = fire at anything in range but don't chase; free = chase visible enemies when idle; nofire = only fire at an explicit attack target.
- missile: needs a LOCK (target visible, not in chaff, inside the launcher's own sensor or a radar ally's sensor). Loses guidance in chaff. Enemy heavies carry missiles guided by their own sensor or the radar tower.
- chaff: missiles lose lock; radar stops working inside. smoke: 35% hit chance when the shot passes through or starts/ends in smoke; also blocks sight (x0.4) across it. flare: reveals radius 4. decoy: enemies prefer it. mine: invisible, 60 dmg. charge: plant on a structure, 260 after 5s. jammer: enemy sensor x0.4 and radar tower off. probe: static sensor 5 for 60s.
- Move mode: normal | fast (x1.5 speed, x0.7 sensor, louder) | careful (x0.6 speed, +1.5 sensor, finds enemy mines within 2.5 and disarms them standing still within 1.2). m2 and m4 have hidden minefields.
- hide: stop; after 2s hidden (detection x0.35) and no auto-fire.
- Ammo: std | ap (armor effect x0.3) | he (splash 1, x1.6 vs structures, ignores forest). Switching takes 2.5s.
- Subsystem damage (fcs: slower fire, legs: slower, sensor: x0.6). A support unit within 2.5 repairs one every 6s.
- MG units shoot down enemy missiles passing within 2.2 (35%).
- Artillery: limited per mission; target must be visible; 5 shells land 8s later within 1.8 and hit EVERYONE.

## Actions
{cmd:'move', units:[ids]|'all', x, y} | {cmd:'attack', units, target:'e<ID>'} | {cmd:'stop'|'hide', units}
{cmd:'stance', units, stance} | {cmd:'mode', units, mode} | {cmd:'ammo', units, ammo}
{cmd:'tool', units, target:'e<ID>'} (missile/charge) | {cmd:'tool', units, x, y} (other tools)
{cmd:'convoy', go} | {cmd:'artillery', x, y} | {cmd:'abort'}

## Missions
${MISSIONS.map(m => `- ${m.id} ${m.type} "${m.name}": budget ${m.budget}, max ${m.max} units${m.limit ? ', time limit ' + m.limit + 's' : ''}. Win: ${m.win}. Lose: ${m.lose}. ${m.brief}`).join('\n')}
`;
}

export type { Difficulty };
