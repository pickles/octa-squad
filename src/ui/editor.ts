// Scenario editor: briefing form, a top-down tile painter and object placement.
// Everything edits one ScenarioDef (plain JSON); saving registers it as a playable mission.
import { ETYPES, VICTORY_NAMES, blankScenario, validateScenario } from '../core';
import type { EType, ScenarioDef, ScenarioGroup, StructType, VictoryKind } from '../core';
import type { GroupRole } from '../core/ecs';
import { deleteScenario, loadScenarios, saveScenario } from './store';

const $ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const CELL = 22;

const TERRAIN: [string, string, string][] = [['.', '平地', '#4a5a3e'], ['F', '森', '#2c4a30'], ['H', '丘', '#7a6a48'], ['#', '岩', '#4f555a'], ['~', '水', '#2e5670'], ['=', '道', '#9a8a62']];
const TCOL: Record<string, string> = Object.fromEntries(TERRAIN.map(([c, , col]) => [c, col]));
const UNIT_TYPES = (Object.keys(ETYPES) as EType[]).filter(k => !ETYPES[k].structure);
const STRUCTS: [StructType, string, string][] = [['turret', '砲台', 'T'], ['radar', 'レーダー塔', 'R'], ['hq', '司令塔', 'H'], ['site', '野営地', 'S']];
const ROLES: [GroupRole, string][] = [['garrison', '守備隊（持ち場の近くだけ）'], ['patrol', '巡回隊（巡回路を回る・12マス以内に応援）'], ['reserve', '予備隊（どこへでも応援）'], ['overwatch', '観測・支援（動かない）'], ['hunt', '追撃隊（最初から部隊を探して来る）']];
const TYPES = ['殲滅', '強襲', '索敵', '護衛', '離脱'] as const;

type Tool = string; // 'terrain:.' | 'spawn' | 'goal' | 'lz' | 'group' | 'struct:turret' | 'mine' | 'road' | 'patrol' | 'reinf' | 'select' | 'erase'
type Sel = { k: 'group' | 'struct' | 'reinf'; i: number } | null;

export interface EditorCallbacks { close(): void; testPlay(sc: ScenarioDef): void }

export class Editor {
  sc: ScenarioDef = blankScenario();
  private tool: Tool = 'terrain:F';
  private brush = 1;
  private sel: Sel = null;
  private drag: { moving: boolean } | null = null;
  private cv!: HTMLCanvasElement;

  constructor(private root: HTMLElement, private cb: EditorCallbacks) {}

  open(sc?: ScenarioDef) {
    if (sc) this.sc = JSON.parse(JSON.stringify(sc));
    this.sel = null; this.render();
  }

