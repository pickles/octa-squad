// OCTA SQUAD — AI player harness (Playwright).  node octa_agent_example.mjs [mission] [difficulty]
// Replace decide() with your own policy or an LLM call (feed it octa.rules() once and octa.text() every turn).
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const MISSION = process.argv[2] || 'm1';
const DIFF = process.argv[3] || 'easy';
const HTML = path.resolve(process.env.OCTA_HTML || new URL('../index.html', import.meta.url).pathname);
const STEP_SEC = 1.0;      // simulated seconds per decision
const MAX_TURNS = +(process.env.TURNS || 900);

const LOADOUT = [
  { slot: 1, chassis: 'heavy',   weapon: 'rifle', equip: 'plate', tool: 'missile' },
  { slot: 2, chassis: 'assault', weapon: 'rifle', equip: 'none',  tool: 'smoke'   },
  { slot: 3, chassis: 'assault', weapon: 'rifle', equip: 'none',  tool: 'none'    },
  { slot: 4, chassis: 'support', weapon: 'rifle', equip: 'none',  tool: 'chaff'   },
  { slot: 5, chassis: 'light',   weapon: 'rifle', equip: 'radar', tool: 'flare'   },
];

// --- a simple rule-based policy: keep the squad together, focus fire, hunt the nearest known enemy.
const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function decide(obs, map) {
  const alive = obs.squad.filter(u => u.alive);
  if (!alive.length) return [];
  const c = { x: alive.reduce((s, u) => s + u.x, 0) / alive.length, y: alive.reduce((s, u) => s + u.y, 0) / alive.length };
  const armed = obs.enemies.filter(e => e.weapon || e.objective || e.type === 'radar');
  if (armed.length) {
    // focus the weakest visible enemy near the squad; missile carriers fire at anything they can lock
    const t = armed.sort((a, b) => (a.hp + d(a, c) * 8) - (b.hp + d(b, c) * 8))[0];
    const cmds = [{ cmd: 'attack', units: 'all', target: t.id }];
    for (const u of alive) if (u.tool === 'missile' && u.ammo > 0 && u.toolReady && !u.pendingTool && u.lockable.length) cmds.push({ cmd: 'tool', units: [u.id], target: u.lockable[0] });
    return cmds;
  }
  const goals = [...obs.lastSeen];
  if (obs.sites) {                       // recon: unscanned search areas first, then back to the LZ
    obs.zones.filter(z => z.kind === 'hint').forEach((z, i) => { if (!obs.sites[i].scanned) goals.push(obs.sites[i].x != null ? obs.sites[i] : z) });
    if (obs.sites.every(s => s.scanned)) goals.push(...obs.zones.filter(z => z.kind === 'lz'));
  } else goals.push(...obs.zones.filter(z => z.kind !== 'hint'));
  if (obs.convoy && !obs.convoy.moving && obs.time > 20) return [{ cmd: 'convoy', go: true }];
  const g = goals.filter(z => d(z, c) > 1.2 || z.kind === 'lz').sort((a, b) => d(a, c) - d(b, c))[0];
  const moving = alive.some(u => u.moving);
  if (g && !moving) return [{ cmd: 'move', units: 'all', x: g.x, y: g.y }];
  if (!g && !moving) { // explore: nearest unexplored passable tile
    let best = null, bd = 1e9;
    for (let y = 0; y < map.size; y++) for (let x = 0; x < map.size; x++)
      if (map.explored[y][x] === '0' && '.FH='.includes(map.rows[y][x])) { const dd = Math.hypot(x + .5 - c.x, y + .5 - c.y); if (dd < bd) { bd = dd; best = { x: x + .5, y: y + .5 } } }
    if (best) return [{ cmd: 'move', units: 'all', x: best.x, y: best.y }];
  }
  return [];
}

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto('file://' + HTML);
await page.waitForFunction(() => window.octa);

// fit the loadout to this mission's budget / unit cap (drops units from the end)
const { mission, parts } = await page.evaluate(id => ({ mission: window.octa.missions().find(m => m.id === id), parts: window.octa.parts() }), MISSION);
const cost = l => parts.chassis[l.chassis].cost + parts.weapons[l.weapon].cost + parts.equip[l.equip].cost + parts.tools[l.tool || 'none'].cost;
let loadout = LOADOUT.slice(0, mission.maxUnits);
while (loadout.reduce((s, l) => s + cost(l), 0) > mission.budget) loadout = loadout.slice(0, -1);
console.log(`${mission.id} ${mission.name}: deploying ${loadout.length} units, cost ${loadout.reduce((s, l) => s + cost(l), 0)}/${mission.budget}`);

let obs = await page.evaluate(o => window.octa.start(o), { mission: MISSION, difficulty: DIFF, seed: 1, loadout });
for (let turn = 0; turn < MAX_TURNS && obs.status === 'running'; turn++) {
  const map = await page.evaluate(() => window.octa.map());
  const cmds = decide(obs, map);
  if (cmds.length) { const r = await page.evaluate(c => window.octa.act(c), cmds); r.forEach((x, i) => { if (!x.ok) console.log('act error', cmds[i], x.error) }); }
  obs = await page.evaluate(s => window.octa.step(s), STEP_SEC);
  for (const e of obs.events) console.log(`[${e.t}s] ${e.text}`);
}
console.log(`\nRESULT: ${obs.status} — ${obs.result} (t=${obs.time}s)`);
console.log(await page.evaluate(() => window.octa.text()));
await page.screenshot({ path: `octa_${MISSION}_final.png` });
// save the replay: paste it into the game's 「リプレイを読み込む」 box (or octa.playReplay(json)) to watch
const replay = await page.evaluate(() => window.octa.replay());
fs.writeFileSync(`octa_replay_${MISSION}.json`, JSON.stringify(replay));
console.log(`replay saved: octa_replay_${MISSION}.json (${replay.cmds.length} commands)`);
console.log('determinism check:', JSON.stringify(await page.evaluate(r => window.octa.verifyReplay(r), replay)));
await browser.close();
