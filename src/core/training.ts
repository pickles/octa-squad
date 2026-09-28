// Training chapters (parts 1–3). Each chapter asks one question whose answer is a weapon, a piece
// of equipment or a tool, with a fixed squad that carries that answer. Sub-goals (medals) reward
// actually using it; winning by brute force is allowed but earns fewer medals.
import type { Sim } from './sim';
import type { MissionDef, Medal } from './missions';
import type { Loadout, ChassisKey, WeaponKey, EquipKey, ToolKey } from './data';

const L = (chassis: ChassisKey, weapon: WeaponKey, equip: EquipKey = 'none', tool: ToolKey = 'none'): Loadout => ({ chassis, weapon, equip, tool });
/** Instructor line: shown in the advisor box. */
const say = (s: Sim, t: number, text: string) => s.schedule(t, s2 => s2.log('教官：' + text, 'tip'));
const allDead = (s: Sim) => s.countE() === 0;
const inGoal = (s: Sim) => s.livingSquad().filter(u => s.inZone(u, 'goal')).length;
const noLoss: Medal = { name: '全機生還', desc: '1機も失わずに勝つ', test: s => s.lost === 0 };
const st = (s: Sim, k: string) => s.stat[k] || 0;
const sumStat = (s: Sim, prefix: string) => Object.entries(s.stat).filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + v, 0);
const COMMON = { budget: 9999, arty: 0, limit: 0, lose: '全機喪失', dmgMul: 0.7 };
const setMissiles = (s: Sim, n: number) => { for (const u of s.world.alive('enemyAI')) if (u.enemyAI.etype === 'launcher' && u.toolbelt) u.toolbelt.ammo = n };

