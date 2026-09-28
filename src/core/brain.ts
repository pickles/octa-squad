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
  const effSpd = (u: U) => u.speed * (u.damaged.includes('legs') ? 0.55 : 1);
  const isScout = (u: U) => u.chassis === 'light' && u.weapon !== 'sniper';
  const supports = alive.filter(u => u.chassis === 'support'), scouts = alive.filter(isScout);
  let line = alive.filter(u => u.chassis !== 'support' && !isScout(u));
  if (!line.length) line = alive.filter(u => u.chassis !== 'support');
  if (!line.length) line = alive;
  const anchor = [...line].sort((a, b) => effSpd(a) - effSpd(b) || b.maxHp - a.maxHp)[0];
  void supports;
  let cmds: Act[] = []; let intent = '';
  const moving = alive.some(u => u.moving);
  const say = (t: string) => { intent = t };

  if (o.convoy) {
    const lead = o.convoy.trucks.find(t => t.alive), goal = o.zones.find(z => z.kind === 'goal')!;
    if (lead) {
      const lc = { x: line.reduce((q, u) => q + u.x, 0) / line.length, y: line.reduce((q, u) => q + u.y, 0) / line.length };
      const ahead = dd(lead, goal) - dd(lc, goal), mineNear = o.enemyMines.some(m => dd(m, lead) < 7), threat = o.enemies.some(e => e.weapon && dd(e, lead) < 8);
      const go = o.time > 25 && (ahead > 1.5 || dd(lead, goal) < 4) && !mineNear && !threat;
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
  // ---- doctrine: scouts find the enemy and fall back; the slowest line unit (usually the heavy) is the shield and the
  //      anchor; everyone else fights next to it, inside the repair radius of the support units.
  const near = o.sites ? [] : o.enemies.filter(e => (e.weapon || e.objective || e.type === 'radar') && dd(e, c) < 10);
  const back = (from: Pt, dist: number, i = 0): Pt => { // a point behind the anchor, away from `from`
    const dx = anchor.x - from.x, dy = anchor.y - from.y, L = Math.hypot(dx, dy) || 1, side = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.8;
    return { x: anchor.x + dx / L * dist - dy / L * side, y: anchor.y + dy / L * dist + dx / L * side };
  };
  if (near.length) {
    const score = (e: typeof near[number]) => (e.type === 'radar' ? -60 : 0) + (e.objective && near.length === 1 ? -30 : 0) + e.hp * 0.6 + dd(e, anchor) * 10 - (e.weapon === 'SN' ? 25 : 0);
    const t = [...near].sort((a, b) => score(a) - score(b))[0];
    const fighters = line.filter(u => u !== anchor && dd(u, anchor) <= 3);
    const strays = line.filter(u => u !== anchor && dd(u, anchor) > 3);
    // the anchor always closes on the target; units next to it join in
    cmds.push({ cmd: 'attack', units: [anchor.id, ...fighters.map(u => u.id)], target: t.id });
    // anyone who ran ahead (or scouts) falls back behind the anchor instead of fighting alone
    let k = 0;
    for (const u of [...strays, ...scouts]) {
      const p = back(t, isScout(u) ? 2.2 : 1.4, k++);
      if (dd(u, p) > 1.2 && !(u.dest && dd(u.dest, p) < 1.0)) cmds.push({ cmd: 'move', units: [u.id], ...p });
    }
    for (const u of line) if (u !== anchor && u.hp / u.maxHp < 0.35 && !strays.includes(u)) { const p = back(t, 1.8, k++); cmds.push({ cmd: 'move', units: [u.id], ...p }) }
    say(`${anchor.pilot}機を盾に${t.name}（HP${t.hp}）を攻撃${strays.length + scouts.length ? `　／ ${strays.length + scouts.length}機は後退して合流` : ''}${near.length > 1 ? `　ほか${near.length - 1}機視認` : ''}`);
    return finish(cmds, intent);
  }
  const goals: (Pt & { why: string; kind?: string })[] = o.lastSeen.map(e => ({ x: e.x, y: e.y, why: `最後に${e.type}を見た地点へ` }));
  if (o.sites) {
    o.zones.filter(z => z.kind === 'hint').forEach((z, i) => { const st = o.sites![i]; if (!st.scanned) goals.push({ ...(st.x != null ? { x: st.x, y: st.y! } : z), why: `${z.label}を捜索` }) });
    if (o.sites.every(x => x.scanned)) goals.push(...o.zones.filter(z => z.kind === 'lz').map(z => ({ ...z, why: 'LZへ帰還' })));
  } else if (o.hq && o.hq.alive) goals.push({ x: 23.5, y: 4.5, why: '司令塔へ前進' });
  else if (o.convoy) {
    const lead = o.convoy.trucks.find(t => t.alive);
    if (lead) { const g = o.zones.find(z => z.kind === 'goal')!, L = dd(lead, g) || 1, ahead = Math.min(L, Math.max(3, L * (o.convoy.moving ? 0.35 : 0.25))); goals.push({ x: lead.x + (g.x - lead.x) / L * ahead, y: lead.y + (g.y - lead.y) / L * ahead, why: '輸送隊の前方を警戒', kind: 'escort' }) }
  }
  let g: (Pt & { why: string; kind?: string }) | undefined = goals.filter(z => dd(z, c) > 1.2 || z.kind === 'lz' || z.kind === 'escort').sort((a, b) => dd(a, c) - dd(b, c))[0];
  if (!g && !moving) {
    const m = port.map(); let best: Pt | null = null, bd = 1e9;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (m.explored[y][x] === '0' && '.FH='.includes(m.rows[y][x])) { const d = Math.hypot(x + .5 - c.x, y + .5 - c.y); if (d < bd) { bd = d; best = { x: x + .5, y: y + .5 } } }
    if (best) g = { ...best, why: '未探索の区域を索敵' };
  }
  if (g) {
    // the line moves as one block (group move = slowest member's speed); scouts stay a few tiles ahead of the anchor
    const ln = line.filter(u => !u.pendingTool && !u.hiding);
    if (ln.length && (!ln.some(u => u.moving) || o.convoy || ln.some(u => !u.moving && dd(u, g!) > 2.5))) cmds.push({ cmd: 'move', units: ln.map(u => u.id), x: g.x, y: g.y });
    const dA = dd(anchor, g), lead = { x: anchor.x + (g.x - anchor.x) / (dA || 1) * Math.min(3.5, dA), y: anchor.y + (g.y - anchor.y) / (dA || 1) * Math.min(3.5, dA) };
    scouts.forEach((u, i) => { const p = { x: lead.x + (i % 2 ? .8 : -.8) * Math.ceil(i / 2), y: lead.y }; if (dd(u, p) > 1.5 && !(u.dest && dd(u.dest, p) < 1.2)) cmds.push({ cmd: 'move', units: [u.id], ...p }) });
    say(g.why);
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
        const hurt = [...cmb].filter(u => dd(u, anchor) <= 4).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0] || anchor; const dx = hurt.x - t.x, dy = hurt.y - t.y, L = Math.hypot(dx, dy) || 1;
        sup.forEach((u, i) => { const p = { x: hurt.x + dx / L * 1.6 - dy / L * (i * 0.8), y: hurt.y + dy / L * 1.6 + dx / L * (i * 0.8) }; if (dd(u, p) > 1.0 && !(u.dest && dd(u.dest, p) < 1.0)) cmds.push({ cmd: 'move', units: [u.id], ...p }) });
        intent += `　／ 修理機は${hurt.pilot}機（HP${Math.round(hurt.hp / hurt.maxHp * 100)}%）の後方へ`;
      }
    }
    { // radar emission control: radiate only while nothing is around (launchers home on emitters)
      const danger = nearE.length > 0 || o.enemies.some(e => e.type === 'launcher') || o.incomingMissiles.length > 0;
      const off = alive.filter(u => u.radar === 'on' && danger), on = alive.filter(u => u.radar === 'off' && !danger);
      if (off.length) { cmds.push({ cmd: 'radar', units: off.map(u => u.id), on: false }); intent += '　／ レーダーOFF' }
      if (on.length) cmds.push({ cmd: 'radar', units: on.map(u => u.id), on: true });
    }
    { // incoming shells (enemy mortar): scatter out of the impact area
      const dodge = new Set<number>(); let k = 0;
      for (const sh of o.artillery.incoming) for (const u of alive) {
        if (dodge.has(u.id) || dd(u, sh) > 2.4) continue; dodge.add(u.id);
        const dx = u.x - sh.x, dy = u.y - sh.y, L = Math.hypot(dx, dy) || 1, a = Math.atan2(dy, dx) + (k++ % 3 - 1) * 0.7;
        void L; cmds.push({ cmd: 'move', units: [u.id], x: Math.max(0.5, Math.min(N - .5, sh.x + Math.cos(a) * 3.2)), y: Math.max(0.5, Math.min(N - .5, sh.y + Math.sin(a) * 3.2)) });
      }
      if (dodge.size) intent += `　／ 砲撃を回避（${dodge.size}機散開）`; // later orders override earlier ones for the same unit
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
