// Run a battle entirely in Node (no browser) with the built-in AI commander or your own policy.
//   npm run agent -- m1 normal [seed]
// Replace `decide` with your own logic or an LLM call (feed it rulesText() once and port.text() every turn).
import { writeFileSync } from 'node:fs';
import { AgentPort, DEFAULT_LOADOUT, Sim, brainTick, buildLoadout, rulesText, verifyReplay } from '../src/core';
import type { MissionId, Difficulty } from '../src/core';

const mission = (process.argv[2] || 'm1') as MissionId;
const difficulty = (process.argv[3] || 'normal') as Difficulty;
const seed = +(process.argv[4] || 1);

const LOADOUT = [
  { slot: 1, chassis: 'heavy', weapon: 'rifle', equip: 'plate', tool: 'missile' },
  { slot: 2, chassis: 'assault', weapon: 'mg', equip: 'none', tool: 'smoke' },
  { slot: 3, chassis: 'assault', weapon: 'rifle', equip: 'none', tool: 'none' },
  { slot: 4, chassis: 'support', weapon: 'rifle', equip: 'none', tool: 'chaff' },
  { slot: 5, chassis: 'light', weapon: 'rifle', equip: 'radar', tool: 'flare' },
  { slot: 6, chassis: 'assault', weapon: 'rifle', equip: 'none', tool: 'none' },
] as const;

// trim to the mission's budget / unit cap
let spec = [...LOADOUT];
let built;
for (;;) { try { built = buildLoadout(mission, DEFAULT_LOADOUT, spec as any); break } catch (e) { if (spec.length <= 1) throw e; spec = spec.slice(0, -1) } }
console.log(`${mission} ${difficulty} seed=${seed}: ${built.deploy.filter(Boolean).length} units, cost ${built.cost}`);

const sim = new Sim({ mission, difficulty, seed, slots: built.slots, deploy: built.deploy });
const port = new AgentPort(sim);
void rulesText; // hand this to an LLM as its system prompt

function decide(p: AgentPort) { return brainTick(p) }

const t0 = Date.now();
while (!sim.over && sim.time < 900) {
  decide(port);
  sim.run(1);
  for (const e of port.observe().events) if (e.kind !== 'ai') console.log(`[${e.t}s] ${e.text}`);
}
console.log(`\nRESULT: ${sim.over ? (sim.over.win ? 'WIN' : 'LOSE') + ' — ' + sim.over.reason : 'timeout'} (t=${sim.time.toFixed(1)}s, ${Date.now() - t0}ms wall)`);
const rep = sim.toReplay();
const file = `replay_${mission}_${difficulty}_${seed}.json`;
writeFileSync(file, JSON.stringify(rep));
console.log(`replay: ${file} (${rep.cmds.length} commands) — verify: ${JSON.stringify(verifyReplay(rep).match)}`);
