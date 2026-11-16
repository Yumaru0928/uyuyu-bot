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

console.log('test-babanuki-core: OK');
