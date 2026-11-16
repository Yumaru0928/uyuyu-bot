'use strict';

// ババ抜き（2人）のルール。UI・通信からは分離した純粋なロジックだけを置く。
//
// カードは { suit, rank } のオブジェクト。suit は 'S'|'H'|'D'|'C'、rank は 1〜13。
// ジョーカーは { joker: true }。ペアは「同じ rank の2枚」で、スートは問わない。
// 山札は 52枚＋ジョーカー1枚の53枚を配り切る（先手27枚・後手26枚）。
//
// 状態（state）:
// {
//   hands: [ [card...], [card...] ],  // プレイヤー0 / プレイヤー1 の手札
//   turn: 0 | 1,                      // いま引く番のプレイヤー
//   winner: null | 0 | 1,             // 勝者が決まったらそのプレイヤー
//   lastEvent: null | {...}           // 直近の出来事（表示用。引いたカードそのものは含めない）
// }
//
// 勝敗: 先に手札をなくした方が勝ち。最後にジョーカーを持っていた方が負け。
// 手札が空になるのは「ペアを捨てて空になる」か「最後の1枚を相手に引かれる」かのどちらかで、
// どちらもそのプレイヤーの勝ちとして扱う。

const SUITS = ['S', 'H', 'D', 'C'];
const JOKER = Object.freeze({ joker: true });

const isJoker = (card) => Boolean(card && card.joker);
const cardKey = (card) => (isJoker(card) ? 'JOKER' : `${card.suit}-${card.rank}`);

// 53枚のデッキを作る（シャッフル前）
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) deck.push({ suit, rank });
  }
  deck.push({ ...JOKER });
  return deck;
}

