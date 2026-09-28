// Phaser scene: renders a BattleSession in isometric view and turns pointer input into orders.
import Phaser from 'phaser';
import { CHASSIS, ETYPES, N, T, TOOLS } from '../core';
import type { Entity, Fx } from '../core';
import type { BattleSession } from './controller';
import { HPX, OX, OY, TCOL, TH, TW, WPX, p2w, shade, standPx, tileH, w2p } from './iso';
import { mulberryVisual } from './visualRng';

type G = Phaser.GameObjects.Graphics;
interface LiveFx extends Fx { born: number; dur: number }
interface Ptr { sx: number; sy: number; x: number; y: number; btn: number; touch: boolean; moved: boolean; camX: number; camY: number; shift: boolean }

const COL = { blue: 0x5fb0e0, red: 0xe4643c, gold: 0xe2b84a, good: 0x8cc67e, ink: 0x081017, sand: 0xd8c690, struct: 0xb9503a, pale: 0xe8f4ff, bg: 0x0a0f13 };
const FXDUR: Record<string, number> = { flash: .12, hit: .2, boom: .7, miss: .4, puff: .6, heal: .6, ping: .6, smoke: .5 };

export interface SceneHooks {
  keys: Set<string>;
  onHover(p: { x: number; y: number } | null, picked: Entity | null): void;
  onBox(rect: { x: number; y: number; w: number; h: number } | null): void;
  onSelectionChanged(): void;
}

export class BattleScene extends Phaser.Scene {
  s!: BattleSession;
  hooks!: SceneHooks;
  private terrain!: G; private fog!: G; private under!: G; private unitsG!: G; private over!: G;
  private texts: Phaser.GameObjects.Text[] = []; private textI = 0;
  private fxs: LiveFx[] = [];
  private ptr: Ptr | null = null;
  hover: { sx: number; sy: number; wx: number; wy: number } | null = null;
  private fogTick = -1;

  constructor() { super('battle') }

  init(data: { session: BattleSession; hooks: SceneHooks }) { this.s = data.session; this.hooks = data.hooks; this.fxs = []; this.fogTick = -1; this.texts = []; this.ptr = null; this.hover = null }

