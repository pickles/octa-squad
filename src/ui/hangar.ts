// Operations room / hangar screen (DOM).
import { CHASSIS, DIFFS, EQUIP, MISSIONS, PILOTS, TOOLS, WEAPONS, loadoutStats } from '../core';
import type { Difficulty, Loadout, MissionId, Replay } from '../core';
import { PROGRESS, SAVE, currentMission, deleteReplay, deployOf, isReplay, loadReplays, persist } from './store';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;

export interface HangarCallbacks {
  start(opts: { auto: boolean }): void;
  playReplay(rep: Replay): void;
}

function shapeSVG(shape: string, col: string) {
  const s: Record<string, string> = {
    tri: '<polygon points="12,3 21,20 3,20"/>', sq: '<rect x="4" y="4" width="16" height="16"/>',
    hex: '<polygon points="12,2 21,7 21,17 12,22 3,17 3,7"/>', circ: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M7 12h10" stroke="#07131b" stroke-width="2.4"/>',
  };
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="${col}" stroke="#07131b" stroke-width="1.2" aria-hidden="true">${s[shape]}</svg>`;
}
function roleOf(s: Loadout) {
  const c = s.chassis, w = s.weapon, e = s.equip;
  if (c === 'support') return '【回復役】'; if (w === 'sniper') return '【狙撃役】'; if (c === 'heavy' || e === 'plate') return '【前衛・盾役】';
  if (c === 'light' && (e === 'radar' || e === 'stealth')) return '【偵察役】'; if (s.tool === 'missile') return '【後方火力】'; if (w === 'mg') return '【近接アタッカー】';
  return '【主力】';
}
function opts(obj: Record<string, { name: string; cost: number }>, sel: string) {
  return Object.entries(obj).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${v.name}${v.cost ? '  ' + v.cost : ''}</option>`).join('');
}

