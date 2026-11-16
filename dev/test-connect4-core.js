#!/usr/bin/env node
'use strict';

// 四目並べコアのテスト。 node dev/test-connect4-core.js

const assert = require('node:assert');
const core = require('../utils/connect4-core.js');
const { RED, YELLOW } = core;

// 重力: 一番下に落ち、同じ列では上に積み上がる
{
  const b = core.createBoard();
  assert.deepStrictEqual(core.drop(b, 3, RED), { x: 3, y: 5 });
  assert.deepStrictEqual(core.drop(b, 3, YELLOW), { x: 3, y: 4 });
  assert.strictEqual(b[5][3], RED);
  assert.strictEqual(b[4][3], YELLOW);
}

// 満杯の列には落とせない
{
  const b = core.createBoard();
  for (let i = 0; i < 6; i++) core.drop(b, 0, i % 2 ? YELLOW : RED);
  assert.strictEqual(core.drop(b, 0, RED), null);
  assert(!core.legalMoves(b).includes(0), '満杯の列は合法手に出ない');
}

// 横の4つ
{
  const b = core.createBoard();
  for (const x of [1, 2, 3]) core.drop(b, x, RED);
  assert.strictEqual(core.findWinner(b), null);
  core.drop(b, 4, RED);
  const w = core.findWinner(b);
  assert.strictEqual(w.player, RED);
  assert.strictEqual(w.line.length, 4);
}

// 縦の4つ
{
  const b = core.createBoard();
  for (let i = 0; i < 4; i++) core.drop(b, 2, YELLOW);
  assert.strictEqual(core.findWinner(b).player, YELLOW);
}

// 斜め（右上）の4つ: 着地点を階段状に作る
{
  const b = core.createBoard();
  // (0,5) (1,4) (2,3) (3,2) に RED を置くための土台
  core.drop(b, 0, RED);
  core.drop(b, 1, YELLOW); core.drop(b, 1, RED);
  core.drop(b, 2, YELLOW); core.drop(b, 2, YELLOW); core.drop(b, 2, RED);
  core.drop(b, 3, YELLOW); core.drop(b, 3, YELLOW); core.drop(b, 3, YELLOW);
  assert.strictEqual(core.findWinner(b), null, '土台だけでは勝ちにならない');
  core.drop(b, 3, RED);
  const w = core.findWinner(b);
  assert.strictEqual(w.player, RED, '斜め4つで勝ち');
}

// 引き分け（全面埋まって勝者なし）の盤面が作れること
{
  // 2色の市松＋ずらしで4つ並ばない埋め方
  const b = core.createBoard();
  const pattern = [
    [1, 1, 2, 2, 1, 1, 2],
    [2, 2, 1, 1, 2, 2, 1],
    [1, 1, 2, 2, 1, 1, 2],
    [2, 2, 1, 1, 2, 2, 1],
    [1, 1, 2, 2, 1, 1, 2],
    [2, 2, 1, 1, 2, 2, 1],
  ];
  for (let y = 0; y < 6; y++) for (let x = 0; x < 7; x++) b[y][x] = pattern[y][x];
  assert.strictEqual(core.findWinner(b), null, 'この並びでは勝者なし');
  assert.strictEqual(core.isFull(b), true);
}

// AI: 勝てる手は取る（普通・強い）
for (const level of ['normal', 'hard']) {
  const b = core.createBoard();
  for (const x of [0, 1, 2]) core.drop(b, x, RED);
  core.drop(b, 6, YELLOW); core.drop(b, 6, YELLOW);
  assert.strictEqual(core.chooseAiMove(b, RED, level), 3, `${level}: 横4つを完成させる`);
}

// AI: 相手の勝ちを止める（普通・強い）
for (const level of ['normal', 'hard']) {
  const b = core.createBoard();
  for (const x of [0, 1, 2]) core.drop(b, x, YELLOW);
  core.drop(b, 6, RED);
  assert.strictEqual(core.chooseAiMove(b, RED, level), 3, `${level}: 相手の4つを止める`);
}

// AI: 合法手しか返さない（全レベル、満杯に近い盤面）
{
  const b = core.createBoard();
  for (let x = 0; x < 7; x++) for (let i = 0; i < 5; i++) core.drop(b, x, (x + i) % 2 ? RED : YELLOW);
  for (const level of ['easy', 'normal', 'hard']) {
    const m = core.chooseAiMove(b, RED, level);
    assert(core.legalMoves(b).includes(m), `${level}: 合法手の範囲内`);
  }
}

console.log('CONNECT4 CORE TESTS PASSED');
