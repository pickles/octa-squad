// Battle session: owns the Sim for one battle and all player-side presentation state
// (selection, targeting, pause/speed, replay playback, AI takeover). The Phaser scene renders it
// and the DOM HUD drives it; neither talks to the simulation directly except through here.
import { AgentPort, MMODES, STANCES, Sim, TOOLS, brainTick, r3 } from '../core';
import type { Entity, Replay, ToolKey, With } from '../core';
import { N } from '../core';

export type Targeting = { tool: ToolKey } | { arty: true } | null;

export interface SessionOptions {
  sim: Sim;
  replay?: Replay;
  /** AI-driven session (window.octa.start): time only advances through step() unless realtime. */
  external?: boolean;
  realtime?: boolean;
}

export class BattleSession {
  sim: Sim;
  port: AgentPort;
  replay: Replay | null;
  paused = true;
  speed = 1;
  private acc = 0;
  external: boolean;
  stepMode: boolean;
  autoAI = false;
  aiIntent = '';
  sel = new Set<number>();
  targeting: Targeting = null;
  showDet = true;
  reveal = false;
  saved = false;
  lastReplay: Replay | null = null;
  onOver: ((s: BattleSession) => void) | null = null;
  onNotice: ((text: string) => void) | null = null;

  constructor(o: SessionOptions) {
    this.sim = o.sim;
    this.port = new AgentPort(o.sim);
    this.replay = o.replay || null;
    this.external = !!o.external;
    this.stepMode = !!o.external && !o.realtime;
    this.sim.onSecond = () => { if (this.autoAI) this.aiIntent = brainTick(this.port) };
    if (this.external) this.paused = !o.realtime;
  }

  // ---------------------------------------------------------------- time
  /** Advance by real elapsed seconds (fixed 30 Hz steps). */
  tick(dt: number) {
    if (this.paused || this.sim.over || this.stepMode) return;
    this.acc += Math.min(dt, 0.1) * this.speed;
    let n = 0;
    while (this.acc >= 1 / 30 && n < 90 && !this.sim.over) { this.sim.step(); this.acc -= 1 / 30; n++ }
    if (n >= 90) this.acc = 0;
    this.checkOver();
  }
  stepSeconds(sec: number) { const n = Math.max(1, Math.round(Math.min(sec, 60) * 30)); for (let i = 0; i < n && !this.sim.over; i++) this.sim.step(); this.checkOver() }
  checkOver() {
    if (this.sim.over && !this.saved) {
      this.saved = true; this.paused = true;
      if (!this.replay) this.lastReplay = this.sim.toReplay();
      this.onOver?.(this);
    }
  }
  setPaused(v: boolean) { if (!this.sim.over) this.paused = v }
  cycleSpeed() { const sp = this.replay ? [1, 2, 4, 8] : [1, 2]; this.speed = sp[(sp.indexOf(this.speed) + 1) % sp.length] }

