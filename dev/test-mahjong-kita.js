'use strict';

// 北抜き・リーチ後暗槓の単体テスト（状態を組み立てて合法手と適用結果を検証する）
const assert = require('node:assert');
const game = require('../utils/mahjong-game.js');
const core = require('../utils/mahjong-core.js');

const NORTH = 30;

// seat0 の手番で、13枚＋ツモ牌の状態を組み立てる
function craft({ hand13, drawn, riichi = false, melds = [], kita = 0, deadWallTop = null }) {
  const m = game.createMatch({});
  game.startRound(m);
  const p = m.players[0];
  p.hand = [...hand13, drawn];
  p.melds = melds;
  p.riichi = riichi;
  p.kita = kita;
  p.score = 35000;
  m.turn = 0;
  m.phase = 'play';
  m.lastDrawn = drawn;
  m.drawnFromRinshan = false;
  if (deadWallTop !== null) m.deadWall[0] = deadWallTop;
  return m;
}

let passed = 0;
function ok(name, cond) {
  assert(cond, name);
  passed++;
  console.log(`  ok: ${name}`);
}

// ---- 北抜き ----
{
  // 手牌に北がある（ツモ牌は別）→ 抜ける。抜いた後は嶺上から補充される
  const m = craft({ hand13: [9, 10, 11, 13, 14, 15, 20, 21, 22, 24, 25, NORTH, 33], drawn: 18, deadWallTop: 5 });
  const legal = game.legalPlay(m, 0);
  ok('北持ちで nuki が合法手に出る', legal.nuki === true);
  const r = game.applyNuki(m, 0);
  ok('applyNuki 成功', r.ok === true);
  const p = m.players[0];
  ok('抜いた北が kita=1', p.kita === 1);
  ok('手牌から北が消える', !p.hand.some((t) => core.normalizeTile(t) === NORTH));
  ok('補充で手牌が14枚に戻る', p.hand.length === 14);
  ok('補充牌が lastDrawn になる', m.lastDrawn === 5);
}
{
  // 北を持っていない → 抜けない
  const m = craft({ hand13: [9, 10, 11, 13, 14, 15, 20, 21, 22, 24, 25, 26, 33], drawn: 18 });
  ok('北なしでは nuki が出ない', game.legalPlay(m, 0).nuki === false);
  ok('applyNuki は失敗する', game.applyNuki(m, 0).ok === false);
}
{
  // 補充で北を引いたら続けて抜ける（チェーン）
  const m = craft({ hand13: [9, 10, 11, 13, 14, 15, 20, 21, 22, 24, 25, NORTH, 33], drawn: 18, deadWallTop: NORTH });
  game.applyNuki(m, 0);
  ok('補充の北も続けて抜ける', game.legalPlay(m, 0).nuki === true);
  game.applyNuki(m, 0);
  ok('2枚抜いて kita=2', m.players[0].kita === 2);
}
{
  // リーチ後でも北は抜ける
  const m = craft({ hand13: [9, 10, 11, 13, 14, 15, 20, 21, 22, 24, 25, NORTH, 33], drawn: 18, riichi: true, deadWallTop: 5 });
  ok('リーチ後でも nuki が出る', game.legalPlay(m, 0).nuki === true);
}
{
  // 抜いた北は和了時にドラとして加算される
  const hand13 = [9, 9, 9, 10, 11, 12, 13, 14, 15, 20, 21, 22, 33];
  const m0 = craft({ hand13, drawn: 33, kita: 0 });
  m0.doraIndicators = [27]; // ドラは南（手牌に無い）
  const m2 = craft({ hand13, drawn: 33, kita: 2 });
  m2.doraIndicators = [27];
  const r0 = game.evalWin(m0, 0, 33, 'tsumo', {});
  const r2 = game.evalWin(m2, 0, 33, 'tsumo', {});
  ok('ツモ和了が成立する', Boolean(r0) && Boolean(r2));
  ok('kita=2 でドラが2つ増える', r2.doraCount - r0.doraCount === 2);
}
{
  // 普通に切った北は他家がポンできる
  const m = game.createMatch({});
  game.startRound(m);
  m.players[0].hand = [NORTH, NORTH, 9, 10, 11, 13, 14, 15, 20, 21, 22, 24, 25];
  m.players[1].hand = [9, 10, 11, 13, 14, 15, 20, 21, 22, 24, 25, 26, NORTH, 18];
  m.turn = 1;
  m.phase = 'play';
  m.lastDrawn = 18;
  const r = game.applyDiscard(m, 1, NORTH);
  ok('北を切れる', r.ok === true);
  ok('北の切りに対してポン候補が出る', m.phase === 'call' && m.call.options[0] && m.call.options[0].pon === true);
}

