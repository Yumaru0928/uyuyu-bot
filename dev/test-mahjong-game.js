'use strict';

// mahjong-game のシミュレーションテスト: 全席 Bot で対局を最後まで回し、
// 状態が壊れないこと・点数合計が保存されることを確認する
const assert = require('node:assert');
const game = require('../utils/mahjong-game.js');

function playMatch(length, seedLabel) {
  const match = game.createMatch({ length });
  game.startRound(match);
  let steps = 0;
  let rounds = 0;
  let guard = 0;
  while (match.phase !== 'gameEnd') {
    assert(++guard < 200000, `${seedLabel}: ループが収束しない`);
    if (match.phase === 'roundEnd') {
      rounds++;
      game.startNextRound(match);
      continue;
    }
    if (match.phase === 'call') {
      for (const seat of Object.keys(match.call.options).map(Number)) {
        game.applyCallResponse(match, seat, game.botChooseCall(match, seat));
      }
      assert(game.callSettled(match), `${seedLabel}: 応答がそろわない`);
      game.resolveCall(match);
      steps++;
      continue;
    }
    // phase === 'play'
    const seat = match.turn;
    const act = game.botChoosePlay(match, seat);
    if (act.type === 'tsumo') {
      const r = game.applyTsumo(match, seat);
      assert(r.ok, `${seedLabel}: ツモ和了が失敗: ${r.reason}`);
    } else if (act.type === 'nuki') {
      const r = game.applyNuki(match, seat);
      assert(r.ok, `${seedLabel}: 北抜きが失敗: ${r.reason}`);
    } else if (act.type === 'kan') {
      const r = game.applyKan(match, seat, act.tile, act.kanKind);
      assert(r.ok, `${seedLabel}: 槓が失敗: ${r.reason}`);
    } else {
      const r = game.applyDiscard(match, seat, act.tile, { riichi: act.riichi });
      assert(r.ok, `${seedLabel}: 打牌が失敗: ${r.reason}`);
    }
    steps++;
    // 点数の整合性チェック（供託と場の合計が START*3 になること）
    const total = match.players.reduce((a, p) => a + p.score, 0) + match.kyotaku * 1000;
    assert.strictEqual(total, game.START_SCORE * 3, `${seedLabel}: 点数合計が合わない (${total})`);
    for (const p of match.players) {
      // 槓は4枚で3枚分として数える（構造上の枚数）
      const handTiles = p.hand.length + p.melds.reduce((a, m) => a + m.tiles.length - (m.type === 'kan' ? 1 : 0), 0);
      assert(handTiles <= 14, `${seedLabel}: 手牌枚数が異常 (${handTiles})`);
    }
  }
  assert(match.placements, `${seedLabel}: 順位が確定していない`);
  const finalTotal = match.players.reduce((a, p) => a + p.score, 0);
  assert.strictEqual(finalTotal, game.START_SCORE * 3, `${seedLabel}: 最終点数合計が合わない`);
  return { rounds, steps, scores: match.players.map((p) => p.score), placements: match.placements };
}

for (const length of ['east', 'south']) {
  for (let i = 0; i < 6; i++) {
    const r = playMatch(length, `${length}-${i}`);
    console.log(`[test-mahjong-game] ${length} #${i}: ${r.rounds}局 ${r.steps}手 scores=${r.scores.join('/')} placements=${r.placements.join('/')}`);
  }
}
console.log('[test-mahjong-game] OK');
