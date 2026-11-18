'use strict';

// 対戦履歴のリプレイ再現テスト:
// 記録を有効にして Bot 戦を最後まで打ち、その記録（JSON 往復後）から
// buildReplay で再現した結果が、元の対局と一致することを確認する。
const assert = require('node:assert');
const game = require('../utils/mahjong-game.js');
const { buildReplay } = require('../utils/mahjong-replay.js');

function playRecordedMatch(length, rules, label) {
  const match = game.createMatch({ length, rules });
  match.firstDealer = 2;
  match.dealer = 2;
  game.enableRecord(match);
  game.startRound(match);
  const roundResults = [];
  let guard = 0;
  while (match.phase !== 'gameEnd') {
    assert(++guard < 200000, `${label}: ループが収束しない`);
    if (match.phase === 'roundEnd') {
      roundResults.push(JSON.parse(JSON.stringify(match.lastResult)));
      game.startNextRound(match);
      continue;
    }
    if (match.phase === 'call') {
      for (const seat of Object.keys(match.call.options).map(Number)) {
        game.applyCallResponse(match, seat, game.botChooseCall(match, seat));
      }
      assert(game.callSettled(match), `${label}: 応答がそろわない`);
      game.resolveCall(match);
      continue;
    }
    const seat = match.turn;
    const act = game.botChoosePlay(match, seat);
    let r;
    if (act.type === 'tsumo') r = game.applyTsumo(match, seat);
    else if (act.type === 'kyuushu') r = game.applyKyuushu(match, seat);
    else if (act.type === 'nuki') r = game.applyNuki(match, seat);
    else if (act.type === 'kan') r = game.applyKan(match, seat, act.tile, act.kanKind);
    else r = game.applyDiscard(match, seat, act.tile, { riichi: act.riichi, openRiichi: act.openRiichi });
    assert(r.ok, `${label}: アクション失敗 ${JSON.stringify(act)}: ${r.reason}`);
  }
  roundResults.push(JSON.parse(JSON.stringify(match.lastResult))); // gameEnd の結果
  return { match, roundResults };
}

function check(length, rules, label) {
  const { match, roundResults } = playRecordedMatch(length, rules, label);
  const record = JSON.parse(JSON.stringify({
    length: match.length,
    rules: match.rules,
    firstDealer: match.firstDealer,
    players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    rounds: match.record.rounds,
  }));
  const { steps, rounds } = buildReplay(record);
  assert(steps.length > record.rounds.length * 10, `${label}: ステップが少なすぎる (${steps.length})`);
  assert.strictEqual(rounds.length, record.rounds.length, `${label}: 局数が一致しない`);
  const finalStep = steps[steps.length - 1];
  assert.deepStrictEqual(finalStep.placements, match.placements, `${label}: 順位が一致しない`);
  assert.deepStrictEqual(finalStep.finalScores, match.finalScores, `${label}: 最終スコアが一致しない`);
  assert.deepStrictEqual(
    finalStep.players.map((p) => p.score),
    match.players.map((p) => p.score),
    `${label}: 最終点数が一致しない`,
  );
  // 各局の結果（最終ステップの lastResult）が元の対局と一致すること
  rounds.forEach((r, i) => {
    const orig = roundResults[i];
    assert.strictEqual(r.summary.type, orig.type, `${label}: ${i}局目の結果種別が一致しない`);
    assert.deepStrictEqual(r.summary.scores, orig.scores, `${label}: ${i}局目の局後点数が一致しない`);
    if (orig.type === 'ron' || orig.type === 'tsumo') {
      assert.deepStrictEqual(r.summary.yaku, orig.yaku, `${label}: ${i}局目の役が一致しない`);
      assert.strictEqual(r.summary.han, orig.han, `${label}: ${i}局目の翻が一致しない`);
    }
  });
  console.log(`ok: ${label}（${rounds.length}局 / ${steps.length}ステップ）`);
}

check('east', null, '東風・規定ルール');
check('south', null, '半荘・規定ルール');
check('east', { kita: false, redDora: false, uraDora: false }, '東風・北抜き/赤/裏なし');
check('east', { openRiichi: true, doubleRon: true }, '東風・オープンリーチ/ダブルロン');
check('south', { startScore: 25000, returnScore: 30000, targetScore: 30000 }, '半荘・25000開始');
console.log('test-mahjong-replay: all ok');
