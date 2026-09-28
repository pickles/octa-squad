// Win-rate benchmark of the built-in AI with the default hangar loadout (greedy deploy like the UI).
//   npx tsx tools/bench.ts [difficulty] [seeds]
import { AgentPort, DEFAULT_LOADOUT, MISSIONS, Sim, brainTick, loadoutStats } from '../src/core';
import type { Difficulty } from '../src/core';
const diff = (process.argv[2] || 'normal') as Difficulty, seeds = +(process.argv[3] || 6);
let total = 0, wins = 0;
for (const m of MISSIONS) {
  let cost = 0, n = 0; const deploy = DEFAULT_LOADOUT.map(s => { const c = loadoutStats(s).cost; if (n < m.max && cost + c <= m.budget) { cost += c; n++; return true } return false });
  const res: string[] = []; let w = 0, lost = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const sim = new Sim({ mission: m.id, difficulty: diff, seed, slots: DEFAULT_LOADOUT, deploy }), port = new AgentPort(sim);
    while (!sim.over && sim.time < 600) { brainTick(port); sim.run(1) }
    const win = !!sim.over?.win; if (win) w++; lost += sim.lost; res.push(win ? 'W' : 'L');
  }
  total += seeds; wins += w;
  console.log(`${m.id} ${m.type}: ${w}/${seeds} win  avg lost ${(lost / seeds).toFixed(1)}/${n}  ${res.join('')}`);
}
console.log(`TOTAL ${wins}/${total}`);
