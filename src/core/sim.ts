// The simulation: owns the ECS world, map and battlefield state, and advances it in fixed ticks.
// Engine-independent — runs the same in the browser (Phaser renders it) and in Node (AI, tests).

import { AMMO_CAP, CHASSIS, DIFFS, ETYPES, PILOTS, TOOLS, WEAPONS, loadoutStats, migrateLoadout } from './data';
import type { Difficulty, EType, Loadout, Shape, ToolKey, UnitStats } from './data';
import { World } from './ecs';
import type { Entity, Pt, Team, With } from './ecs';
import { GameMap, N, T, generateMap } from './map';
import { dist, rng } from './rng';
import { MISSIONS } from './missions';
import type { MissionDef, MissionId } from './missions';
import type { Command, CommandSource, RecordedCommand } from './commands';
import { execCommand, describeCommand } from './commands';
import { runSystems } from './systems';

export const TICK = 1 / 30;

export interface Cloud { k: 'chaff' | 'smoke' | 'flare' | 'jam'; x: number; y: number; r: number; t: number; dur: number; team: Team }
export interface Mine { x: number; y: number; team: Team; arm: number; revealed: boolean; disarm: number; src: number | null; done?: boolean }
export interface Shell { x: number; y: number; at: number; cx: number; cy: number; done?: boolean }
export interface Charge { x: number; y: number; t: number; team: Team; src: number | null; done?: boolean }
export interface Projectile {
  x: number; y: number; px: number; py: number; tx: number; ty: number; tgt: number; spd: number; dmg: number; splash: number;
  team: Team; k: 'MG' | 'RF' | 'SN' | 'MSL'; src: number; am: 'std' | 'ap' | 'he'; acc: number; lost?: boolean; tried?: number[]; done?: boolean;
}
export interface Zone { kind: 'lz' | 'goal' | 'hint'; x: number; y: number; r: number; label: string }
export type FxKind = 'flash' | 'hit' | 'boom' | 'miss' | 'puff' | 'heal' | 'ping' | 'smoke';
export interface Fx { k: FxKind; x: number; y: number; r?: number; team?: Team; red?: boolean }
export type LogKind = 'warning' | 'info' | 'note' | 'ai';
export interface LogEntry { t: number; text: string; kind: LogKind }
export interface Outcome { win: boolean; reason: string }
export interface TimedEvent { t: number; fn: (s: Sim) => void; done?: boolean }

export interface SimOptions {
  mission: MissionId;
  difficulty?: Difficulty;
  seed?: number;
  slots?: Loadout[];
  deploy?: boolean[];
  /** Commands to replay; issuing new commands is disabled while replaying. */
  replay?: RecordedCommand[];
}

export interface Replay {
  v: 3; mission: MissionId; diff: Difficulty; seed: number; slots: Loadout[]; deploy: boolean[];
  ctrl: 'human' | 'ai' | 'mixed'; date: number; ticks: number;
  result: { win: boolean; reason: string; time: number; kills: number; lost: number };
  cmds: RecordedCommand[];
}

export class Sim {
  readonly m: MissionDef;
  readonly diff: Difficulty;
  readonly seed: number;
  readonly slots: Loadout[];
  readonly deploy: boolean[];
  readonly world = new World();
  readonly map: GameMap;
  readonly rnd: () => number;

  time = 0; tickN = 0;
  vis = new Uint8Array(N * N); explored = new Uint8Array(N * N);
  seenE = new Set<number>(); detP = new Set<number>();
  visTimer = 0;
  clouds: Cloud[] = []; mines: Mine[] = []; shells: Shell[] = []; charges: Charge[] = []; projs: Projectile[] = [];
  zones: Zone[] = []; events: TimedEvent[] = [];
  fx: Fx[] = []; logs: LogEntry[] = [];
  over: Outcome | null = null;
  kills = 0; lost = 0; arty = 0;
  // mission state
  convoyGo = false; arrived = 0; extracted = 0; pickup = 0; need = 0;
  hq: Entity | null = null; radar: Entity | null = null; sites: Entity[] = [];
  huntGoal: Pt | null = null; intel: Pt | null = null; intelT = -99;
  // commands
  rec: RecordedCommand[] = [];
  private replayCmds: RecordedCommand[] | null; private replayI = 0;
  /** Called once per simulated second (used by the built-in AI commander). */
  onSecond: ((s: Sim) => void) | null = null;

