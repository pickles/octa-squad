// Built-in AI commander. It only uses the same fog-respecting observations and actions that an
// external agent gets through AgentPort, so it doubles as a reference implementation.
import type { AgentPort, Action, Observation } from './agent';
import { N } from './map';

type U = Observation['squad'][number];
type Pt = { x: number; y: number };
type Act = Action & { units?: number[] | 'all'; x?: number; y?: number; target?: string };
const dd = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Decide and issue this second's orders. Returns a one-line description of the intent. */
export function brainTick(port: AgentPort): string {
  const o = port.observe({ peek: true }), alive = o.squad.filter(u => u.alive);
  if (!alive.length) return '';
  const c = { x: alive.reduce((s, u) => s + u.x, 0) / alive.length, y: alive.reduce((s, u) => s + u.y, 0) / alive.length };
  let cmds: Act[] = []; let intent = '';
  const moving = alive.some(u => u.moving);
  const say = (t: string) => { intent = t };

  if (o.convoy) {
    const lead = o.convoy.trucks.find(t => t.alive), goal = o.zones.find(z => z.kind === 'goal')!;
    if (lead) {
      const ahead = dd(lead, goal) - dd(c, goal), mineNear = o.enemyMines.some(m => dd(m, lead) < 7), threat = o.enemies.some(e => e.weapon && dd(e, lead) < 8);
      const go = o.time > 25 && ahead > Math.min(3, dd(lead, goal) * 0.15) && !mineNear && !threat;
      if (go !== o.convoy.moving) cmds.push({ cmd: 'convoy', go });
    }
  }
  { // clear known enemy mines
    const used = new Set<number>();
    for (const m of o.enemyMines) {
      const u = alive.filter(x => !used.has(x.id) && x.chassis !== 'support').sort((a, b) => dd(a, m) - dd(b, m))[0];
      if (!u || dd(u, m) > 9) continue; used.add(u.id);
      if (u.moveMode !== 'careful') cmds.push({ cmd: 'mode', units: [u.id], mode: 'careful' });
      if (dd(u, m) > 1.0 && !(u.dest && dd(u.dest, m) < 0.8)) cmds.push({ cmd: 'move', units: [u.id], x: m.x + 0.4, y: m.y + 0.4 });
    }
    if (used.size) { say(`地雷処理中（${o.enemyMines.length}個）`); if (!o.enemies.some(e => e.weapon && dd(e, c) < 8)) return finish(cmds, intent) }
  }
  if (o.sites) { const nf = alive.filter(u => u.stance !== 'nofire'); if (nf.length) cmds.push({ cmd: 'stance', units: nf.map(u => u.id), stance: 'nofire' }) }
  if (o.extraction) {
    const lz = o.zones.find(z => z.kind === 'lz')!, inLZ = alive.filter(u => dd(u, lz) <= lz.r - 0.3);
    const threat = o.enemies.filter(e => e.weapon && alive.some(u => dd(u, e) <= u.range + 0.5)).sort((a, b) => a.hp - b.hp)[0];
    const dl = dd(c, lz);
    if (threat) { cmds.push({ cmd: 'attack', units: 'all', target: threat.id }); say(inLZ.length === alive.length ? `LZを守りつつ ${threat.name} を集中攻撃` : `進路上の ${threat.name} を排除`) }
    else if (dl < 4 || inLZ.length) {
      const out = alive.filter(u => !inLZ.includes(u) && !(u.dest && dd(u.dest, lz) < lz.r));
      if (out.length) cmds.push({ cmd: 'move', units: out.map(u => u.id), x: lz.x, y: lz.y });
      say(o.extraction.pickupRequested ? `LZで回収待ち（残り${Math.ceil(o.extraction.pickupIn || 0)}秒）` : `LZへ進入（${inLZ.length}/${alive.length}機）`);
    } else if (!moving) { const k = Math.min(5, dl) / dl; cmds.push({ cmd: 'move', units: 'all', x: c.x + (lz.x - c.x) * k, y: c.y + (lz.y - c.y) * k }); say(`隊列を保ってLZへ前進（残り${dl.toFixed(0)}マス）`) }
    else say('隊列を保ってLZへ前進');
    return finish(cmds, intent);
  }
  const near = o.sites ? [] : o.enemies.filter(e => (e.weapon || e.objective || e.type === 'radar') && dd(e, c) < 9);
  if (near.length) {
    const score = (e: typeof near[number]) => (e.type === 'radar' ? -60 : 0) + (e.objective && near.length === 1 ? -30 : 0) + e.hp * 0.6 + dd(e, c) * 10 - (e.weapon === 'SN' ? 25 : 0);
    const t = [...near].sort((a, b) => score(a) - score(b))[0];
    cmds.push({ cmd: 'attack', units: 'all', target: t.id }); say(`${t.name}（HP${t.hp}）を集中攻撃${near.length > 1 ? `　ほか${near.length - 1}機視認` : ''}`);
    for (const u of alive) if (u.hp / u.maxHp < 0.25 && alive.length > 1) { const e = near[0]; cmds.push({ cmd: 'move', units: [u.id], x: u.x + (u.x - e.x) * 0.6, y: u.y + (u.y - e.y) * 0.6 }) }
    return finish(cmds, intent);
  }
  const goals: (Pt & { why: string; kind?: string })[] = o.lastSeen.map(e => ({ x: e.x, y: e.y, why: `最後に${e.type}を見た地点へ` }));
  if (o.sites) {
    o.zones.filter(z => z.kind === 'hint').forEach((z, i) => { const st = o.sites![i]; if (!st.scanned) goals.push({ ...(st.x != null ? { x: st.x, y: st.y! } : z), why: `${z.label}を捜索` }) });
    if (o.sites.every(x => x.scanned)) goals.push(...o.zones.filter(z => z.kind === 'lz').map(z => ({ ...z, why: 'LZへ帰還' })));
  } else if (o.hq && o.hq.alive) goals.push({ x: 23.5, y: 4.5, why: '司令塔へ前進' });
  else if (o.convoy) {
    const lead = o.convoy.trucks.find(t => t.alive);
    if (lead) { const g = o.zones.find(z => z.kind === 'goal')!; const k = o.convoy.moving ? 0.35 : 0.25; goals.push({ x: lead.x + (g.x - lead.x) * k, y: lead.y + (g.y - lead.y) * k, why: '輸送隊の前方を警戒' }) }
  }
  const g = goals.filter(z => dd(z, c) > 1.2 || z.kind === 'lz').sort((a, b) => dd(a, c) - dd(b, c))[0];
  if (g) {
    if (!moving || o.convoy) cmds.push({ cmd: 'move', units: 'all', x: g.x, y: g.y });
    else { const idle = alive.filter(u => !u.moving && !u.pendingTool && !u.hiding && dd(u, g) > 2.5); if (idle.length) cmds.push({ cmd: 'move', units: idle.map(u => u.id), x: g.x, y: g.y }) }
    say(g.why);
  } else if (!moving) {
    const m = port.map(); let best: Pt | null = null, bd = 1e9;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (m.explored[y][x] === '0' && '.FH='.includes(m.rows[y][x])) { const d = Math.hypot(x + .5 - c.x, y + .5 - c.y); if (d < bd) { bd = d; best = { x: x + .5, y: y + .5 } } }
    if (best) { cmds.push({ cmd: 'move', units: 'all', ...best }); say('未探索の区域を索敵') }
  } else say('移動中');
  return finish(cmds, intent);

  function finish(cmds0: Act[], intent0: string): string {
    let cmds = cmds0, intent = intent0;
    const busy = new Set<number>();
    const tl = (u: U, k: string) => u.alive && u.tool === k && u.ammo > 0 && !u.pendingTool && u.toolReady && !busy.has(u.id);
    const cloudAt = (k: string, p: Pt, r = 1.5) => o.clouds.some(cl => cl.kind === k && Math.hypot(cl.x - p.x, cl.y - p.y) < r);
    for (const u of alive) if (tl(u, 'missile') && u.lockable.length) {
      const cand = o.enemies.filter(e => u.lockable.includes(e.id)).sort((a, b) => (b.weapon === 'SN' ? 50 : 0) + (b.missiles ? 40 : 0) - (a.weapon === 'SN' ? 50 : 0) - (a.missiles ? 40 : 0) + (a.hp - b.hp) * 0.3)[0];
      if (cand) { cmds.push({ cmd: 'tool', units: [u.id], target: cand.id }); busy.add(u.id); intent += `　／ ${u.id}番がミサイルで${cand.name}を狙う` }
    }
    for (const m of o.incomingMissiles) {
      const tu = alive.find(u => u.id === m.target); if (!tu || cloudAt('chaff', tu)) continue;
      const cu = alive.filter(u => tl(u, 'chaff') && dd(u, tu) <= 3.5).sort((a, b) => dd(a, tu) - dd(b, tu))[0];
      if (cu) { cmds.push({ cmd: 'tool', units: [cu.id], x: tu.x, y: tu.y }); busy.add(cu.id); intent += `　／ ミサイル接近、${tu.id}番にチャフ`; break }
    }
    const nearE = o.enemies.filter(e => e.weapon && dd(e, c) < 7);
    if (nearE.length) for (const hu of alive.filter(u => u.detected && u.hp / u.maxHp < 0.45 && !cloudAt('smoke', u))) {
      const su = alive.filter(u => tl(u, 'smoke') && dd(u, hu) <= 3.5).sort((a, b) => dd(a, hu) - dd(b, hu))[0];
      if (su) { cmds.push({ cmd: 'tool', units: [su.id], x: hu.x, y: hu.y }); busy.add(su.id); intent += `　／ ${hu.id}番を煙幕で隠す`; break }
    }
    if (o.sites) o.zones.filter(z => z.kind === 'hint').forEach((z, i) => {
      if (o.sites![i].scanned || o.sites![i].x != null || cloudAt('flare', z, 3)) return;
      const fu = alive.find(u => tl(u, 'flare') && dd(u, z) <= 8 && dd(u, z) > 3);
      if (fu) { cmds.push({ cmd: 'tool', units: [fu.id], x: z.x, y: z.y }); busy.add(fu.id); intent += `　／ ${z.label}に照明弾` }
    });
    if (o.extraction && nearE.length && !o.decoys.length) {
      const du = alive.find(u => tl(u, 'decoy'));
      if (du) { const e = [...nearE].sort((a, b) => dd(a, du) - dd(b, du))[0]; const L = dd(e, du) || 1; cmds.push({ cmd: 'tool', units: [du.id], x: du.x + (e.x - du.x) / L * 3.5, y: du.y + (e.y - du.y) / L * 3.5 }); busy.add(du.id); intent += '　／ デコイで敵を引きつける' }
    }
    { // ammo: AP against heavies, HE against structures
      const tgtE = o.enemies.find(e => cmds.some(k => k.cmd === 'attack' && k.target === e.id));
      if (tgtE) {
        const want = tgtE.structure ? 'he' : tgtE.type === 'heavy' ? 'ap' : 'std';
        const sw = alive.filter(u => u.weapon && !u.reloading && u.ammoType !== want && (want === 'std' || (want === 'ap' ? u.apRounds : u.heRounds) > 0) && !busy.has(u.id));
        if (sw.length) cmds.push({ cmd: 'ammo', units: sw.map(u => u.id), ammo: want });
      }
    }
    if (o.mission === 'm2' || o.mission === 'm4') { const want = nearE.length ? 'normal' : 'careful'; const ch = alive.filter(u => u.moveMode !== want); if (ch.length) cmds.push({ cmd: 'mode', units: ch.map(u => u.id), mode: want }) }
    if (o.artillery.left > 0 && !o.artillery.incoming.length) for (const e of o.enemies) {
      if (e.structure) continue; const cl = o.enemies.filter(f => !f.structure && dd(f, e) <= 1.8);
      if (cl.length >= 3 && alive.every(u => dd(u, e) > 4)) { cmds.push({ cmd: 'artillery', x: e.x, y: e.y }); intent += `　／ 敵${cl.length}機の集団に砲撃要請`; break }
    }
    for (const u of alive) if (tl(u, 'charge')) { const st = o.enemies.find(e => e.structure && dd(e, u) < 6); if (st) { cmds.push({ cmd: 'tool', units: [u.id], target: st.id }); busy.add(u.id); intent += `　／ ${u.id}番が${st.name}に爆薬` } }
    cmds = cmds.map(k => (k.cmd === 'move' || k.cmd === 'attack') && k.units === 'all' ? { ...k, units: alive.filter(u => !busy.has(u.id) && !u.pendingTool).map(u => u.id) } : k)
      .filter(k => !Array.isArray(k.units) || k.units.length);
    // roles: repair units never lead — they trail the group and tuck in behind whoever is hurt
    const sup = alive.filter(u => u.chassis === 'support'), cmb = alive.filter(u => u.chassis !== 'support');
    if (sup.length && cmb.length) {
      const cc = { x: cmb.reduce((a, u) => a + u.x, 0) / cmb.length, y: cmb.reduce((a, u) => a + u.y, 0) / cmb.length }; const out: Act[] = [];
      for (const k of cmds) {
        if ((k.cmd === 'attack' || k.cmd === 'move') && (k.units === 'all' || (Array.isArray(k.units) && k.units.some(id => sup.some(u => u.id === id))))) {
          const ids = (k.units === 'all' ? alive.map(u => u.id) : k.units as number[]).filter(id => !sup.some(u => u.id === id));
          if (ids.length) out.push({ ...k, units: ids });
          if (k.cmd === 'move') {
            const lz = o.zones.find(z => z.kind === 'lz');
            if (!(o.extraction && lz && dd(k as Pt, lz) < 1)) { const dx = k.x! - cc.x, dy = k.y! - cc.y, L = Math.hypot(dx, dy) || 1; sup.forEach((u, i) => out.push({ cmd: 'move', units: [u.id], x: k.x! - dx / L * 1.8 - dy / L * (i * 0.8), y: k.y! - dy / L * 1.8 + dx / L * (i * 0.8) })) }
            else sup.forEach(u => out.push({ cmd: 'move', units: [u.id], x: k.x!, y: k.y! }));
          }
        } else out.push(k);
      }
      cmds = out;
      const atk = cmds.find(k => k.cmd === 'attack'), t = atk && o.enemies.find(e => e.id === atk.target);
      if (t) {
        const hurt = [...cmb].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0]; const dx = hurt.x - t.x, dy = hurt.y - t.y, L = Math.hypot(dx, dy) || 1;
        sup.forEach((u, i) => { const p = { x: hurt.x + dx / L * 1.6 - dy / L * (i * 0.8), y: hurt.y + dy / L * 1.6 + dx / L * (i * 0.8) }; if (dd(u, p) > 1.0 && !(u.dest && dd(u.dest, p) < 1.0)) cmds.push({ cmd: 'move', units: [u.id], ...p }) });
        intent += `　／ 修理機は${hurt.pilot}機（HP${Math.round(hurt.hp / hurt.maxHp * 100)}%）の後方へ`;
      }
    }
    const pick = (k: Act) => k.units === 'all' || !k.units ? alive : alive.filter(u => (k.units as number[]).includes(u.id));
    const f = cmds.filter(k => {
      if (k.cmd === 'tool') return true;
      if (k.cmd === 'attack') return pick(k).some(u => u.target !== k.target && !u.pendingTool);
      if (k.cmd === 'move') return !pick(k).every(u => u.dest && Math.hypot(u.dest.x - k.x!, u.dest.y - k.y!) < 1.0);
      return true;
    });
    if (f.length) port.act(f as Action[]);
    return intent || '待機';
  }
}
