// Advisor: points out a mismatch between weapons, equipment and enemy types the first time it
// happens in a battle, so the player can feel which combinations work. Purely informational
// (it only writes log lines), so it cannot change the outcome of a replay.
import type { Sim } from '../sim';
import { dist } from '../rng';

const MG_FOES = new Set(['gunner', 'scout']);

export function advisorSystem(s: Sim) {
  if (s.tickN % 30 !== 0 || s.time - s.instrT < 10) return; // don't talk over the instructor
  const tip = (key: string, text: string) => { if (s.tips.has(key)) return; s.tips.add(key); s.log('助言：' + text, 'tip') };
  for (const p of s.projs) {
    if (p.team !== 'P' || p.k === 'MSL') continue;
    const src = s.world.get(p.src), t = s.world.get(p.tgt);
    if (!src?.squad || !t?.health) continue;
    if (p.k === 'MG' && t.health.armor >= 4) tip('mg-armor', `機関銃は装甲の厚い相手（${t.name}）にほとんど通らない。ライフル・狙撃砲で撃つか、機関銃は軽い敵に回す`);
    else if (p.k === 'RF' && p.am === 'std' && t.health.armor >= 5 && src.weapon && src.weapon.ap > 0) tip('ap', `${t.name}には徹甲弾が効く（R で切替）`);
    if (p.am === 'std' && t.structure && src.weapon && src.weapon.he > 0) tip('he', '建造物には榴弾（R で切替）が1.6倍効く');
  }
  const ours = s.world.alive('squad');
  for (const e of s.enemies()) {
    if (!s.seenE.has(e.id) || !e.enemyAI) continue;
    const k = e.enemyAI.etype, st = e.enemyAI.state;
    if (MG_FOES.has(k) && ours.some(u => u.health!.armor <= 3 && dist(u.pos, e.pos) <= 3.4))
      tip('close', `${e.name}（機関銃）に接近された。機関銃は近いほど強い。煙幕で視線を切るか、ライフルの射程（4.8）まで下がって撃つ`);
    if (st === 'flank') tip('flank', '敵が横へ回り込んでいる。盾役は正面の敵しか引き受けられない。側面に1機向けるか、陣形ごと向きを変える');
    if (st === 'withdraw' || st === 'hold') { const t = s.map.at(e.pos.x, e.pos.y); if (t === 1 || t === 2) tip('cover', `敵が${t === 1 ? '森' : '丘'}に下がって待ち構えている。${t === 1 ? '森の敵は被弾25%減（榴弾は無視）。' : '丘の敵は射程・視界+1。'}追うなら迂回するか砲撃で`) }
    if (k === 'launcher') tip('launcher', '誘導弾型：電波を出している機体（レーダーON・デコイ）を遠くから狙う。Z でレーダーを切るか、デコイで釣る');
    if (k === 'mortar') tip('mortar', '迫撃砲型：3機以上が固まっているところに撃ち込む。発射音が聞こえたら4秒以内に散開');
  }
  for (const p of s.projs) if (p.k === 'MSL' && p.team === 'E' && !p.lost) {
    const t = s.world.get(p.tgt);
    if (t?.squad && s.emitting(t)) tip('arm', `${t.squad.pilot}機はレーダーの電波で誘導弾に捕捉された。Z でレーダーを切る／チャフ／デコイ`);
    else if (t?.squad) tip('msl', 'ミサイル接近。チャフで誘導を外すか、機関銃の味方の近くなら迎撃できる');
  }
  if (s.world.alive('structure').some(r => r.structure.kind === 'radar' && r.structure.alerted)) tip('tower', 'レーダー塔に見つかると、覆域内の敵部隊が一斉に動く。チャフ・電障弾の中なら探知されない。先に狙撃で塔を落とすと敵の連携が切れる');
}