  constructor(o: SimOptions) {
    const m = MISSIONS.find(x => x.id === o.mission);
    if (!m) throw new Error('unknown mission ' + o.mission);
    this.m = m;
    this.diff = o.difficulty || 'easy';
    this.seed = o.seed != null ? (o.seed >>> 0) : (Math.random() * 4294967296) >>> 0;
    this.rnd = rng(this.seed);
    this.slots = (o.slots || []).map(migrateLoadout);
    this.deploy = [...(o.deploy || this.slots.map(() => true))];
    this.replayCmds = o.replay || null;
    this.map = generateMap(m);
    this.arty = m.arty;

    let k = 0;
    this.slots.forEach((s, i) => {
      if (!this.deploy[i]) return;
      const o2 = OFFS[k++] || [0, 0];
      const p = this.map.nearestPass(m.spawn[0] + .5 + o2[0] * .9, m.spawn[1] + .5 + o2[1] * .9);
      this.spawnSquad(i, s, p);
    });
    m.setup(this);
    for (const [x, y] of m.emines || []) this.mines.push({ x, y, team: 'E', arm: 0, revealed: false, disarm: 0, src: null });
    runSystems.vision(this);
  }

  // ------------------------------------------------------------------ factories
  private unitBase(team: Team, st: UnitStats | { hp: number; armor: number; sensor: number; weapon: string | null; shape: Shape }, p: Pt, name: string) {
    const w = st.weapon ? WEAPONS[st.weapon as keyof typeof WEAPONS] : null;
    const e: Omit<Entity, 'id'> = {
      pos: { x: p.x, y: p.y }, team, name, shape: st.shape, life: { alive: true, gone: false },
      health: { hp: st.hp, maxHp: st.hp, armor: st.armor, hitT: 0 },
      sensor: { range: st.sensor, radarBonus: 'radarBonus' in st ? st.radarBonus : 0, emit: 'emit' in st ? st.emit : 0 },
      systems: { fcs: false, legs: false, sensor: false, fixP: 0 },
    };
    if (w) {
      const key = st.weapon as keyof typeof WEAPONS;
      e.weapon = { key, def: w, cd: this.rnd() * 0.6, fireT: 0, ammoType: 'std', nextAmmo: null, reloadT: 0, ap: AMMO_CAP[key].ap, he: AMMO_CAP[key].he };
    }
    if ('speed' in st && st.speed > 0) e.mover = { speed: st.speed, path: [], repathT: 0, stT: 0, stP: null, cap: 0 };
    if ('stealth' in st && st.stealth) e.stealth = { revealT: 0 };
    if ('regen' in st && st.regen) e.regen = { rate: st.regen };
    if ('repair' in st && st.repair) e.repairer = { rate: st.repair, radius: 2.5 };
    if ('tool' in st && st.tool !== 'none') e.toolbelt = { tool: st.tool, ammo: TOOLS[st.tool].ammo, cd: 0, pending: null };
    return e;
  }

  spawnSquad(slot: number, cfg: Loadout, p: Pt) {
    const st = loadoutStats(cfg);
    const e = this.unitBase('P', st, p, PILOTS[slot][0]);
    e.squad = { no: slot + 1, pilot: PILOTS[slot][0], cfg, stance: 'hold', order: 'idle', target: null, mmode: 'normal', hidden: false, hideT: 0 };
    e.exposure = { margin: 99, warnBy: null };
    return this.world.spawn(e);
  }

  spawnEnemy(type: EType, x: number, y: number, extra: { patrol?: [number, number][]; hunt?: boolean; objective?: boolean; label?: string } = {}) {
    const d = ETYPES[type];
    const p = this.map.nearestPass(x, y);
    const hpMul = DIFFS[this.diff].hp;
    let e: Omit<Entity, 'id'>;
    if (d.structure) {
      const s = d.structure;
      e = this.unitBase('E', { ...s, hp: Math.round(s.hp * hpMul) }, p, d.name);
      e.structure = { kind: type, objective: !!extra.objective, label: extra.label || '', scan: 0, scanned: false, alerted: false };
      delete e.systems;
    } else {
      const st = loadoutStats(d.loadout!);
      e = this.unitBase('E', { ...st, hp: Math.round(st.hp * hpMul) }, p, d.name);
      const patrol = extra.patrol ? extra.patrol.map(([a, b]) => ({ x: a + .5, y: b + .5 })) : null;
      e.enemyAI = { etype: type, state: extra.hunt ? 'hunt' : patrol ? 'patrol' : 'guard', home: { ...p }, patrol, pi: 0, lostT: 0, lastKnown: null, alertLogged: false, target: null };
    }
    e.intel = { lastSeen: null };
    return this.world.spawn(e);
  }

  group(types: EType[], cx: number, cy: number, extra: { patrol?: [number, number][]; hunt?: boolean } = {}) {
    types.forEach((t, i) => this.spawnEnemy(t, cx + .5 + OFFS[i][0], cy + .5 + OFFS[i][1], extra));
  }

