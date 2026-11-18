'use strict';

// 麻雀の対戦履歴ストアのテスト:
// Bot 戦を記録→ストアへ保存→読み戻し→再生が一致することと、
// 一覧・お気に入り・期限切れ掃除の基本動作を確認する。
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.MAHJONG_HISTORY_LOCAL_PATH = path.join(os.tmpdir(), `mj-history-test-${process.pid}.json`);
fs.rmSync(process.env.MAHJONG_HISTORY_LOCAL_PATH, { force: true });

const game = require('../utils/mahjong-game.js');
const store = require('../utils/mahjong-history-store.js');
const { buildReplay } = require('../utils/mahjong-replay.js');

function playRecordedMatch() {
  const match = game.createMatch({ length: 'east' });
  match.firstDealer = 2;
  match.dealer = 2;
  game.enableRecord(match);
  game.startRound(match);
  let guard = 0;
  while (match.phase !== 'gameEnd') {
    assert(++guard < 200000, 'ループが収束しない');
    if (match.phase === 'roundEnd') { game.startNextRound(match); continue; }
    if (match.phase === 'call') {
      for (const seat of Object.keys(match.call.options).map(Number)) {
        game.applyCallResponse(match, seat, game.botChooseCall(match, seat));
      }
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
    else r = game.applyDiscard(match, seat, act.tile, { riichi: act.riichi });
    assert(r.ok, `アクション失敗: ${r.reason}`);
  }
  return match;
}

async function main() {
  const match = playRecordedMatch();
  const players = [
    { id: 'user-1', name: '先生', bot: false },
    { id: 'BOT', name: 'Bot 1', bot: true },
    { id: 'BOT', name: 'Bot 2', bot: true },
  ];
  const rec = store.recordMatch({
    length: match.length,
    players,
    firstDealer: match.firstDealer,
    placements: match.placements,
    finalScores: match.finalScores,
    scores: match.players.map((p) => p.score),
    rules: match.rules,
    rounds: match.record.rounds,
  });
  assert(rec, '保存に失敗した');
  assert(/^[A-Z2-9]{6}$/.test(rec.code), `コード形式が不正: ${rec.code}`);

  // コード引き・一覧
  const byCode = store.getByCode(rec.code.toLowerCase());
  assert(byCode && byCode.id === rec.id, 'コードで引けない');
  const mine = store.listForUser('user-1');
  assert.strictEqual(mine.length, 1, '自分の対局が一覧に出ない');
  assert.strictEqual(store.listForUser('user-2').length, 0, '他人の対局が一覧に出ている');
  assert.strictEqual(store.listForUser('BOT').length, 0, 'Bot の対局が一覧に出ている');

  // 読み戻した記録から再生が一致する
  const { steps, rounds } = buildReplay(byCode);
  const finalStep = steps[steps.length - 1];
  assert.deepStrictEqual(finalStep.placements, match.placements, '再生の順位が一致しない');
  assert.strictEqual(rounds.length, match.record.rounds.length, '再生の局数が一致しない');

  // お気に入り
  assert.strictEqual(store.getFavorite('user-1', rec.id), null);
  assert(store.setFavorite('user-1', rec.id, true, 'テスト対局'));
  assert.deepStrictEqual(store.getFavorite('user-1', rec.id).name, 'テスト対局');
  assert(store.setFavorite('user-1', rec.id, false));
  assert.strictEqual(store.getFavorite('user-1', rec.id), null);

  // 期限切れ掃除: お気に入り済みは残り、未登録の古い記録は消える
  const old = store.recordMatch({
    length: match.length, players, firstDealer: 2,
    placements: match.placements, finalScores: match.finalScores,
    scores: match.players.map((p) => p.score), rules: match.rules, rounds: match.record.rounds,
  });
  store.store.data.records.find((r) => r.id === old.id).createdAt = Date.now() - store.RETENTION_MS - 1000;
  store.store.data.records.find((r) => r.id === rec.id).createdAt = Date.now() - store.RETENTION_MS - 1000;
  store.setFavorite('user-1', rec.id, true);
  store.cleanup(store.store.data);
  assert(store.getById(rec.id), 'お気に入り済みの古い記録が消えた');
  assert(!store.getById(old.id), '期限切れの記録が残っている');

  await store.flush();
  fs.rmSync(process.env.MAHJONG_HISTORY_LOCAL_PATH, { force: true });
  console.log('test-mahjong-history: all ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
