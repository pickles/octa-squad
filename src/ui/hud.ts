// Battle HUD (DOM): top bar, unit cards, detail and inspector panels, command bar, log, minimap,
// replay bar and the result panel. Reads the BattleSession; never touches Phaser directly.
import { playAlert, isMuted, setMuted, primeAudio } from './alerts';
import { AMMO, CHASSIS, DIFFS, EQUIP, MMODES, N, STANCES, SYSN, TERR, TOOLS, WEAPONS } from '../core';
import type { Entity, SubsystemKey } from '../core';
import type { BattleSession } from '../game/controller';
import { HPX, TCOL, WPX, css, shade, tileH, w2p } from '../game/iso';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const fmtT = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const ESTATE: Record<string, string> = { guard: '待機警戒', patrol: '巡回中', engage: '交戦中', hunt: '追跡中', return: '帰投中', rally: '集結中', flank: '回り込み', withdraw: '後退中', hold: '陣地で待ち伏せ', search: '捜索中', support: '支援に移動' };
const LOGCLS: Record<string, string> = { warning: 'e', info: 'g', ai: 'ai', note: '', tip: 'tip' };

export interface HudCallbacks {
  toHQ(): void;
  retry(): void;
  watch(): void;
  seek(tick: number): void;
  replayAgain(): void;
  centerOn(tile: { x: number; y: number }): void;
  centerOnPixel(px: number, py: number): void;
  view(): { x: number; y: number; width: number; height: number };
}

export class Hud {
  s: BattleSession | null = null;
  private logShown: { text: string; kind: string; at: number }[] = [];
  private tipAt = 0;
  private alertCursor = 0; private alertUntil = 0;
  private logCursor = 0;
  private hover: { x: number; y: number } | null = null;
  private hoverUnit: Entity | null = null;
  private miniTerrain: HTMLCanvasElement | null = null;
  private abortArmed = 0;
  private seeking = false;

