'use strict';

// 麻雀コア（三麻）のテスト：シャンテン・待ち・役・符・点数の既知ケースで検証する
const assert = require('node:assert');
const M = require('../utils/mahjong-core.js');

// 牌の表記ヘルパー： 'p5' 's9' 'm1' / 字牌は E S W N P(白) F(發) C(中)
const HONOR = { E: 27, S: 28, W: 29, N: 30, P: 31, F: 32, C: 33 };
function tile(str) {
  if (HONOR[str] !== undefined) return HONOR[str];
  const suit = { m: 0, p: 9, s: 18 }[str[0]];
  return suit + Number(str.slice(1)) - 1;
}
function hand(str) {
  return M.countsFromTiles(str.split(/\s+/).filter(Boolean).map(tile));
}
function ctx(base = {}) {
  return { winType: 'ron', seatWind: 27, roundWind: 27, isDealer: false, doraCount: 0, ...base };
}

// ---- 牌山（三麻） ----
{
  const wall = M.buildWall(() => 0.42);
  assert.equal(wall.length, 108, '三麻の牌山は108枚');
  const counts = M.countsFromTiles(wall);
  assert.equal(counts[0], 4); assert.equal(counts[8], 4); // 1萬・9萬
  assert.equal(counts[1], 0, '2萬は無い');
  assert.equal(counts[13], 4); // 5筒（赤含む）
  assert.equal(wall.filter((t) => t === M.RED_5P).length, 1);
  assert.equal(wall.filter((t) => t === M.RED_5S).length, 1);
  console.log('牌山（三麻・赤）: OK');
}

// ---- シャンテン ----
{
  const win = hand('p2 p3 p4 p3 p4 p5 s5 s6 s7 s7 s8 s9 E E');
  assert.equal(M.shanten(win), -1, '和了形は-1');
  const tenpai = hand('p2 p3 p4 p3 p4 p5 s5 s6 s7 s7 s8 s9 E');
  assert.equal(M.shanten(tenpai), 0, '聴牌は0');
  assert.deepEqual(M.waitingTiles(tenpai), [27], '待ちは東のみ');
  const one = hand('p2 p3 p4 p3 p4 p5 s5 s6 s7 s7 s8 E W');
  assert.equal(M.shanten(one), 1);
  const chii = hand('p2 p2 p5 p5 s3 s3 s7 s7 s9 s9 E E C');
  assert.equal(M.shanten(chii), 0);
  assert.deepEqual(M.waitingTiles(chii), [33]);
  const kokushi = hand('m1 m9 p1 p9 s1 s9 E S W N P F C');
  assert.equal(M.shanten(kokushi), 0);
  assert.equal(M.waitingTiles(kokushi).length, 13);
  const open = hand('p2 p3 p4 s5 s6 s7 s7 s8 s9 E E');
  assert.equal(M.shanten(open, 1), -1, '副露1つ＋閉じた手の和了形');
  console.log('シャンテン・待ち: OK');
}