export const TRAINING: MissionDef[] = [
  // ------------------------------------------------------------------ part 1: chassis & weapons
  {
    ...COMMON, id: 't1', part: 1, type: '教練', code: '1-1', name: '射程と装甲', max: 4, seed: 101,
    terr: { forest: 2, hills: 1, water: 0, rocks: 2 }, spawn: [6, 20], keys: [[18, 12]], bounds: [3, 7, 24, 24], paint: [['forest', 12, 17, 1.6]],
    squad: [L('assault', 'mg'), L('assault', 'mg'), L('assault', 'rifle'), L('assault', 'rifle')],
    brief: '軽い敵と重い敵、それぞれどう倒す？　まず偵察型（装甲1）が3機、続いて重装型（装甲6）が来る。',
    win: '敵の全滅', hint: '機関銃は近距離で軽い敵を溶かすが、重装型には弾かれる。重装型にはライフルの徹甲弾（R）。',
    medals: [
      { name: '機関銃の本領', desc: '偵察型へのダメージの半分以上を機関銃で与える', test: s => st(s, 'dmg:w:mg:scout') > 0 && st(s, 'dmg:w:mg:scout') >= (st(s, 'dmg:w:mg:scout') + st(s, 'dmg:w:rifle:scout')) * 0.5 },
      { name: '装甲を貫く', desc: '徹甲弾で重装型に60以上のダメージ', test: s => st(s, 'apHeavy') >= 60 },
      noLoss,
    ],
    setup(s) {
      s.schedule(6, s2 => s2.group(['scout', 'scout', 'scout'], 19, 10, { role: 'hunt' }));
      say(s, 0.5, '開始時は一時停止中。機体カードかマップ上の味方を左クリックで選択、地面を右クリックで移動、敵を右クリックで攻撃。Space で再開・一時停止。');
      say(s, 5, '北東から偵察型が3機来る。装甲1の軽い機体だ。機関銃（射程3.2）は近いほど強い。機関銃の2機を前に、ライフルの2機は1マス後ろに。');
    },
    objective: s => s.flags.w2 ? (s.countE() ? `重装型を撃破せよ` : '重装型の接近を待て') : `偵察型を撃破せよ（残り ${s.countE()}）`,
    check: s => {
      if (s.time > 7 && !s.flags.w2 && allDead(s)) {
        s.flags.w2 = true;
        s.log('教官：よくやった。次は重装型（装甲6）が1機来る。機関銃の弾（1発6）は装甲にほぼ弾かれる。今のうちにライフルの2機を選んで R で徹甲弾に切り替えろ（2.5秒かかる）。', 'tip');
        s.schedule(s.time + 14, s2 => {
          s2.group(['heavy'], 20, 8, { role: 'hunt' });
          for (const u of s2.world.alive('enemyAI')) if (u.toolbelt) u.toolbelt.ammo = 0;
          s2.log('教官：重装型が来た。ライフルで撃て。弱った機体は後ろへ下げろ。敵は弱った機体を狙ってくる。', 'tip');
        });
      }
      return s.flags.w2 && allDead(s) && s.events.every(e => e.done) ? { win: true, reason: '敵を全滅させた' } : undefined;
    },
  },
  {
    ...COMMON, id: 't2', part: 1, type: '教練', code: '1-2', name: '盾と修理', max: 4, seed: 202,
    terr: { forest: 3, hills: 1, water: 0, rocks: 2 }, spawn: [6, 20], keys: [[19, 11]], bounds: [3, 7, 24, 24],
    squad: [L('heavy', 'rifle', 'plate'), L('support', 'rifle'), L('assault', 'rifle'), L('assault', 'rifle')],
    brief: '被弾を誰が受ける？　突撃型の小隊が2波来る。ヘヴィを盾にし、サポートの修理範囲で戦う。',
    win: '敵の全滅', hint: 'ヘヴィを先頭に、他は1〜2マス後ろ。サポートは半径2.5の味方を毎秒3.5回復し、壊れた部位も直す。',
    medals: [
      { name: '盾の役目', desc: '味方が受けたダメージの4割以上をヘヴィが受ける', test: s => st(s, 'taken:heavy') >= sumStat(s, 'taken:') * 0.4 },
      { name: '野戦修理', desc: '第2波が来た時点で、全機のHPを8割以上に戻しておく（修理を使って）', test: s => !!s.flags.healed },
      noLoss,
    ],
    setup(s) {
      s.schedule(6, s2 => s2.group(['trooper', 'trooper', 'gunner'], 19, 10, { role: 'hunt' }));
      say(s, 0.5, 'ヘヴィ（装甲8）を先頭に置け。敵は近い機体と弱った機体を狙う。サポートは後ろ、半径2.5の味方を修理する。');
      say(s, 20, '被弾した機体はサポートの近くへ下げろ。部位損傷（火器・脚・センサー）もサポートの近くで6秒ごとに直る。');
    },
    objective: s => `敵残存 ${s.countE()}（第${s.flags.w2 ? 2 : 1}波）`,
    check: s => {
      if (s.time > 7 && !s.flags.w2 && allDead(s)) {
        s.flags.w2 = true; s.log('教官：第1波を撃退。第2波まで25秒。傷ついた機体をサポートの近く（2.5以内）に集めて、全機HP8割以上まで直せ。', 'tip');
        s.schedule(s.time + 25, s2 => {
          s2.flags.healed = st(s2, 'repaired') > 0 && s2.livingSquad().every(u => u.health!.hp >= u.health!.maxHp * 0.8);
          s2.group(['trooper', 'trooper', 'gunner'], 20, 9, { role: 'hunt' });
          s2.log(`教官：第2波が来た。ヘヴィを前に。${s2.flags.healed ? '（修理は万全だ）' : ''}`, 'tip');
        });
      }
      return s.flags.w2 && allDead(s) && s.events.every(e => e.done) ? { win: true, reason: '2波とも撃退した' } : undefined;
    },
  },
  {
    ...COMMON, id: 't3', part: 1, type: '教練', code: '1-3', name: '観測と狙撃', max: 3, seed: 303,
    terr: { forest: 3, hills: 0, water: 0, rocks: 2 }, spawn: [5, 21], keys: [[15, 11], [20, 13], [22, 7]], bounds: [2, 5, 25, 25],
    paint: [['hill', 15, 11, 2.2], ['hill', 22, 7, 1.5]],
    squad: [L('light', 'rifle', 'radar'), L('assault', 'sniper'), L('heavy', 'rifle', 'plate')],
    brief: '見えない敵をどう撃つ？　丘に守備隊がいる。狙撃砲は射程8.5だが自分の視界は5しかない。',
    win: '敵の全滅', hint: 'レーダー機（視界9）が見つけた敵なら狙撃砲で撃てる。撃つと位置がばれて敵が寄ってくるので、ヘヴィで受け止める。奥の誘導弾型は、レーダーの電波（3秒でロック）か自分の視界6の中の機体しか狙えない。',
    medals: [
      { name: '遠くから', desc: '狙撃砲で3機以上倒す', test: s => sumStat(s, 'kill:w:sniper:') >= 3 },
      { name: '電波管理', desc: '誘導弾のミサイルを一度も受けない', test: s => st(s, 'mslOnUs') === 0 },
      noLoss,
    ],
    setup(s) {
      s.group(['trooper', 'trooper'], 15, 11, { role: 'garrison', leash: 5 });
      s.group(['gunner', 'trooper'], 20, 13, { role: 'garrison', leash: 5 });
      s.group(['launcher'], 22, 7, { role: 'overwatch' }); setMissiles(s, 2);
      say(s, 0.5, 'レーダー機（01）を警戒移動（M）で前へ。視界9で先に敵を見つけられる。狙撃砲（02）は味方が見ている敵を射程8.5から撃てる。');
      say(s, 25, '撃つと発砲炎で2秒間位置がばれる。寄ってくる敵はヘヴィ（03）の後ろで迎えろ。');
      say(s, 50, '奥の丘に誘導弾型がいる。レーダーを点けている機体は電波を追われ、3秒点けっぱなしだとミサイルが来る（「ロックオン警報」が出たらすぐ Z で切れ）。誘導弾型自身の視界は丘の上で6。レーダーを切ってそれより遠くにいれば狙われない。狙撃砲の射程8.5から撃てば撃ち返されない。');
    },
    objective: s => `敵残存 ${s.countE()}`,
    check: s => allDead(s) ? { win: true, reason: '丘の敵を排除した' } : undefined,
  },
  // ------------------------------------------------------------------ part 2: seeing and hiding
  {
    ...COMMON, id: 't4', part: 2, type: '教練', code: '2-1', name: '地雷原', max: 4, seed: 404, limit: 300, lose: '全機喪失／時間切れ',
    terr: { forest: 3, hills: 0, water: 0, rocks: 1 }, spawn: [5, 21], keys: [[21, 9], [12, 15]], bounds: [3, 6, 24, 24],
    paint: [['rock', 5, 15, 1.7], ['rock', 8, 15, 1.7], ['rock', 16.5, 15, 1.7], ['rock', 19.5, 15, 1.7], ['rock', 22.5, 15, 1.7]],
    emines: [[11.5, 15.5], [12.5, 14.5], [13.5, 15.5], [12.5, 16.3], [11.2, 14.2], [14, 14.6], [16.5, 11.5], [18.5, 10.5], [17.5, 12.5]],
    squad: [L('light', 'rifle'), L('light', 'rifle'), L('assault', 'rifle'), L('heavy', 'mg', 'plate')],
    brief: '見えない地雷をどう抜ける？　狭い通路の先の合流点まで進む。通路と出口に地雷が埋まっている。偵察型は逃げながら地雷を置く。',
    win: '3機以上が合流点に入る', hint: '警戒移動（M）の機体は半径2.5の地雷を見つけ、隣（1.2以内）で止まると2秒で処理する。逃げる偵察型が見えていれば、置いた地雷も見える。',
    medals: [
      { name: '無事故', desc: '一度も地雷を踏まない', test: s => st(s, 'mineHit') === 0 },
      { name: '処理班', desc: '地雷を5個以上処理する', test: s => st(s, 'disarm') >= 5 },
      { name: '急行', desc: '3分以内に到達', test: s => s.time < 180 },
    ],
    setup(s) {
      s.addZone({ kind: 'goal', x: 21, y: 9, r: 1.8, label: '合流点' });
      s.group(['scout', 'scout'], 13, 11, { patrol: [[13, 11], [19, 12]] });
      say(s, 0.5, '通路（中央の隙間）に地雷がある。先頭の機体を警戒移動（M）にして進め。地雷が見えたら隣で止まれば2秒で処理できる。');
      say(s, 40, '偵察型は不利になると下がりながら地雷を置く。見ていれば位置がわかる。見失ったら警戒移動で探せ。');
    },
    objective: s => `合流点 ${inGoal(s)}/3`,
    check: s => inGoal(s) >= 3 ? { win: true, reason: '地雷原を抜けた' } : undefined,
  },
  {
    ...COMMON, id: 't5', part: 2, type: '教練', code: '2-2', name: '目を置く', max: 4, seed: 505,
    terr: { forest: 1, hills: 0, water: 0, rocks: 2 }, spawn: [5, 21], keys: [[15, 10], [18, 12], [11, 9]], bounds: [2, 4, 25, 25],
    paint: [['forest', 15, 11, 3.6], ['forest', 19, 9, 2]],
    squad: [L('assault', 'sniper'), L('assault', 'rifle', 'none', 'probe'), L('heavy', 'rifle', 'plate'), L('light', 'rifle', 'none', 'probe')],
    brief: '森の奥の狙撃型をどう見つける？　森の中の敵は見える距離が0.7倍になる。近づけば狙撃型と誘導弾型に撃たれる。',
    win: '狙撃型と誘導弾型を撃破', hint: 'プローブ（T）を森の縁に置けば、自分は下がったままその視界（5）で狙撃砲が撃てる。敵の偵察型はプローブを見つけて壊すので、巡回を先に片付けるか、通り過ぎてから置く。',
    medals: [
      { name: '置き目', desc: 'プローブの視界で3機以上を見つける', test: s => st(s, 'probeSpot') >= 3 },
      { name: '狙撃戦', desc: '狙撃型を狙撃砲で倒す', test: s => st(s, 'kill:w:sniper:sniper') >= 1 },
      noLoss,
    ],
    setup(s) {
      s.group(['sniper'], 16, 10, { role: 'overwatch' }); s.group(['launcher'], 19, 9, { role: 'overwatch' }); setMissiles(s, 3);
      s.group(['trooper', 'gunner'], 12, 9, { role: 'garrison', leash: 4 });
      s.group(['scout', 'scout'], 11, 14, { patrol: [[11, 14], [18, 15], [20, 12]] });
      say(s, 0.5, '森の中は見えにくい。プローブ（T、射程5）を森の縁に置いてみろ。置いた地点の視界5が使え、狙撃砲はそれを頼りに撃てる。');
      say(s, 30, '敵の偵察型はプローブを見つけて壊しに来る。巡回の通り道は避けて置け。');
    },
    objective: s => { const n = s.world.alive('enemyAI').filter(u => u.enemyAI.etype === 'sniper' || u.enemyAI.etype === 'launcher').length; return `狙撃型・誘導弾型 残り ${n}` },
    check: s => s.world.alive('enemyAI').some(u => u.enemyAI.etype === 'sniper' || u.enemyAI.etype === 'launcher') ? undefined : { win: true, reason: '森の射手を排除した' },
  },
  {
    ...COMMON, id: 't6', part: 2, type: '教練', code: '2-3', name: '照らす', max: 4, seed: 606,
    terr: { forest: 2, hills: 0, water: 0, rocks: 2 }, spawn: [5, 21], keys: [[12, 14], [17, 11], [20, 16]], bounds: [2, 5, 25, 25],
    paint: [['forest', 12, 14, 2.3], ['forest', 17, 10.5, 2.2], ['forest', 20.5, 16.5, 2.2]],
    squad: [L('light', 'rifle', 'none', 'flare'), L('assault', 'rifle'), L('assault', 'mg'), L('heavy', 'rifle', 'plate')],
    brief: '森で待ち伏せる敵をどう引きずり出す？　3つの森に敵が潜んで待っている。近づくまで見えない。',
    win: '敵の全滅', hint: '照明弾（T、射程8）で森を照らすと、隠れている敵も10秒間見える。森の敵は被弾25%減だが、榴弾（R）は森の遮蔽を無視する。',
    medals: [
      { name: '照らし出す', desc: '照明弾で3機以上を見つける', test: s => st(s, 'flareSpot') >= 3 },
      { name: '榴弾', desc: '森の敵に榴弾で80以上のダメージ', test: s => st(s, 'heForest') >= 80 },
      noLoss,
    ],
    setup(s) {
      s.group(['trooper', 'gunner'], 11.5, 13.5, { role: 'garrison', leash: 3, ambush: true });
      s.group(['trooper', 'trooper'], 16.5, 10, { role: 'garrison', leash: 3, ambush: true });
      s.group(['gunner', 'scout'], 20, 16, { role: 'garrison', leash: 3, ambush: true });
      say(s, 0.5, '森に敵が伏せている。伏せた敵は0.35倍の距離まで近づかないと見えない。照明弾（T）を森に撃ち込んで照らせ。');
      say(s, 20, '見えた敵が森の中なら、ライフルを R で榴弾に切り替えろ。森の遮蔽（被弾25%減）を無視できる。');
    },
    objective: s => `敵残存 ${s.countE()}`,
    check: s => allDead(s) ? { win: true, reason: '伏兵を一掃した' } : undefined,
  },
  {
    ...COMMON, id: 't7', part: 2, type: '教練', code: '2-4', name: 'すり抜ける', max: 3, seed: 707, limit: 300, lose: '全機喪失／時間切れ',
    terr: { forest: 4, hills: 0, water: 0, rocks: 3 }, spawn: [4, 22], keys: [[22, 7], [12, 15], [17, 11]], bounds: [2, 5, 25, 25],
    paint: [['forest', 9, 17, 1.8], ['forest', 14, 13, 1.6], ['forest', 19, 10, 1.6]],
    squad: [L('light', 'rifle', 'stealth'), L('light', 'rifle', 'stealth'), L('light', 'mg', 'stealth')],
    brief: '見つからずにどう通る？　巡回隊が行き交う谷を抜けて、北東の回収点まで行く。見つかると周りの敵が集まってくる。',
    win: '生き残った全機（2機以上）が回収点に入る', hint: 'ステルスは見つかる距離が半分、森ならさらに0.7倍、隠蔽（H）でさらに0.35倍。V で敵の警戒圏（黄色い点線）が見える。巡回が通り過ぎるのを森で待て。',
    medals: [
      { name: '影', desc: '一度も発見されない', test: s => s.everDetected.size === 0 },
      { name: 'やり過ごし', desc: '隠蔽中に敵を2回、4マス以内でやり過ごす', test: s => st(s, 'hidePass') >= 2 },
      { name: '全機到達', desc: '3機とも回収点に着く', test: s => s.lost === 0 },
    ],
    setup(s) {
      s.addZone({ kind: 'goal', x: 22, y: 7, r: 1.8, label: '回収点' });
      s.group(['trooper', 'gunner'], 10, 13, { patrol: [[10, 13], [15, 19], [10, 13]] });
      s.group(['scout', 'trooper'], 17, 15, { patrol: [[17, 15], [14, 9], [17, 15]] });
      s.group(['trooper', 'trooper'], 21, 11, { patrol: [[21, 11], [18, 7]] });
      s.group(['heavy'], 22, 5, { role: 'garrison', leash: 3 });
      say(s, 0.5, 'V で敵の警戒圏（黄色い点線）が見える。その円に入らなければ見つからない。森に入り、H で隠蔽すると円はもっと小さくなる。');
      say(s, 25, '撃つとステルスが2.5秒切れる。射撃禁止（Q）にしておくと勝手に撃たない。');
    },
    objective: s => `回収点 ${inGoal(s)}/${s.countP()}`,
    check: s => s.countP() >= 2 && inGoal(s) === s.countP() ? { win: true, reason: '谷を抜けた' } : (s.countP() < 2 ? { win: false, reason: '2機未満になった' } : undefined),
  },
  // ------------------------------------------------------------------ part 3: tools
  {
    ...COMMON, id: 't8', part: 3, type: '教練', code: '3-1', name: 'おとり', max: 4, seed: 808,
    terr: { forest: 3, hills: 0, water: 0, rocks: 2 }, spawn: [5, 21], keys: [[18, 8], [22, 12], [20, 10]], bounds: [2, 4, 25, 25],
    paint: [['hill', 18, 8, 1.6], ['hill', 22.5, 12.5, 1.6]],
    squad: [L('light', 'rifle', 'radar', 'decoy'), L('assault', 'rifle', 'none', 'decoy'), L('heavy', 'rifle', 'plate'), L('assault', 'sniper')],
    brief: '誘導弾型と守備隊をどう崩す？　2つの丘に誘導弾型が陣取り、その間を守備隊が固めている。',
    win: '誘導弾型2機を撃破', hint: 'デコイ（T）は電波を出す囮。誘導弾はデコイを優先して狙い、守備隊も吸い寄せられる。デコイで弾と敵を引きつけ、その横から撃つ。',
    medals: [
      { name: '身代わり', desc: 'デコイに誘導弾を3発当てさせる', test: s => st(s, 'decoyMissile') >= 3 },
      { name: '無傷の突破', desc: '誘導弾を一度も受けない', test: s => st(s, 'mslOnUs') === 0 },
      noLoss,
    ],
    setup(s) {
      s.group(['launcher'], 18, 8, { role: 'overwatch' }); s.group(['launcher'], 22, 12, { role: 'overwatch' });
      s.group(['trooper', 'trooper', 'gunner'], 20, 10, { role: 'garrison', leash: 5 });
      say(s, 0.5, '誘導弾型は電波を出す機体を射程9から狙う。01のレーダーは Z で切っておけ。デコイ（T、射程4）を前に置けば、ミサイルはそちらへ飛ぶ。');
      say(s, 30, 'デコイには守備隊も寄ってくる。持ち場から釣り出したところを横から叩け。');
    },
    objective: s => `誘導弾型 残り ${s.world.alive('enemyAI').filter(u => u.enemyAI.etype === 'launcher').length}`,
    check: s => s.world.alive('enemyAI').some(u => u.enemyAI.etype === 'launcher') ? undefined : { win: true, reason: '誘導弾陣地を潰した' },
  },
  {
    ...COMMON, id: 't9', part: 3, type: '教練', code: '3-2', name: '電子戦', max: 4, seed: 909,
    terr: { forest: 4, hills: 0, water: 0, rocks: 2 }, spawn: [5, 21], keys: [[16, 10], [18, 8], [22, 16], [21, 5]], bounds: [2, 3, 25, 25],
    squad: [L('light', 'rifle', 'stealth', 'jammer'), L('support', 'rifle', 'none', 'chaff'), L('assault', 'rifle', 'none', 'chaff'), L('assault', 'sniper')],
    brief: 'レーダー塔の覆域をどう渡る？　塔の半径9で動く機体は誘導弾に狙われ、見つかると2つの予備隊が呼ばれる。塔は補強されていて、遠くから撃っても簡単には壊れない。',
    win: 'レーダー塔の破壊', hint: '電障弾（T、射程6）は【攻め】の道具：中の敵の視界を4割にし、無線と塔を止める。チャフは【守り】の道具：ミサイルの誘導を切る。',
    medals: [
      { name: '沈黙', desc: 'レーダー塔を電障弾で合計10秒止める', test: s => st(s, 'towerJam') >= 10 },
      { name: '回避', desc: 'チャフで誘導弾を2発外す', test: s => st(s, 'chaffMissile') >= 2 },
      { name: '孤立', desc: '予備隊を一度も呼ばせない', test: s => st(s, 'radioCalls') === 0 },
    ],
    setup(s) {
      s.radar = s.spawnEnemy('radar', 16.5, 10.5, { objective: true });
      { const h = s.radar.health!; h.maxHp = h.hp = Math.round(h.hp * 3); h.armor = 5 } // hardened: shooting it from afar takes a long time
      s.group(['trooper', 'trooper'], 15, 12, { role: 'garrison', leash: 4 });
      s.group(['launcher'], 18, 8, { role: 'overwatch' }); setMissiles(s, 3);
      s.group(['trooper', 'gunner'], 22, 16, { role: 'reserve' }); s.group(['scout'], 21, 5, { role: 'reserve' });
      say(s, 0.5, 'レーダー塔は半径9を見張り、見つけた機体を無線で予備隊に知らせる。ステルスの01で近づき、電障弾（T）を塔に撃ち込め。');
      say(s, 25, '塔の覆域で動くと誘導弾が飛んでくる。「ミサイル接近」が出たら、狙われた機体の上にチャフ（T）を張れ。');
    },
    objective: s => `レーダー塔 ${s.radar!.life.alive ? '稼働中' : '破壊'}`,
    check: s => !s.radar!.life.alive ? { win: true, reason: 'レーダー塔を破壊した' } : undefined,
  },
  {
    ...COMMON, id: 't10', part: 3, type: '教練', code: '3-3', name: '煙の中を渡る', max: 4, seed: 1010,
    terr: { forest: 0, hills: 0, water: 0, rocks: 2 }, spawn: [4, 21], keys: [[21, 8], [22, 14], [15, 11], [9, 7]], bounds: [2, 5, 25, 24],
    paint: [['hill', 22.5, 14.5, 1.3], ['hill', 9, 7, 1.3]],
    squad: [L('assault', 'rifle', 'none', 'smoke'), L('assault', 'rifle', 'none', 'smoke'), L('heavy', 'mg', 'plate', 'smoke'), L('light', 'rifle')],
    brief: '開けた場所を十字砲火の中でどう渡る？　平原の両側の丘に狙撃型、中央に機関銃陣地がある。',
    win: '3機以上が集結点に入る', hint: '煙幕（T）は視線を切り、煙越しの射撃は命中率35%。狙撃型のいる方向に煙の壁を作りながら進む。機関銃陣地（射程3.2）には近づかない。',
    medals: [
      { name: '煙の壁', desc: '煙幕で敵弾を10発外させる', test: s => st(s, 'smokeMiss') >= 10 },
      { name: '全機到達', desc: '4機とも集結点に着く', test: s => s.lost === 0 },
    ],
    setup(s) {
      s.addZone({ kind: 'goal', x: 21, y: 8, r: 1.8, label: '集結点' });
      s.group(['sniper'], 22, 14, { role: 'overwatch' }); s.group(['sniper'], 9, 7, { role: 'overwatch' });
      s.group(['gunner', 'gunner'], 15, 11, { role: 'garrison', leash: 2 });
      say(s, 0.5, '狙撃型が2方向から平原を見張っている。煙幕（T、射程3.5）を狙撃型との間に張れば、見つかりにくくなり弾も外れる。');
      say(s, 30, '煙は15秒で消える。4機で2回ずつ、切らさないように順番に張れ。');
    },
    objective: s => `集結点 ${inGoal(s)}/3`,
    check: s => inGoal(s) >= 3 ? { win: true, reason: '平原を渡りきった' } : undefined,
  },
  {
    ...COMMON, id: 't11', part: 3, type: '教練', code: '3-4', name: '罠', max: 4, seed: 1111,
    terr: { forest: 2, hills: 0, water: 0, rocks: 1 }, spawn: [6, 21], keys: [[18, 9], [12, 15]], bounds: [3, 5, 24, 24],
    paint: [['rock', 5, 15, 2], ['rock', 7.5, 15, 1.2], ['rock', 9, 15, 1.5], ['rock', 16, 15, 1.8], ['rock', 20, 15, 2.2], ['rock', 23.5, 15, 1.6]],
    squad: [L('light', 'rifle', 'stealth', 'mine'), L('light', 'rifle', 'none', 'mine'), L('assault', 'rifle', 'none', 'mine'), L('assault', 'sniper')],
    brief: '追ってくる敵をどう迎える？　北の野営地に敵が6機。正面から撃ち合えば数で負ける。間には狭い通路が1本。',
    win: '敵の全滅', hint: '地雷（T）は足元近くに置き、1.5秒後に作動して敵からは見えない。踏んだ敵は脚が壊れて遅くなる。通路に置いてから狙撃で釣り、足の止まった敵を撃つ。',
    medals: [
      { name: '罠師', desc: '地雷で3機以上の脚を止める', test: s => st(s, 'mineLegs') >= 3 },
      noLoss,
    ],
    setup(s) {
      s.group(['trooper', 'trooper', 'gunner'], 16, 9, { role: 'reserve' });
      s.group(['trooper', 'scout', 'gunner'], 19, 10, { role: 'reserve' });
      say(s, 0.5, '通路（中央の隙間）に地雷を3〜4個置け。T で地雷を選び、置きたい地点をクリック。自分の足元近く（1.5以内）にしか置けない。');
      say(s, 25, '置けたら狙撃砲で1機撃ってすぐ下がれ。撃たれた敵は撃った相手を追って通路を通る。地雷を踏んだ敵は脚が壊れて遅くなるので、そこを撃つ。');
    },
    objective: s => `敵残存 ${s.countE()}`,
    check: s => allDead(s) ? { win: true, reason: '追撃隊を撃退した' } : undefined,
  },
  {
    ...COMMON, id: 't12', part: 3, type: '教練', code: '3-5', name: '固い目標', max: 4, seed: 1212, arty: 2,
    terr: { forest: 1, hills: 0, water: 0, rocks: 2 }, spawn: [5, 21], keys: [[19, 9], [14, 13], [17, 11], [21, 11]], bounds: [2, 4, 25, 25],
    paint: [['forest', 14, 13.5, 2.2]],
    squad: [L('assault', 'rifle', 'none', 'charge'), L('assault', 'rifle', 'none', 'charge'), L('light', 'rifle', 'radar'), L('heavy', 'rifle', 'plate')],
    brief: '陣地と、固まって籠もる敵をどう崩す？　砲台2基が守る掩蔽壕を破壊する。手前の森には敵が固まって籠もっている。',
    win: '掩蔽壕の破壊', hint: '建造物は装甲が厚く、弾では時間がかかる。爆薬（T）を隣に仕掛ければ5秒後に260。固まった敵には砲撃支援（B）が効くが、味方も巻き込む。',
    medals: [
      { name: '爆破', desc: '爆薬で建造物を壊す', test: s => st(s, 'kill:struct:charge') >= 1 },
      { name: '砲撃', desc: '砲撃支援で2機以上倒す', test: s => st(s, 'kill:arty') >= 2 },
      { name: '迅速', desc: '4分以内に破壊', test: s => s.time < 240 },
    ],
    setup(s) {
      s.hq = s.spawnEnemy('hq', 19.5, 8.5, { objective: true });
      s.spawnEnemy('turret', 17.5, 11); s.spawnEnemy('turret', 21.5, 11);
      s.group(['trooper', 'trooper', 'gunner'], 13.5, 13, { role: 'garrison', leash: 2 });
      say(s, 0.5, '森に3機が固まっている。レーダー機（03）で見つけたら、砲撃支援（B）で森を叩け。8秒後に着弾し、味方も巻き込むので4マス以上離れておけ。');
      say(s, 30, '掩蔽壕（HP大・装甲5）は弾では削りにくい。爆薬（T）を持った01・02を隣まで運べば一撃で大ダメージ。');
    },
    objective: s => `掩蔽壕 耐久 ${Math.max(0, Math.ceil(s.hq!.health!.hp / s.hq!.health!.maxHp * 100))}%`,
    check: s => !s.hq!.life.alive ? { win: true, reason: '掩蔽壕を破壊した' } : undefined,
  },
];