// ---- リーチ後暗槓 ----
{
  // 許可例: 333筒は刻子としてしか読めない＋待ち不変 → 暗槓できる
  const hand13 = [11, 11, 11, 13, 14, 15, 20, 21, 22, 24, 25, 33, 33];
  const m = craft({ hand13, drawn: 11, riichi: true });
  const legal = game.legalPlay(m, 0);
  ok('リーチ後暗槓（純刻子）は候補に出る', legal.kan.some((k) => k.kind === 'ankan' && k.tile === 11));
  const r = game.applyKan(m, 0, 11, 'ankan');
  ok('applyKan 成功', r.ok === true);
  const p = m.players[0];
  ok('槓の副露ができる', p.melds.length === 1 && p.melds[0].type === 'kan');
  // 嶺上ツモの後はツモ切り固定
  const after = game.legalPlay(m, 0);
  ok('槓後はツモ切りだけが合法手', after.discards.length === 1 && after.discards[0] === m.lastDrawn);
}
{
  // 禁止例（ユーザーのケース）: 222333444索に3索。待ちは変わらないが 234 の読み方が壊れるので不可
  const hand13 = [19, 19, 19, 20, 20, 20, 21, 21, 21, 24, 25, 33, 33];
  const counts13 = core.countsFromTiles(hand13);
  const waitsBefore = core.waitingTiles(counts13, 0);
  const countsAfter = counts13.slice();
  countsAfter[20] -= 3;
  const waitsAfter = core.waitingTiles(countsAfter, 1);
  ok('前提: このケースは待ちだけ見ると不変', JSON.stringify(waitsBefore) === JSON.stringify(waitsAfter) && waitsBefore.length > 0);
  const m = craft({ hand13, drawn: 20, riichi: true });
  ok('222333444+3索 はリーチ後暗槓できない', game.legalPlay(m, 0).kan.length === 0);
}
{
  // 禁止例: 333444555筒に4筒。345筒×3 の読み方があるので不可
  const hand13 = [11, 11, 11, 12, 12, 12, 13, 13, 13, 24, 25, 33, 33];
  const m = craft({ hand13, drawn: 12, riichi: true });
  ok('333444555+4筒 はリーチ後暗槓できない', game.legalPlay(m, 0).kan.length === 0);
}
{
  // 禁止例: 待ちが変わる槓（2223索形は順子読みで待ちが広い）
  const hand13 = [19, 19, 19, 20, 9, 10, 11, 13, 14, 15, 21, 22, 23];
  const m = craft({ hand13, drawn: 19, riichi: true });
  ok('待ちが変わる槓はできない', game.legalPlay(m, 0).kan.length === 0);
}
{
  // リーチ前は従来通り暗槓できる（222333444 でも可）
  const hand13 = [19, 19, 19, 20, 20, 20, 21, 21, 21, 24, 25, 33, 33];
  const m = craft({ hand13, drawn: 20, riichi: false });
  ok('リーチ前なら同じ形でも暗槓できる', game.legalPlay(m, 0).kan.some((k) => k.kind === 'ankan' && k.tile === 20));
}

console.log(`test-mahjong-kita: ${passed} 件すべて成功`);
