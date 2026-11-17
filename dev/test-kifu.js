#!/usr/bin/env node
'use strict';

// 棋譜（保存ストア＋お気に入り＋30日クリーンアップ＋再生ロジック）のテスト。 node dev/test-kifu.js

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 記録ストアの保存先をテスト用の一時ファイルに向ける（require 前に設定すること）
const TMP_FILE = path.join(os.tmpdir(), `uyuyu-kifu-test-${process.pid}.json`);
try { fs.unlinkSync(TMP_FILE); } catch { /* 無ければ何もしない */ }
process.env.KIFU_LOCAL_PATH = TMP_FILE;

const kifuStore = require('../utils/kifu-store.js');
const replay = require('../utils/kifu-replay.js');
const othelloCore = require('../utils/othello-core.js');
const connect4Core = require('../utils/connect4-core.js');
const shogiCore = require('../utils/shogi-core.js');
const boardImage = require('../utils/board-image.js');

// 決定的な乱数（テスト用 LCG）
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const HUMAN_A = { id: 'user-a', name: 'Aさん', bot: false };
const HUMAN_B = { id: 'user-b', name: 'Bさん', bot: false };
const BOT = { id: 'bot-1', name: 'うゆゆBot', bot: true };
const DAY = 24 * 60 * 60 * 1000;

