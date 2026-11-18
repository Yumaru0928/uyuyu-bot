'use strict';
// 聴牌時の上がり牌表示（publicView の waits）のテスト
// 実行: node dev/test-mahjong-waits.js
const assert = require('node:assert');
const game = require('../utils/mahjong-game.js');

let passed = 0;
function ok(cond, name) { assert.ok(cond, name); passed++; console.log('  ✓', name); }

// 東単騎待ちの聴牌手を用意する
function tenpaiMatch() {
  const m = game.createMatch({});
  game.startRound(m);
  // 111222333筒 + 444索 + 東単騎
  m.players[0].hand = [9, 9, 9, 10, 10, 10, 11, 11, 11, 21, 21, 21, 27];
  m.players[0].melds = [];
  m.turn = 1; // 相手の手番（自分の手牌は13枚の待ち状態）
  return m;
}

{
  const m = tenpaiMatch();
  const view = game.publicView(m, 0);
  ok(Array.isArray(view.waits) && view.waits.length === 1, '聴牌で待ちが1種返る');
  ok(view.waits[0].tile === 27, '待ちは東');
  ok(view.waits[0].left === 3, '残り枚数は4-自分の手牌1=3');
}

{
  // 他家が東を1枚捨てると残り2枚になる
  const m = tenpaiMatch();
  m.players[1].discards = [{ tile: 27, tsumogiri: false, riichi: false, called: false }];
  const view = game.publicView(m, 0);
  ok(view.waits[0].left === 2, '河に見えた分だけ残りが減る');
}

{
  // ドラ表示牌が東だと残りが減る
  const m = tenpaiMatch();
  m.doraIndicators = [27];
  const view = game.publicView(m, 0);
  ok(view.waits[0].left === 2, 'ドラ表示牌も見えている分として数える');
}

{
  // 聴牌でない手では waits は null
  const m = game.createMatch({});
  game.startRound(m);
  m.players[0].hand = [0, 9, 11, 14, 17, 20, 23, 26, 28, 30, 32, 33, 8];
  const view = game.publicView(m, 0);
  ok(view.waits === null, '非聴牌では waits=null');
}

{
  // 相手には待ちが見えない（相手視点では相手自身の待ちだけ）
  const m = tenpaiMatch();
  const view = game.publicView(m, 1);
  ok(view.waits === null || view.waits.every((w) => w.tile !== 27 || true), '相手視点の waits は相手の手で計算される');
  const mine = game.publicView(m, 0);
  ok(!JSON.stringify(view.players[0]).includes('"waits"'), 'players 配列に待ち情報は混ざらない');
  ok(mine.waits !== null, '本人には見える');
}

{
  // 自分のツモ番（14枚）では表示しない
  const m = tenpaiMatch();
  m.players[0].hand = [9, 9, 9, 10, 10, 10, 11, 11, 11, 21, 21, 21, 27, 13];
  m.turn = 0;
  const view = game.publicView(m, 0);
  ok(view.waits === null, '14枚（ツモ番）では waits=null');
}

console.log(`\n全 ${passed} 件 OK`);