  // ---------------------------------------------------------------- layout
  private render() {
    const sc = this.sc;
    const saved = loadScenarios();
    this.root.innerHTML = `
    <div class="ed-top">
      <h2 class="lbl">Scenario Editor<b>シナリオエディタ</b></h2>
      <div class="ed-btns">
        <select id="edLoad"><option value="">保存済みを開く…</option>${saved.map(s => `<option value="${esc(s.id)}"${s.id === sc.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
        <button class="btn" id="edNew">新規</button><button class="btn" id="edSave">保存</button><button class="btn" id="edDel">削除</button>
        <button class="btn" id="edJson">JSON</button><button class="btn primary" id="edPlay">テストプレイ</button><button class="btn" id="edClose">閉じる</button>
      </div>
    </div>
    <div id="edMsg"></div>
    <div class="ed-grid">
      <div class="ed-col">
        <h3>ブリーフィング</h3>
        ${this.field('name', 'ミッション名')}
        <label>種別<select data-f="type">${TYPES.map(t => `<option${t === sc.type ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        ${this.field('brief', '説明', true)}${this.field('win', '勝利条件（表示用）')}${this.field('lose', '敗北条件（表示用）')}
        <div class="ed-row">${this.num('max', '出撃枠', 1, 8)}${this.num('budget', '予算', 300, 9999, 50)}</div>
        <div class="ed-row">${this.num('limit', '制限時間（秒・0=なし）', 0, 3600, 10)}${this.num('arty', '砲撃支援', 0, 9)}</div>
        ${this.field('hint', '助言', true)}
        <h3>勝敗の判定</h3>
        <label>勝利条件<select id="edVic">${(Object.keys(VICTORY_NAMES) as VictoryKind[]).map(k => `<option value="${k}"${k === sc.victory.kind ? ' selected' : ''}>${VICTORY_NAMES[k]}</option>`).join('')}</select></label>
        <div class="ed-row"><label>必要数<input type="number" id="edNeed" min="1" max="8" value="${sc.victory.need ?? ''}" placeholder="自動"></label>
        <label>回収までの秒数<input type="number" id="edWait" min="5" max="300" value="${sc.victory.wait ?? 30}"></label></div>
        <p class="ed-note">${this.vicNote()}</p>
        <h3>マップ</h3>
        <div class="ed-row"><label>幅<input type="number" id="edW" min="8" max="28" value="${sc.w}"></label><label>高さ<input type="number" id="edH" min="8" max="28" value="${sc.h}"></label></div>
        <div class="ed-row"><label>初期エリア半径<input type="number" id="edSR" min="1" max="6" step="0.5" value="${sc.spawn.r}"></label>
        <label>地点の半径<input type="number" id="edZR" min="1" max="5" step="0.5" value="${(sc.goal ?? sc.lz)?.r ?? 1.8}"></label></div>
        ${sc.convoy ? `<label>輸送車の台数<input type="number" id="edTrucks" min="1" max="5" value="${sc.convoy.trucks}"></label>` : ''}
      </div>
      <div class="ed-map">
        <div class="ed-tools">${this.tools()}</div>
        <canvas id="edCv" width="${sc.w * CELL}" height="${sc.h * CELL}"></canvas>
        <p class="ed-note" id="edHelp">${this.toolHelp()}</p>
      </div>
      <div class="ed-col">
        <div id="edSel">${this.selPanel()}</div>
        <h3>イベント（表示中は時間が止まる）</h3>
        <div id="edEvents">${sc.events.map((e, i) => `<div class="ed-ev"><input type="number" data-ev="${i}" data-k="t" value="${e.t}" min="0"><span>秒</span><textarea data-ev="${i}" data-k="text" rows="2">${esc(e.text)}</textarea><button class="ed-x" data-evdel="${i}">×</button></div>`).join('')}</div>
        <button class="btn" id="edEvAdd">＋ イベント</button>
        <h3>一覧</h3>
        <div class="ed-list">${this.listHtml()}</div>
      </div>
    </div>
    <details class="help" id="edJsonBox"><summary>JSON（共有・バックアップ用）</summary><textarea id="edJsonTxt" rows="6"></textarea><button class="btn" id="edJsonLoad">この内容を読み込む</button></details>`;
    this.cv = $('#edCv', this.root) as HTMLCanvasElement;
    this.bind(); this.draw(); this.showProblems();
  }

  private field(k: keyof ScenarioDef, label: string, area = false) {
    const v = esc(String(this.sc[k] ?? ''));
    return `<label>${label}${area ? `<textarea data-f="${k}" rows="3">${v}</textarea>` : `<input data-f="${k}" value="${v}">`}</label>`;
  }
  private num(k: keyof ScenarioDef, label: string, min: number, max: number, step = 1) {
    return `<label>${label}<input type="number" data-n="${k}" min="${min}" max="${max}" step="${step}" value="${this.sc[k]}"></label>`;
  }
  private tools() {
    const b = (t: Tool, label: string, color?: string) => `<button class="ed-tool${this.tool === t ? ' on' : ''}" data-tool="${t}">${color ? `<i style="background:${color}"></i>` : ''}${label}</button>`;
    return `<div class="ed-tg"><span>地形</span>${TERRAIN.map(([c, n, col]) => b('terrain:' + c, n, col)).join('')}<select id="edBrush">${[1, 2, 3].map(n => `<option value="${n}"${n === this.brush ? ' selected' : ''}>筆 ${n}</option>`).join('')}</select></div>
      <div class="ed-tg"><span>配置</span>${b('spawn', '初期エリア')}${b('goal', '目標地点')}${b('lz', '回収地点')}${b('group', '敵部隊')}${STRUCTS.map(([t, n]) => b('struct:' + t, n)).join('')}${b('mine', '地雷')}${b('road', '輸送路')}${b('reinf', '増援')}</div>
      <div class="ed-tg"><span>編集</span>${b('select', '選択・移動')}${b('patrol', '巡回路')}${b('erase', '消去')}</div>`;
  }
  private toolHelp() {
    const t = this.tool;
    if (t.startsWith('terrain:')) return 'ドラッグで塗る。';
    return ({
      spawn: 'クリックで初期エリア（出撃位置）の中心を置く。', goal: 'クリックで目標地点を置く（勝利条件「到達」用）。', lz: 'クリックで回収地点を置く（「回収」「索敵」用）。',
      group: 'クリックで敵部隊を置く。右の欄で機種・AI・持ち場の半径を設定。', mine: 'クリックで地雷を置く／外す（敵の地雷）。',
      road: 'クリックで輸送路の点を順に追加、右クリックで最後の点を消す。最初の点に輸送車が並ぶ。', reinf: 'クリックで増援の出現地点を置く。右の欄で時刻と機種を設定。',
      select: 'クリックで選択、ドラッグで移動。', patrol: '選択中の敵部隊の巡回路：クリックで点を追加、右クリックで最後の点を消す。', erase: 'クリックでそのマスの物を消す。',
    } as Record<string, string>)[t] || (t.startsWith('struct:') ? 'クリックで建造物を置く。「目標」にすると破壊が勝利条件になる。' : '');
  }
  private vicNote() {
    return ({
      annihilate: '建造物も含めて敵が全滅したら勝ち。', objectives: '「目標」にチェックした建造物をすべて壊したら勝ち。', reach: '目標地点に「必要数」の機体が入ったら勝ち。',
      extract: '回収地点に入ると回収を要請。指定秒数後に地点内にいた機体が回収され、「必要数」に届けば勝ち。', escort: '輸送路の終点に輸送車が「必要数」着けば勝ち（戦闘中に輸送隊の前進・停止を指示）。',
      survive: '制限時間まで1機でも残れば勝ち。', recon: 'すべての野営地を2秒視界に入れ、回収地点に戻れば勝ち。',
    } as Record<VictoryKind, string>)[this.sc.victory.kind];
  }
  private selPanel() {
    const s = this.sel, sc = this.sc;
    if (!s) return '<h3>選択中</h3><p class="ed-note">「選択・移動」で地図上の敵部隊・建造物・増援をクリック。</p>';
    const typesEd = (types: EType[], k: string) => `<div class="ed-types">${types.map((t, i) => `<span>${ETYPES[t].name}<button class="ed-x" data-tdel="${k}:${i}">×</button></span>`).join('')}<select data-tadd="${k}"><option value="">＋ 機種を追加</option>${UNIT_TYPES.map(t => `<option value="${t}">${ETYPES[t].name}</option>`).join('')}</select></div>`;
    if (s.k === 'group') {
      const g = sc.groups[s.i];
      return `<h3>敵部隊 ${s.i + 1}</h3>${typesEd(g.types, 'g')}
      <label>AI<select data-g="role">${ROLES.map(([r, n]) => `<option value="${r}"${r === g.role ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <div class="ed-row"><label>持ち場の半径<input type="number" data-g="leash" min="1" max="20" value="${g.leash ?? 6}"></label></div>
      <label class="ck"><input type="checkbox" data-g="ambush"${g.ambush ? ' checked' : ''}> 伏兵（近づくまで隠れて待つ）</label>
      <label class="ck"><input type="checkbox" data-g="deaf"${g.deaf ? ' checked' : ''}> 無線で呼ばれても応援に行かない</label>
      <p class="ed-note">巡回路：${g.patrol?.length ?? 0} 点（「巡回路」ツールで追加）${g.patrol?.length ? ' <button class="btn" id="edPClr">巡回路を消す</button>' : ''}</p>
      <button class="btn" id="edSelDel">この部隊を消す</button>`;
    }
    if (s.k === 'struct') {
      const st = sc.structures[s.i];
      return `<h3>建造物 ${s.i + 1}</h3><label>種類<select data-st="type">${STRUCTS.map(([t, n]) => `<option value="${t}"${t === st.type ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="ck"><input type="checkbox" data-st="objective"${st.objective ? ' checked' : ''}> 目標（破壊が勝利条件）</label><button class="btn" id="edSelDel">消す</button>`;
    }
    const r = sc.reinforcements[s.i];
    return `<h3>増援 ${s.i + 1}</h3><div class="ed-row"><label>出現（秒）<input type="number" data-r="t" min="0" value="${r.t}"></label><label>隊数<input type="number" data-r="count" min="1" max="4" value="${r.count}"></label></div>
      ${typesEd(r.types, 'r')}<label>AI<select data-r="role">${ROLES.map(([k, n]) => `<option value="${k}"${k === r.role ? ' selected' : ''}>${n}</option>`).join('')}</select></label><button class="btn" id="edSelDel">消す</button>`;
  }
  private listHtml() {
    const sc = this.sc, row = (k: string, i: number, txt: string) => `<button class="ed-li${this.sel && this.sel.k === k && this.sel.i === i ? ' on' : ''}" data-pick="${k}:${i}">${txt}</button>`;
    return [
      ...sc.groups.map((g, i) => row('group', i, `部隊${i + 1}　${g.types.map(t => ETYPES[t].name).join('・') || '（空）'}　<small>${ROLES.find(r => r[0] === g.role)![1].split('（')[0]}</small>`)),
      ...sc.structures.map((s, i) => row('struct', i, `${STRUCTS.find(x => x[0] === s.type)![1]}${s.objective ? '（目標）' : ''}`)),
      ...sc.reinforcements.map((r, i) => row('reinf', i, `増援${i + 1}　${r.t}秒　${r.types.map(t => ETYPES[t].name).join('・')}×${r.count}`)),
    ].join('') || '<p class="ed-note">まだ何も置いていません。</p>';
  }
  private msg(t: string, bad = false) { const m = $('#edMsg', this.root); m.textContent = t; m.className = bad ? 'bad' : 'ok' }
  private showProblems() { const p = validateScenario(this.sc); const m = $('#edMsg', this.root); m.className = p.length ? 'bad' : ''; m.textContent = p.length ? '要確認：' + p.join('／') : '' }

  // ---------------------------------------------------------------- events
  private bind() {
    const R = this.root, sc = this.sc;
    R.querySelectorAll<HTMLInputElement>('[data-f]').forEach(el => el.oninput = () => { (sc as unknown as Record<string, string>)[el.dataset.f!] = el.value; if (el.dataset.f === 'name') this.refreshLists() });
    R.querySelectorAll<HTMLInputElement>('[data-n]').forEach(el => el.oninput = () => { (sc as unknown as Record<string, number>)[el.dataset.n!] = Math.max(+el.min, Math.min(+el.max, +el.value || 0)); this.showProblems() });
    ($('#edVic', R) as HTMLSelectElement).onchange = e => { sc.victory.kind = (e.target as HTMLSelectElement).value as VictoryKind; if (sc.victory.kind === 'escort' && !sc.convoy) sc.convoy = { path: [], trucks: 3 }; this.render() };
    ($('#edNeed', R) as HTMLInputElement).oninput = e => { const v = +(e.target as HTMLInputElement).value; sc.victory.need = v > 0 ? v : undefined };
    ($('#edWait', R) as HTMLInputElement).oninput = e => { sc.victory.wait = +(e.target as HTMLInputElement).value || 30 };
    ($('#edSR', R) as HTMLInputElement).oninput = e => { sc.spawn.r = +(e.target as HTMLInputElement).value || 2.5; this.draw() };
    ($('#edZR', R) as HTMLInputElement).oninput = e => { const r = +(e.target as HTMLInputElement).value || 1.8; if (sc.goal) sc.goal.r = r; if (sc.lz) sc.lz.r = r; this.draw() };
    const tr = $('#edTrucks', R) as HTMLInputElement | null; if (tr) tr.oninput = () => { sc.convoy!.trucks = Math.max(1, Math.min(5, +tr.value || 1)) };
    const resize = () => {
      const w = Math.max(8, Math.min(28, +($('#edW', R) as HTMLInputElement).value || sc.w)), h = Math.max(8, Math.min(28, +($('#edH', R) as HTMLInputElement).value || sc.h));
      sc.tiles = Array.from({ length: h }, (_, y) => (sc.tiles[y] ?? '').padEnd(w, '.').slice(0, w)); sc.w = w; sc.h = h; this.render();
    };
    ($('#edW', R) as HTMLInputElement).onchange = resize; ($('#edH', R) as HTMLInputElement).onchange = resize;
    R.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b => b.onclick = () => { this.tool = b.dataset.tool!; R.querySelectorAll('.ed-tool').forEach(x => x.classList.toggle('on', x === b)); $('#edHelp', R).textContent = this.toolHelp() });
    ($('#edBrush', R) as HTMLSelectElement).onchange = e => { this.brush = +(e.target as HTMLSelectElement).value };
    // events
    R.querySelectorAll<HTMLInputElement>('[data-ev]').forEach(el => el.oninput = () => { const e = sc.events[+el.dataset.ev!]; if (el.dataset.k === 't') e.t = Math.max(0, +el.value || 0); else e.text = el.value });
    R.querySelectorAll<HTMLButtonElement>('[data-evdel]').forEach(b => b.onclick = () => { sc.events.splice(+b.dataset.evdel!, 1); this.render() });
    $('#edEvAdd', R).onclick = () => { sc.events.push({ t: sc.events.length ? sc.events[sc.events.length - 1].t + 30 : 3, text: '' }); this.render() };
    // list & selection panel
    R.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach(b => b.onclick = () => { const [k, i] = b.dataset.pick!.split(':'); this.sel = { k: k as 'group', i: +i }; this.render() });
    this.bindSel();
    // top buttons
    ($('#edLoad', R) as HTMLSelectElement).onchange = e => { const id = (e.target as HTMLSelectElement).value; const s = loadScenarios().find(x => x.id === id); if (s) this.open(s) };
    $('#edNew', R).onclick = () => this.open(blankScenario());
    $('#edSave', R).onclick = () => { saveScenario(this.sc); this.render(); this.msg(`「${this.sc.name}」を保存した。作戦一覧の「カスタム」から遊べる。`) };
    $('#edDel', R).onclick = () => { if (!loadScenarios().some(x => x.id === sc.id)) { this.msg('まだ保存されていません', true); return } deleteScenario(sc.id); this.open(blankScenario()); this.msg('削除した') };
    $('#edClose', R).onclick = () => this.cb.close();
    $('#edPlay', R).onclick = () => { const p = validateScenario(sc); if (p.length) { this.msg('テストプレイできません：' + p.join('／'), true); return } saveScenario(sc); this.cb.testPlay(sc) };
    $('#edJson', R).onclick = () => { ($('#edJsonBox', R) as HTMLDetailsElement).open = true; ($('#edJsonTxt', R) as HTMLTextAreaElement).value = JSON.stringify(sc) };
    $('#edJsonLoad', R).onclick = () => {
      try { const s = JSON.parse(($('#edJsonTxt', R) as HTMLTextAreaElement).value); if (s?.v !== 1 || !Array.isArray(s.tiles)) throw new Error('形式が違います'); this.open(s); this.msg('読み込んだ（保存はまだ）') }
      catch (err) { this.msg('読み込めません：' + (err as Error).message, true) }
    };
    // canvas
    const cv = this.cv;
    cv.oncontextmenu = e => e.preventDefault();
    cv.onpointerdown = e => { cv.setPointerCapture(e.pointerId); this.drag = { moving: false }; this.act(e, true) };
    cv.onpointermove = e => { if (this.drag && (this.tool.startsWith('terrain:') || this.tool === 'select')) { this.drag.moving = true; this.act(e, false) } };
    cv.onpointerup = () => { if (this.drag) { this.drag = null; this.render() } };
  }
  private bindSel() {
    const R = this.root, sc = this.sc, s = this.sel; if (!s) return;
    const target = s.k === 'group' ? sc.groups[s.i] : s.k === 'reinf' ? sc.reinforcements[s.i] : null;
    R.querySelectorAll<HTMLSelectElement>('[data-tadd]').forEach(el => el.onchange = () => { if (el.value && target && target.types.length < 6) { target.types.push(el.value as EType); this.render() } });
    R.querySelectorAll<HTMLButtonElement>('[data-tdel]').forEach(b => b.onclick = () => { const i = +b.dataset.tdel!.split(':')[1]; target?.types.splice(i, 1); this.render() });
    R.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-g]').forEach(el => el.onchange = () => { const g = sc.groups[s.i] as unknown as Record<string, unknown>, k = el.dataset.g!; g[k] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : k === 'leash' ? +el.value : el.value; this.render() });
    R.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-st]').forEach(el => el.onchange = () => { const st = sc.structures[s.i] as unknown as Record<string, unknown>; st[el.dataset.st!] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value; this.render() });
    R.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-r]').forEach(el => el.onchange = () => { const r = sc.reinforcements[s.i] as unknown as Record<string, unknown>, k = el.dataset.r!; r[k] = k === 'role' ? el.value : Math.max(0, +el.value || 0); this.render() });
    const pc = $('#edPClr', R); if (pc) pc.onclick = () => { sc.groups[s.i].patrol = []; this.render() };
    const del = $('#edSelDel', R); if (del) del.onclick = () => { (s.k === 'group' ? sc.groups : s.k === 'struct' ? sc.structures : sc.reinforcements).splice(s.i, 1); this.sel = null; this.render() };
  }
  private refreshLists() { const l = this.root.querySelector('.ed-list'); if (l) l.innerHTML = this.listHtml() }

  // ---------------------------------------------------------------- map interaction
  private act(e: PointerEvent, down: boolean) {
    const r = this.cv.getBoundingClientRect(), sc = this.sc;
    const fx = (e.clientX - r.left) / r.width * sc.w, fy = (e.clientY - r.top) / r.height * sc.h;
    const x = Math.floor(fx), y = Math.floor(fy); if (x < 0 || y < 0 || x >= sc.w || y >= sc.h) return;
    const cx = x + .5, cy = y + .5, right = e.button === 2, t = this.tool;
    if (t.startsWith('terrain:')) {
      const ch = t.slice(8), b = this.brush - 1;
      for (let yy = y - b; yy <= y + b; yy++) for (let xx = x - b; xx <= x + b; xx++) {
        if (xx < 0 || yy < 0 || xx >= sc.w || yy >= sc.h || Math.hypot(xx - x, yy - y) > b + .5) continue;
        const row = sc.tiles[yy]; sc.tiles[yy] = row.slice(0, xx) + ch + row.slice(xx + 1);
      }
      this.draw(); return;
    }
    if (t === 'select') {
      if (down) this.sel = this.pick(fx, fy);
      else if (this.sel) { const o = this.selObj(); if (o) { o.x = cx; o.y = cy } }
      this.draw(); return;
    }
    if (!down) return;
    const near = (p: { x: number; y: number }) => Math.hypot(p.x - fx, p.y - fy) < 0.9;
    switch (true) {
      case t === 'spawn': sc.spawn.x = cx; sc.spawn.y = cy; break;
      case t === 'goal': sc.goal = { x: cx, y: cy, r: sc.goal?.r ?? 1.8 }; break;
      case t === 'lz': sc.lz = { x: cx, y: cy, r: sc.lz?.r ?? 2.2 }; break;
      case t === 'group': sc.groups.push({ types: ['trooper', 'trooper'], x: cx, y: cy, role: 'garrison', leash: 6 }); this.sel = { k: 'group', i: sc.groups.length - 1 }; break;
      case t.startsWith('struct:'): sc.structures.push({ type: t.slice(7) as StructType, x: cx, y: cy, objective: t === 'struct:hq' }); this.sel = { k: 'struct', i: sc.structures.length - 1 }; break;
      case t === 'mine': { const i = sc.mines.findIndex(([mx, my]) => Math.floor(mx) === x && Math.floor(my) === y); if (i >= 0) sc.mines.splice(i, 1); else sc.mines.push([cx, cy]); break }
      case t === 'road': { sc.convoy ??= { path: [], trucks: 3 }; if (right) sc.convoy.path.pop(); else sc.convoy.path.push([x, y]); break }
      case t === 'reinf': sc.reinforcements.push({ t: 60, x: cx, y: cy, types: ['trooper', 'gunner'], role: 'hunt', count: 1 }); this.sel = { k: 'reinf', i: sc.reinforcements.length - 1 }; break;
      case t === 'patrol': {
        if (this.sel?.k !== 'group') { this.msg('先に「選択・移動」で敵部隊を選んでください', true); return }
        const g = sc.groups[this.sel.i]; g.patrol ??= []; if (right) g.patrol.pop(); else { if (!g.patrol.length) g.patrol.push([g.x, g.y]); g.patrol.push([cx, cy]) } if (g.role !== 'patrol' && g.patrol.length > 1) g.role = 'patrol'; break;
      }
      case t === 'erase': {
        const gi = sc.groups.findIndex(near); if (gi >= 0) { sc.groups.splice(gi, 1); break }
        const si = sc.structures.findIndex(near); if (si >= 0) { sc.structures.splice(si, 1); break }
        const ri = sc.reinforcements.findIndex(near); if (ri >= 0) { sc.reinforcements.splice(ri, 1); break }
        const mi = sc.mines.findIndex(([mx, my]) => Math.floor(mx) === x && Math.floor(my) === y); if (mi >= 0) { sc.mines.splice(mi, 1); break }
        if (sc.goal && near(sc.goal)) { sc.goal = undefined; break }
        if (sc.lz && near(sc.lz)) { sc.lz = undefined; break }
        this.sel = null; break;
      }
    }
    this.render();
  }
  private pick(fx: number, fy: number): Sel {
    const sc = this.sc, d = (p: { x: number; y: number }) => Math.hypot(p.x - fx, p.y - fy);
    const c: [Sel, number][] = [...sc.groups.map((g, i) => [{ k: 'group', i }, d(g)] as [Sel, number]), ...sc.structures.map((g, i) => [{ k: 'struct', i }, d(g)] as [Sel, number]), ...sc.reinforcements.map((g, i) => [{ k: 'reinf', i }, d(g)] as [Sel, number])];
    const best = c.filter(([, dd]) => dd < 1.2).sort((a, b) => a[1] - b[1])[0];
    return best ? best[0] : null;
  }
  private selObj(): { x: number; y: number } | null {
    const s = this.sel, sc = this.sc; if (!s) return null;
    return s.k === 'group' ? sc.groups[s.i] : s.k === 'struct' ? sc.structures[s.i] : sc.reinforcements[s.i];
  }

  // ---------------------------------------------------------------- drawing
  private draw() {
    const sc = this.sc, g = this.cv.getContext('2d')!, C = CELL;
    for (let y = 0; y < sc.h; y++) for (let x = 0; x < sc.w; x++) {
      const ch = sc.tiles[y]?.[x] ?? '.'; g.fillStyle = TCOL[ch] ?? '#4a5a3e'; g.fillRect(x * C, y * C, C, C);
      if (ch === 'F') { g.fillStyle = '#1c3322'; g.beginPath(); g.moveTo(x * C + C / 2, y * C + 4); g.lineTo(x * C + C - 5, y * C + C - 5); g.lineTo(x * C + 5, y * C + C - 5); g.fill() }
      if (ch === 'H') { g.strokeStyle = '#a8946a'; g.beginPath(); g.arc(x * C + C / 2, y * C + C, C * .45, Math.PI, 0); g.stroke() }
    }
    g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 1;
    for (let x = 0; x <= sc.w; x++) { g.beginPath(); g.moveTo(x * C + .5, 0); g.lineTo(x * C + .5, sc.h * C); g.stroke() }
    for (let y = 0; y <= sc.h; y++) { g.beginPath(); g.moveTo(0, y * C + .5); g.lineTo(sc.w * C, y * C + .5); g.stroke() }
    const circ = (a: { x: number; y: number; r: number }, col: string, label: string, dash = false) => {
      g.save(); g.strokeStyle = col; g.lineWidth = 2; if (dash) g.setLineDash([5, 4]); g.beginPath(); g.arc(a.x * C, a.y * C, a.r * C, 0, Math.PI * 2); g.stroke(); g.restore();
      g.fillStyle = col; g.font = 'bold 11px sans-serif'; g.textAlign = 'center'; g.fillText(label, a.x * C, a.y * C + 4);
    };
    circ(sc.spawn, '#5fb0e0', '出撃');
    if (sc.goal) circ(sc.goal, '#e2b84a', '目標');
    if (sc.lz) circ(sc.lz, '#e2b84a', '回収', true);
    if (sc.convoy?.path.length) {
      g.strokeStyle = '#e6d7aa'; g.lineWidth = 3; g.beginPath(); sc.convoy.path.forEach(([x, y], i) => i ? g.lineTo(x * C + C / 2, y * C + C / 2) : g.moveTo(x * C + C / 2, y * C + C / 2)); g.stroke();
      sc.convoy.path.forEach(([x, y], i) => { g.fillStyle = i ? '#e6d7aa' : '#5fb0e0'; g.fillRect(x * C + C / 2 - 4, y * C + C / 2 - 4, 8, 8) });
    }
    for (const [mx, my] of sc.mines) { g.strokeStyle = '#e4643c'; g.lineWidth = 2; g.beginPath(); g.moveTo(mx * C - 5, my * C - 5); g.lineTo(mx * C + 5, my * C + 5); g.moveTo(mx * C + 5, my * C - 5); g.lineTo(mx * C - 5, my * C + 5); g.stroke() }
    const isSel = (k: string, i: number) => this.sel && this.sel.k === k && this.sel.i === i;
    sc.groups.forEach((gr: ScenarioGroup, i) => {
      if (gr.patrol && gr.patrol.length > 1) { g.save(); g.setLineDash([4, 3]); g.strokeStyle = '#ffb38f'; g.lineWidth = 1.5; g.beginPath(); gr.patrol.forEach(([x, y], k) => k ? g.lineTo(x * C, y * C) : g.moveTo(x * C, y * C)); g.stroke(); g.restore() }
      if (gr.role === 'garrison') { g.save(); g.strokeStyle = 'rgba(228,100,60,.35)'; g.setLineDash([2, 4]); g.beginPath(); g.arc(gr.x * C, gr.y * C, (gr.leash ?? 6) * C, 0, Math.PI * 2); g.stroke(); g.restore() }
      g.fillStyle = gr.ambush ? '#7a3a2a' : '#c4502e'; g.fillRect(gr.x * C - 9, gr.y * C - 9, 18, 18);
      g.strokeStyle = isSel('group', i) ? '#fff' : '#2a0f08'; g.lineWidth = 2; g.strokeRect(gr.x * C - 9, gr.y * C - 9, 18, 18);
      g.fillStyle = '#fff'; g.font = 'bold 11px sans-serif'; g.textAlign = 'center'; g.fillText(String(gr.types.length), gr.x * C, gr.y * C + 4);
    });
    sc.structures.forEach((st, i) => {
      g.fillStyle = st.objective ? '#e2b84a' : '#8a3a26'; g.beginPath(); g.arc(st.x * C, st.y * C, 9, 0, Math.PI * 2); g.fill();
      g.strokeStyle = isSel('struct', i) ? '#fff' : '#2a0f08'; g.lineWidth = 2; g.stroke();
      g.fillStyle = '#111'; g.font = 'bold 11px sans-serif'; g.textAlign = 'center'; g.fillText(STRUCTS.find(s => s[0] === st.type)![2], st.x * C, st.y * C + 4);
    });
    sc.reinforcements.forEach((r, i) => {
      g.fillStyle = '#e4643c'; g.beginPath(); g.moveTo(r.x * C, r.y * C - 10); g.lineTo(r.x * C + 9, r.y * C + 7); g.lineTo(r.x * C - 9, r.y * C + 7); g.closePath(); g.fill();
      g.strokeStyle = isSel('reinf', i) ? '#fff' : '#2a0f08'; g.lineWidth = 2; g.stroke();
      g.fillStyle = '#fff'; g.font = '10px sans-serif'; g.textAlign = 'center'; g.fillText(`${r.t}s`, r.x * C, r.y * C + 20);
    });
  }
}