  constructor(private cb: HudCallbacks) {
    $('#cards').addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.card'); const s = this.s; if (!b || !s) return;
      const id = +b.dataset.id!; const u = s.sim.world.get(id); if (!u || !u.life.alive) return;
      if ((e as MouseEvent).shiftKey || (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey) s.toggle(id); else s.select([id]);
      this.update();
    });
    $('#cards').addEventListener('dblclick', () => this.centerSel());
    $('.cmdbar').addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]'); const s = this.s; if (!b || !s || s.sim.over) return;
      const map: Record<string, () => void> = {
        all: () => s.selectAll(), stop: () => s.stop(), stance: () => s.cycleStance(), det: () => { s.showDet = !s.showDet }, center: () => this.centerSel(),
        convoy: () => s.toggleConvoy(), tool: () => s.startTargeting(), mode: () => s.cycleMode(), hide: () => s.hide(), radar: () => s.toggleRadar(), ammo: () => s.cycleAmmo(),
        arty: () => s.startArty(), ai: () => s.setAuto(!s.autoAI),
      };
      map[b.dataset.cmd!]?.(); this.update();
    });
    $('#pauseBtn').onclick = () => { if (this.s) { this.s.setPaused(!this.s.paused); this.update() } };
    $('#spdBtn').onclick = () => { if (this.s) { this.s.cycleSpeed(); this.update() } };
    const mb = $('#muteBtn'), showMute = () => { mb.textContent = isMuted() ? '音 OFF' : '音 ON'; mb.classList.toggle('on', isMuted()) };
    showMute(); mb.onclick = () => { setMuted(!isMuted()); showMute(); if (!isMuted()) { primeAudio(); playAlert('lock') } };
    addEventListener('pointerdown', () => primeAudio(), { once: true });
    $('#abortBtn').onclick = () => {
      const s = this.s; if (!s) return; const b = $('#abortBtn');
      if (s.sim.over || s.replay) { this.cb.toHQ(); return }
      if (performance.now() - this.abortArmed < 3000) { b.classList.remove('arm'); s.abort(); return }
      this.abortArmed = performance.now(); b.classList.add('arm'); b.textContent = 'もう一度押して撤退';
      setTimeout(() => { b.classList.remove('arm'); b.textContent = this.s?.replay ? 'リプレイ終了' : '撤退' }, 3000);
    };
    const sk = $<HTMLInputElement>('#rpSeek');
    sk.addEventListener('pointerdown', () => { this.seeking = true });
    sk.addEventListener('input', () => { if (this.s?.replay) $('#rpTime').textContent = `${fmtT(+sk.value / 30)} / ${fmtT(this.s.replay.ticks / 30)}` });
    sk.addEventListener('change', () => { this.seeking = false; if (this.s?.replay) { $('#result').hidden = true; this.cb.seek(+sk.value) } });
    $<HTMLInputElement>('#rpReveal').addEventListener('change', e => { if (this.s) this.s.reveal = (e.target as HTMLInputElement).checked });
    $<HTMLCanvasElement>('#mini').addEventListener('click', e => {
      const r = (e.target as HTMLElement).getBoundingClientRect();
      this.cb.centerOnPixel((e.clientX - r.left) * WPX / r.width, (e.clientY - r.top) * HPX / r.height);
    });
  }

  /** Attach to a new battle session. */
  bind(s: BattleSession) {
    this.s = s; this.logShown = []; this.logCursor = 0; this.tipAt = 0; $('#tip').hidden = true; this.alertCursor = 0; this.alertUntil = 0; $('#alertBox').hidden = true; this.hover = null; this.hoverUnit = null;
    const m = s.sim.m;
    $('#bType').textContent = m.type; $('#bType').className = 'mtype t-' + m.type; $('#bName').textContent = m.name;
    $('#convoyBtn').hidden = !m.road;
    $('#result').hidden = true; $('#insp').hidden = true;
    $('#cards').innerHTML = s.sim.squad.map(u => `<button class="card" data-id="${u.id}"><span class="cno">${u.squad.no}</span><span class="cname">${u.squad.pilot}<small>${CHASSIS[u.squad.cfg.chassis].name}/${WEAPONS[u.squad.cfg.weapon].tag}<span class="ctl"></span></small></span><span class="cst"></span><span class="hpb"><i></i></span></button>`).join('');
    const rp = s.replay;
    $('#rpbar').hidden = !rp; $('.cmdbar').hidden = !!rp;
    $('#abortBtn').textContent = rp ? 'リプレイ終了' : '撤退';
    if (rp) {
      const sk = $<HTMLInputElement>('#rpSeek'); sk.max = String(rp.ticks); sk.value = String(s.sim.tickN);
      $('#rpMarks').innerHTML = rp.cmds.map(c => `<i class="${c[1].src === 'ai' ? 'ai' : ''}" style="left:${(c[0] / Math.max(1, rp.ticks) * 100).toFixed(2)}%"></i>`).join('');
      $('#rpInfo').textContent = `${rp.ctrl === 'ai' ? 'AI' : rp.ctrl === 'human' ? 'プレイヤー' : 'AI＋プレイヤー'}・${DIFFS[rp.diff]?.name || ''}・${rp.result.win ? '勝利' : '敗北'}・指令 ${rp.cmds.length}`;
      $<HTMLInputElement>('#rpReveal').checked = s.reveal;
    }
    this.miniTerrain = this.buildMiniTerrain();
    this.update();
  }

  setHover(p: { x: number; y: number } | null, u: Entity | null) { this.hover = p; this.hoverUnit = u; this.inspect() }
  setBox(r: { x: number; y: number; w: number; h: number } | null) {
    const el = $('#boxsel'); if (!r) { el.hidden = true; return }
    Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' }); el.hidden = false;
  }
  centerSel() {
    const us = this.s?.selUnits(); if (!us?.length) return;
    this.cb.centerOn({ x: us.reduce((a, u) => a + u.pos.x, 0) / us.length, y: us.reduce((a, u) => a + u.pos.y, 0) / us.length });
  }
  notice(text: string) { this.logShown.push({ text, kind: '', at: performance.now() }); if (this.logShown.length > 5) this.logShown.shift(); this.renderLog() }

  // ---------------------------------------------------------------- periodic refresh
  update() {
    const s = this.s; if (!s) return; const sim = s.sim;
    // log
    for (const l of sim.logs.slice(this.logCursor)) if (l.kind === 'tip') { this.tipAt = sim.time + 0.001; $('#tip').textContent = l.text; $('#tip').hidden = false }
    if (this.tipAt && sim.time - this.tipAt > 14) { this.tipAt = 0; $('#tip').hidden = true }
    for (const l of sim.logs.slice(this.logCursor)) if (l.kind !== 'tip') { this.logShown.push({ text: l.text, kind: LOGCLS[l.kind], at: performance.now() }); if (this.logShown.length > 5) this.logShown.shift() }
    this.logCursor = sim.logs.length;
    // danger alerts: banner + sound (only fresh ones — seeking a replay re-simulates old alerts)
    for (const a of sim.alerts.slice(this.alertCursor)) {
      if (sim.time - a.t > 1) continue;
      const box = $('#alertBox'), hint = a.kind === 'lock' ? 'Z でレーダーOFF／チャフ／隠れる' : a.kind === 'missile' ? 'チャフで誘導を切る／機関銃の味方の近くへ' : '固まっている機体を散らせ';
      box.className = a.kind; box.innerHTML = `${a.text}<small>${hint}</small>`; box.hidden = false;
      this.alertUntil = performance.now() + (a.kind === 'mortar' ? 4000 : 2600);
      playAlert(a.kind);
    }
    this.alertCursor = sim.alerts.length;
    if (this.alertUntil && performance.now() > this.alertUntil) { this.alertUntil = 0; $('#alertBox').hidden = true }
    const now = performance.now(); if (this.logShown.length && now - this.logShown[0].at > 9000) this.logShown.shift();
    this.renderLog();
    // top bar
    $('#bObj').textContent = sim.m.objective(sim);
    const t = sim.m.limit ? Math.max(0, sim.m.limit - sim.time) : sim.time;
    $('#bTime').textContent = fmtT(t); $('#bTime').style.color = sim.m.limit && t < 60 ? '#e4643c' : '';
    const pb = $('#pauseBtn'); pb.textContent = s.paused ? '▶ 再開' : '❚❚ 一時停止'; pb.classList.toggle('pulse', s.paused && !sim.over && !s.stepMode);
    $('#spdBtn').textContent = '×' + s.speed;
    $('#pauseBanner').hidden = !s.paused || !!sim.over || s.stepMode;
    $('#aiChip').hidden = !(s.autoAI || s.external);
    const ai = $('#aiIntent'); ai.hidden = !s.autoAI; if (s.autoAI) ai.innerHTML = `<b>AI</b>${s.aiIntent || '待機'}`;
    // cards
    document.querySelectorAll<HTMLElement>('.card').forEach(c => {
      const u = sim.world.get(+c.dataset.id!)!, sq = u.squad!, h = u.health!;
      c.classList.toggle('sel', s.sel.has(u.id)); c.classList.toggle('dead', !u.life.alive);
      c.querySelector('.cst')!.textContent = (u.life.alive && sim.detP.has(u.id) ? '被発見 ' : '') + this.stateText(u) + (u.life.alive && sq.stance !== 'hold' ? '｜' + (sq.stance === 'nofire' ? '禁射' : '自由') : '');
      const w = u.weapon, sy = u.systems!;
      c.querySelector('.ctl')!.textContent = (u.toolbelt ? ` ${TOOLS[u.toolbelt.tool].tag}×${u.toolbelt.ammo}` : '') + (w && w.ammoType !== 'std' ? ` ${AMMO[w.ammoType].tag}${w[w.ammoType]}` : '') + (u.life.alive && (sy.fcs || sy.legs || sy.sensor) ? ' [' + (['fcs', 'legs', 'sensor'] as SubsystemKey[]).filter(k => sy[k]).map(k => SYSN[k]).join('・') + '損傷]' : '');
      const pct = h.hp / h.maxHp, bar = c.querySelector<HTMLElement>('.hpb i')!;
      bar.style.width = (pct * 100) + '%'; bar.style.background = pct > .6 ? '#8cc67e' : pct > .3 ? '#e2b84a' : '#e4643c';
    });
    this.updateButtons();
    this.updateDetail();
    this.inspect();
    this.drawMini();
    if (s.replay && !this.seeking) { $<HTMLInputElement>('#rpSeek').value = String(sim.tickN); $('#rpTime').textContent = `${fmtT(sim.tickN / 30)} / ${fmtT(s.replay.ticks / 30)}` }
    $<HTMLElement>('#phaser').style.cursor = s.targeting ? 'crosshair' : '';
  }

  private renderLog() { $('#log').innerHTML = this.logShown.map(l => `<div class="${l.kind}">${l.text}</div>`).join('') }

  private stateText(u: Entity) {
    const sq = u.squad!; if (u.life.gone) return '回収済'; if (!u.life.alive) return '大破';
    if (sq.hidden) return '隠蔽中'; if (sq.order === 'hide') return '隠蔽準備'; if (u.weapon?.nextAmmo) return '装填中';
    if (u.toolbelt?.pending) return TOOLS[u.toolbelt.tool].name; if (u.weapon && u.weapon.fireT > 0) return '交戦';
    if (sq.order === 'attack') return '攻撃'; if (u.mover!.path.length) return '移動'; return '待機';
  }

  private updateButtons() {
    const s = this.s!, sim = s.sim, us = s.selUnits(), u0 = us[0];
    const stv = u0?.squad.stance || 'hold'; $('#stanceBtn').textContent = '姿勢: ' + STANCES[stv] + ' Q'; $('#stanceBtn').classList.toggle('on', stv === 'nofire');
    const ts = s.selTools(), tb = $<HTMLButtonElement>('#toolBtn'), tg = s.targeting;
    if (tg && 'tool' in tg && !ts.includes(tg.tool)) s.targeting = null;
    const ab = $<HTMLButtonElement>('#artyBtn'), artyOn = !!(tg && 'arty' in tg);
    ab.textContent = artyOn ? '砲撃：視界内の地点をクリック（Esc取消）' : `砲撃支援 ×${sim.arty} B`; ab.disabled = !sim.arty && !artyOn; ab.classList.toggle('on', artyOn);
    $('#modeBtn').textContent = '移動: ' + MMODES[u0?.squad.mmode || 'normal'].name + ' M'; $('#modeBtn').classList.toggle('on', !!u0 && u0.squad.mmode !== 'normal');
    $('#hideBtn').classList.toggle('on', !!u0 && u0.squad.order === 'hide');
    const rs = us.filter(u => u.sensor && u.sensor.radarBonus > 0), rb = $<HTMLButtonElement>('#radarBtn');
    rb.disabled = !rs.length; rb.textContent = rs.length ? `レーダー: ${rs[0].sensor!.off ? 'OFF' : 'ON'} Z` : 'レーダー Z'; rb.classList.toggle('on', !!rs.length && !!rs[0].sensor!.off);
    const w = u0?.weapon;
    $('#ammoBtn').textContent = '弾種: ' + (w ? (w.nextAmmo ? AMMO[w.nextAmmo].tag + 'に装填中' : AMMO[w.ammoType].tag + (w.ammoType !== 'std' ? '×' + w[w.ammoType] : '')) : '通常') + ' R';
    $('#ammoBtn').classList.toggle('on', !!w && w.ammoType !== 'std');
    if (s.targeting && 'tool' in s.targeting) { const T = TOOLS[s.targeting.tool]; tb.textContent = `${T.name}：${T.target === 'enemy' ? '敵を' : T.target === 'struct' ? '建造物を' : '地点を'}クリック（Esc取消）`; tb.classList.add('on') }
    else { tb.classList.remove('on'); tb.disabled = !ts.length; tb.textContent = ts.length ? `${ts.map(t => TOOLS[t].name + '×' + us.filter(u => u.toolbelt?.tool === t).reduce((a, u) => a + u.toolbelt!.ammo, 0)).join(' / ')} T` : 'ツール T' }
    const cb = $('#convoyBtn'); cb.textContent = '輸送隊: ' + (sim.convoyGo ? '前進中' : '停止中'); cb.classList.toggle('on', sim.convoyGo);
    $('#detBtn').classList.toggle('on', s.showDet);
    $('#aiBtn').textContent = 'AI指揮: ' + (s.autoAI ? 'ON' : 'OFF') + ' G'; $('#aiBtn').classList.toggle('on', s.autoAI);
  }

  private updateDetail() {
    const s = this.s!, sim = s.sim, us = s.selUnits(), d = $('#detail');
    if (us.length === 1) {
      const u = us[0], sq = u.squad, w = u.weapon!, sy = u.systems!, h = u.health!;
      const broken = (['fcs', 'legs', 'sensor'] as SubsystemKey[]).filter(k => sy[k]);
      d.innerHTML = `<b>${String(sq.no).padStart(2, '0')} ${sq.pilot}</b>　${CHASSIS[sq.cfg.chassis].name} / ${w.def.name} / ${EQUIP[sq.cfg.equip].name}<br>HP <b class="num">${Math.ceil(h.hp)}/${h.maxHp}</b>　装甲 ${h.armor}　速度 ${u.mover!.speed}<br>視界 ${sim.effSensor(u).toFixed(1)}　射程 ${sim.rangeOf(u)}　姿勢 ${STANCES[sq.stance]}${u.toolbelt ? `<br>ツール ${TOOLS[u.toolbelt.tool].name} ×${u.toolbelt.ammo}${u.toolbelt.pending ? '（使用に向かう）' : ''}` : ''}<br>移動 ${MMODES[sq.mmode].name}　弾 ${AMMO[w.ammoType].tag}（徹甲${w.ap}・榴弾${w.he}）${sq.hidden ? '　<b>隠蔽中</b>' : ''}${broken.length ? '<br><span style="color:#ffb38f">損傷：' + broken.map(k => SYSN[k]).join('・') + '（修理機の近くで回復）</span>' : ''}${u.stealth ? (u.stealth.revealT > 0 ? '　<span style="color:#e4643c">ステルス露見</span>' : '　ステルス') : ''}${sim.inForest(u) ? '　森林内' : ''}`;
    } else if (us.length) d.innerHTML = `<b>${us.length} 機選択中</b><br>地面を右クリックで移動、敵を右クリックで集中攻撃。`;
    else d.innerHTML = '<span style="color:#86949a">機体未選択。カードかマップ上の味方をクリック。</span>';
  }

  private inspect() {
    const el = $('#insp'), s = this.s, w = this.hover;
    if (!s || !w) { el.hidden = true; return }
    const sim = s.sim, X = Math.floor(w.x), Y = Math.floor(w.y);
    if (X < 0 || Y < 0 || X >= N || Y >= N) { el.hidden = true; return }
    const i = Y * N + X, ti = TERR[sim.map.grid[i]];
    const vis = sim.vis[i] ? '<span class="ok">視界内</span>' : sim.explored[i] ? '<span class="gd">探索済（敵は見えない）</span>' : '<span class="ng">未探索</span>';
    let h = `<h4>${ti.name}<small>X${X} Y${Y}</small></h4><div>${ti.fx}</div><div class="row"><span>状態</span><span>${vis}</span></div>`;
    for (const c of sim.clouds) if (Math.hypot(w.x - c.x, w.y - c.y) <= c.r) h += `<div class="row"><span>効果</span><span class="gd">${TOOLS[c.k === 'jam' ? 'jammer' : c.k].name}（残り${Math.ceil(c.t)}秒）</span></div>`;
    for (const z of sim.zones) if (Math.hypot(w.x - z.x, w.y - z.y) <= z.r) h += `<div class="row"><span>区域</span><span class="gd">${z.label}</span></div>`;
    const u = this.hoverUnit && this.hoverUnit.life.alive ? this.hoverUnit : null;
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    if (u && u.health) {
      const hp = u.health, pct = Math.ceil(hp.hp / hp.maxHp * 100); h += '<div class="sec">';
      if (u.team === 'E') {
        h += `<h4><span class="E">${u.name}${u.structure?.label ? ' ' + u.structure.label : ''}</span><small>敵</small></h4><div class="row"><span>HP</span><span class="num">${Math.ceil(hp.hp)}/${hp.maxHp}（${pct}%）</span></div><div class="row"><span>装甲</span><span>${hp.armor}</span></div>`;
        h += `<div class="row"><span>武装</span><span>${u.weapon ? u.weapon.def.name + '　射程' + sim.rangeOf(u) : 'なし'}</span></div><div class="row"><span>視界</span><span>${sim.effSensor(u).toFixed(1)}</span></div>`;
        const ref = s.selUnits()[0];
        if (ref) { const r = sim.detRange(u, ref), d = dist(u.pos, ref.pos); h += `<div class="row"><span>${ref.squad.pilot}機を見つける距離</span><span class="${r >= 0 && d <= r ? 'ng' : d - r < 1.5 ? 'gd' : 'ok'}">${r < 0 ? '探知不可' : r.toFixed(1)}（今${d.toFixed(1)}）</span></div>` }
        if (u.enemyAI) h += `<div class="row"><span>行動</span><span>${ESTATE[u.enemyAI.state] || '—'}</span></div>`;
        if (u.structure?.kind === 'site') h += `<div class="row"><span>特定</span><span>${u.structure.scanned ? '<span class="ok">完了</span>' : Math.floor(u.structure.scan * 100) + '%'}</span></div>`;
        if (u.structure?.kind === 'radar') h += '<div>探知すると広範囲の敵を呼び寄せる。チャフの中の機体は探知できない</div>';
        if (u.toolbelt?.tool === 'missile') h += `<div class="row"><span>ミサイル</span><span class="${u.toolbelt.ammo ? 'ng' : ''}">残 ${u.toolbelt.ammo} 発</span></div>`;
        const ms = s.selUnits().filter(x => x.toolbelt?.tool === 'missile' && x.toolbelt.ammo > 0);
        if (ms.length) { const ok = ms.some(x => sim.canLock(x, u)); h += `<div class="row"><span>ミサイルのロック</span><span class="${ok ? 'ok' : 'gd'}">${ok ? '可能' : sim.inCloud('chaff', u.pos) ? '不可（チャフ）' : dist(ms[0].pos, u.pos) > TOOLS.missile.range! ? '射程外' : '不可（視界・レーダー不足）'}</span></div>` }
      } else if (u.truck) h += `<h4><span class="P">${u.name}</span><small>護衛対象</small></h4><div class="row"><span>HP</span><span class="num">${Math.ceil(hp.hp)}/${hp.maxHp}</span></div><div class="row"><span>状態</span><span>${u.truck.hold ? '停止' : '前進'}</span></div>`;
      else if (u.squad) {
        const sq = u.squad, ex = u.exposure!;
        h += `<h4><span class="P">${String(sq.no).padStart(2, '0')} ${sq.pilot}</span><small>${CHASSIS[sq.cfg.chassis].name}</small></h4><div class="row"><span>HP</span><span class="num">${Math.ceil(hp.hp)}/${hp.maxHp}（${pct}%）</span></div><div class="row"><span>武装</span><span>${u.weapon!.def.name}　射程${sim.rangeOf(u)}</span></div><div class="row"><span>装備</span><span>${EQUIP[sq.cfg.equip].name}</span></div><div class="row"><span>姿勢</span><span${sq.stance === 'nofire' ? ' class="gd"' : ''}>${STANCES[sq.stance]}</span></div><div class="row"><span>状態</span><span>${this.stateText(u)}${sim.detP.has(u.id) ? '　<span class="ng">被発見</span>' : ''}</span></div><div class="row"><span>見つかりにくさ</span><span>×${sim.detMul(u).toFixed(2)}${u.sensor?.emit ? ' ＋' + u.sensor.emit + '（レーダー）' : ''}${u.stealth && u.stealth.revealT > 0 ? ' <span class="ng">発砲で露見</span>' : ''}</span></div>${ex.warnBy != null && ex.margin < 99 ? `<div class="row"><span>最寄りの警戒圏まで</span><span class="${ex.margin <= 0 ? 'ng' : ex.margin < 1.5 ? 'gd' : 'ok'}">${ex.margin <= 0 ? '圏内' : ex.margin.toFixed(1)}</span></div>` : ''}`;
      } else if (u.ephemeral) h += `<h4><span class="P">${u.name}</span><small>残り${Math.ceil(u.ephemeral.ttl)}秒</small></h4><div class="row"><span>HP</span><span class="num">${Math.ceil(hp.hp)}/${hp.maxHp}</span></div>`;
      h += '</div>';
    }
    const ws = s.selUnits().filter(x => x.weapon);
    if (ws.length && (!u || u.team !== 'P')) {
      const tp = u ? u.pos : w; h += '<div class="sec">';
      for (const x of ws.slice(0, 4)) {
        const d = dist(x.pos, tp), r = sim.rangeOf(x), mn = x.weapon!.def.min || 0;
        const st = d < mn ? '<span class="ng">近すぎ</span>' : d <= r ? '<span class="ok">射程内</span>' : `<span class="gd">あと${(d - r).toFixed(1)}</span>`;
        h += `<div class="row"><span>${x.squad.no} ${x.squad.pilot}　距離${d.toFixed(1)}</span><span>${st}</span></div>`;
      }
      if (ws.length > 4) h += `<div style="color:var(--faint)">ほか ${ws.length - 4} 機</div>`;
      h += '</div>';
    }
    el.innerHTML = h; el.hidden = false;
  }

  // ---------------------------------------------------------------- minimap
  private buildMiniTerrain() {
    const s = this.s!, c = document.createElement('canvas'); c.width = 240; c.height = 120;
    const g = c.getContext('2d')!, sx = c.width / WPX, sy = c.height / HPX;
    for (let d = 0; d < 2 * N - 1; d++) for (let x = 0; x < N; x++) {
      const y = d - x; if (y < 0 || y >= N || !s.sim.map.inside(x, y)) continue;
      const t = s.sim.map.grid[y * N + x], hgt = tileH(t);
      g.fillStyle = css(shade(TCOL[t], 1)); g.beginPath();
      for (const [a, b] of [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]]) { const [px, py] = w2p(a, b); g.lineTo(px * sx, (py - hgt) * sy) }
      g.closePath(); g.fill();
    }
    return c;
  }
  private drawMini() {
    const s = this.s!, sim = s.sim, cv = $<HTMLCanvasElement>('#mini'), g = cv.getContext('2d')!, w = cv.width, h = cv.height, sx = w / WPX, sy = h / HPX;
    g.fillStyle = '#0a0f13'; g.fillRect(0, 0, w, h); if (this.miniTerrain) g.drawImage(this.miniTerrain, 0, 0);
    g.fillStyle = 'rgba(8,12,16,.55)';
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { if (sim.explored[y * N + x]) continue; const [px, py] = w2p(x + .5, y + .5); g.fillRect(px * sx - 2.5, py * sy - 1.3, 5, 2.6) }
    for (const z of sim.zones) { if (z.kind === 'hint') continue; const [px, py] = w2p(z.x, z.y); g.strokeStyle = '#e2b84a'; g.beginPath(); g.ellipse(px * sx, py * sy, z.r * 64 * .7 * sx, z.r * 32 * .7 * sy, 0, 0, 7); g.stroke() }
    for (const u of sim.world.all()) {
      if (!u.life.alive || !u.health) continue;
      if (u.team === 'E' && !sim.seenE.has(u.id) && !(s.replay && s.reveal)) continue;
      const [px, py] = w2p(u.pos.x, u.pos.y);
      g.fillStyle = u.team === 'P' ? (u.truck ? '#d8c690' : '#5fb0e0') : '#e4643c'; const z = u.structure ? 5 : 4; g.fillRect(px * sx - 2, py * sy - 2, z, z);
    }
    const v = this.cb.view(); g.strokeStyle = '#e8f4ff'; g.lineWidth = 1; g.strokeRect(v.x * sx, v.y * sy, v.width * sx, v.height * sy);
  }

  // ---------------------------------------------------------------- result
  showResult() {
    const s = this.s!, sim = s.sim, r = sim.over!, m = sim.m;
    const alive = sim.countP() + sim.extracted, total = sim.squad.length;
    let score = 0, rank = '—';
    if (r.win) { score = 1000 + alive * 120 - sim.lost * 150 + sim.kills * 20 + (m.limit ? Math.floor((m.limit - sim.time) * 2) : Math.max(0, Math.floor(600 - sim.time))); rank = score >= 1700 ? 'S' : score >= 1400 ? 'A' : score >= 1100 ? 'B' : 'C' }
    const res = $('#result');
    res.innerHTML = `<div class="rpanel">${s.replay ? '<div class="rpchip">REPLAY</div>' : ''}${r.win ? `<div class="rank">${rank}</div>` : ''}<h2 class="${r.win ? 'win' : 'lose'}">${r.win ? 'MISSION COMPLETE' : 'MISSION FAILED'}</h2>
     <p>${r.reason}</p><dl><dt>作戦</dt><dd>${m.code} ${m.name}</dd><dt>経過時間</dt><dd>${fmtT(sim.time)}</dd><dt>撃破</dt><dd>${sim.kills}</dd><dt>損失</dt><dd>${sim.lost} / ${total}</dd>${r.win ? `<dt>スコア</dt><dd>${score}</dd>` : ''}</dl>
     ${r.win && m.medals ? `<div class="rmedals">${m.medals.map((md, i) => `<div class="${r.medals?.[i] ? 'got' : ''}"><i>${r.medals?.[i] ? '●' : '○'}</i> <b>${md.name}</b>　<small>${md.desc}</small></div>`).join('')}</div>` : ''}
     <div class="rbtns">${s.replay ? '<button class="btn" id="rpAgain">最初から再生</button><button class="btn" id="rHQ">リプレイ終了</button>' : '<button class="btn" id="rWatch">リプレイを見る</button><button class="btn" id="rRetry">同じ編成で再出撃</button><button class="btn" id="rHQ">編成に戻る</button>'}</div></div>`;
    res.hidden = false;
    res.querySelector<HTMLElement>('#rHQ')!.onclick = () => this.cb.toHQ();
    res.querySelector<HTMLElement>('#rWatch')?.addEventListener('click', () => this.cb.watch());
    res.querySelector<HTMLElement>('#rRetry')?.addEventListener('click', () => this.cb.retry());
    res.querySelector<HTMLElement>('#rpAgain')?.addEventListener('click', () => this.cb.replayAgain());
    this.update();
  }
}
