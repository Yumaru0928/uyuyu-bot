'use strict';

// 対戦履歴のリプレイ再生（サーバー側でステップ列を生成する）
//
// 記録は「各局の牌山（108枚の並び）＋全アクション」の形で保存されている
// （utils/mahjong-game.js の enableRecord）。エンジンの乱数は牌山生成だけなので、
// 同じ入口関数に記録を流し込めば対局を完全再現できる。
// ここでは再現しながら各ステップの全情報スナップショットを作り、
// クライアント（再生画面）はそれを描くだけにする。

const game = require('./mahjong-game.js');

function seatWindKind(match, seat) {
  return 27 + ((seat - match.dealer + 3) % 3);
}

function snapshot(match, extra = {}) {
  return {
    label: game.roundLabel(match),
    honba: match.honba,
    kyotaku: match.kyotaku,
    turn: match.turn,
    phase: match.phase,
    wallLeft: game.liveWallCount(match),
    wall: [...match.wall],
    deadWall: [...match.deadWall],
    doraIndicators: [...match.doraIndicators],
    lastDrawn: match.lastDrawn,
    call: match.call ? { discarder: match.call.discarder, tile: match.call.tile, kind: match.call.kind } : null,
    players: match.players.map((p, s) => ({
      seat: s,
      wind: seatWindKind(match, s),
      waits: p.hand.length % 3 === 1 ? game.waitsOf(p) : null, // 聴牌詳細表示用（待ち牌の種類）
      hand: [...p.hand],
      melds: p.melds.map((m) => ({ ...m, tiles: [...m.tiles] })),
      discards: p.discards.map((d) => ({ ...d })),
      kita: p.kita,
      score: p.score,
      riichi: p.riichi,
      doubleRiichi: p.doubleRiichi,
      openRiichi: p.openRiichi,
    })),
    lastResult: (match.phase === 'roundEnd' || match.phase === 'gameEnd') ? match.lastResult : null,
    placements: match.placements,
    finalScores: match.finalScores,
    ...extra,
  };
}

function mustOk(res, ev) {
  if (res && res.ok === false) {
    throw new Error(`リプレイ再現に失敗しました（${JSON.stringify(ev)}: ${res.reason || '不明'}）`);
  }
}

/**
 * 記録からステップ列を組み立てる。
 * @param {object} record { length, rules, firstDealer, players: [{name}], rounds: [...] }
 * @returns {{ steps: Array, rounds: Array<{label, honba, firstStep, summary}> }}
 */
function buildReplay(record) {
  if (!record || !Array.isArray(record.rounds) || record.rounds.length === 0) {
    throw new Error('記録が空です');
  }
  const names = (record.players || []).map((p) => p.name || '');
  const nameOf = (seat) => names[seat] || `席${seat}`;
  const match = game.createMatch({ length: record.length, rules: record.rules });
  match.firstDealer = Number.isInteger(record.firstDealer) ? record.firstDealer : 0;
  match.dealer = match.firstDealer;

  const steps = [];
  const rounds = [];

  record.rounds.forEach((round, ri) => {
    match._wallOverride = round.wall;
    if (ri === 0) game.startRound(match);
    else game.startNextRound(match);
    // 記録時のチェックポイントと一致するか確認（壊れた記録を早期に検出する）
    if (match.dealer !== round.dealer || match.honba !== round.honba) {
      throw new Error(`リプレイ再現に失敗しました（${round.label || ri}局の親・本場が一致しません）`);
    }
    for (let s = 0; s < 3; s++) {
      if (match.players[s].score !== round.scores[s]) {
        throw new Error(`リプレイ再現に失敗しました（${round.label || ri}局の点数が一致しません）`);
      }
    }
    const firstStep = steps.length;
    let discards = 0;
    steps.push(snapshot(match, {
      round: ri, jun: 0, kind: 'start',
      desc: `${round.label || game.roundLabel(match)} ${round.honba}本場 開始`,
    }));
    const pushStep = (kind, desc, actor = null) => {
      steps.push(snapshot(match, { round: ri, jun: Math.floor(discards / 3), kind, desc, actor }));
    };
    for (const ev of round.events) {
      if (ev.t === 'd') {
        mustOk(game.applyDiscard(match, ev.s, ev.tile, { riichi: ev.riichi, openRiichi: ev.openRiichi }), ev);
        discards++;
        pushStep('discard', `${nameOf(ev.s)} が打牌${ev.riichi ? '（リーチ）' : ''}`, ev.s);
      } else if (ev.t === 'c') {
        // ロン即決でウィンドウが閉じた後に記録された残りの応答は、結果に影響しないので読み飛ばす
        // （ロン解決は非ロン応答を見ない・ダブルロンは全ロン候補の応答を待ってから即決する仕様のため）
        if (match.phase !== 'call') continue;
        mustOk(game.applyCallResponse(match, ev.s, ev.a), ev);
        if (game.callSettled(match)) {
          const beforeMelds = match.players.map((p) => p.melds.length);
          game.resolveCall(match);
          let desc = '見送り';
          let actor = null;
          if (match.phase === 'roundEnd' && match.lastResult) {
            desc = match.lastResult.type === 'ron' ? 'ロン' : '局終了';
            actor = match.lastResult.winner ?? null;
          } else {
            const meldSeat = match.players.findIndex((p, s) => p.melds.length > beforeMelds[s]);
            if (meldSeat >= 0) {
              desc = `${nameOf(meldSeat)} が${match.players[meldSeat].melds.at(-1).type === 'kan' ? 'カン' : 'ポン'}`;
              actor = meldSeat;
            }
          }
          pushStep('call', desc, actor);
        }
      } else if (ev.t === 't') {
        mustOk(game.applyTsumo(match, ev.s), ev);
        pushStep('tsumo', `${nameOf(ev.s)} がツモ和了`, ev.s);
      } else if (ev.t === 'k') {
        mustOk(game.applyKan(match, ev.s, ev.tile, ev.kind), ev);
        pushStep('kan', `${nameOf(ev.s)} が槓`, ev.s);
      } else if (ev.t === 'n') {
        mustOk(game.applyNuki(match, ev.s), ev);
        pushStep('nuki', `${nameOf(ev.s)} が北抜き`, ev.s);
      } else if (ev.t === 'q') {
        mustOk(game.applyKyuushu(match, ev.s), ev);
        pushStep('draw', '九種九牌で流局', ev.s);
      } else {
        throw new Error(`未知の記録イベントです: ${JSON.stringify(ev)}`);
      }
    }
    if (match.phase !== 'roundEnd' && match.phase !== 'gameEnd') {
      throw new Error(`リプレイ再現に失敗しました（${round.label || ri}局が終了しませんでした）`);
    }
    const last = steps[steps.length - 1];
    rounds.push({
      label: round.label || game.roundLabel(match),
      honba: round.honba,
      firstStep,
      summary: last && last.lastResult ? last.lastResult : null,
    });
    // 最終局のあとは startNextRound が finishMatch を呼んで順位・最終スコアを確定させる
    if (ri === record.rounds.length - 1 && match.phase === 'roundEnd') {
      game.startNextRound(match);
      if (match.phase === 'gameEnd') {
        steps.push(snapshot(match, {
          round: ri, jun: steps[steps.length - 1].jun, kind: 'end', desc: '終局',
        }));
      }
    }
  });

  return { steps, rounds };
}

module.exports = { buildReplay };
