// Terrain grid, map generation and pathfinding.
import { rng } from './rng';
import type { Pt } from './ecs';

export const N = 28;
export const T = { PLAIN: 0, FOREST: 1, HILL: 2, ROCK: 3, WATER: 4, ROAD: 5 } as const;
export type Terrain = typeof T[keyof typeof T];
export const TERR: { name: string; move: number; pass: boolean; fx: string }[] = [
  { name: '平地', move: 1, pass: true, fx: '特になし' },
  { name: '森林', move: 1.7, pass: true, fx: '移動コスト×1.7 ／ 中の機体は発見距離×0.7・被ダメージ-25%' },
  { name: '丘陵', move: 1.35, pass: true, fx: '移動コスト×1.35 ／ 上の機体は視界+1・射程+1' },
  { name: '岩場', move: 9, pass: false, fx: '通行不可' },
  { name: '水域', move: 9, pass: false, fx: '通行不可' },
  { name: '道路', move: 0.8, pass: true, fx: '移動コスト×0.8（速く移動できる）' },
];

export interface MapSpec {
  seed: number; spawn: [number, number]; keys: [number, number][]; road?: [number, number][];
  terr: { forest: number; hills: number; water: number; rocks: number };
  /** Hand-placed terrain discs after the random blobs: [kind, x, y, radius]. */
  paint?: [kind: 'plain' | 'forest' | 'hill' | 'rock' | 'water', x: number, y: number, r: number][];
  /** Hand-made map (scenario editor): N rows of . F H # ~ =. Replaces the procedural terrain. */
  tiles?: string[];
  /** Playable rectangle [x0, y0, x1, y1] (inclusive tiles); everything outside becomes rock. For small training maps. */
  bounds?: [number, number, number, number];
}

export class GameMap {
  constructor(public grid: Uint8Array, public bounds?: [number, number, number, number]) {}
  /** False for tiles outside a training map's playable rectangle (not drawn). */
  inside(x: number, y: number) { const b = this.bounds; return !b || (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) }
  at(x: number, y: number): Terrain {
    const X = Math.floor(x), Y = Math.floor(y);
    if (X < 0 || Y < 0 || X >= N || Y >= N) return T.ROCK;
    return this.grid[Y * N + X] as Terrain;
  }
  pass(x: number, y: number) { return TERR[this.at(x, y)].pass }
  passI(i: number) { return TERR[this.grid[i]].pass }
  nearestPass(x: number, y: number): Pt {
    if (this.pass(x, y)) return { x, y };
    for (let r = 1; r < 8; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const X = Math.floor(x) + dx, Y = Math.floor(y) + dy;
      if (X >= 0 && Y >= 0 && X < N && Y < N && TERR[this.grid[Y * N + X]].pass) return { x: X + .5, y: Y + .5 };
    }
    return { x, y };
  }

  private los(a: Pt, b: Pt) {
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    for (let s = 0; s <= L; s += 0.2) {
      const x = a.x + (b.x - a.x) * s / L, y = a.y + (b.y - a.y) * s / L;
      if (!this.pass(x, y) || !this.pass(x + .22, y) || !this.pass(x - .22, y) || !this.pass(x, y + .22) || !this.pass(x, y - .22)) return false;
      if (this.at(x, y) === T.FOREST && this.at(a.x, a.y) !== T.FOREST && this.at(b.x, b.y) !== T.FOREST) return false;
    }
    return true;
  }

  /** A* over the tile grid (8 directions, no corner cutting, terrain costs) followed by line-of-sight smoothing. */
  findPath(sx: number, sy: number, tx: number, ty: number): Pt[] {
    const sp = this.nearestPass(sx, sy), tp = this.nearestPass(tx, ty); tx = tp.x; ty = tp.y;
    const s = Math.floor(sp.y) * N + Math.floor(sp.x), t = Math.floor(ty) * N + Math.floor(tx);
    if (s === t) return [{ x: tx, y: ty }];
    const g = new Float32Array(N * N).fill(1e9), came = new Int32Array(N * N).fill(-1), closed = new Uint8Array(N * N);
    const heap: [number, number][] = [];
    const H = (i: number) => { const dx = Math.abs(i % N - t % N), dy = Math.abs(((i / N) | 0) - ((t / N) | 0)); return (dx + dy - 0.586 * Math.min(dx, dy)) * 0.8 };
    g[s] = 0; hpush(heap, [H(s), s]);
    while (heap.length) {
      const c = hpop(heap)[1]; if (closed[c]) continue; closed[c] = 1; if (c === t) break;
      const cx = c % N, cy = (c / N) | 0;
      for (const [dx, dy, dc] of DIRS) {
        const X = cx + dx, Y = cy + dy; if (X < 0 || Y < 0 || X >= N || Y >= N) continue;
        const n = Y * N + X; if (closed[n] || !this.passI(n)) continue;
        if (dx && dy && (!this.passI(cy * N + X) || !this.passI(Y * N + cx))) continue;
        const ng = g[c] + dc * TERR[this.grid[n]].move;
        if (ng < g[n]) { g[n] = ng; came[n] = c; hpush(heap, [ng + H(n), n]) }
      }
    }
    if (came[t] === -1) return [];
    const pts: Pt[] = []; let c = t;
    while (c !== s) { pts.push({ x: c % N + .5, y: ((c / N) | 0) + .5 }); c = came[c] }
    pts.reverse(); pts[pts.length - 1] = { x: tx, y: ty };
    const out: Pt[] = []; let cur: Pt = { x: sx, y: sy }, i = 0;
    while (i < pts.length) { let j = pts.length - 1; while (j > i && !this.los(cur, pts[j])) j--; out.push(pts[j]); cur = pts[j]; i = j + 1 }
    return out;
  }
}

