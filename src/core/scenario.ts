// User-made scenarios (scenario editor). A ScenarioDef is plain JSON — it can be saved, shared and
// embedded in replays — and is turned into a regular MissionDef at run time.
import type { Sim } from './sim';
import type { MissionDef, MissionType } from './missions';
import { MISSIONS } from './missions';
import type { EType } from './data';
import type { GroupRole } from './ecs';
import { N } from './map';

export type VictoryKind = 'annihilate' | 'objectives' | 'reach' | 'extract' | 'escort' | 'survive' | 'recon';
export const VICTORY_NAMES: Record<VictoryKind, string> = {
  annihilate: '敵の全滅', objectives: '目標建造物の破壊', reach: '目標地点への到達', extract: '回収地点での回収',
  escort: '輸送車の護衛', survive: '制限時間まで生き残る', recon: '野営地の特定と帰還',
};
export type StructType = 'turret' | 'radar' | 'hq' | 'site';
export interface Area { x: number; y: number; r: number }
export interface ScenarioGroup { types: EType[]; x: number; y: number; role: GroupRole; leash?: number; patrol?: [number, number][]; ambush?: boolean; deaf?: boolean }
export interface ScenarioDef {
  v: 1; id: string; name: string; type: MissionType;
  brief: string; win: string; lose: string; hint: string;
  max: number; budget: number; limit: number; arty: number;
  /** Map size (tiles, up to 28) and rows of terrain: . plain, F forest, H hill, # rock, ~ water, = road. */
  w: number; h: number; tiles: string[];
  spawn: Area;
  victory: { kind: VictoryKind; need?: number; wait?: number };
  goal?: Area; lz?: Area;
  convoy?: { path: [number, number][]; trucks: number };
  groups: ScenarioGroup[];
  structures: { type: StructType; x: number; y: number; objective?: boolean }[];
  mines: [number, number][];
  /** Story text shown at t seconds; the battle pauses until the player dismisses it. */
  events: { t: number; text: string }[];
  reinforcements: { t: number; x: number; y: number; types: EType[]; role: GroupRole; count: number }[];
}

export function blankScenario(): ScenarioDef {
  const w = 24, h = 20;
  return {
    v: 1, id: 's' + Date.now().toString(36), name: '新しい作戦', type: '殲滅',
    brief: '作戦の説明を書く。', win: '敵の全滅', lose: '全機喪失', hint: '',
    max: 6, budget: 2200, limit: 0, arty: 1, w, h, tiles: Array.from({ length: h }, () => '.'.repeat(w)),
    spawn: { x: 3, y: h - 4, r: 2.5 }, victory: { kind: 'annihilate' },
    groups: [], structures: [], mines: [], events: [], reinforcements: [],
  };
}

const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0 };
const inArea = (s: Sim, a: Area) => s.livingSquad().filter(u => Math.hypot(u.pos.x - a.x, u.pos.y - a.y) <= a.r).length;

/** Problems that make a scenario unplayable (shown in the editor). */
export function validateScenario(sc: ScenarioDef): string[] {
  const err: string[] = [];
  const at = (x: number, y: number) => sc.tiles[Math.floor(y)]?.[Math.floor(x)] ?? '#';
  const pass = (x: number, y: number) => '.FH='.includes(at(x, y));
  if (!pass(sc.spawn.x, sc.spawn.y)) err.push('初期エリアの中心が通れない地形です');
  // reachability from the spawn
  const seen = new Uint8Array(sc.w * sc.h), q = [[Math.floor(sc.spawn.x), Math.floor(sc.spawn.y)]];
  if (pass(sc.spawn.x, sc.spawn.y)) seen[Math.floor(sc.spawn.y) * sc.w + Math.floor(sc.spawn.x)] = 1;
  while (q.length) { const [x, y] = q.pop()!; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= sc.w || Y >= sc.h || seen[Y * sc.w + X] || !pass(X, Y)) continue; seen[Y * sc.w + X] = 1; q.push([X, Y]) } }
  const reach = (x: number, y: number) => seen[Math.floor(y) * sc.w + Math.floor(x)] === 1;
  const k = sc.victory.kind;
  if (k === 'annihilate' && !sc.groups.length && !sc.structures.length) err.push('敵がいません');
  if (k === 'objectives' && !sc.structures.some(s => s.objective)) err.push('「目標」にチェックした建造物がありません');
  if ((k === 'reach') && !sc.goal) err.push('目標地点がありません');
  if ((k === 'extract' || k === 'recon') && !sc.lz) err.push('回収地点がありません');
  if (k === 'recon' && !sc.structures.some(s => s.type === 'site')) err.push('野営地がありません');
  if (k === 'escort' && (!sc.convoy || sc.convoy.path.length < 2)) err.push('輸送路（2点以上）がありません');
  if (k === 'survive' && !sc.limit) err.push('「生き残る」には制限時間が必要です');
  if (sc.goal && !reach(sc.goal.x, sc.goal.y)) err.push('目標地点に初期エリアから行けません');
  if (sc.lz && !reach(sc.lz.x, sc.lz.y)) err.push('回収地点に初期エリアから行けません');
  sc.convoy?.path.forEach(([x, y], i) => { if (!reach(x, y)) err.push(`輸送路の${i + 1}点目に行けません`) });
  sc.structures.forEach((s, i) => { if (s.objective && ![[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]].some(([dx, dy]) => reach(s.x + dx, s.y + dy))) err.push(`目標の建造物${i + 1}の近くに行けません`) });
  return err;
}

