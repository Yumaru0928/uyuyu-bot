'use strict';

// ババ抜き（2〜4人）のルール。UI・通信からは分離した純粋なロジックだけを置く。
//
// カードは { suit, rank } のオブジェクト。suit は 'S'|'H'|'D'|'C'、rank は 1〜13。
// ジョーカーは { joker: true }。ペアは「同じ rank の2枚」で、スートは問わない。
// 山札は 52枚＋ジョーカー1枚の53枚を全員に配り切る。
//
// 状態（state）:
// {
//   hands: [ [card...], ... ],   // プレイヤーごとの手札（添字がプレイヤー番号）
//   turn: number,                 // いま引く番のプレイヤー
//   finished: [bool, ...],        // 手札が空になって「上がり」になったかどうか
//   finishOrder: [number, ...],   // 上がった順のプレイヤー番号（敗者は含まない）
//   loser: null | number,         // 最後まで残った1人（ジョーカー保持者）。決着まで null
//   winner: null | number,        // 1位のプレイヤー（決着まで null。2人対戦の v1 互換）
//   placements: null | [number],  // プレイヤーごとの順位（1始まり）。決着まで null
//   lastEvent: null | {...}       // 直近の出来事（表示用。引いたカードそのものは含めない）
// }
//
// ルール: 手番の人は「時計回りで次の、まだ上がっていないプレイヤー」の手札から裏向きで
// 1枚引く（引かれる側の手札は引く前にシャッフルする）。ペアができたら自動で捨てる。
// 手札が0枚になったプレイヤーは上がりで、以降の手番はスキップされる。
// 最後まで残った1人が負け（ジョーカーを持っている）。順位は上がった順。
// 相手の最後の1枚を引いて相手が空になった場合も、相手が上がりになる
// （2人対戦の v1 で「相手の勝ち」としていた解釈の一般化）。
// 1手で引いた側と引かれた側が同時に空になった場合は、行動を完結させた引いた側を
// 先の上がりとする（v1 の「両方同時に空なら引いた側の勝ち」という解釈の踏襲）。

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

// まだ上がっていない（手札が残っている）プレイヤーの一覧
function activePlayers(state) {
  const out = [];
  state.hands.forEach((_, i) => { if (!state.finished[i]) out.push(i); });
  return out;
}

// from の時計回りで次にいる、まだ上がっていないプレイヤー（from 自身は除く）。
// いなければ null（＝残り1人以下で、対局は終了しているはず）
function nextActivePlayer(state, from) {
  const n = state.hands.length;
  for (let step = 1; step < n; step++) {
    const idx = (from + step) % n;
    if (!state.finished[idx]) return idx;
  }
  return null;
}

// いま手番のプレイヤーが引く相手（次の未上がりプレイヤー）。対局終了時は null
function drawTarget(state) {
  if (state.placements !== null) return null;
  return nextActivePlayer(state, state.turn);
}

// 残り1人以下になったら決着を付ける（順位・敗者・勝者を確定させる）
function finalizeIfOver(state) {
  if (state.placements !== null) return;
  const active = activePlayers(state);
  if (active.length > 1) return;
  const n = state.hands.length;
  const placements = new Array(n).fill(null);
  state.finishOrder.forEach((player, i) => { placements[player] = i + 1; });
  state.loser = active.length === 1 ? active[0] : null;
  if (state.loser !== null) placements[state.loser] = n;
  state.placements = placements;
  state.winner = state.finishOrder.length > 0 ? state.finishOrder[0] : null;
}

// 対局の初期状態を作る。配って、最初のペアは自動で捨てる。
// firstPlayer は最初に引く番。playerCount は 2〜4（ルームの定員はサーバー側で制限）。
function createGame({ rng = Math.random, firstPlayer = 0, playerCount = 2 } = {}) {
  const count = Math.max(2, Math.min(8, Math.floor(playerCount) || 2));
  const deck = shuffle(createDeck(), rng);
  const hands = Array.from({ length: count }, () => []);
  deck.forEach((card, i) => hands[i % count].push(card));
  return createGameFromHands(hands, firstPlayer);
}

// 任意の手札から対局を始める（初期ペア捨てと勝敗判定を含む。テスト・再戦用）
function createGameFromHands(hands, firstPlayer = 0) {
  const cleaned = hands.map((h) => removePairs(h).hand);
  const state = {
    hands: cleaned,
    turn: firstPlayer,
    finished: cleaned.map((h) => h.length === 0),
    finishOrder: [],
    loser: null,
    winner: null,
    placements: null,
    lastEvent: null,
  };
  // 配った時点で手札が空のプレイヤーは上がり扱い。同時上がりの順序は席順で確定させる
  state.finished.forEach((f, i) => { if (f) state.finishOrder.push(i); });
  finalizeIfOver(state);
  // 手番が上がり済みのプレイヤーを指していたら、次の未上がりプレイヤーへ進める
  if (state.placements === null && state.finished[state.turn]) {
    const next = nextActivePlayer(state, state.turn);
    if (next !== null) state.turn = next;
  }
  return state;
}

