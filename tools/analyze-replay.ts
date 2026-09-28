// Balance analysis for a saved replay.
//   npm run analyze -- path/to/replay.json [--log]
// Re-runs the replay's commands on the CURRENT simulation and prints, per unit:
// shots fired, how often the shooter was undetected while firing, max firing
// distance, damage dealt (attributed by the landing projectile), damage taken
// and how much of that damage came through smoke.
// If the replay was recorded on an older SIM_VERSION the outcome may differ —
// that is the point: it shows how the same orders fare under the new rules.
import { readFileSync } from 'node:fs';
import { Sim, verifyReplay, SIM_VERSION } from '../src/core';
import type { Entity } from '../src/core/ecs';

const file = process.argv[2];
if (!file) { console.error('usage: npm run analyze -- replay.json [--log]'); process.exit(1) }
const rep = JSON.parse(readFileSync(file, 'utf8'));
const showLog = process.argv.includes('--log');

const v = verifyReplay(rep);
console.log(`mission ${rep.mission} ${rep.diff} seed ${rep.seed}  recorded sim v${v.simVersion.recorded} / current v${SIM_VERSION}`);
console.log(`recorded: ${JSON.stringify(rep.result)}`);
console.log(`current : ${JSON.stringify(v.replayed)}  ${v.match ? '(same result)' : '(DIFFERENT under current rules)'}`);

const s = Sim.fromReplay(rep);
type Row = { shots: number; hidden: number; maxD: number; dealt: number; taken: number; takenSmoke: number };
const rows: Record<string, Row> = {};
const row = (k: string) => (rows[k] ??= { shots: 0, hidden: 0, maxD: 0, dealt: 0, taken: 0, takenSmoke: 0 });
const key = (e: Entity) => e.team === 'P' ? `${String(e.squad?.no ?? '').padStart(2, '0')} ${e.name} ${e.weapon?.def.name ?? ''}` : 'ENEMY(all)';
const hp = new Map<number, number>();
for (const e of s.world.all()) if (e.health) hp.set(e.id, e.health.hp);
const seen = new Set<object>();
// a shot counts as 'hidden' if the shooter stays undetected for the 2s muzzle-flash window after firing
const pending: { src: number; until: number; r: Row; hit: boolean }[] = [];
let first = -1;

while (!s.over && s.tickN < rep.ticks + 30 * 60) {
  const before = new Set(s.projs);
  // smoke state at the moment a projectile lands is taken from before the step
  const smokeAt = new Map<object, boolean>();
  for (const p of before) { const src = s.world.get(p.src), t = s.world.get(p.tgt); if (src && t) smokeAt.set(p, s.smokeOn(src.pos, t.pos)) }
  s.step();
  for (const p of s.projs) if (!seen.has(p)) {
    seen.add(p); const src = s.world.get(p.src)!, t = s.world.get(p.tgt)!, r = row(key(src));
    r.shots++; r.maxD = Math.max(r.maxD, Math.hypot(src.pos.x - t.pos.x, src.pos.y - t.pos.y));
    if (src.team === 'P') pending.push({ src: src.id, until: s.time + 2.2, r, hit: false });
    if (first < 0) first = s.time;
  }
  for (const q of pending) if (s.detP.has(q.src)) q.hit = true;
  for (let i = pending.length - 1; i >= 0; i--) if (pending[i].until <= s.time) { if (!pending[i].hit) pending[i].r.hidden++; pending.splice(i, 1) }
  const drop = new Map<number, number>();
  for (const e of s.world.all()) if (e.health) {
    const now = Math.max(0, e.health.hp), prev = hp.get(e.id) ?? now;
    if (now < prev) { drop.set(e.id, prev - now); row(key(e)).taken += prev - now }
    hp.set(e.id, now);
  }
  for (const p of before) if (!s.projs.includes(p)) {
    const d = drop.get(p.tgt); if (!d) continue;
    const src = s.world.get(p.src)!, tgt = s.world.get(p.tgt)!;
    row(key(src)).dealt += d; if (smokeAt.get(p)) row(key(tgt)).takenSmoke += d;
    drop.delete(p.tgt);
  }
}

const totP = Object.entries(rows).filter(([k]) => !k.startsWith('ENEMY')).reduce((a, [, r]) => a + r.dealt, 0);
console.log(`\nfirst shot ${first.toFixed(1)}s, end ${s.time.toFixed(1)}s\n`);
console.log('unit'.padEnd(24) + 'shots  hidden%  maxRng  dealt(share)  taken  viaSmoke');
for (const [k, r] of Object.entries(rows).sort((a, b) => b[1].dealt - a[1].dealt)) {
  const share = k.startsWith('ENEMY') ? '' : ` (${Math.round(r.dealt / (totP || 1) * 100)}%)`;
  console.log(k.padEnd(24) + String(r.shots).padStart(5) + (r.shots && !k.startsWith('ENEMY') ? Math.round(r.hidden / r.shots * 100) + '%' : '-').padStart(9)
    + r.maxD.toFixed(1).padStart(8) + (r.dealt.toFixed(0) + share).padStart(14) + r.taken.toFixed(0).padStart(7) + r.takenSmoke.toFixed(0).padStart(10));
}
if (showLog) { console.log(); for (const l of s.logs) console.log(`[${l.t}s] ${l.text}`) }
