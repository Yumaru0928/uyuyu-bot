#!/usr/bin/env node
'use strict';

// ババ抜きコアのテスト。 node dev/test-babanuki-core.js

const assert = require('node:assert');
const core = require('../utils/babanuki-core.js');

// 決定的な乱数（テスト用）。seed を進めるだけの単純な LCG
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const C = (suit, rank) => ({ suit, rank });
const JOKER = { joker: true };

// デッキは53枚（52枚＋ジョーカー1枚）、重複なし
{
  const deck = core.createDeck();
  assert.strictEqual(deck.length, 53);
  assert.strictEqual(deck.filter(core.isJoker).length, 1);
  assert.strictEqual(new Set(deck.map(core.cardKey)).size, 53);
}

// removePairs: ペアは捨て、3枚は1枚残し、ジョーカーは残る
{
  const { hand, discarded } = core.removePairs([C('S', 5), C('H', 5), C('D', 5), C('C', 9), JOKER]);
  assert.strictEqual(discarded.length, 2);
  assert.strictEqual(hand.length, 3); // 5が1枚 + 9 + ジョーカー
  assert(core.hasNoPairs(hand));
  const four = core.removePairs([C('S', 7), C('H', 7), C('D', 7), C('C', 7)]);
  assert.strictEqual(four.hand.length, 0);
  assert.strictEqual(four.discarded.length, 4);
}

// 配布: 合計53枚、先手27・後手26、初期ペアは捨てられていて手札にペアが無い。ジョーカーはどちらかにある
{
  const state = core.createGame({ rng: lcg(42) });
  const total = state.hands[0].length + state.hands[1].length;
  assert(total <= 53 && total % 2 === 1, '捨てたペアは2枚単位なので合計は奇数');
  assert(core.hasNoPairs(state.hands[0]));
  assert(core.hasNoPairs(state.hands[1]));
  const jokers = [...state.hands[0], ...state.hands[1]].filter(core.isJoker).length;
  assert.strictEqual(jokers, 1);
  assert.strictEqual(state.winner, null);
}

// 引く: 相手から1枚減り、自分に来る。ペアができたら捨てる
{
  const state = core.createGameFromHands(
    [[C('S', 3), C('H', 8)], [C('D', 3), C('C', 12)]],
    0
  );
  // プレイヤー0が引く。相手(1)の手札は [3, 12]。シャッフルされるので位置は選べないが、
  // どちらを引いても手番が移ることと枚数の変化は決定的
  const before0 = state.hands[0].length;
  const r = core.drawCard(state, 0, lcg(7));
  assert(r.ok);
  assert.strictEqual(state.hands[1].length, 1);
  // 3を引けばペアで捨てて2枚のまま、12を引けば3枚になる
  assert(state.hands[0].length === before0 || state.hands[0].length === before0 + 1);
  assert.strictEqual(state.turn, 1);
  assert(core.hasNoPairs(state.hands[0]));
}

// ペアを引いて手札が空になったら勝ち
{
  const state = core.createGameFromHands([[C('S', 3)], [C('H', 3), C('C', 9)]], 0);
  // 相手の手札はシャッフルされる。3 を引く位置を決定的にするため rng を調整するのではなく、
  // 相手が9だけになるまで引く…ではなく、シャッフル結果が既知になる rng を使う:
  // shuffle は Fisher-Yates。要素2つの場合 rng() が 0.99 なら入れ替わらない（j=1）
  const r = core.drawCard(state, 0, () => 0.99); // 相手 [3, 9] のまま → 3を引く
  assert(r.ok);
  assert.strictEqual(r.discardedPair, true);
  assert.strictEqual(state.winner, 0);
  assert.strictEqual(state.hands[0].length, 0);
}

// 相手の最後の1枚を引いたら、相手（先に手札をなくした方）の勝ち
{
  const state = core.createGameFromHands([[C('S', 3), C('H', 8)], [C('C', 12)]], 0);
  const r = core.drawCard(state, 0, () => 0.5);
  assert(r.ok);
  assert.strictEqual(state.winner, 1);
  assert.strictEqual(state.hands[1].length, 0);
}

// ジョーカーを引いてもペアにはならず手札に残る
{
  const state = core.createGameFromHands([[C('S', 3)], [JOKER, C('C', 9)]], 0);
  const r = core.drawCard(state, 0, () => 0.99); // [JOKER, 9] のまま → ジョーカーを引く
  assert(r.ok);
  assert.strictEqual(r.discardedPair, false);
  assert(state.hands[0].some(core.isJoker));
  assert.strictEqual(state.winner, null);
}