  // ---------------------------------------------------------------- selection
  selUnits(): With<'squad'>[] { return this.sim.livingSquad().filter(u => this.sel.has(u.id)) }
  select(ids: number[], add = false) { if (!add) this.sel.clear(); ids.forEach(i => this.sel.add(i)) }
  toggle(id: number) { this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id) }
  selectAll() { this.select(this.sim.livingSquad().map(u => u.id)) }
  selectSlot(no: number, add: boolean) { const u = this.sim.livingSquad().find(x => x.squad.no === no); if (u) add ? this.sel.add(u.id) : this.select([u.id]) }
  pruneSelection() { for (const id of [...this.sel]) if (!this.sim.world.get(id)?.life.alive) this.sel.delete(id) }

  // ---------------------------------------------------------------- orders (all recorded through Sim.issue)
  private ids() { return this.selUnits().map(u => u.id) }
  orderAt(w: { x: number; y: number }, target: Entity | null) {
    if (!this.sel.size || this.replay) return;
    if (target && target.team === 'E') this.sim.issue({ k: 'attack', u: this.ids(), t: target.id });
    else this.sim.issue({ k: 'move', u: this.ids(), x: r3(Math.max(0, Math.min(N - .01, w.x))), y: r3(Math.max(0, Math.min(N - .01, w.y))) });
  }
  stop() { if (this.sel.size) this.sim.issue({ k: 'stop', u: this.ids() }) }
  cycleStance() {
    const us = this.selUnits(); if (!us.length || this.replay) return;
    const next = { hold: 'free', free: 'nofire', nofire: 'hold' } as const, ns = next[us[0].squad.stance];
    this.sim.issue({ k: 'stance', u: us.map(u => u.id), s: ns });
    this.sim.log(`${us.length === 1 ? us[0].squad.pilot + '機' : us.length + '機'}：${STANCES[ns]}`, ns === 'nofire' ? 'info' : 'note');
  }
  cycleMode() {
    const us = this.selUnits(); if (!us.length || this.replay) return;
    const o = Object.keys(MMODES) as (keyof typeof MMODES)[];
    this.sim.issue({ k: 'mode', u: us.map(u => u.id), s: o[(o.indexOf(us[0].squad.mmode) + 1) % o.length] });
  }
  toggleRadar() {
    const us = this.selUnits().filter(u => u.sensor && u.sensor.radarBonus > 0); if (!us.length || this.replay) return;
    this.sim.issue({ k: 'radar', u: us.map(u => u.id), on: !!us[0].sensor!.off });
  }
  hide() { const us = this.selUnits(); if (us.length && !this.replay) this.sim.issue({ k: 'hide', u: us.map(u => u.id) }) }
  cycleAmmo() {
    const us = this.selUnits().filter(u => u.weapon); if (!us.length || this.replay) return;
    const o = ['std', 'ap', 'he'] as const, w0 = us[0].weapon!;
    const has = (a: 'std' | 'ap' | 'he') => a === 'std' || us.some(u => u.weapon![a] > 0);
    let n: 'std' | 'ap' | 'he' = o[(o.indexOf(w0.nextAmmo || w0.ammoType) + 1) % 3];
    if (!has(n)) n = o[(o.indexOf(n) + 1) % 3];
    if (!has(n)) n = 'std';
    this.sim.issue({ k: 'ammo', u: us.map(u => u.id), s: n });
  }
  toggleConvoy() { if (this.sim.m.road) this.sim.issue({ k: 'convoy', go: !this.sim.convoyGo }) }
  abort() { if (this.replay) return; this.sim.issue({ k: 'abort' }); this.checkOver() }

  // ---------------------------------------------------------------- tools & artillery (click-to-target)
  selTools(): ToolKey[] {
    const t: ToolKey[] = [];
    for (const u of this.selUnits()) if (u.toolbelt && u.toolbelt.ammo > 0 && !t.includes(u.toolbelt.tool)) t.push(u.toolbelt.tool);
    return t;
  }
  startTargeting() {
    if (this.replay || this.sim.over) return;
    const ts = this.selTools();
    if (!ts.length) { this.onNotice?.('ツールを持つ機体（弾数あり）を選択してください'); return }
    const cur = this.targeting && 'tool' in this.targeting ? ts.indexOf(this.targeting.tool) : -1;
    this.targeting = { tool: ts[(cur + 1) % ts.length] };
  }
  startArty() {
    if (this.replay || this.sim.over) return;
    if (this.sim.arty <= 0) { this.onNotice?.('砲撃支援は使い切った'); return }
    this.targeting = { arty: true };
  }
  cancelTargeting() { if (this.targeting) { this.targeting = null; return true } return false }
  /** Returns false if the click did not produce an order (message already shown). */
  targetClick(w: { x: number; y: number }, picked: Entity | null): boolean {
    const tg = this.targeting; if (!tg) return false;
    if ('arty' in tg) {
      const X = Math.floor(w.x), Y = Math.floor(w.y);
      if (X < 0 || Y < 0 || X >= N || Y >= N || !this.sim.vis[Y * N + X]) { this.onNotice?.('砲撃は味方の視界内（観測できる地点）にしか要請できない'); return false }
      this.sim.issue({ k: 'arty', x: r3(w.x), y: r3(w.y) }); this.targeting = null; return true;
    }
    const tool = tg.tool, T = TOOLS[tool];
    const carriers = this.selUnits().filter(u => u.toolbelt?.tool === tool && u.toolbelt.ammo > 0);
    if (!carriers.length) { this.targeting = null; return false }
    if (T.target === 'enemy' || T.target === 'struct') {
      if (!picked || picked.team !== 'E' || (T.target === 'struct' && !picked.structure)) { this.onNotice?.(`${T.name}：目標の${T.target === 'struct' ? '敵建造物' : '敵'}をクリックしてください`); return false }
      this.sim.issue({ k: 'tool', tool, u: carriers.map(u => u.id), t: picked.id, x: r3(picked.pos.x), y: r3(picked.pos.y) });
    } else {
      const x = r3(Math.max(0, Math.min(N - .01, w.x))), y = r3(Math.max(0, Math.min(N - .01, w.y)));
      const c = [...carriers].sort((a, b) => Math.hypot(a.pos.x - x, a.pos.y - y) - Math.hypot(b.pos.x - x, b.pos.y - y))[0];
      this.sim.issue({ k: 'tool', tool, u: [c.id], x, y });
    }
    this.targeting = null; return true;
  }

  // ---------------------------------------------------------------- AI takeover
  setAuto(on: boolean) {
    if (this.replay) return;
    this.autoAI = on;
    if (on) { if (this.paused && !this.stepMode) this.paused = false; this.sim.log('AIが指揮を引き継いだ', 'ai'); this.aiIntent = brainTick(this.port) }
    else { this.sim.log('プレイヤーが指揮を引き継いだ', 'info'); this.aiIntent = '' }
  }
}
