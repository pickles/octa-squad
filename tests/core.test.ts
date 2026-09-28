import { describe, expect, it } from 'vitest';
import { AgentPort, DEFAULT_LOADOUT, MISSIONS, Sim, brainTick, buildLoadout, verifyReplay, N } from '../src/core';

function autoBattle(mission: any, difficulty: any, seed: number, maxSec = 240) {
  const { slots, deploy } = buildLoadout(mission, DEFAULT_LOADOUT, [
    { slot: 1, chassis: 'heavy', weapon: 'rifle', equip: 'plate', tool: 'missile' },
    { slot: 2, chassis: 'assault', weapon: 'mg', equip: 'none', tool: 'smoke' },
    { slot: 4, chassis: 'support', weapon: 'rifle', equip: 'none', tool: 'chaff' },
  ]);
  const sim = new Sim({ mission, difficulty, seed, slots, deploy });
  const port = new AgentPort(sim);
  while (!sim.over && sim.time < maxSec) { brainTick(port); sim.run(1) }
  if (!sim.over) sim.issue({ k: 'abort' });
  return sim;
}

describe('map generation', () => {
  it.each(MISSIONS.map(m => m.id))('%s: every key point is reachable from spawn', id => {
    const sim = new Sim({ mission: id, seed: 1, slots: DEFAULT_LOADOUT, deploy: DEFAULT_LOADOUT.map((_, i) => i < 2) });
    const m = MISSIONS.find(x => x.id === id)!;
    for (const [x, y] of m.keys) expect(sim.map.findPath(m.spawn[0] + .5, m.spawn[1] + .5, x + .5, y + .5).length).toBeGreaterThan(0);
    expect(sim.map.grid.length).toBe(N * N);
  });
});

describe('determinism', () => {
  it.each(MISSIONS.map(m => m.id))('%s: a replay reproduces the recorded outcome', id => {
    const sim = autoBattle(id, 'normal', 7, 120);
    const rep = sim.toReplay();
    expect(rep.cmds.length).toBeGreaterThan(0);
    const v = verifyReplay(JSON.parse(JSON.stringify(rep)));
    expect(v.match).toBe(true);
  });
  it('same seed and commands give identical state', () => {
    const a = autoBattle('m1', 'easy', 3, 60), b = autoBattle('m1', 'easy', 3, 60);
    expect(a.world.all().map(e => [e.pos.x, e.pos.y, e.health?.hp])).toEqual(b.world.all().map(e => [e.pos.x, e.pos.y, e.health?.hp]));
  });
});

describe('agent interface', () => {
  it('rejects over-budget loadouts', () => {
    expect(() => buildLoadout('m3', DEFAULT_LOADOUT, [1, 2, 3, 4, 5].map(slot => ({ slot, chassis: 'heavy' as const })))).toThrow();
  });
  it('does not reveal enemies hidden in the fog', () => {
    const sim = new Sim({ mission: 'm1', seed: 1, slots: DEFAULT_LOADOUT, deploy: [true, false, false, false, false, false, false, false] });
    const o = new AgentPort(sim).observe();
    expect(o.enemies.length).toBe(0);
    expect(sim.countE()).toBeGreaterThan(0);
  });
  it('validates actions', () => {
    const sim = new Sim({ mission: 'm1', seed: 1, slots: DEFAULT_LOADOUT, deploy: DEFAULT_LOADOUT.map(() => true) });
    const port = new AgentPort(sim);
    expect(port.act({ cmd: 'attack', units: 'all', target: 'e999' })[0].ok).toBe(false);
    expect(port.act({ cmd: 'move', units: [1, 2], x: 10, y: 10 })[0].ok).toBe(true);
    expect(sim.rec.length).toBe(1);
  });
});