// 範囲外の位置・終了後の着手は拒否
{
  const state = core.createGameFromHands([[C('S', 3)], [C('H', 4), C('C', 9)]], 0);
  assert.strictEqual(core.drawCard(state, 2).ok, false);
  assert.strictEqual(core.drawCard(state, -1).ok, false);
  const done = core.createGameFromHands([[C('S', 3)], [C('H', 3)]], 0);
  core.drawCard(done, 0, () => 0.5);
  assert.strictEqual(done.winner, 0);
  assert.strictEqual(core.drawCard(done, 0).ok, false);
}

// publicView: 相手の手札の中身が見えないこと
{
  const state = core.createGameFromHands([[C('S', 3), JOKER], [C('H', 4), C('C', 9)]], 0);
  const view = core.publicView(state, 0);
  assert.strictEqual(view.opponentCount, 2);
  assert.strictEqual(view.yourHand.length, 2);
  assert(!JSON.stringify(view).includes('"rank":4'), '相手のカードが見えてはいけない');
  assert.strictEqual(view.yourTurn, true);
}

// Bot の位置選びは範囲内
{
  for (let i = 0; i < 100; i++) {
    const p = core.chooseBotPosition(5, lcg(i + 1));
    assert(p >= 0 && p < 5);
  }
  assert.strictEqual(core.chooseBotPosition(0), -1);
}

// 対局シミュレーション: ランダムに引き続けると必ず終わり、敗者はジョーカーを持っている
for (let seed = 1; seed <= 30; seed++) {
  const rng = lcg(seed * 1000 + 17);
  const state = core.createGame({ rng, firstPlayer: seed % 2 });
  let guard = 0;
  while (state.winner === null && guard++ < 10000) {
    const oppSize = state.hands[1 - state.turn].length;
    const r = core.drawCard(state, core.chooseBotPosition(oppSize, rng), rng);
    assert(r.ok, `seed=${seed} で着手が失敗`);
    assert(core.hasNoPairs(state.hands[0]) && core.hasNoPairs(state.hands[1]));
  }
  assert(state.winner !== null, `seed=${seed} で対局が終わらなかった`);
  const loser = 1 - state.winner;
  assert(state.hands[loser].some(core.isJoker), `seed=${seed} で敗者がジョーカーを持っていない`);
  assert.strictEqual(state.hands[state.winner].length, 0);
}

// ---- 多人数（v2） ----

// 配布（3人・4人）: 合計53枚からペアを捨てた残り、ペア無し、ジョーカーは1枚だけ
for (const n of [3, 4]) {
  const state = core.createGame({ rng: lcg(100 + n), playerCount: n });
  assert.strictEqual(state.hands.length, n);
  const total = state.hands.reduce((s, h) => s + h.length, 0);
  assert(total <= 53 && (53 - total) % 2 === 0);
  for (const h of state.hands) assert(core.hasNoPairs(h));
  const jokers = state.hands.flat().filter(core.isJoker).length;
  assert.strictEqual(jokers, 1);
  assert.strictEqual(state.placements, null);
  assert(state.hands.every((h) => h.length > 0), '配布直後に上がっている人がいる');
}

// 手番ローテーション: 引く相手は「次のプレイヤー」で、手番は時計回りに移る
{
  // rng = () => 0.99 でシャッフルは並びを変えない（位置が決定的になる）
  const state = core.createGameFromHands(
    [[C('S', 1), C('S', 2)], [C('H', 3), C('H', 4)], [C('D', 5), C('D', 6)]],
    0
  );
  let r = core.drawCard(state, 0, () => 0.99); // P0 が P1 の先頭 (H3) を引く
  assert(r.ok);
  assert.strictEqual(r.drawnFrom, 1);
  assert.strictEqual(state.turn, 1);
  r = core.drawCard(state, 0, () => 0.99); // P1 が P2 の先頭 (D5) を引く
  assert.strictEqual(r.drawnFrom, 2);
  assert.strictEqual(state.turn, 2);
  r = core.drawCard(state, 0, () => 0.99); // P2 が P0 の先頭を引く（一周する）
  assert.strictEqual(r.drawnFrom, 0);
  assert.strictEqual(state.turn, 0);
}