// Fisher-Yates シャッフル。rng は 0<=r<1 を返す関数（テストで差し替え可能）
function shuffle(deck, rng = Math.random) {
  const a = [...deck];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 手札からペア（同じ rank の2枚）をすべて取り除く。
// 3枚ある rank は2枚だけ捨てて1枚残す。4枚なら全部捨てる。ジョーカーは常に対象外。
// 戻り値: { hand: 残った手札, discarded: 捨てたカードの配列 }
function removePairs(hand) {
  const byRank = new Map();
  const rest = [];
  for (const card of hand) {
    if (isJoker(card)) {
      rest.push(card);
      continue;
    }
    if (!byRank.has(card.rank)) byRank.set(card.rank, []);
    byRank.get(card.rank).push(card);
  }
  const discarded = [];
  for (const cards of byRank.values()) {
    const pairs = Math.floor(cards.length / 2);
    for (let i = 0; i < pairs * 2; i++) discarded.push(cards[i]);
    if (cards.length % 2 === 1) rest.push(cards[cards.length - 1]);
  }
  return { hand: rest, discarded };
}

// 手札にペアが残っていないか（removePairs を通した後の手札は常に true）
function hasNoPairs(hand) {
  const seen = new Set();
  for (const card of hand) {
    if (isJoker(card)) continue;
    if (seen.has(card.rank)) return false;
    seen.add(card.rank);
  }
  return true;
}

// 対局の初期状態を作る。配って、最初のペアは自動で捨てる。
// firstPlayer は最初に引く番（0 か 1）。
function createGame({ rng = Math.random, firstPlayer = 0 } = {}) {
  const deck = shuffle(createDeck(), rng);
  const hands = [[], []];
  deck.forEach((card, i) => hands[i % 2].push(card));
  return createGameFromHands(hands, firstPlayer);
}

// 任意の手札から対局を始める（初期ペア捨てと勝敗判定を含む。テスト・再戦用）
function createGameFromHands(hands, firstPlayer = 0) {
  const cleaned = hands.map((h) => removePairs(h).hand);
  const state = { hands: cleaned, turn: firstPlayer, winner: null, lastEvent: null };
  // 配った時点で手札が空になったら、その場で勝ち（53枚配布では実質起きないが、規則として揃える）
  if (cleaned[0].length === 0 && cleaned[1].length === 0) {
    state.winner = firstPlayer; // 両方空はあり得ない想定。起きたら先手番側を勝ちとする
  } else if (cleaned[0].length === 0) {
    state.winner = 0;
  } else if (cleaned[1].length === 0) {
    state.winner = 1;
  }
  return state;
}

/**
 * 手番のプレイヤーが、相手の手札から position 番目の1枚を引く。
 * 相手の手札は引く前にシャッフルする（並び順から中身が推測できないようにするため）。
 * 引いたカードとペアになるカードがあれば自動で捨てる。
 * @returns {{ ok: true, drawn: object, discardedPair: boolean, winner: null|0|1 }
 *          | { ok: false, reason: string }}
 *          drawn は「引いた本人」にだけ見せる想定の情報。相手向けの表示には使わない。
 */
function drawCard(state, position, rng = Math.random) {
  if (state.winner !== null) return { ok: false, reason: '対局は終了しています' };
  const me = state.turn;
  const opp = 1 - me;
  const oppHand = state.hands[opp];
  if (oppHand.length === 0) return { ok: false, reason: '相手の手札がありません' };
  if (!Number.isInteger(position) || position < 0 || position >= oppHand.length) {
    return { ok: false, reason: 'その位置のカードは引けません' };
  }

  state.hands[opp] = shuffle(oppHand, rng);
  const [drawn] = state.hands[opp].splice(position, 1);
  state.hands[me].push(drawn);
  const before = state.hands[me].length;
  const { hand, discarded } = removePairs(state.hands[me]);
  state.hands[me] = hand;
  const discardedPair = discarded.length > 0;

  state.lastEvent = {
    type: 'draw',
    player: me,
    discardedPair,
    // 捨てたペアの2枚（捨てた時点で公開情報なので、両プレイヤーへ送ってよい）。
    // ペア捨てのアニメーション表示用。無ければ null。
    pair: discardedPair ? [...discarded] : null,
    handCounts: [state.hands[0].length, state.hands[1].length],
  };

  // 勝敗判定。引いた側がペアを捨てて空になったら引いた側の勝ち。
  // 相手の最後の1枚を引いて相手が空になったら、相手の勝ち（先に手札をなくしたのは相手）。
  // 両方同時に空になるのは「引いた側がペアを捨てて空＋相手も空」のときだけで、その場合は
  // 行動を完結させた引いた側の勝ちとする（最小解釈。決定シートへの逸脱ではなく規則の穴埋め）。
  if (state.hands[me].length === 0) {
    state.winner = me;
  } else if (state.hands[opp].length === 0) {
    state.winner = opp;
  }

  if (state.winner === null) state.turn = opp;
  return { ok: true, drawn, discardedPair, winner: state.winner };
}

// Bot の手: 相手の手札からランダムな位置を1つ選ぶ（ババ抜きの Bot に読みは要らない）
function chooseBotPosition(opponentHandSize, rng = Math.random) {
  if (!Number.isInteger(opponentHandSize) || opponentHandSize <= 0) return -1;
  return Math.floor(rng() * opponentHandSize);
}

// そのプレイヤー視点の公開情報（相手の手札の中身は含めない）
function publicView(state, player) {
  return {
    yourHand: [...state.hands[player]],
    opponentCount: state.hands[1 - player].length,
    yourCount: state.hands[player].length,
    turn: state.turn,
    yourTurn: state.winner === null && state.turn === player,
    winner: state.winner,
    youWon: state.winner === null ? null : state.winner === player,
    lastEvent: state.lastEvent
      ? {
          type: state.lastEvent.type,
          // 「引いたのが自分かどうか」だけを伝える。相手が引いたカードの中身は伝えない
          byYou: state.lastEvent.player === player,
          discardedPair: state.lastEvent.discardedPair,
          // 捨てたペアは公開情報なので、そのまま両プレイヤーに伝える（表示用）
          pair: state.lastEvent.pair ? state.lastEvent.pair.map((c) => ({ ...c })) : null,
          handCounts: [...state.lastEvent.handCounts],
        }
      : null,
  };
}

module.exports = {
  SUITS,
  JOKER,
  isJoker,
  cardKey,
  createDeck,
  shuffle,
  removePairs,
  hasNoPairs,
  createGame,
  createGameFromHands,
  drawCard,
  chooseBotPosition,
  publicView,
};