async function main() {
  // ---- 保存と読み戻し ----
  let first;
  {
    first = kifuStore.recordGame({
      game: 'shogi',
      players: [HUMAN_A, HUMAN_B],
      firstId: 'user-a',
      winnerId: 'user-b',
      reason: 'resign',
      moves: ['7g7f', '3c3d', '2g2f'],
      level: null,
    });
    assert(first, '棋譜が保存されなかった');
    assert.strictEqual(first.code.length, 6);
    const byCode = kifuStore.getByCode(first.code);
    assert.deepStrictEqual(byCode, first);
    assert.strictEqual(kifuStore.getByCode(first.code.toLowerCase())?.id, first.id, 'コードは大文字小文字を区別しない');
    assert.strictEqual(kifuStore.getByCode('ZZZZZZ'), null);
    console.log('棋譜の保存と読み戻し: OK');
  }

  // ---- コードの一意性 ----
  {
    const codes = new Set([first.code]);
    for (let i = 0; i < 100; i++) {
      const rec = kifuStore.recordGame({
        game: 'connect4',
        players: [HUMAN_A, BOT],
        firstId: 'user-a',
        winnerId: 'user-a',
        reason: 'four',
        moves: [3, 3, 4],
        level: 'normal',
      });
      assert(rec, '棋譜が保存されなかった');
      assert(/^[A-Z2-9]{6}$/.test(rec.code), `コードの形式が違う: ${rec.code}`);
      assert(!/[ILO01]/.test(rec.code), `紛らわしい文字が混ざっている: ${rec.code}`);
      codes.add(rec.code);
    }
    assert.strictEqual(codes.size, 101, 'コードが重複した');
    console.log('棋譜コードの一意性（101件）: OK');
  }

  // ---- 一覧（自分の対局だけ・新しい順） ----
  {
    const mine = kifuStore.listForUser('user-a');
    assert.strictEqual(mine.length, 101);
    assert(mine.every((r) => r.players.some((p) => p.id === 'user-a')));
    for (let i = 1; i < mine.length; i++) {
      assert(mine[i - 1].createdAt >= mine[i].createdAt, '新しい順になっていない');
    }
    assert.strictEqual(kifuStore.listForUser('user-b').length, 1);
    assert.strictEqual(kifuStore.listForUser('nobody').length, 0);
    console.log('自分の対局一覧: OK');
  }

  // ---- お気に入りと名前 ----
  {
    const id = first.id;
    assert.strictEqual(kifuStore.getFavorite('user-a', id), null);
    assert.strictEqual(kifuStore.setFavorite('user-a', id, true, '  決勝の投了  '), true);
    let fav = kifuStore.getFavorite('user-a', id);
    assert.strictEqual(fav.name, '決勝の投了', '前後の空白は取り除く');
    // 名前を省略したら維持される
    assert.strictEqual(kifuStore.setFavorite('user-a', id, true), true);
    assert.strictEqual(kifuStore.getFavorite('user-a', id).name, '決勝の投了');
    // 空文字で名前だけ消す
    kifuStore.setFavorite('user-a', id, true, '');
    assert.strictEqual(kifuStore.getFavorite('user-a', id).name, null);
    // 50文字に切り詰める
    kifuStore.setFavorite('user-a', id, true, 'あ'.repeat(80));
    assert.strictEqual(kifuStore.getFavorite('user-a', id).name.length, 50);
    // 他人のお気に入りには影響しない
    assert.strictEqual(kifuStore.getFavorite('user-b', id), null);
    // 解除すると消える
    kifuStore.setFavorite('user-a', id, false);
    assert.strictEqual(kifuStore.getFavorite('user-a', id), null);
    // 実在しない棋譜には付けられない
    assert.strictEqual(kifuStore.setFavorite('user-a', 'no-such-id', true), false);
    console.log('お気に入りと名前の設定・取得: OK');
  }

  // ---- 30日クリーンアップ（お気に入りは残る） ----
  {
    const now = Date.now();
    const mk = (id, code, createdAt) => ({
      id, code, game: 'connect4',
      players: [HUMAN_A, HUMAN_B],
      firstId: 'user-a', winnerId: 'user-a', reason: 'four',
      moves: [3, 3, 4], level: null, createdAt,
    });
    kifuStore.importRecords({
      version: 1,
      records: [
        mk('old-unfav', 'OLDUNF', now - 31 * DAY), // 31日前・お気に入りなし → 消える
        mk('old-fav', 'OLDFAV', now - 31 * DAY), //   31日前・お気に入りあり → 残る
        mk('edge-29', 'EDGE29', now - 29 * DAY), //   29日前 → 残る
        mk('recent', 'RECENT', now), //               新しい → 残る
      ],
      favorites: { 'user-a': { 'old-fav': { name: '名局', at: now } } },
    });
    // 新規保存のタイミングでクリーンアップが走る
    kifuStore.recordGame({
      game: 'othello',
      players: [HUMAN_A, HUMAN_B],
      firstId: 'user-b',
      winnerId: null,
      reason: 'score',
      moves: [{ x: 5, y: 4 }],
      level: null,
    });
    assert.strictEqual(kifuStore.getByCode('OLDUNF'), null, '30日超え・お気に入りなしが消えていない');
    assert(kifuStore.getByCode('OLDFAV'), '30日超えでもお気に入りは残るはず');
    assert(kifuStore.getByCode('EDGE29'), '29日前は残るはず');
    assert(kifuStore.getByCode('RECENT'), '新しい棋譜が消えた');
    assert.strictEqual(kifuStore.getFavorite('user-a', 'old-fav')?.name, '名局');
    console.log('30日クリーンアップ（お気に入りは削除免除）: OK');
  }

  // ---- 再生: オセロ（パス再現を含む） ----
  {
    const rand = lcg(42);
    let totalPasses = 0;
    for (let g = 0; g < 60; g++) {
      // コマンド側の doMove と同じ規則でランダムに対局を進める（パスは着手列に入らない）
      const board = othelloCore.createBoard();
      const moves = [];
      let turn = othelloCore.BLACK;
      for (;;) {
        if (othelloCore.getLegalMoves(board, turn).length === 0) {
          if (othelloCore.getLegalMoves(board, 3 - turn).length === 0) break;
          totalPasses++;
          turn = 3 - turn;
          continue;
        }
        const legal = othelloCore.getLegalMoves(board, turn);
        const m = legal[Math.floor(rand() * legal.length)];
        othelloCore.place(board, m.x, m.y, turn);
        moves.push({ x: m.x, y: m.y });
        turn = 3 - turn;
      }
      const rec = { game: 'othello', moves };
      // 最終局面が一致する
      assert.deepStrictEqual(replay.othelloBoardAt(moves, moves.length).board, board, `対局${g}: 最終局面が一致しない`);
      // 途中の手数でも「石の総数 = 4 + 手数」が保たれる（パスの読み違いがあると崩れる）
      for (let k = 0; k <= moves.length; k++) {
        const at = replay.othelloBoardAt(moves, k);
        const { black, white } = othelloCore.countStones(at.board);
        assert.strictEqual(black + white, 4 + k, `対局${g} ${k}手目: 石の数が合わない`);
      }
    }
    assert(totalPasses > 0, 'テスト対局でパスが1回も発生しなかった（前提が崩れている）');
    console.log(`再生ロジック（オセロ・パス再現）: OK（60局・パス合計${totalPasses}回）`);
  }

  // ---- 再生: 四目並べ ----
  {
    const rand = lcg(7);
    for (let g = 0; g < 40; g++) {
      const board = connect4Core.createBoard();
      const moves = [];
      let turn = connect4Core.RED;
      while (!connect4Core.findWinner(board) && !connect4Core.isFull(board)) {
        const legal = connect4Core.legalMoves(board);
        const col = legal[Math.floor(rand() * legal.length)];
        connect4Core.drop(board, col, turn);
        moves.push(col);
        turn = 3 - turn;
      }
      const at = replay.connect4BoardAt(moves, moves.length);
      assert.deepStrictEqual(at.board, board, `対局${g}: 最終局面が一致しない`);
      const win = connect4Core.findWinner(board);
      assert.deepStrictEqual(at.winLine, win ? win.line : null);
    }
    console.log('再生ロジック（四目並べ）: OK');
  }

  // ---- 再生: 将棋 ----
  {
    // 合法手を順に選んで30手ぶんの指し手列を作る
    const game = new shogiCore.ShogiGame();
    const rand = lcg(3);
    for (let i = 0; i < 30 && !game.outcome(); i++) {
      const legal = game.legalMoves();
      game.play(legal[Math.floor(rand() * legal.length)]);
    }
    const moves = [...game.moves];
    assert(moves.length > 0);
    for (const k of [0, 1, 5, moves.length]) {
      const expected = new shogiCore.ShogiGame(moves.slice(0, k));
      const at = replay.shogiPositionAt(moves, k);
      assert.strictEqual(shogiCore.toSfen(at.pos, false), shogiCore.toSfen(expected.pos, false), `${k}手目が一致しない`);
    }
    console.log('再生ロジック（将棋）: OK');
  }

  // ---- ply のクランプと着手ラベル ----
  {
    const rec = { game: 'othello', moves: [{ x: 5, y: 4 }, { x: 5, y: 5 }] };
    assert.strictEqual(replay.clampPly(rec, -3), 0);
    assert.strictEqual(replay.clampPly(rec, 99), 2);
    assert.strictEqual(replay.clampPly(rec, '1'), 1);
    assert.strictEqual(replay.clampPly(rec, undefined), 0);
    assert.deepStrictEqual(replay.moveLabels(rec), ['F5', 'F6']);
    assert.deepStrictEqual(replay.moveLabels({ game: 'connect4', moves: [3, 0] }), ['4列', '1列']);
    assert.deepStrictEqual(replay.moveLabels({ game: 'shogi', moves: ['7g7f'] }), ['7g7f']);
    console.log('ply のクランプと着手ラベル: OK');
  }

  // ---- 盤面画像の生成 ----
  if (boardImage.available) {
    const png = (buf) => Buffer.isBuffer(buf) && buf[0] === 0x89 && buf[1] === 0x50;
    assert(png(replay.renderPositionPng({ game: 'shogi', moves: ['7g7f', '3c3d'] }, 2)), '将棋の盤面画像が作れない');
    assert(png(replay.renderPositionPng({ game: 'othello', moves: [{ x: 5, y: 4 }] }, 1)), 'オセロの盤面画像が作れない');
    assert(png(replay.renderPositionPng({ game: 'connect4', moves: [3, 3, 4] }, 3)), '四目並べの盤面画像が作れない');
    console.log('盤面画像の生成（3ゲーム）: OK');
  } else {
    console.log('盤面画像の生成: Canvas が使えない環境のためスキップ');
  }

  await kifuStore.flush();
  try { fs.unlinkSync(TMP_FILE); } catch { /* 無ければ何もしない */ }
  console.log('test-kifu: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