export function guideHTML() {
  const row = (o: Record<string, { name: string; desc: string }>, f: (v: any) => string) => Object.values(o).map(v => `<tr><th>${v.name}</th><td class="num">${f(v)}</td><td>${v.desc}</td></tr>`).join('');
  return `<h3>機体</h3><div class="tw"><table>${row(CHASSIS, v => `HP${v.hp} 装甲${v.armor} 速${v.speed} 視界${v.sensor} / ${v.cost}`)}</table></div>
  <h3>武装</h3><div class="tw"><table>${row(WEAPONS, v => `射程${v.range} 威力${v.dmg} 間隔${v.cd}s / ${v.cost}`)}</table></div>
  <h3>装備</h3><div class="tw"><table>${row(EQUIP, v => `${v.cost}`)}</table></div>
  <h3>ツール（弾数制限あり・戦闘中に <kbd>T</kbd> で使用）</h3><div class="tw"><table>${Object.entries(TOOLS).filter(([k]) => k !== 'none').map(([, v]) => `<tr><th>${v.name}</th><td class="num">${v.range ? '射程' + v.range + ' ' : ''}${v.radius ? '半径' + v.radius + ' ' : ''}${v.dur ? v.dur + '秒 ' : ''}×${v.ammo} / ${v.cost}</td><td>${v.desc}</td></tr>`).join('')}</table></div>
  <h3>戦闘中の行動</h3><ul>
   <li><b>移動モード</b>（<kbd>M</kbd>）：<b>通常</b>／<b>高速</b>＝速度1.5倍・視界0.7倍・敵に1.5遠くから見つかる／<b>警戒</b>＝速度0.6倍・視界+1.5・見つかりにくさ×0.85。警戒移動の機体は半径2.5の敵地雷を発見し、隣で止まると2秒で処理する。</li>
   <li><b>隠蔽</b>（<kbd>H</kbd>）：その場で止まり、2秒で隠蔽完了。見つかりにくさ×0.35、自動射撃はしない。移動・攻撃命令で解除。</li>
   <li><b>レーダー</b>（<kbd>Z</kbd>）：レーダー装備の機体はON/OFFを切り替えられる。OFFだと視界ボーナスも電波も無くなる。</li>
   <li><b>弾種</b>（<kbd>R</kbd>）：通常弾（無限）／<b>徹甲弾</b>＝装甲の効果を7割無視／<b>榴弾</b>＝周囲1にも半分、建造物に1.6倍、森の遮蔽を無視。切替に2.5秒。</li>
   <li><b>砲撃支援</b>（<kbd>B</kbd>）：視界内の地点を指定すると8秒後に6発が半径1.3に着弾（1発65、爆風半径1.35）。森の遮蔽は効かない。<b>味方も巻き込む</b>。</li>
   <li><b>ミサイル迎撃</b>：マシンガン装備の機体は、2.2以内を通る敵ミサイルを35%で撃ち落とす。</li>
   <li><b>損傷</b>：大きな被弾で <b>火器管制</b>・<b>脚部</b>・<b>センサー</b>が壊れることがある。修理機の2.5以内で6秒ごとに1つ回復。</li></ul>
  <h3>見つかる仕組み</h3><ul><li>敵がこちらを見つける距離 ＝ 敵の視界 × 見つかりにくさ ＋ レーダーの電波（2.5）。</li><li>見つかりにくさ：ステルス ×0.5、森林 ×0.7、隠蔽 ×0.35、警戒移動 ×0.85、煙幕 ×0.4（煙の中にいる時だけでなく、煙が間に挟まっていても）。</li><li>見えている敵の「警戒圏」を黄色い点線で表示する（<kbd>V</kbd>）。機体左上の <b style="color:#e2b84a">!</b> は警戒圏まで1.5以内、<b style="color:#e4643c">!</b> は発見されている。</li><li><b>発砲炎</b>：撃った機体は2秒間、撃たれた相手から距離に関係なく見える（敵味方とも）。射程外から撃てば撃ち返されはしないが、位置はばれて敵が寄ってくる。煙幕越しなら発砲炎も隠れる。</li><li><b>恨み</b>：撃たれた敵は、一番痛い攻撃をしてきた相手（直近8秒ほど）を狙って進んでくる。手前にヘビィがいても素通りしようとするので、狙撃機を守るなら進路をふさぐこと。</li></ul>
  <h3>敵の動き</h3><ul><li><b>無線</b>：見つけた敵は周囲9マス（レーダー塔の覆域13マス内なら全域）に知らせる。<b>守備隊</b>は持ち場の近くしか助けに来ない。<b>巡回隊</b>は12マス以内、<b>予備隊</b>はどこへでも来る。<b>観測・支援</b>（誘導弾型・迫撃砲型・狙撃型）は動かない。レーダー塔を落とすと連携が切れる。</li>
  <li><b>攻め方</b>：集結してからまとめて来る。機関銃型・重装型が正面で足止めし、突撃型・偵察型が横へ回り込む。煙の中には入ってこない。</li>
  <li><b>引き際</b>：射程外から一方的に撃たれている時や大きく損耗した時は、丘・森へ下がって待ち構える。偵察型は下がりながら地雷を置く（見ていれば位置がわかる）。</li>
  <li><b>誘導弾型</b>：電波を出している機体（レーダーON・デコイ）を射程9から狙う。レーダー塔があれば<b>動いている</b>機体も狙う。自分の視界（5、丘なら6）の中なら何でも狙う。<b>ロックに時間がかかる</b>（見えている相手1.5秒、電波だけなら3秒）。「ロックオン警報」が出たら <kbd>Z</kbd> でレーダーを切るか、チャフ・隠れる。</li>
  <li><b>迫撃砲型</b>：3機以上が固まっている所に撃ち込む。発射音から4秒で着弾するので散開する。</li><li><b>伏兵</b>：森などに伏せて待つ部隊は、撃つか4.5マスまで近づかれるまで0.35倍の距離でしか見えない。照明弾で暴ける。</li><li><b>偵察型</b>はプローブを普通に見つけて壊す。</li></ul>
  <h3>武器と装甲の相性</h3><ul><li>弾1発のダメージ ＝ 威力 − 装甲（最低でも威力の15%）。<b>機関銃</b>（1発6）は軽い機体（装甲1〜3）には強いが、装甲5以上にはほぼ通らない。<b>ライフル</b>（14）はどれにもそこそこ。<b>狙撃砲</b>（40）と<b>徹甲弾</b>は重装甲に有効。</li><li>ミサイル・地雷・砲撃などの爆発は装甲の影響が小さい。</li></ul>
  <h3>迷ったらこの形</h3><ul><li><b>盾</b>：ヘヴィ＋ライフル＋増加装甲</li><li><b>主力</b>：アサルト＋ライフル</li><li><b>回復</b>：サポート＋ライフル＋チャフ</li><li><b>偵察</b>：ライト＋ライフル＋レーダー（索敵任務はステルス）</li><li><b>火力</b>：ヘヴィ＋ライフル＋ミサイル（レーダー機とセットで）</li></ul>`;
}