/**
 * 手番のプレイヤーが、次の未上がりプレイヤーの手札から position 番目の1枚を引く。
 * 相手の手札は引く前にシャッフルする（並び順から中身が推測できないようにするため）。
 * 引いたカードとペアになるカードがあれば自動で捨てる。
 * @returns {{ ok: true, drawn: object, drawnFrom: number, discardedPair: boolean,
 *             finishedNow: number[], loser: null|number }
 *          | { ok: false, reason: string }}
 *          drawn は「引いた本人」にだけ見せる想定の情報。相手向けの表示には使わない。
 */
function drawCard(state, position, rng = Math.random) {
  if (state.placements !== null) return { ok: false, reason: '対局は終了しています' };
  const me = state.turn;
  if (state.finished[me]) return { ok: false, reason: 'そのプレイヤーは上がり済みです' };
  const opp = nextActivePlayer(state, me);
  if (opp === null) return { ok: false, reason: '引く相手がいません' };
  const oppHand = state.hands[opp];
  if (!Number.isInteger(position) || position < 0 || position >= oppHand.length) {
    return { ok: false, reason: 'その位置のカードは引けません' };
  }

  state.hands[opp] = shuffle(oppHand, rng);
  const [drawn] = state.hands[opp].splice(position, 1);
  state.hands[me].push(drawn);
  const { hand, discarded } = removePairs(state.hands[me]);
  state.hands[me] = hand;
  const discardedPair = discarded.length > 0;

  // 上がり判定。同時に空になった場合は引いた側を先とする（ファイル冒頭の解釈どおり）
  const finishedNow = [];
  if (state.hands[me].length === 0 && !state.finished[me]) finishedNow.push(me);
  if (state.hands[opp].length === 0 && !state.finished[opp]) finishedNow.push(opp);
  for (const p of finishedNow) {
    state.finished[p] = true;
    state.finishOrder.push(p);
  }

  state.lastEvent = {
    type: 'draw',
    player: me,
    from: opp,
    discardedPair,
    // 捨てたペアの2枚（捨てた時点で公開情報なので、全プレイヤーへ送ってよい）。
    // ペア捨てのアニメーション表示用。無ければ null。
    pair: discardedPair ? [...discarded] : null,
    finishedNow: [...finishedNow],
    handCounts: state.hands.map((h) => h.length),
  };

  finalizeIfOver(state);
  if (state.placements === null) {
    const next = nextActivePlayer(state, me);
    if (next !== null) state.turn = next;
  }
  return { ok: true, drawn, drawnFrom: opp, discardedPair, finishedNow, loser: state.loser };
}

// Bot の手: 相手の手札からランダムな位置を1つ選ぶ（ババ抜きの Bot に読みは要らない）
function chooseBotPosition(opponentHandSize, rng = Math.random) {
  if (!Number.isInteger(opponentHandSize) || opponentHandSize <= 0) return -1;
  return Math.floor(rng() * opponentHandSize);
}

// そのプレイヤー視点の公開情報（他のプレイヤーの手札の中身は含めない）
function publicView(state, player) {
  const counts = state.hands.map((h) => h.length);
  const over = state.placements !== null;
  return {
    yourHand: [...state.hands[player]],
    yourCount: counts[player],
    counts,
    // 2人対戦の v1 互換: 相手全員の合計枚数（2人なら相手の枚数そのもの）
    opponentCount: counts.reduce((sum, c, i) => (i === player ? sum : sum + c), 0),
    finished: [...state.finished],
    finishOrder: [...state.finishOrder],
    youFinished: Boolean(state.finished[player]),
    turn: state.turn,
    yourTurn: !over && state.turn === player && !state.finished[player],
    drawTarget: drawTarget(state),
    loser: state.loser,
    winner: state.winner,
    placements: state.placements ? [...state.placements] : null,
    yourPlace: state.placements ? state.placements[player] : null,
    youWon: state.placements ? state.placements[player] === 1 : null,
    lastEvent: state.lastEvent
      ? {
          type: state.lastEvent.type,
          // 引いた人と引かれた人のプレイヤー番号（名前はサーバー側が付ける）
          player: state.lastEvent.player,
          from: state.lastEvent.from,
          // 「引いたのが自分かどうか」「引かれたのが自分かどうか」だけでも判定できるように
          byYou: state.lastEvent.player === player,
          drawnFromYou: state.lastEvent.from === player,
          discardedPair: state.lastEvent.discardedPair,
          // 捨てたペアは公開情報なので、そのまま全プレイヤーに伝える（表示用）
          pair: state.lastEvent.pair ? state.lastEvent.pair.map((c) => ({ ...c })) : null,
          finishedNow: [...state.lastEvent.finishedNow],
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
  activePlayers,
  nextActivePlayer,
  drawTarget,
};