const DIRS: [number, number, number][] = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
function hpush(h: [number, number][], n: [number, number]) { h.push(n); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break;[h[p], h[i]] = [h[i], h[p]]; i = p } }
function hpop(h: [number, number][]) {
  const top = h[0], last = h.pop()!;
  if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && h[l][0] < h[m][0]) m = l; if (r < h.length && h[r][0] < h[m][0]) m = r; if (m === i) break;[h[m], h[i]] = [h[i], h[m]]; i = m } }
  return top;
}

/** Procedural terrain from the mission seed; guarantees every key point is reachable from spawn. */
export function generateMap(m: MapSpec): GameMap {
  if (m.tiles) {
    const CH: Record<string, number> = { '.': T.PLAIN, F: T.FOREST, H: T.HILL, '#': T.ROCK, '~': T.WATER, '=': T.ROAD };
    const g = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) g[y * N + x] = CH[m.tiles[y]?.[x] ?? '#'] ?? T.ROCK;
    if (m.bounds) { const [x0, y0, x1, y1] = m.bounds; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (x < x0 || x > x1 || y < y0 || y > y1) g[y * N + x] = T.ROCK }
    return new GameMap(g, m.bounds);
  }
  const R = rng(m.seed), g = new Uint8Array(N * N);
  const blob = (type: number, count: number, r0: number, r1: number) => {
    for (let k = 0; k < count; k++) {
      const cx = R() * N, cy = R() * N, r = r0 + R() * (r1 - r0);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x + .5 - cx, y + .5 - cy) + (R() - .5) * 1.3 < r) g[y * N + x] = type;
    }
  };
  blob(T.FOREST, m.terr.forest, 1.6, 3.6); blob(T.HILL, m.terr.hills, 1.2, 2.6); blob(T.WATER, m.terr.water, 1.2, 2.6); blob(T.ROCK, m.terr.rocks, 0.6, 1.4);
  const PK = { plain: T.PLAIN, forest: T.FOREST, hill: T.HILL, rock: T.ROCK, water: T.WATER } as const;
  for (const [k, cx, cy, r] of m.paint || []) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x + .5 - cx, y + .5 - cy) < r) g[y * N + x] = PK[k];
  if (m.bounds) { const [x0, y0, x1, y1] = m.bounds; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (x < x0 || x > x1 || y < y0 || y > y1) g[y * N + x] = T.ROCK }
  const clear = (cx: number, cy: number, r: number) => {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const i = y * N + x; if (Math.hypot(x + .5 - cx, y + .5 - cy) < r && (g[i] === T.ROCK || g[i] === T.WATER || r > 2.5)) g[i] = T.PLAIN }
  };
  clear(m.spawn[0] + .5, m.spawn[1] + .5, 3.2);
  m.keys.forEach(([x, y]) => clear(x + .5, y + .5, 1.3));
  if (m.road) for (let k = 0; k < m.road.length - 1; k++) {
    const [a, b] = m.road[k], [c, d] = m.road[k + 1], L = Math.hypot(c - a, d - b);
    for (let s = 0; s <= L; s += 0.2) {
      const tx = Math.floor(a + (c - a) * s / L), ty = Math.floor(b + (d - b) * s / L);
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = tx + dx, Y = ty + dy; if (X < 0 || Y < 0 || X >= N || Y >= N) continue; const i = Y * N + X;
        if (dx || dy) { if (g[i] === T.ROCK || g[i] === T.WATER) g[i] = T.PLAIN } else g[i] = T.ROAD;
      }
    }
  }
  if (m.bounds) { const [x0, y0, x1, y1] = m.bounds; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (x < x0 || x > x1 || y < y0 || y > y1) g[y * N + x] = T.ROCK }
  const reach = () => {
    const seen = new Uint8Array(N * N), s0 = Math.floor(m.spawn[1]) * N + Math.floor(m.spawn[0]), q = [s0]; seen[s0] = 1;
    while (q.length) {
      const c = q.pop()!, cx = c % N, cy = (c / N) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = cx + dx, Y = cy + dy; if (X < 0 || Y < 0 || X >= N || Y >= N) continue; const i = Y * N + X; if (!seen[i] && TERR[g[i]].pass) { seen[i] = 1; q.push(i) } }
    }
    return seen;
  };
  let seen = reach();
  for (const [kx, ky] of m.keys) {
    if (seen[Math.floor(ky) * N + Math.floor(kx)]) continue;
    const [a, b] = m.spawn, L = Math.hypot(kx - a, ky - b);
    for (let s = 0; s <= L; s += 0.25) { const i = Math.floor(b + (ky - b) * s / L) * N + Math.floor(a + (kx - a) * s / L); if (!TERR[g[i]].pass) g[i] = T.PLAIN }
    seen = reach();
  }
  for (let i = 0; i < N * N; i++) if (!seen[i] && TERR[g[i]].pass) g[i] = T.ROCK;
  return new GameMap(g, m.bounds);
}