  spawnTruck(name: string, p: Pt, path: Pt[]) {
    const e = this.unitBase('P', { hp: 210, armor: 4, sensor: 3, weapon: null, shape: 'truck' }, p, name);
    e.mover = { speed: 0.8, path: path.map(q => ({ ...q })), repathT: 0, stT: 0, stP: null, cap: 0 };
    e.truck = { hold: true };
    delete e.systems;
    return this.world.spawn(e);
  }

  spawnPlaced(kind: 'decoy' | 'probe', p: Pt, ttl: number) {
    const e = kind === 'decoy'
      ? this.unitBase('P', { hp: 60, armor: 2, sensor: 1, weapon: null, shape: 'decoy' }, p, 'デコイ')
      : this.unitBase('P', { hp: 25, armor: 1, sensor: 5, weapon: null, shape: 'probe' }, p, 'プローブ');
    if (kind === 'decoy') e.sensor!.emit = 2.5; else e.stealth = { revealT: 0 };
    e.ephemeral = { kind, ttl };
    delete e.systems;
    return this.world.spawn(e);
  }

  // ------------------------------------------------------------------ queries & rules helpers
  get squad() { return this.world.with('squad') }
  livingSquad() { return this.world.alive('squad') }
  enemies() { return this.world.alive().filter(e => e.team === 'E') }
  countE() { return this.enemies().length }
  countP() { return this.livingSquad().length }
  etype(e: Entity): EType | null { return e.enemyAI?.etype ?? e.structure?.kind ?? null }
  inCloud(k: Cloud['k'], p: Pt) { for (const c of this.clouds) if (c.k === k && Math.hypot(p.x - c.x, p.y - c.y) <= c.r) return true; return false }
  inZone(e: Entity, kind: Zone['kind']) { return this.zones.some(z => z.kind === kind && Math.hypot(e.pos.x - z.x, e.pos.y - z.y) <= z.r) }
  onHill(e: Entity) { return this.map.at(e.pos.x, e.pos.y) === T.HILL }
  inForest(e: Entity) { return this.map.at(e.pos.x, e.pos.y) === T.FOREST }
  /** Current movement speed before terrain (legs damage and move mode applied). */
  effSpeed(e: Entity) { const mm = e.squad?.mmode; return (e.mover?.speed || 0) * (e.systems?.legs ? 0.55 : 1) * (mm === 'fast' ? 1.5 : mm === 'careful' ? 0.6 : 1) }
  rangeOf(e: Entity) { return e.weapon ? e.weapon.def.range + (this.onHill(e) ? 1 : 0) : 0 }
  effSensor(e: Entity) {
    if (!e.sensor) return 0;
    let s = e.sensor.range - (e.sensor.radarBonus && this.inCloud('chaff', e.pos) ? e.sensor.radarBonus : 0);
    if (e.systems?.sensor) s *= 0.6;
    const mm = e.squad?.mmode;
    if (mm === 'fast') s *= 0.7; else if (mm === 'careful') s += 1.5;
    if (e.team === 'E' && this.inCloud('jam', e.pos)) s *= 0.4;
    return s + (this.onHill(e) ? 1 : 0);
  }
  hasRadar(e: Entity) { return !!e.sensor && e.sensor.radarBonus > 0 && !this.inCloud('chaff', e.pos) }
  /** Multiplier on how far away enemies notice this unit. */
  detMul(p: Entity) {
    let f = 1;
    if (p.stealth && p.stealth.revealT <= 0) f *= 0.5;
    if (this.inForest(p)) f *= 0.7;
    if (p.squad?.hidden) f *= 0.35;
    if (p.squad?.mmode === 'careful') f *= 0.85;
    return f;
  }
  /** Distance at which enemy `e` detects our unit `p` (-1 = cannot). */
  detRange(e: Entity, p: Entity) {
    const cp = this.inCloud('chaff', p.pos), isRadar = this.etype(e) === 'radar';
    if (isRadar && (cp || this.inCloud('chaff', e.pos) || this.inCloud('jam', e.pos))) return -1;
    let m = this.detMul(p);
    if (!isRadar && this.inCloud('smoke', p.pos)) m *= 0.4;
    return this.effSensor(e) * m + (p.sensor?.emit && !cp ? p.sensor.emit : 0) + (p.squad?.mmode === 'fast' ? 1.5 : 0);
  }
  canSee(viewer: Entity, t: Entity) { return viewer.team === 'P' ? this.seenE.has(t.id) : this.detP.has(t.id) }
  canLock(u: Entity, t: Entity | undefined): boolean {
    if (!t || !t.life.alive || this.inCloud('chaff', t.pos)) return false;
    const d = dist(u.pos, t.pos);
    if (d > TOOLS.missile.range! + (this.onHill(u) ? 1 : 0)) return false;
    if (u.team === 'P') {
      if (!this.seenE.has(t.id)) return false;
      if (d <= this.effSensor(u)) return true;
      return this.world.alive().some(a => a.team === 'P' && this.hasRadar(a) && dist(a.pos, t.pos) <= this.effSensor(a));
    }
    if (!this.detP.has(t.id)) return false;
    if (d <= this.effSensor(u)) return true;
    return this.world.alive('structure').some(a => a.structure.kind === 'radar' && !this.inCloud('chaff', a.pos) && dist(a.pos, t.pos) <= this.effSensor(a));
  }
  targetOf(e: Entity): Entity | undefined { return this.world.get(e.squad ? e.squad.target : e.enemyAI ? e.enemyAI.target : null) }
  diffMul() { return DIFFS[this.diff] }

