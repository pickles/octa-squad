// App shell: switches between the hangar (DOM) and a battle (Phaser scene + DOM HUD),
// wires keyboard input, and exposes window.octa for programmatic / AI control.
import Phaser from 'phaser';
import './ui/style.css';
import { SIM_VERSION, Sim, verifyReplay } from './core';
import type { Difficulty, Loadout, Replay } from './core';
import { BattleSession } from './game/controller';
import { BattleScene } from './game/BattleScene';
import type { SceneHooks } from './game/BattleScene';
import { Hangar } from './ui/hangar';
import { Hud } from './ui/hud';
import { SAVE, currentMission, deployOf, saveReplay } from './ui/store';
import { installOctaApi } from './api/octa';

const $ = (s: string) => document.querySelector(s) as HTMLElement;

export interface StartOptions { slots: Loadout[]; deploy: boolean[]; seed?: number; diff?: Difficulty; auto?: boolean; external?: boolean; realtime?: boolean; mission?: Sim['m']['id'] }

class App {
  game: Phaser.Game | null = null;
  session: BattleSession | null = null;
  keys = new Set<string>();
  hud: Hud;
  hangar: Hangar;
  private hudTimer = 0;
  private sleeping = false;

  constructor() {
    this.hud = new Hud({
      toHQ: () => this.toHQ(),
      retry: () => { const s = this.session!.sim; this.startBattle({ mission: s.m.id, slots: s.slots, deploy: s.deploy, diff: s.diff }) },
      watch: () => { const r = this.session?.lastReplay; if (r) this.playReplay(r) },
      seek: t => this.seek(t),
      replayAgain: () => { this.seek(0); this.session!.setPaused(false) },
      centerOn: t => this.scene()?.centerOn(t),
      centerOnPixel: (x, y) => this.scene()?.centerOnPixel(x, y),
      view: () => this.scene()?.viewRect() || { x: 0, y: 0, width: 0, height: 0 },
    });
    this.hangar = new Hangar({
      start: ({ auto }) => { const m = currentMission(); this.startBattle({ mission: m.id, slots: SAVE.slots, deploy: deployOf(m), diff: SAVE.diff, auto }) },
      playReplay: r => this.playReplay(r),
    });
    this.hangar.render();
    this.bindKeys();
    setInterval(() => { if (this.session && !$('#battle').hidden) this.hud.update() }, 200);
    void this.hudTimer;
  }

  scene(): BattleScene | null { return this.game && this.game.scene.isActive('battle') ? (this.game.scene.getScene('battle') as BattleScene) : null }

  private ensureGame(onReady: () => void) {
    if (this.game) { onReady(); return }
    this.game = new Phaser.Game({
      type: Phaser.AUTO, parent: 'phaser', backgroundColor: '#0a0f13', antialias: true,
      scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
      scene: [], banner: false, input: { mouse: { preventDefaultWheel: true } },
      callbacks: { postBoot: () => onReady() },
    });
    this.game.scene.add('battle', BattleScene, false);
  }

  private enter(session: BattleSession) {
    this.session = session;
    session.onOver = s => { if (!s.replay && s.lastReplay) saveReplay(s.lastReplay); this.hud.showResult() };
    session.onNotice = t => this.hud.notice(t);
    $('#hq').hidden = true; $('#battle').hidden = false;
    this.hud.bind(session);
    this.ensureGame(() => {
      if (this.sleeping) { this.sleeping = false; this.game!.scale.startListeners(); this.game!.loop.wake() }
      const mgr = this.game!.scene;
      if (mgr.isActive('battle') || mgr.isPaused('battle')) mgr.stop('battle');
      mgr.start('battle', {
        session,
        hooks: <SceneHooks>{
          keys: this.keys,
          onHover: (p, u) => this.hud.setHover(p, u),
          onBox: r => this.hud.setBox(r),
          onSelectionChanged: () => this.hud.update(),
        },
      });
      this.game!.scale.refresh();
    });
  }

  startBattle(o: StartOptions) {
    const sim = new Sim({ mission: o.mission || currentMission().id, difficulty: o.diff || SAVE.diff, seed: o.seed, slots: o.slots, deploy: o.deploy });
    const session = new BattleSession({ sim, external: o.external, realtime: o.realtime });
    this.keys.clear();
    this.enter(session);
    sim.log(`${sim.m.code} ${sim.m.name} 作戦開始。${o.external ? 'AI制御モード' : '一時停止中に命令を出せます'}`, 'info');
    if (o.auto) { session.speed = 2; session.setAuto(true) }
    return session;
  }