// ---- 役・点数 ----
// 平和ロン（子・30符1翻＝1000）
{
  const h = hand('p2 p3 p4 p3 p4 p5 s5 s6 s7 s2 s3 s4 s9 s9');
  const r = M.evaluateWin(h, [], ctx({ winTile: tile('p4') }));
  assert.ok(r, '平和は和了できる');
  assert.ok(r.yaku.some((y) => y.name === '平和'));
  assert.equal(r.fu, 30);
  assert.equal(r.score.ron, 1000);
  console.log('平和ロン 1000: OK');
}
// 門前ツモ＋平和（20符2翻、子ツモ 400/700、三麻精算は2人分）
{
  const h = hand('p2 p3 p4 p3 p4 p5 s5 s6 s7 s2 s3 s4 s9 s9');
  const r = M.evaluateWin(h, [], ctx({ winTile: tile('p4'), winType: 'tsumo' }));
  assert.equal(r.fu, 20);
  assert.equal(r.score.tsumoChild, 400);
  assert.equal(r.score.tsumoDealer, 700);
  assert.equal(r.sanma.total, 1100, '三麻ツモは2人分のみ');
  console.log('平和ツモ 400/700・三麻精算: OK');
}
// リーチ＋平和＋タンヤオ＋ドラ1（30符4翻＝7700。han はドラ込みの合計）
{
  const h = hand('p2 p3 p4 p3 p4 p5 s5 s6 s7 s2 s3 s4 s8 s8');
  const r = M.evaluateWin(h, [], ctx({ winTile: tile('p4'), riichi: 1, doraCount: 1 }));
  assert.equal(r.han, 4);
  assert.equal(r.score.ron, 7700);
  console.log('リーチ・タンヤオ・ドラ1 7700: OK');
}
// 七対子（25符2翻、子ロン1600）
{
  const h = hand('p2 p2 p5 p5 s3 s3 s7 s7 s9 s9 E E C C');
  const r = M.evaluateWin(h, [], ctx({ winTile: tile('C') }));
  assert.ok(r.yaku.some((y) => y.name === '七対子'));
  assert.equal(r.fu, 25);
  assert.equal(r.score.ron, 1600);
  console.log('七対子 1600: OK');
}
// 役なしは和了不可（副露・ドラ3でも不可）
{
  const h = hand('p3 p4 p5 s5 s6 s7 s2 s3 s4 s9 s9');
  const r = M.evaluateWin(h, [{ type: 'pon', tile: tile('m1'), open: true }], ctx({ winTile: tile('p5'), doraCount: 3 }));
  assert.equal(r, null, 'ドラだけでは和了できない');
  console.log('役なし（ドラのみ）不可: OK');
}
// 対々和＋三暗刻（シャンポン待ちロン、4翻50符＝満貫8000）
{
  const h = hand('p2 p2 p2 s5 s5 s5 s9 s9 s9 C C N N N');
  const r = M.evaluateWin(h, [], ctx({ winTile: tile('N') }));
  const names = r.yaku.map((y) => y.name);
  assert.ok(names.includes('対々和') && names.includes('三暗刻'), names.join(','));
  assert.equal(r.han, 4);
  assert.equal(r.fu, 60); // 中の雀頭2符を含む
  assert.equal(r.score.ron, 8000);
  console.log('対々和・三暗刻 満貫: OK');
}
// 四暗刻単騎（2倍役満、子ロン64000）
{
  const h = hand('p2 p2 p2 s5 s5 s5 s9 s9 s9 E E E C C');
  const r = M.evaluateWin(h, [], ctx({ winTile: tile('C') }));
  assert.equal(r.yakuman, 2, '四暗刻単騎は2倍役満');
  assert.equal(r.score.ron, 64000);
  console.log('四暗刻単騎 2倍役満: OK');
}
// 国士無双（役満）／13面は2倍
{
  const h = hand('m1 m1 m9 p1 p9 s1 s9 E S W N P F C');
  const r = M.evaluateWin(h, [], ctx({ winTile: tile('C') }));
  assert.equal(r.yakuman, 1);
  assert.equal(r.score.ron, 32000);
  const h13 = hand('m1 m1 m9 p1 p9 s1 s9 E S W N P F C');
  const r13 = M.evaluateWin(h13, [], ctx({ winTile: tile('m1') }));
  assert.equal(r13.yakuman, 2, '13面待ちは2倍役満');
  console.log('国士無双・13面2倍: OK');
}
// 混一色＋役牌（副露・食い下がりで混一色2翻）
{
  const closed = hand('p2 p3 p4 p7 p8 p9 P P');
  const melds = [
    { type: 'pon', tile: tile('C'), open: true },
    { type: 'pon', tile: tile('p5'), open: true },
  ];
  const r = M.evaluateWin(closed, melds, ctx({ winTile: tile('P') }));
  const names = r.yaku.map((y) => y.name);
  assert.ok(names.includes('混一色') && names.includes('役牌'), names.join(','));
  assert.equal(r.han, 3);
  console.log('混一色（副露）＋役牌: OK');
}
// 跳満ツモ：リーチ・一発・ツモ・タンヤオ・平和・ドラ1 = 6翻
{
  const h = hand('p2 p3 p4 p3 p4 p5 s5 s6 s7 s2 s3 s4 s8 s8');
  const r = M.evaluateWin(h, [], ctx({ winTile: tile('p4'), winType: 'tsumo', riichi: 1, ippatsu: true, doraCount: 1 }));
  assert.equal(r.han, 6);
  assert.equal(r.score.tsumoChild, 3000);
  assert.equal(r.score.tsumoDealer, 6000);
  assert.equal(r.sanma.total, 9000, '三麻の子跳満ツモは9000');
  console.log('跳満ツモ・三麻精算: OK');
}
// 親のリーチ平和ロン（2翻30符＝2900）
{
  const h = hand('p2 p3 p4 p3 p4 p5 s5 s6 s7 s2 s3 s4 s9 s9');
  const r = M.evaluateWin(h, [], ctx({ winTile: tile('p4'), isDealer: true, riichi: 1 }));
  assert.equal(r.han, 2);
  assert.equal(r.score.ron, 2900);
  console.log('親リーチ平和 2900: OK');
}
console.log('test-mahjong-core: OK');