  // ------------------------------------------------------------------ output channels
  log(text: string, kind: LogKind = 'note') { this.logs.push({ t: +this.time.toFixed(1), text, kind }); if (this.logs.length > 800) this.logs.splice(0, 200) }
  emit(f: Fx) { this.fx.push(f); if (this.fx.length > 600) this.fx.splice(0, 200) }
  schedule(t: number, fn: (s: Sim) => void) { this.events.push({ t, fn }) }
  addZone(z: Zone) { this.zones.push(z) }

  // ------------------------------------------------------------------ commands
  get replaying() { return !!this.replayCmds }
  /** Record and execute a command. Returns false when the battle is over or a replay is playing. */
  issue(c: Command, src: CommandSource = 'human'): boolean {
    if (this.over || this.replayCmds) return false;
    const cmd = { ...c, src } as Command;
    this.rec.push([this.tickN, cmd]);
    execCommand(this, cmd);
    return true;
  }
  describe(c: Command) { return describeCommand(this, c) }

  // ------------------------------------------------------------------ stepping
  step() {
    if (this.over) return;
    if (this.replayCmds) {
      while (this.replayI < this.replayCmds.length && this.replayCmds[this.replayI][0] <= this.tickN) {
        execCommand(this, this.replayCmds[this.replayI][1]); this.replayI++;
        if (this.over) return;
      }
    }
    runSystems.all(this, TICK);
    this.tickN++;
    if (this.onSecond && !this.replayCmds && !this.over && this.tickN % 30 === 0) this.onSecond(this);
  }
  /** Advance by `sec` seconds (whole ticks). */
  run(sec: number) { const n = Math.max(1, Math.round(sec * 30)); for (let i = 0; i < n && !this.over; i++) this.step() }

  finish(r: Outcome) {
    if (this.over) return;
    this.over = r;
  }

  toReplay(): Replay {
    const srcs = new Set(this.rec.map(x => x[1].src || 'human'));
    return {
      v: 3, mission: this.m.id, diff: this.diff, seed: this.seed, slots: this.slots, deploy: this.deploy,
      ctrl: srcs.size > 1 ? 'mixed' : srcs.size ? ([...srcs][0] as 'human' | 'ai') : 'human', date: Date.now(), ticks: this.tickN,
      result: { win: !!this.over?.win, reason: this.over?.reason || '', time: +this.time.toFixed(2), kills: this.kills, lost: this.lost },
      cmds: this.rec,
    };
  }
  static fromReplay(r: Replay) {
    return new Sim({ mission: r.mission, difficulty: r.diff, seed: r.seed, slots: r.slots, deploy: r.deploy, replay: r.cmds });
  }
}

export const OFFS: [number, number][] = [[0, 0], [1.1, 0], [0, 1.1], [-1.1, 0], [0, -1.1], [1.1, 1.1], [-1.1, 1.1], [1.1, -1.1], [-1.1, -1.1], [2.2, 0], [0, 2.2], [-2.2, 0]];

/** Re-simulate a replay without rendering and check that it reproduces the recorded outcome. */
export function verifyReplay(r: Replay) {
  const s = Sim.fromReplay(r);
  const limit = r.ticks + 5;
  while (!s.over && s.tickN < limit) s.step();
  const got = { win: !!s.over?.win, reason: s.over?.reason || '', time: +s.time.toFixed(2) };
  return { recorded: r.result, replayed: got, match: got.win === r.result.win && Math.abs(got.time - r.result.time) < 0.05 };
}

export { CHASSIS, TOOLS };
export type { ToolKey, With };