export function missionFromScenario(sc: ScenarioDef): MissionDef {
  const k = sc.victory.kind;
  const need = () => sc.victory.need ?? (k === 'escort' ? Math.max(1, Math.ceil((sc.convoy?.trucks ?? 1) * 0.6)) : 1);
  const m: MissionDef = {
    id: 'c:' + sc.id, part: 5, type: sc.type, code: 'CUSTOM', name: sc.name, budget: sc.budget, max: sc.max, limit: sc.limit, arty: sc.arty,
    brief: sc.brief, win: sc.win, lose: sc.lose, hint: sc.hint || '—',
    seed: hash(sc.id), spawn: [Math.floor(sc.spawn.x), Math.floor(sc.spawn.y)], keys: [], terr: { forest: 0, hills: 0, water: 0, rocks: 0 },
    tiles: sc.tiles.map(r => r.padEnd(N, '#').slice(0, N)).concat(Array(Math.max(0, N - sc.tiles.length)).fill('#'.repeat(N))).slice(0, N),
    bounds: [0, 0, Math.min(N, sc.w) - 1, Math.min(N, sc.h) - 1],
    road: sc.convoy && sc.convoy.path.length >= 2 ? sc.convoy.path.map(([x, y]) => [x, y] as [number, number]) : undefined,
    emines: sc.mines,
    scenario: sc,
    setup(s) {
      if (sc.goal) s.addZone({ kind: 'goal', x: sc.goal.x, y: sc.goal.y, r: sc.goal.r, label: '目標地点' });
      if (sc.lz) s.addZone({ kind: 'lz', x: sc.lz.x, y: sc.lz.y, r: sc.lz.r, label: '回収地点' });
      let site = 0;
      for (const st of sc.structures) {
        const e = s.spawnEnemy(st.type, st.x, st.y, { objective: !!st.objective || (k === 'objectives' && st.type === 'hq'), label: st.type === 'site' ? 'ABCDEFGH'[site] : '' });
        if (st.type === 'site') { s.sites.push(e); site++ }
        if (st.type === 'hq' && !s.hq) s.hq = e;
        if (st.type === 'radar' && !s.radar) s.radar = e;
      }
      for (const g of sc.groups) if (g.types.length) s.group(g.types, Math.floor(g.x), Math.floor(g.y), { role: g.role, leash: g.leash, patrol: g.patrol?.length ? g.patrol.map(([x, y]) => [Math.floor(x), Math.floor(y)] as [number, number]) : undefined, ambush: g.ambush, deaf: g.deaf });
      if (sc.convoy && sc.convoy.path.length >= 2) {
        const pts = sc.convoy.path.slice(1).map(([x, y]) => ({ x: x + .5, y: y + .5 })), [x0, y0] = sc.convoy.path[0];
        for (let i = 0; i < sc.convoy.trucks; i++) s.spawnTruck('輸送車' + (i + 1), s.map.nearestPass(x0 + .5 - i * 0.9, y0 + .5), pts);
      }
      for (const ev of sc.events) s.schedule(ev.t, s2 => s2.showStory(ev.text));
      for (const r of sc.reinforcements) s.schedule(r.t, s2 => {
        for (let i = 0; i < Math.max(1, r.count); i++) s2.group(r.types, Math.floor(r.x) + (i % 2 ? 2 : 0), Math.floor(r.y) + (i > 1 ? 2 : 0), { role: r.role });
        s2.log(`敵増援：${r.types.length * Math.max(1, r.count)}機`, 'warning');
      });
      if (k === 'extract') s.need = need();
    },
    objective(s) {
      switch (k) {
        case 'annihilate': return `敵残存 ${s.countE()}`;
        case 'objectives': { const o = s.world.alive('structure').filter(e => e.structure.objective).length; return `目標 残り ${o}` }
        case 'reach': return `目標地点 ${sc.goal ? inArea(s, sc.goal) : 0}/${need()}`;
        case 'extract': return s.pickup ? `回収まで ${Math.max(0, Math.ceil(s.pickup - s.time))} 秒　回収地点内 ${sc.lz ? inArea(s, sc.lz) : 0}/${need()}` : `回収地点に入って回収を要請（必要 ${need()} 機）`;
        case 'escort': return `輸送車 到達 ${s.arrived}　健在 ${s.world.alive('truck').length}（必要 ${need()}）`;
        case 'survive': return `残り ${Math.max(0, Math.ceil(sc.limit - s.time))} 秒　残存 ${s.countP()}`;
        case 'recon': { const n = s.sites.filter(x => x.structure!.scanned).length; return n < s.sites.length ? `野営地の特定 ${n}/${s.sites.length}` : '回収地点へ帰還せよ' }
      }
    },
    check(s) {
      switch (k) {
        case 'annihilate': return s.countE() === 0 ? { win: true, reason: '敵を全滅させた' } : undefined;
        case 'objectives': return s.world.alive('structure').some(e => e.structure.objective) ? undefined : { win: true, reason: '目標を破壊した' };
        case 'reach': return sc.goal && inArea(s, sc.goal) >= need() ? { win: true, reason: '目標地点に到達した' } : undefined;
        case 'recon': return s.sites.every(x => x.structure!.scanned) && sc.lz && inArea(s, sc.lz) > 0 ? { win: true, reason: '偵察情報を持ち帰った' } : undefined;
        case 'survive': return s.time >= sc.limit - 0.05 ? { win: true, reason: '持ちこたえた' } : undefined;
        case 'escort': {
          const alive = s.world.alive('truck').length;
          if (alive + s.arrived < need()) return { win: false, reason: '輸送車を失いすぎた' };
          if (alive === 0 && s.arrived >= need()) return { win: true, reason: '輸送車を送り届けた' };
          return undefined;
        }
        case 'extract': {
          const lz = sc.lz!; if (!lz) return undefined;
          if (!s.pickup && inArea(s, lz) > 0) { s.pickup = s.time + (sc.victory.wait ?? 30); s.log(`回収を要請。到着まで${sc.victory.wait ?? 30}秒`, 'info') }
          if (s.pickup && s.time >= s.pickup) {
            const inLZ = s.livingSquad().filter(u => Math.hypot(u.pos.x - lz.x, u.pos.y - lz.y) <= lz.r);
            s.extracted = inLZ.length; inLZ.forEach(u => { u.life.alive = false; u.life.gone = true });
            return s.extracted >= need() ? { win: true, reason: `${s.extracted} 機を回収した` } : { win: false, reason: `回収できたのは ${s.extracted} 機（必要 ${need()}）` };
          }
          if (s.countP() < need()) return { win: false, reason: '回収に必要な機数を割り込んだ' };
          return undefined;
        }
      }
    },
  };
  return m;
}

// ---------------------------------------------------------------- registry
const CUSTOM = new Map<string, MissionDef>();
/** Make a scenario playable (idempotent; replaces an older version with the same id). */
export function registerScenario(sc: ScenarioDef): MissionDef { const m = missionFromScenario(sc); CUSTOM.set(m.id, m); return m }
export function unregisterScenario(id: string) { CUSTOM.delete(id.startsWith('c:') ? id : 'c:' + id) }
export function customMissions(): MissionDef[] { return [...CUSTOM.values()] }
export function findMission(id: string): MissionDef | undefined { return MISSIONS.find(m => m.id === id) ?? CUSTOM.get(id) }