// 上がりとスキップ: 手札が空になったプレイヤーは上がり、手番と引く相手から外れる
{
  const state = core.createGameFromHands(
    [[C('S', 1), C('S', 2)], [C('H', 1)], [C('D', 5), C('D', 6)]],
    0
  );
  // P0 が P1 の最後の1枚 (H1) を引く → ペアで捨てて P0 は S2 のみ、P1 は空で上がり
  const r = core.drawCard(state, 0, () => 0.99);
  assert(r.ok);
  assert.deepStrictEqual(r.finishedNow, [1]);
  assert.strictEqual(state.finished[1], true);
  assert.strictEqual(state.placements, null, 'まだ2人残っているので決着していない');
  assert.strictEqual(state.turn, 2, '手番は上がった P1 を飛ばして P2 へ');
  assert.strictEqual(core.drawTarget(state), 0, 'P2 の引く相手は P1 を飛ばして P0');
}

// 順位確定（3人）: 上がった順に順位が付き、最後に残ったジョーカー保持者が負け
{
  const state = core.createGameFromHands(
    [[C('S', 1)], [C('H', 1), C('H', 9)], [C('D', 9), JOKER]],
    0
  );
  // P0 が P1 の H1 を引く → ペアを捨てて P0 が上がり（1位）
  let r = core.drawCard(state, 0, () => 0.99);
  assert(r.ok);
  assert.deepStrictEqual(state.finishOrder, [0]);
  assert.strictEqual(state.turn, 1);
  // P1 が P2 の D9 を引く → ペアを捨てて P1 が上がり（2位）。残り P2 が負け
  // ※ P2 の手札は初期ペア捨て（removePairs）の並び替えで [JOKER, D9] になっているので位置は 1
  r = core.drawCard(state, 1, () => 0.99);
  assert(r.ok);
  assert.deepStrictEqual(state.placements, [1, 2, 3]);
  assert.strictEqual(state.loser, 2);
  assert.strictEqual(state.winner, 0);
  assert(state.hands[2].some(core.isJoker), '敗者はジョーカーを持っているはず');
  assert.strictEqual(core.drawCard(state, 0).ok, false, '決着後は引けない');
}

// publicView（多人数）: 全員の枚数と上がり状態は見えるが、他人の手札の中身は見えない
{
  const state = core.createGameFromHands(
    [[C('S', 1), C('S', 2)], [C('H', 3)], [C('C', 13), JOKER]],
    2
  );
  const view = core.publicView(state, 0);
  assert.deepStrictEqual(view.counts, [2, 1, 2]);
  assert.deepStrictEqual(view.finished, [false, false, false]);
  assert.strictEqual(view.turn, 2);
  assert.strictEqual(view.yourTurn, false);
  assert.strictEqual(view.drawTarget, 0, 'P2 の引く相手は P0');
  assert(!JSON.stringify(view).includes('"rank":13'), '他人のカードが見えてはいけない');
  assert(!JSON.stringify(view).includes('"rank":3'), '他人のカードが見えてはいけない');
  const view2 = core.publicView(state, 2);
  assert.strictEqual(view2.yourTurn, true);
  assert.strictEqual(view2.yourHand.length, 2);
}

// Bot だけのシミュレーション（3人・4人）: 必ず終わり、順位は 1..n の順列、敗者はジョーカー持ち
for (const n of [3, 4]) {
  for (let seed = 1; seed <= 20; seed++) {
    const rng = lcg(seed * 777 + n);
    const state = core.createGame({ rng, firstPlayer: seed % n, playerCount: n });
    let guard = 0;
    while (state.placements === null && guard++ < 10000) {
      const target = core.drawTarget(state);
      assert(target !== null && !state.finished[target]);
      const r = core.drawCard(state, core.chooseBotPosition(state.hands[target].length, rng), rng);
      assert(r.ok, `n=${n} seed=${seed} で着手が失敗`);
      for (const h of state.hands) assert(core.hasNoPairs(h));
    }
    assert(state.placements !== null, `n=${n} seed=${seed} で対局が終わらなかった`);
    assert.deepStrictEqual([...state.placements].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i + 1));
    assert(state.hands[state.loser].some(core.isJoker), `n=${n} seed=${seed} で敗者がジョーカーを持っていない`);
    state.hands.forEach((h, i) => {
      if (i !== state.loser) assert.strictEqual(h.length, 0, `n=${n} seed=${seed} で敗者以外に手札が残っている`);
    });
    assert.strictEqual(state.winner, state.finishOrder[0]);
  }
}

console.log('test-babanuki-core: OK');