  playReplay(rep: Replay, autoplay = true, atTick = 0) {
    const sim = Sim.fromReplay(rep);
    const session = new BattleSession({ sim, replay: rep });
    session.reveal = this.session?.replay === rep ? this.session.reveal : false;
    while (sim.tickN < atTick && !sim.over) sim.step();
    sim.fx.length = 0;
    const prev = this.session;
    if (prev?.replay === rep) { session.speed = prev.speed; session.sel = prev.sel }
    this.enter(session);
    if ((rep.sv ?? 1) !== SIM_VERSION) sim.log(`このリプレイは別バージョンの計算（v${rep.sv ?? 1}、現在v${SIM_VERSION}）で記録されています。記録と違う展開になることがあります`, 'warning');
    sim.log(`リプレイ：${sim.m.code} ${sim.m.name}（${rep.ctrl === 'ai' ? 'AI' : rep.ctrl === 'human' ? 'プレイヤー' : 'AI＋プレイヤー'}の操作）`, 'info');
    session.paused = !autoplay;
    return session;
  }

  /** Jump to a tick in the current replay (re-simulates from the start when going backwards). */
  seek(tick: number) {
    const s = this.session; if (!s?.replay) return;
    const scene = this.scene(), view = scene?.viewRect();
    const cx = view ? view.centerX : 0, cy = view ? view.centerY : 0, paused = s.paused;
    if (tick < s.sim.tickN || s.sim.over) this.playReplay(s.replay, false, tick);
    else { while (s.sim.tickN < tick && !s.sim.over) s.sim.step(); s.sim.fx.length = 0 }
    const ns = this.session!; ns.paused = paused && !ns.sim.over;
    if (view) setTimeout(() => this.scene()?.centerOnPixel(cx, cy), 0);
    this.hud.update();
  }

  toHQ() {
    if (this.game?.scene.isActive('battle')) this.game.scene.stop('battle');
    // the canvas' parent is about to be hidden (0x0): stop the loop and resize handling so WebGL never sees a 0-size framebuffer
    if (this.game && !this.sleeping) { this.sleeping = true; this.game.loop.sleep(); this.game.scale.stopListeners() }
    this.session = null; this.hud.s = null;
    $('#battle').hidden = true; $('#hq').hidden = false;
    this.hangar.render();
  }

  private bindKeys() {
    const PANK: Record<string, string> = { ArrowLeft: 'L', ArrowRight: 'R', ArrowUp: 'U', ArrowDown: 'D', a: 'L', A: 'L', d: 'R', D: 'R', w: 'U', W: 'U', s: 'D', S: 'D' };
    addEventListener('keydown', e => {
      const s = this.session; if (!s || $('#battle').hidden) return;
      if ((e.target as HTMLElement).closest?.('select,input,textarea')) return;
      const k = e.key;
      if (e.ctrlKey || e.metaKey) { if (k === 'a' || k === 'A') { e.preventDefault(); if (!s.sim.over) s.selectAll() } this.hud.update(); return }
      const pk = PANK[k]; if (pk) { this.keys.add(pk); e.preventDefault(); return }
      if (s.sim.over) return;
      if (k === ' ') { e.preventDefault(); s.setPaused(!s.paused) }
      else if (k >= '1' && k <= '8') s.selectSlot(+k, e.shiftKey);
      else if (k === 'e' || k === 'E') s.selectAll();
      else if (k === 'x' || k === 'X') s.stop();
      else if (k === 'q' || k === 'Q') s.cycleStance();
      else if (k === 'c' || k === 'C') this.hud.centerSel();
      else if (k === 'f' || k === 'F') s.cycleSpeed();
      else if (k === 'v' || k === 'V') s.showDet = !s.showDet;
      else if (k === 't' || k === 'T') s.startTargeting();
      else if (k === 'm' || k === 'M') s.cycleMode();
      else if (k === 'h' || k === 'H') s.hide();
      else if (k === 'r' || k === 'R') s.cycleAmmo();
      else if (k === 'b' || k === 'B') s.startArty();
      else if ((k === 'g' || k === 'G') && !s.replay) s.setAuto(!s.autoAI);
      else if (k === 'Escape') { if (!s.cancelTargeting()) s.sel.clear() }
      else return;
      this.hud.update();
    });
    addEventListener('keyup', e => { const pk = PANK[e.key]; if (pk) this.keys.delete(pk) });
    addEventListener('blur', () => this.keys.clear());
  }
}

const app = new App();
installOctaApi(app);
export type { App };
export { verifyReplay };