  create() {
    this.cameras.main.setBackgroundColor(COL.bg);
    this.terrain = this.add.graphics().setDepth(0);
    this.drawTerrain();
    this.fog = this.add.graphics().setDepth(1);
    this.under = this.add.graphics().setDepth(2);
    this.unitsG = this.add.graphics().setDepth(3);
    this.over = this.add.graphics().setDepth(5);
    const m = this.s.sim.m, [sx, sy] = w2p(m.spawn[0] + .5, m.spawn[1] + .5);
    this.cameras.main.centerOn(sx + 60, sy - 40);
    this.input.mouse?.disableContextMenu();
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onDown(p));
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.onMove(p));
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => this.onUp(p));
    this.input.on('gameout', () => { this.hover = null; this.hooks.onHover(null, null) });
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      const cam = this.cameras.main; cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.55, 1.8)); this.clampCam();
    });
  }

  // ------------------------------------------------------------------ helpers
  private text(x: number, y: number, str: string, style: { size?: number; color?: string; weight?: number; mono?: boolean; alpha?: number; depth?: number }) {
    let t = this.texts[this.textI];
    if (!t) { t = this.add.text(0, 0, '', { fontFamily: '"IBM Plex Sans JP", sans-serif', fontSize: '11px', color: '#fff' }).setOrigin(0.5).setResolution(2); this.texts.push(t) }
    this.textI++;
    const font = `${style.weight || 500} ${style.size || 11}px ${style.mono ? '"IBM Plex Mono", monospace' : '"IBM Plex Sans JP", sans-serif'}`;
    if ((t as any)._font !== font) { t.setFont(font); (t as any)._font = font }
    if (t.text !== str) t.setText(str);
    t.setColor(style.color || '#ffffff').setAlpha(style.alpha ?? 1).setPosition(x, y).setDepth(style.depth ?? 6).setVisible(true);
    return t;
  }
  /** Iso circle of radius r tiles centred at pixel (x,y). */
  private ell(g: G, x: number, y: number, r: number, stroke: number | null, alpha = 1, width = 1, fill?: number, fillA = 0, dash = 0) {
    const w = r * TW * 1.414, h = r * TH * 1.414;
    if (fill !== undefined && fillA > 0) { g.fillStyle(fill, fillA); g.fillEllipse(x, y, w, h) }
    if (stroke == null) return;
    g.lineStyle(width, stroke, alpha);
    if (!dash) { g.strokeEllipse(x, y, w, h); return }
    const seg = Math.max(24, Math.round(r * 18));
    for (let i = 0; i < seg; i += 2) {
      const a0 = i / seg * Math.PI * 2, a1 = (i + 1) / seg * Math.PI * 2;
      g.lineBetween(x + Math.cos(a0) * w / 2, y + Math.sin(a0) * h / 2, x + Math.cos(a1) * w / 2, y + Math.sin(a1) * h / 2);
    }
  }
  private dashLine(g: G, pts: [number, number][], color: number, alpha: number, dash = 4, gap = 4) {
    g.lineStyle(1, color, alpha);
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], L = Math.hypot(bx - ax, by - ay);
      for (let d = 0; d < L; d += dash + gap) { const e = Math.min(L, d + dash); g.lineBetween(ax + (bx - ax) * d / L, ay + (by - ay) * d / L, ax + (bx - ax) * e / L, ay + (by - ay) * e / L) }
    }
  }
  private at(e: Entity | { x: number; y: number }) { const p = 'pos' in e ? e.pos : e; return standPx(this.s.sim.map, p.x, p.y) }
  visibleEntity(e: Entity) {
    const s = this.s.sim;
    if (!e.life.alive) return false;
    if (e.team === 'P') return true;
    return s.seenE.has(e.id) || !!(e.structure?.scanned) || (!!this.s.replay && this.s.reveal);
  }
  /** Pick the unit under a world-pixel position. */
  /** Our own unit under the cursor, with a bigger hit area than pickAt (for selecting). */
  pickSquadAt(wx: number, wy: number): Entity | null {
    let best: Entity | null = null, bd = 26;
    for (const e of this.s.sim.livingSquad()) { const [px, py] = this.at(e); const d = Math.hypot(px - wx, py - 12 - wy); if (d < bd) { bd = d; best = e } }
    return best;
  }
  pickAt(wx: number, wy: number): Entity | null {
    let best: Entity | null = null, bd = 18;
    for (const e of this.s.sim.world.all()) {
      if (!this.visibleEntity(e) || !e.health) continue;
      const [px, py] = this.at(e); const d = Math.hypot(px - wx, py - 12 - wy), lim = e.structure ? 22 : 16;
      if (d < lim && d < bd) { bd = d; best = e }
    }
    return best;
  }
  viewRect() { const c = this.cameras?.main; return c ? c.worldView : new Phaser.Geom.Rectangle(0, 0, 0, 0) }
  centerOn(tile: { x: number; y: number }) { const [px, py] = w2p(tile.x, tile.y); this.cameras.main.centerOn(px, py); this.clampCam() }
  centerOnPixel(px: number, py: number) { this.cameras.main.centerOn(px, py); this.clampCam() }
  private clampCam() {
    const c = this.cameras.main, v = c.worldView;
    c.scrollX = Phaser.Math.Clamp(c.scrollX, -v.width * .4 - (c.width - v.width) / 2, WPX - v.width * .6 - (c.width - v.width) / 2);
    c.scrollY = Phaser.Math.Clamp(c.scrollY, -v.height * .4 - (c.height - v.height) / 2, HPX - v.height * .6 - (c.height - v.height) / 2);
  }

  // ------------------------------------------------------------------ input
  private onDown(p: Phaser.Input.Pointer) {
    if (this.s.sim.over) return;
    const ev = p.event as MouseEvent;
    this.ptr = { sx: p.x, sy: p.y, x: p.x, y: p.y, btn: ev.button ?? 0, touch: p.wasTouch, moved: false, camX: this.cameras.main.scrollX, camY: this.cameras.main.scrollY, shift: ev.shiftKey || ev.ctrlKey || ev.metaKey };
  }
  private onMove(p: Phaser.Input.Pointer) {
    if (!p.wasTouch) { this.hover = { sx: p.x, sy: p.y, wx: p.worldX, wy: p.worldY }; this.hooks.onHover(p2w(p.worldX, p.worldY), this.pickAt(p.worldX, p.worldY)) }
    const P = this.ptr; if (!P) return;
    P.x = p.x; P.y = p.y;
    if (Math.hypot(p.x - P.sx, p.y - P.sy) > 6) P.moved = true;
    const cam = this.cameras.main;
    if (P.moved && (P.touch || P.btn === 1 || P.btn === 2)) { cam.scrollX = P.camX - (p.x - P.sx) / cam.zoom; cam.scrollY = P.camY - (p.y - P.sy) / cam.zoom; this.clampCam() }
    else if (P.moved && P.btn === 0) this.hooks.onBox({ x: Math.min(P.sx, p.x), y: Math.min(P.sy, p.y), w: Math.abs(p.x - P.sx), h: Math.abs(p.y - P.sy) });
  }
  private onUp(p: Phaser.Input.Pointer) {
    const P = this.ptr; this.ptr = null; this.hooks.onBox(null);
    if (!P || this.s.sim.over) return;
    const s = this.s, picked = this.pickAt(p.worldX, p.worldY), w = p2w(p.worldX, p.worldY);
    if (!P.moved) {
      if (s.targeting) { if (P.btn === 2) s.cancelTargeting(); else s.targetClick(w, picked); this.hooks.onSelectionChanged(); return }
      if (P.btn === 2) { s.orderAt(w, picked); return }
      // left click only selects (generous radius on our own units); orders are right click. Touch has no right click, so a tap on the ground still orders.
      const mine = this.pickSquadAt(p.worldX, p.worldY);
      if (mine) { if (P.shift) s.toggle(mine.id); else s.select([mine.id]); this.hooks.onSelectionChanged(); return }
      if (P.touch && s.sel.size) s.orderAt(w, picked);
      return;
    }
    if (P.btn === 0 && !P.touch) {
      const cam = this.cameras.main;
      const a = cam.getWorldPoint(Math.min(P.sx, p.x), Math.min(P.sy, p.y)), b = cam.getWorldPoint(Math.max(P.sx, p.x), Math.max(P.sy, p.y));
      const ids = s.sim.livingSquad().filter(u => { const [px, py] = this.at(u); return px >= a.x && px <= b.x && py - 12 >= a.y && py - 12 <= b.y }).map(u => u.id);
      s.select(ids, P.shift); this.hooks.onSelectionChanged();
    }
  }

  // ------------------------------------------------------------------ frame
  override update(_t: number, delta: number) {
    const dt = delta / 1000, s = this.s, sim = s.sim, cam = this.cameras.main;
    const pan = 560 * dt / cam.zoom, k = this.hooks.keys;
    if (k.size) { if (k.has('L')) cam.scrollX -= pan; if (k.has('R')) cam.scrollX += pan; if (k.has('U')) cam.scrollY -= pan; if (k.has('D')) cam.scrollY += pan; this.clampCam() }
    s.tick(dt);
    s.pruneSelection();
    for (const f of sim.fx.splice(0)) this.fxs.push({ ...f, born: this.time.now / 1000, dur: FXDUR[f.k] || .5 });
    this.textI = 0;
    if (sim.tickN !== this.fogTick) { this.fogTick = sim.tickN; this.drawFog() }
    this.drawUnder();
    this.drawUnits();
    this.drawOver(dt);
    for (let i = this.textI; i < this.texts.length; i++) this.texts[i].setVisible(false);
  }

  private drawTerrain() {
    const g = this.terrain, map = this.s.sim.map, R = mulberryVisual(this.s.sim.m.seed + 7);
    const J = Array.from({ length: N * N }, () => (R() - .5) * 10);
    const quad = (pts: [number, number][], col: number) => { g.fillStyle(col, 1); g.fillPoints(pts.map(([x, y]) => new Phaser.Math.Vector2(x, y)), true) };
    for (let d = 0; d < 2 * N - 1; d++) for (let x = 0; x < N; x++) {
      const y = d - x; if (y < 0 || y >= N || !map.inside(x, y)) continue;
      const t = map.grid[y * N + x], h = tileH(t), col = TCOL[t], j = J[y * N + x];
      const p0 = w2p(x, y), p1 = w2p(x + 1, y), p2 = w2p(x + 1, y + 1), p3 = w2p(x, y + 1);
      if (h) { quad([p3, p2, [p2[0], p2[1] - h], [p3[0], p3[1] - h]], shade(col, .62, j)); quad([p2, p1, [p1[0], p1[1] - h], [p2[0], p2[1] - h]], shade(col, .78, j)) }
      const top = [p0, p1, p2, p3].map(p => [p[0], p[1] - h] as [number, number]);
      quad(top, shade(col, 1, j));
      g.lineStyle(1, 0x000000, .16); g.strokePoints(top.map(([a, b]) => new Phaser.Math.Vector2(a, b)), true);
      const [cx, cy] = w2p(x + .5, y + .5);
      if (t === T.WATER) { g.lineStyle(1, 0x96c8e6, .18); g.lineBetween(cx - 10, cy, cx + 6, cy) }
      if (t === T.ROCK) { g.lineStyle(1, 0x000000, .3); g.lineBetween(cx - 8, cy - h - 2, cx, cy - h + 3); g.lineBetween(cx, cy - h + 3, cx + 7, cy - h - 1) }
      if (t === T.ROAD) { g.fillStyle(0xe6d7aa, .25); g.fillRect(cx - 2, cy - 1, 4, 2) }
    }
    for (let d = 0; d < 2 * N - 1; d++) for (let x = 0; x < N; x++) {
      const y = d - x; if (y < 0 || y >= N || map.grid[y * N + x] !== T.FOREST) continue;
      for (const [ox, oy] of [[.3, .3], [.72, .4], [.45, .75]]) {
        const [px, py] = w2p(x + ox + (R() - .5) * .15, y + oy + (R() - .5) * .15), sz = 5 + R() * 2, hg = 13 + R() * 5;
        g.fillStyle(0x27442f, 1); g.fillTriangle(px - sz, py, px, py - hg, px, py + 2);
        g.fillStyle(0x1d3524, 1); g.fillTriangle(px + sz, py, px, py - hg, px, py + 2);
      }
    }
    const b = map.bounds || [0, 0, N - 1, N - 1];
    const c0 = w2p(b[0], b[1]), c1 = w2p(b[2] + 1, b[1]), c2 = w2p(b[2] + 1, b[3] + 1), c3 = w2p(b[0], b[3] + 1);
    g.lineStyle(1.5, COL.blue, .25); g.strokePoints([c0, c1, c2, c3].map(([a, b]) => new Phaser.Math.Vector2(a, b)), true);
  }

  private drawFog() {
    const g = this.fog, sim = this.s.sim; g.clear();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x; if (sim.vis[i] || !sim.map.inside(x, y)) continue;
      const h = tileH(sim.map.grid[i]);
      const a = w2p(x, y), b = w2p(x + 1, y), c = w2p(x + 1, y + 1), d = w2p(x, y + 1);
      g.fillStyle(0x080c10, sim.explored[i] ? .38 : .64);
      g.fillPoints([new Phaser.Math.Vector2(a[0], a[1] - h), new Phaser.Math.Vector2(b[0], b[1] - h), new Phaser.Math.Vector2(c[0], c[1]), new Phaser.Math.Vector2(d[0], d[1])], true);
    }
  }

  private drawUnder() {
    const g = this.under, s = this.s, sim = s.sim, nowT = this.time.now / 1000; g.clear();
    for (const c of sim.clouds) {
      const [sx, sy] = w2p(c.x, c.y), fade = Math.min(1, c.t / 2);
      if (c.k === 'smoke') {
        for (let i = 0; i < 7; i++) { const a = i * 0.9 + nowT * 0.15, rr = c.r * (0.25 + 0.45 * ((i * 37) % 10) / 10); this.ell(g, sx + Math.cos(a) * rr * 22, sy + Math.sin(a) * rr * 11 - 6, c.r * 0.55, null, 0, 0, 0xa8aaa4, 0.22 * fade) }
        this.ell(g, sx, sy, c.r, 0xc8c8be, .35 * fade, 1, undefined, 0, 1);
      } else if (c.k === 'chaff') {
        this.ell(g, sx, sy, c.r, 0xc8dcf0, .45 * fade, 1.2, 0xbecddc, .1 * fade, 1);
        for (let i = 0; i < 26; i++) { const a = i * 2.4 + nowT * (0.3 + (i % 5) * 0.07), rr = ((i * 53) % 100) / 100 * c.r; g.fillStyle(0xe6f0ff, (0.35 + 0.5 * Math.abs(Math.sin(nowT * 6 + i))) * fade); g.fillRect(sx + Math.cos(a) * rr * TW / 2 * 1.3, sy + Math.sin(a) * rr * TH / 2 * 1.3 - 8 - ((i * 17 + nowT * 20) % 14), 1.6, 1.6) }
      } else if (c.k === 'jam') {
        for (let i = 0; i < 3; i++) { const ph = (nowT * 0.6 + i / 3) % 1; this.ell(g, sx, sy, c.r * ph, 0xbe8ce6, .5 * (1 - ph) * fade, 1.5) }
        this.ell(g, sx, sy, c.r, null, 0, 0, 0xbe8ce6, .07 * fade);
      } else if (c.k === 'flare') {
        for (let i = 4; i >= 1; i--) this.ell(g, sx, sy, c.r * i / 4, null, 0, 0, 0xffe296, .06 * fade);
        this.ell(g, sx, sy, c.r, 0xffe296, .4 * fade); g.fillStyle(0xfff0c8, fade); g.fillCircle(sx, sy - 38 + Math.sin(nowT * 3) * 2, 3);
      }
      this.text(sx, sy + c.r * TH * 0.7 + 12, `${(TOOLS[c.k === 'jam' ? 'jammer' : c.k]).name} ${Math.ceil(c.t)}s`, { size: 10, color: '#dcdccd', alpha: .8 * fade });
    }
    for (const m of sim.mines) {
      if (m.team !== 'P' && !m.revealed && !(s.replay && s.reveal)) continue;
      const [sx, sy] = this.at(m), pts = [[sx, sy - 5], [sx + 7, sy], [sx, sy + 5], [sx - 7, sy]].map(([a, b]) => new Phaser.Math.Vector2(a, b));
      if (m.team === 'E') { g.fillStyle(0x2a1612, 1); g.fillPoints(pts, true); g.lineStyle(1.4, COL.red, 1); g.strokePoints(pts, true); if (m.disarm > 0) { g.fillStyle(COL.good, 1); g.fillRect(sx - 8, sy + 7, 16 * m.disarm, 2) } continue }
      const c = m.arm > 0 ? 0x56656c : COL.blue; g.fillStyle(0x1a2229, 1); g.fillPoints(pts, true); g.lineStyle(1.2, c, 1); g.strokePoints(pts, true); g.fillStyle(c, 1); g.fillRect(sx - 1, sy - 1, 2, 2);
    }
    const seen = new Set<string>();
    for (const sh of sim.shells) {
      const key = sh.cx + ',' + sh.cy; if (seen.has(key)) continue; seen.add(key);
      const [sx, sy] = w2p(sh.cx, sh.cy); this.ell(g, sx, sy, 1.8, COL.red, .9, 1.5, undefined, 0, 1);
      this.text(sx, sy - 30, `着弾 ${Math.max(0, sh.at - sim.time).toFixed(1)}s`, { size: 11, weight: 600, mono: true, color: '#ffb38f' });
    }
    for (const c of sim.charges) { const [sx, sy] = this.at(c); g.fillStyle(COL.gold, 1); g.fillRect(sx - 4, sy - 14, 8, 6); this.text(sx, sy - 22, c.t.toFixed(1), { size: 10, mono: true, color: '#e2b84a', weight: 600 }) }
    // targeting preview
    const tg = s.targeting, hv = this.hover;
    if (tg && 'arty' in tg && hv) { const w = p2w(hv.wx, hv.wy), [px, py] = w2p(w.x, w.y); this.ell(g, px, py, 1.8, COL.red, .8, 1, COL.red, .12, 1) }
    if (tg && 'tool' in tg) {
      const TT = TOOLS[tg.tool];
      for (const u of s.selUnits().filter(u => u.toolbelt?.tool === tg.tool && u.toolbelt.ammo > 0)) {
        const [sx, sy] = this.at(u);
        this.ell(g, sx, sy, TT.range! + (TT.target === 'enemy' && sim.onHill(u) ? 1 : 0), COL.gold, .75, 1.4, undefined, 0, 1);
        if (TT.target === 'enemy') this.ell(g, sx, sy, sim.effSensor(u), COL.gold, .35, 1, undefined, 0, 1);
      }
      if (hv && TT.radius) { const w = p2w(hv.wx, hv.wy), [px, py] = w2p(w.x, w.y); this.ell(g, px, py, TT.radius, COL.gold, .8, 1, COL.gold, .1) }
    }
    for (const z of sim.zones) {
      const [sx, sy] = w2p(z.x, z.y);
      this.ell(g, sx, sy, z.r, z.kind === 'hint' ? COL.good : COL.gold, z.kind === 'hint' ? .65 : .9, z.kind === 'hint' ? 1.2 : 2, COL.gold, z.kind === 'hint' ? 0 : .08, 1);
      this.text(sx, sy, z.label, { size: 12, weight: 600, color: z.kind === 'hint' ? '#8cc67e' : '#e2b84a' });
    }
    for (const u of s.selUnits()) {
      const [sx, sy] = this.at(u), mv = u.mover!;
      if (mv.path.length) this.dashLine(g, [[sx, sy], ...mv.path.map(p => this.at(p))], COL.blue, .6, 3, 4);
      const t = sim.targetOf(u);
      if (t && t.life.alive) { const [a, b] = this.at(t); this.dashLine(g, [[sx, sy - 10], [a, b - 10]], COL.red, .7, 5, 4) }
      this.ell(g, sx, sy, sim.rangeOf(u), COL.blue, .35, 1, undefined, 0, 1);
      if (u.repairer) this.ell(g, sx, sy, u.repairer.radius, COL.good, .3);
    }
    if (s.showDet) {
      const ref = s.selUnits()[0];
      for (const e of sim.enemies()) {
        if (!sim.seenE.has(e.id) || !e.sensor) continue;
        const [sx, sy] = this.at(e), r = ref ? sim.detRange(e, ref) : sim.effSensor(e); if (r <= 0) continue;
        const close = ref && Math.hypot(e.pos.x - ref.pos.x, e.pos.y - ref.pos.y) - r < 1.5;
        this.ell(g, sx, sy, r, COL.gold, close ? .75 : .3, 1.2, COL.gold, sim.etype(e) === 'radar' ? .05 : 0, 1);
      }
    }
    // last-seen ghosts
    for (const e of sim.enemies()) {
      if (sim.seenE.has(e.id) || !e.intel?.lastSeen || e.structure) continue;
      const [sx, sy] = standPx(sim.map, e.intel.lastSeen.x, e.intel.lastSeen.y);
      this.shape(g, CHASSIS[ETYPES[e.enemyAI!.etype].loadout!.chassis].shape, sx, sy - 10, 8, null, COL.red, .4);
      this.text(sx, sy - 6, '?', { size: 10, mono: true, color: '#e4643c', alpha: .6 });
    }
  }

  private shape(g: G, shape: string, x: number, y: number, r: number, fill: number | null, stroke: number, alpha = 1) {
    const V = (a: number, b: number) => new Phaser.Math.Vector2(a, b);
    let pts: Phaser.Math.Vector2[] | null = null;
    switch (shape) {
      case 'tri': case 'decoy': pts = [V(x, y - r), V(x + r * .95, y + r * .75), V(x - r * .95, y + r * .75)]; break;
      case 'sq': pts = [V(x - r * .8, y - r * .8), V(x + r * .8, y - r * .8), V(x + r * .8, y + r * .8), V(x - r * .8, y + r * .8)]; break;
      case 'hex': pts = Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 3 * i - Math.PI / 2; return V(x + Math.cos(a) * r, y + Math.sin(a) * r) }); break;
      case 'truck': pts = [V(x - r * 1.1, y - r * .6), V(x + r * 1.1, y - r * .6), V(x + r * 1.1, y + r * .6), V(x - r * 1.1, y + r * .6)]; break;
      case 'radar': pts = [V(x, y - r * 1.2), V(x + r * .7, y + r * .7), V(x - r * .7, y + r * .7)]; break;
      case 'hq': pts = [V(x - r, y - r), V(x + r, y - r), V(x + r, y + r), V(x - r, y + r)]; break;
      case 'site': pts = [V(x, y - r), V(x + r, y + r * .7), V(x - r, y + r * .7)]; break;
    }
    const circR = shape === 'circ' ? r * .85 : shape === 'turret' ? r * .8 : shape === 'probe' ? r * .5 : 0;
    if (fill != null) { g.fillStyle(fill, alpha); if (pts) g.fillPoints(pts, true); else g.fillCircle(x, y, circR) }
    g.lineStyle(1.5, stroke, alpha); if (pts) g.strokePoints(pts, true); else g.strokeCircle(x, y, circR);
    g.lineStyle(2, stroke, alpha);
    if (shape === 'circ') { g.lineBetween(x - r * .45, y, x + r * .45, y); g.lineBetween(x, y - r * .45, x, y + r * .45) }
    if (shape === 'hq') g.strokeRect(x - r * .5, y - r * .5, r, r);
    if (shape === 'turret') g.lineBetween(x, y, x + r * 1.1, y - r * .5);
    if (shape === 'radar') { g.beginPath(); g.arc(x, y - r * 1.2, r * .6, Math.PI * 1.1, Math.PI * 1.9); g.strokePath() }
  }

  private drawUnits() {
    const g = this.unitsG, s = this.s, sim = s.sim, now = this.time.now; g.clear();
    const list = sim.world.all().filter(e => this.visibleEntity(e)).sort((a, b) => (a.pos.x + a.pos.y) - (b.pos.x + b.pos.y));
    for (const u of list) {
      const [sx, sy] = this.at(u), r = u.structure ? 13 : u.truck ? 9 : 10, iy = sy - 12, sq = u.squad;
      g.fillStyle(0x000000, .35); g.fillEllipse(sx, sy, r * 1.9, r * .9);
      if (s.sel.has(u.id)) { g.lineStyle(1.5, COL.pale, 1); g.strokeEllipse(sx, sy, (r + 5) * 2, r + 5) }
      g.lineStyle(1, 0x000000, .45); g.lineBetween(sx, sy, sx, iy + r * .6);
      let fill = u.ephemeral?.kind === 'decoy' ? COL.blue : u.ephemeral?.kind === 'probe' ? 0xbfe6ff : u.team === 'P' ? (u.truck ? COL.sand : COL.blue) : (u.structure ? COL.struct : COL.red);
      if (u.health && u.health.hitT > 0) fill = 0xffffff;
      const ghost = (u.team === 'P' && u.stealth && u.stealth.revealT <= 0) || !!sq?.hidden || (u.team === 'E' && !sim.seenE.has(u.id)) || u.ephemeral?.kind === 'decoy';
      this.shape(g, u.shape, sx, iy, r, fill, COL.ink, ghost ? .5 : 1);
      if (u.structure && (u.structure.objective || u.structure.kind === 'site')) { g.lineStyle(1.5, u.structure.scanned ? COL.good : COL.gold, 1); g.strokeCircle(sx, iy, r + 5 + Math.sin(now / 250) * 1.5) }
      if (sq && sq.stance === 'nofire') { const bx = sx + r + 2, by = iy - r + 1; g.fillStyle(0x0c1217, 1); g.fillCircle(bx, by, 4.5); g.lineStyle(1.3, COL.gold, 1); g.strokeCircle(bx, by, 4.5); g.lineBetween(bx - 3, by + 3, bx + 3, by - 3) }
      if (sq) {
        const sy2 = u.systems!, w = u.weapon;
        const tags = [sq.hidden ? '隠' : sq.order === 'hide' ? '隠…' : '', sq.mmode === 'fast' ? '速' : sq.mmode === 'careful' ? '警' : '', w?.ammoType === 'ap' ? '徹' : w?.ammoType === 'he' ? '榴' : '', sy2.fcs ? 'F✕' : '', sy2.legs ? '脚✕' : '', sy2.sensor ? 'S✕' : ''].filter(Boolean).join(' ');
        if (tags) { const tw = tags.length * 9 + 6; g.fillStyle(0x080c10, .75); g.fillRect(sx - tw / 2, sy + 4, tw, 11); this.text(sx, sy + 9.5, tags, { size: 9, color: (sy2.fcs || sy2.legs || sy2.sensor) ? '#ffb38f' : '#bfe6ff' }) }
        this.text(sx, iy + (u.shape === 'tri' ? 3 : 0.5), String(sq.no), { size: 11, weight: 700, mono: true, color: '#07131b' });
        const det = sim.detP.has(u.id), warn = !det && (u.exposure?.margin ?? 99) < 1.5;
        if (det || warn) { const bx = sx - r - 3, by = iy - r; g.fillStyle(det ? COL.red : COL.gold, 1); g.fillCircle(bx, by, 6); this.text(bx, by + .5, '!', { size: 10, weight: 700, mono: true, color: '#0c1217' }) }
      } else if (u.ephemeral) this.text(sx, sy + 9, (u.ephemeral.kind === 'decoy' ? '囮 ' : 'PRB ') + Math.ceil(u.ephemeral.ttl) + 's', { size: 9, color: '#bfe6ff' });
      else if (u.team === 'E' && !u.structure && u.weapon) this.text(sx, sy + 8, u.weapon.def.tag, { size: 9, mono: true, color: '#e4643c' });
      if (u.structure) {
        this.text(sx, sy + 10, u.name + (u.structure.label ? ' ' + u.structure.label : ''), { size: 10.5, color: '#f0c9b8' });
        if (u.structure.kind === 'site' && !u.structure.scanned && u.structure.scan > 0) { g.fillStyle(COL.good, 1); g.fillRect(sx - 14, iy - r - 12, 28 * u.structure.scan, 3) }
      }
      const h = u.health; if (!h) continue;
      const pct = h.hp / h.maxHp;
      if (pct < 1 || s.sel.has(u.id)) {
        const bw = u.structure ? 30 : 22; g.fillStyle(0x000000, .6); g.fillRect(sx - bw / 2 - 1, iy - r - 7, bw + 2, 4);
        g.fillStyle(u.team === 'E' ? COL.red : pct > .6 ? COL.good : pct > .3 ? COL.gold : COL.red, 1); g.fillRect(sx - bw / 2, iy - r - 6, bw * pct, 2);
      }
    }
  }

  private drawOver(_dt: number) {
    const g = this.over, s = this.s, sim = s.sim, now = this.time.now / 1000; g.clear();
    for (const p of sim.projs) {
      const [sx, sy] = this.at(p), [qx, qy] = standPx(sim.map, p.px, p.py), col = p.team === 'P' ? 0xbfe6ff : 0xffb38f;
      if (p.k === 'MSL') { g.fillStyle(p.lost ? 0x9aa4a8 : col, 1); g.fillCircle(sx, sy - 12, 2.8) }
      else { const dx = sx - qx, dy = sy - qy, L = Math.hypot(dx, dy) || 1, len = p.k === 'SN' ? 18 : 8; g.lineStyle(p.k === 'SN' ? 2.2 : 1.4, col, 1); g.lineBetween(sx, sy - 12, sx - dx / L * len, sy - 12 - dy / L * len) }
    }
    this.fxs = this.fxs.filter(f => now - f.born < f.dur);
    for (const f of this.fxs) {
      const [sx, sy] = standPx(sim.map, f.x, f.y), k = (now - f.born) / f.dur;
      switch (f.k) {
        case 'boom': g.fillStyle(0xffaa5a, .55 * (1 - k)); g.fillEllipse(sx, sy - 6, ((f.r || 1) * 22 * k + 4) * 2, ((f.r || 1) * 11 * k + 2) * 2); g.lineStyle(1.5, 0xffdca0, 1 - k); g.strokeEllipse(sx, sy - 6, ((f.r || 1) * 22 * k + 4) * 2, ((f.r || 1) * 11 * k + 2) * 2); break;
        case 'miss': this.text(sx, sy - 20 - k * 8, 'MISS', { size: 9, weight: 600, mono: true, color: '#c8c8be', alpha: 1 - k }); break;
        case 'puff': this.ell(g, sx, sy, (f.r || 1) * (0.3 + k * 0.7), 0xe6e6dc, .7 * (1 - k), 2); break;
        case 'hit': g.fillStyle(0xffe6b4, 1 - k); g.fillCircle(sx, sy - 12, 3 * (1 - k) + 1); break;
        case 'flash': g.fillStyle(f.team === 'P' ? 0xc8ebff : 0xffbe8c, .9); g.fillCircle(sx, sy - 12, 4); break;
        case 'smoke': g.fillStyle(0xb4b4aa, .35 * (1 - k)); g.fillCircle(sx, sy - 12, 2 + k * 3); break;
        case 'heal': this.text(sx + 6, sy - 24 - k * 10, '+', { size: 11, weight: 700, mono: true, color: '#8cc67e', alpha: 1 - k }); break;
        case 'ping': this.ell(g, sx, sy, .3 + k * .6, f.red ? COL.red : COL.blue, 1 - k, 2); break;
      }
    }
    const hv = this.hover;
    if (hv && !this.ptr) {
      const w = p2w(hv.wx, hv.wy), X = Math.floor(w.x), Y = Math.floor(w.y);
      if (X >= 0 && Y >= 0 && X < N && Y < N) {
        const h = tileH(sim.map.grid[Y * N + X]);
        g.lineStyle(1.2, COL.pale, .7); g.strokePoints([[X, Y], [X + 1, Y], [X + 1, Y + 1], [X, Y + 1]].map(([a, b]) => { const [px, py] = w2p(a, b); return new Phaser.Math.Vector2(px, py - h) }), true);
      }
      const hu = this.pickAt(hv.wx, hv.wy);
      if (hu && hu.team === 'E' && hu.weapon) { const [sx, sy] = this.at(hu); this.ell(g, sx, sy, sim.rangeOf(hu), COL.red, .55, 1.2, COL.red, .06, 1) }
    }
  }
}

export { OX, OY };