export class Hangar {
  constructor(private cb: HangarCallbacks) {
    $('#guideBody').innerHTML = guideHTML();
    try { if (localStorage.getItem('octa-guide') === '0') ($('#guide') as HTMLDetailsElement).open = false } catch { /* ignore */ }
    $('#guide').addEventListener('toggle', () => { try { localStorage.setItem('octa-guide', ($('#guide') as HTMLDetailsElement).open ? '1' : '0') } catch { /* ignore */ } });
    $('#mlist').addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-m]'); if (!b) return; SAVE.mission = b.dataset.m as MissionId; persist(); this.render(); $('#brief').scrollIntoView({ block: 'nearest', behavior: 'smooth' }) });
    $('#diff').addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-d]'); if (!b) return; SAVE.diff = b.dataset.d as Difficulty; persist(); this.render() });
    $('#slots').addEventListener('change', e => {
      const t = e.target as HTMLInputElement | HTMLSelectElement, row = t.closest<HTMLElement>('.slot'); if (!row) return;
      const i = +row.dataset.i!;
      if (t instanceof HTMLInputElement && t.type === 'checkbox') deployOf(currentMission())[i] = t.checked;
      else (SAVE.slots[i] as unknown as Record<string, string>)[t.dataset.k!] = t.value;
      persist(); this.render(); document.getElementById(t.id)?.focus();
    });
    $('#goBtn').addEventListener('click', () => cb.start({ auto: false }));
    $('#aiGoBtn').addEventListener('click', () => { if (!($('#goBtn') as HTMLButtonElement).disabled) cb.start({ auto: true }) });
    $('#rplist').addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!b) return; const L = loadReplays();
      if (b.dataset.play) cb.playReplay(L[+b.dataset.play]);
      else if (b.dataset.del) { deleteReplay(+b.dataset.del); this.renderReplays() }
      else if (b.dataset.copy) {
        const txt = JSON.stringify(L[+b.dataset.copy]), ta = $<HTMLTextAreaElement>('#rpIn');
        const fallback = () => { ta.value = txt; ($('#rpImport') as HTMLDetailsElement).open = true; ta.select(); $('#rpErr').textContent = '下の欄に表示しました。選択してコピーしてください' };
        try { navigator.clipboard.writeText(txt).then(() => { b.textContent = 'コピー済'; setTimeout(() => (b.textContent = 'コピー'), 1500) }, fallback) } catch { fallback() }
      }
    });
    $('#rpLoad').addEventListener('click', () => {
      try { const r = JSON.parse($<HTMLTextAreaElement>('#rpIn').value.trim()); if (!isReplay(r)) throw new Error('形式が違います（このバージョンのリプレイ v3 が必要です）'); $('#rpErr').textContent = ''; cb.playReplay(r) }
      catch (err) { $('#rpErr').textContent = '読み込めません：' + (err as Error).message }
    });
    $('#rpFile').addEventListener('change', e => {
      const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
      const fr = new FileReader(); fr.onload = () => { $<HTMLTextAreaElement>('#rpIn').value = String(fr.result); $('#rpErr').textContent = '読み込みました。「再生」を押してください' }; fr.readAsText(f);
    });
  }

  render() {
    const m = currentMission();
    const PARTS: Record<number, string> = { 1: '第1部　機体と武器', 2: '第2部　見る・隠れる', 3: '第3部　道具で崩す', 4: '第4部　作戦' };
    $('#mlist').innerHTML = [1, 2, 3, 4].map(p => {
      const ms = MISSIONS.filter(x => (x.part ?? 4) === p); if (!ms.length) return '';
      return `<div class="mpart">${PARTS[p]}</div>` + ms.map(x => {
        const pr = PROGRESS[x.id], md = x.medals ? x.medals.map((_, i) => pr?.medals[i] ? '<i class="on">●</i>' : '<i>○</i>').join('') : '';
        return `<button class="mcard${x.id === m.id ? ' on' : ''}${pr?.clear ? ' clear' : ''}" data-m="${x.id}"><span class="mtype t-${x.type}">${x.part && x.part < 4 ? x.code : x.type}</span><span class="nm">${x.name}${pr?.clear ? ' <b class="ck">✓</b>' : ''}</span><span class="cd">${md || x.code}</span></button>`;
      }).join('');
    }).join('');
    $('#diff').innerHTML = Object.entries(DIFFS).map(([k, d]) => `<button data-d="${k}" class="${SAVE.diff === k ? 'on' : ''}">${d.name}</button>`).join('');
    $('#brief').innerHTML = `<h3>${m.code}　${m.name}</h3><p>${m.brief}</p>
     <dl><dt>勝利条件</dt><dd>${m.win}</dd><dt>敗北条件</dt><dd>${m.lose}</dd>
     ${m.squad ? `<dt>編成</dt><dd>固定（${m.squad.length} 機）</dd>` : `<dt>出撃枠</dt><dd class="num">${m.max} 機</dd><dt>予算</dt><dd class="num">${m.budget}</dd>`}
     <dt>制限時間</dt><dd class="num">${m.limit ? Math.floor(m.limit / 60) + ' 分' : 'なし'}</dd><dt>砲撃支援</dt><dd class="num">${m.arty} 回</dd></dl>
     <div class="hint">助言：${m.hint}</div>${m.medals ? `<div class="medals"><b>サブ目標</b>${m.medals.map((md, i) => `<div class="${PROGRESS[m.id]?.medals[i] ? 'got' : ''}"><i>${PROGRESS[m.id]?.medals[i] ? '●' : '○'}</i> ${md.name}　<small>${md.desc}</small></div>`).join('')}</div>` : ''}`;
    if (m.squad) {
      $('#slots').innerHTML = `<p class="fixed">この章は編成固定です（${m.squad.length}機）。</p>` + m.squad.map((s, i) => {
        const st = loadoutStats(s), w = WEAPONS[s.weapon];
        return `<div class="slot on fixedslot"><span class="no">0${i + 1}</span><div class="pilot">${shapeSVG(st.shape, '#5fb0e0')}<div><b>${PILOTS[i][0]}</b><small>${roleOf(s)}</small></div></div>
        <div class="fx">${CHASSIS[s.chassis].name}／${w.name}／${EQUIP[s.equip].name}／${TOOLS[s.tool].name}${s.tool !== 'none' ? '×' + TOOLS[s.tool].ammo : ''}</div>
        <div class="st"><span>HP <b>${st.hp}</b></span><span>装甲 <b>${st.armor}</b></span><span>速度 <b>${st.speed}</b></span><span>視界 <b>${st.sensor}</b></span><span>射程 <b>${w.range}</b></span></div></div>`;
      }).join('');
      $('#budget').innerHTML = ''; const el = $('#deployMsg'); el.textContent = `${m.squad.length} 機で出撃`; el.className = '';
      ($('#goBtn') as HTMLButtonElement).disabled = false; ($('#aiGoBtn') as HTMLButtonElement).disabled = false;
      this.renderReplays(); return;
    }
    const dep = deployOf(m);
    $('#slots').innerHTML = SAVE.slots.map((s, i) => {
      const st = loadoutStats(s), w = WEAPONS[s.weapon];
      return `<div class="slot${dep[i] ? ' on' : ''}" data-i="${i}">
      <label class="dep"><input type="checkbox" id="dep${i}" ${dep[i] ? 'checked' : ''} aria-label="${PILOTS[i][0]}を出撃させる"><span class="no">0${i + 1}</span></label>
      <div class="pilot">${shapeSVG(st.shape, dep[i] ? '#5fb0e0' : '#56656c')}<div><b>${PILOTS[i][0]}</b><small>${PILOTS[i][1]}</small></div></div>
      <select id="ch${i}" data-k="chassis" aria-label="機体">${opts(CHASSIS, s.chassis)}</select>
      <select id="wp${i}" data-k="weapon" aria-label="武装">${opts(WEAPONS, s.weapon)}</select>
      <select id="eq${i}" data-k="equip" aria-label="装備">${opts(EQUIP, s.equip)}</select>
      <select id="tl${i}" data-k="tool" aria-label="ツール">${opts(TOOLS, s.tool)}</select>
      <div class="cost">${st.cost}<small>COST</small></div>
      <div class="st"><span>HP <b>${st.hp}</b></span><span>装甲 <b>${st.armor}</b></span><span>速度 <b>${st.speed}</b></span><span>視界 <b>${st.sensor}</b></span><span>射程 <b>${w.range}</b></span><span>DPS <b>${(w.dmg / w.cd).toFixed(1)}</b></span>${st.repair ? '<span>修理 <b>' + st.repair + '/s</b></span>' : ''}${st.stealth ? '<span><b>ステルス</b></span>' : ''}${st.regen ? '<span>再生 <b>' + st.regen + '/s</b></span>' : ''}${st.tool !== 'none' ? '<span>' + TOOLS[st.tool].name + ' <b>×' + TOOLS[st.tool].ammo + '</b></span>' : ''}</div>
      <div class="desc"><span>${roleOf(s)}</span>　${CHASSIS[s.chassis].desc}。${w.desc}。${s.equip !== 'none' ? EQUIP[s.equip].name + '：' + EQUIP[s.equip].desc + '。' : ''}${s.tool !== 'none' ? TOOLS[s.tool].name + '：' + TOOLS[s.tool].desc + '。' : ''}</div>
    </div>`;
    }).join('');
    this.updateBudget();
    this.renderReplays();
  }

  private updateBudget() {
    const m = currentMission(), dep = deployOf(m); let cost = 0, n = 0;
    SAVE.slots.forEach((s, i) => { if (dep[i]) { cost += loadoutStats(s).cost; n++ } });
    const over = cost > m.budget;
    $('#budget').innerHTML = `<div class="btxt"><span>予算 <b class="num">${cost} / ${m.budget}</b></span><span>出撃 <b class="num">${n} / ${m.max}</b> 機</span></div><div class="bbar${over ? ' over' : ''}"><i style="width:${Math.min(100, cost / m.budget * 100)}%"></i></div>`;
    let msg = '', bad = true;
    if (n === 0) msg = '出撃する機体を選んでください';
    else if (n > m.max) msg = `出撃枠を ${n - m.max} 機超えています`;
    else if (over) msg = `予算を ${cost - m.budget} 超えています。装備を軽くするか機数を減らしてください`;
    else { msg = `${n} 機で出撃可能`; bad = false }
    const el = $('#deployMsg'); el.textContent = msg; el.className = bad ? 'bad' : '';
    ($('#goBtn') as HTMLButtonElement).disabled = bad; ($('#aiGoBtn') as HTMLButtonElement).disabled = bad;
  }

  renderReplays() {
    const L = loadReplays(), el = $('#rplist');
    if (!L.length) { el.innerHTML = '<p class="rpempty">まだありません。作戦を終えると自動で保存されます（最新15件）。</p>'; return }
    const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    el.innerHTML = L.map((r, i) => {
      const m = MISSIONS.find(x => x.id === r.mission)!, d = new Date(r.date);
      return `<div class="rpitem"><span class="mtype t-${m.type}">${m.type}</span><div class="rpmeta"><b>${m.name}</b><small>${r.ctrl === 'ai' ? 'AI' : r.ctrl === 'human' ? 'プレイヤー' : 'AI＋プレイヤー'}・<span class="${r.result.win ? 'w' : 'l'}">${r.result.win ? '勝利' : '敗北'}</span>・${fmt(r.result.time)}・${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}</small></div>
        <div class="rpbtns"><button class="btn" data-play="${i}">再生</button><button class="btn" data-copy="${i}">コピー</button><button class="btn" data-del="${i}" aria-label="削除">×</button></div></div>`;
    }).join('');
  }
}
