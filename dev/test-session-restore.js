#!/usr/bin/env node
'use strict';

// 対局セッションの保存・復元の検証。 node dev/test-session-restore.js
//  ・「指す前の確認 ON/OFF」の設定（players[].confirm）が、保存→JSON化→復元をまたいでも残ること
//  ・通知メッセージID（notifyMessageId）が同じく残ること
//  ・将棋は保存された指し手列から局面が復元でき、確認設定とあわせて needsConfirm の判定が保たれること

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// sessions の保存先を一時ファイルに向ける（本体の data を汚さない）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uyuyu-sessions-'));
process.env.SESSIONS_LOCAL_PATH = path.join(tmp, 'sessions.json');

const sessions = require('../utils/sessions.js');
const shogiCore = require('../utils/shogi-core.js');

(async () => {
  const players = {
    1: { id: '111', displayName: '先手さん', isAi: false, confirm: false }, // 確認OFFにした人
    2: { id: '222', displayName: '後手さん', isAi: false }, // 未設定（=既定ON）
  };

  // --- 将棋セッションの往復 ---
  sessions.put('shogi', 'msg-shogi-1', {
    channelId: 'chan-1',
    guildId: 'guild-1',
    moves: ['7g7f', '3c3d'],
    players,
    ranked: true,
    level: 'normal',
    notifyMessageId: 'notify-1',
  });
  // --- オセロセッションの往復 ---
  sessions.put('othello', 'msg-othello-1', {
    channelId: 'chan-1',
    guildId: 'guild-1',
    board: Array.from({ length: 8 }, () => Array(8).fill(0)),
    turn: 1,
    players,
    ranked: true,
    level: 'normal',
    events: [],
    notifyMessageId: 'notify-2',
  });
  await sessions.flush();

  // ディスク上の JSON を直接読む（＝再起動後に読み込まれる実データ）
  const raw = JSON.parse(fs.readFileSync(process.env.SESSIONS_LOCAL_PATH, 'utf-8'));
  assert.strictEqual(raw.games.shogi['msg-shogi-1'].players[1].confirm, false, '将棋: 確認OFFがJSONに残る');
  assert.strictEqual(raw.games.shogi['msg-shogi-1'].notifyMessageId, 'notify-1', '将棋: 通知IDが残る');
  assert.strictEqual(raw.games.othello['msg-othello-1'].players[1].confirm, false, 'オセロ: 確認OFFがJSONに残る');

  // 復元側（list）の形でも残っていること
  const [restored] = sessions.list('shogi');
  assert.strictEqual(restored.players[1].confirm, false, '復元後も確認OFF');
  assert.strictEqual(restored.players[2].confirm, undefined, '未設定は未設定のまま（既定ONとして扱う）');

  // needsConfirm と同じ判定（players[color].confirm !== false）で、復元後も人ごとに保たれる
  const needsConfirm = (ps, color) => ps[color].confirm !== false;
  assert.strictEqual(needsConfirm(restored.players, 1), false, '先手は確認なしで指せる');
  assert.strictEqual(needsConfirm(restored.players, 2), true, '後手は確認あり');

  // 指し手列から局面が復元できる（復元の前提）
  const game = new shogiCore.ShogiGame(restored.moves);
  assert.strictEqual(game.moves.length, 2, '指し手を再生できた');
  assert.strictEqual(game.turn, shogiCore.BLACK, '2手進めたので先手番');

  // 終了した対局は消える
  assert.strictEqual(sessions.remove('shogi', 'msg-shogi-1'), true);
  assert.strictEqual(sessions.list('shogi').length, 0);

  console.log('SESSION RESTORE TESTS PASSED');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
