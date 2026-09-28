// window.octa: programmatic control of the game in the browser (console, Playwright, LLM agents).
// The same AgentPort / rules are available directly in Node through src/core.
import { CHASSIS, EQUIP, MISSIONS, TOOLS, WEAPONS, buildLoadout, rulesText, verifyReplay } from '../core';
import type { Action, Difficulty, Loadout, MissionId, Replay } from '../core';
import type { App } from '../main';
import { SAVE, deployOf, isReplay, loadReplays } from '../ui/store';

export function installOctaApi(app: App) {
  const need = () => { if (!app.session) throw new Error('no battle running: call octa.start() first'); return app.session };
  const api = {
    version: 3,
    missions: () => MISSIONS.map(m => ({ id: m.id, type: m.type, name: m.name, budget: m.budget, maxUnits: m.max, timeLimit: m.limit || null, artillery: m.arty, win: m.win, lose: m.lose, brief: m.brief, spawn: { x: m.spawn[0] + .5, y: m.spawn[1] + .5 } })),
    parts: () => ({ chassis: CHASSIS, weapons: WEAPONS, equip: EQUIP, tools: TOOLS }),
    rules: () => rulesText(),
    /** Start an AI-controlled battle. Time advances only via step() unless realtime:true. */
    start(o: { mission?: MissionId; difficulty?: Difficulty; seed?: number; loadout?: ({ slot: number; deploy?: boolean } & Partial<Loadout>)[]; realtime?: boolean; auto?: boolean } = {}) {
      const mission = o.mission || 'm1', m = MISSIONS.find(x => x.id === mission);
      if (!m) throw new Error('unknown mission ' + mission);
      const { slots, deploy } = buildLoadout(mission, SAVE.slots, o.loadout, o.loadout ? undefined : deployOf(m));
      const s = app.startBattle({ mission, slots, deploy, seed: o.seed, diff: o.difficulty || SAVE.diff, external: true, realtime: !!o.realtime });
      if (o.auto) s.setAuto(true);
      return s.port.observe();
    },
    observe: () => need().port.observe(),
    map: () => need().port.map(),
    text: () => need().port.text(),
    act: (a: Action | Action[]) => { const r = need().port.act(a); app.hud.update(); return r },
    step(sec = 1) { const s = need(); s.stepSeconds(sec); app.hud.update(); return s.port.observe() },
    realtime(on = true) { const s = need(); s.stepMode = !on; s.paused = !on; return { realtime: on } },
    auto(on = true) { const s = need(); s.setAuto(!!on); return { autoAI: s.autoAI } },
    quit() { if (app.session) app.toHQ(); return { status: 'idle' } },
    replay: (): Replay | null => app.session?.lastReplay || loadReplays()[0] || null,
    replays: () => loadReplays().map((r, i) => ({ index: i, mission: r.mission, ctrl: r.ctrl, difficulty: r.diff, date: new Date(r.date).toISOString(), result: r.result, commands: r.cmds.length })),
    playReplay(rep: Replay | number | string, opt: { autoplay?: boolean; speed?: number } = {}) {
      const r = typeof rep === 'number' ? loadReplays()[rep] : typeof rep === 'string' ? JSON.parse(rep) : rep;
      if (!isReplay(r)) throw new Error('not a v3 replay');
      const s = app.playReplay(r, opt.autoplay !== false); if (opt.speed) s.speed = opt.speed;
      return { ticks: r.ticks };
    },
    /** Re-simulate headlessly (no rendering) and compare with the recorded result. */
    verifyReplay(rep: Replay | number | string) {
      const r = typeof rep === 'number' ? loadReplays()[rep] : typeof rep === 'string' ? JSON.parse(rep) : rep;
      if (!isReplay(r)) throw new Error('not a v3 replay');
      return verifyReplay(r);
    },
  };
  (window as unknown as { octa: typeof api }).octa = api;
  addEventListener('message', e => {
    const d = e.data; if (!d || d.octa !== 1 || !(d.method in api)) return;
    let result: unknown, error: string | undefined;
    try { result = (api as unknown as Record<string, (...a: unknown[]) => unknown>)[d.method](...(d.args || [])) } catch (err) { error = (err as Error).message }
    try { (e.source as Window || parent).postMessage({ octa: 1, id: d.id, result, error }, '*') } catch { /* ignore */ }
  });
  return api;
}
