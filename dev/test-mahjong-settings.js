'use strict';

// 対局前設定（ルール）の単体テスト
const assert = require('node:assert');
const game = require('../utils/mahjong-game.js');
const core = require('../utils/mahjong-core.js');

let passed = 0;
function ok(name, cond) {
  assert(cond, name);
  passed++;
  console.log(`  ok: ${name}`);
}

// リーチで和了できる手（444筒・123筒・678筒・234索・7索単騎）: 役はリーチのみ、ドラは表示牌で調整
const RIICHI_HAND = [12, 12, 12, 9, 10, 11, 14, 15, 16, 19, 20, 21, 24];
// ノーテンの捨て牌用（么九12種＋中張1枚。国士テンパイにならない組み合わせ）
const JUNK13 = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 12];

function baseMatch(rules = {}) {
  const m = game.createMatch({ rules });
  game.startRound(m);
  return m;
}

// ---- normalizeRules ----
{
  const r = game.normalizeRules({ startScore: 123456, returnScore: -5, requiredScore: 40000, shibari: 9, uma: '30', kuitan: false });
  ok('持ち点は200000で丸め＋100点単位', r.startScore === 123500);
  ok('返し点は0未満をクランプ', r.returnScore === 0);
  ok('shibari 範囲外は既定0', r.shibari === 0);
  ok('ウマプリセット30', JSON.stringify(r.uma) === '[30,0,-30]');
  ok('真偽値の上書き', r.kuitan === false && r.redDora === true);
  const d = game.normalizeRules();
  ok('既定は 35000/40000/40000・積み棒200', d.startScore === 35000 && d.returnScore === 40000 && d.requiredScore === 40000 && d.honbaRon === 200);
}

// ---- 持ち点の反映 ----
{
  const m = game.createMatch({ rules: { startScore: 25000 } });
  ok('開始点が全員25000', m.players.every((p) => p.score === 25000));
}

// ---- 赤ドラなし ----
{
  const wall = core.buildWall(Math.random, { red: false });
  ok('赤なしの牌山は108枚で赤牌なし', wall.length === 108 && !wall.includes(core.RED_5P) && !wall.includes(core.RED_5S));
  const m = baseMatch({ redDora: false });
  const all = [...m.wall, ...m.deadWall, ...m.players.flatMap((p) => p.hand)];
  ok('赤なし対局に赤牌が混ざらない', !all.includes(core.RED_5P) && !all.includes(core.RED_5S));
}

// ---- 積み棒200（ロン+200/本場、ツモ各+100/本場） ----
{
  const mk = (honba) => {
    const m = baseMatch();
    m.honba = honba;
    m.players[0].hand = [...RIICHI_HAND];
    m.players[0].riichi = true;
    m.doraIndicators = [0]; // ドラは1萬（手に無い）でドラ0に固定
    return game.evalWin(m, 0, 24, 'ron');
  };
  const r0 = mk(0);
  const r2 = mk(2);
  ok('ロン本場なしは成立', r0 !== null && r2 !== null);
  ok('ロン積み棒は1本場200', r2.settlement.total - r0.settlement.total === 400);
  const mkT = (honba) => {
    const m = baseMatch();
    m.honba = honba;
    m.players[0].hand = [...RIICHI_HAND, 24];
    m.players[0].riichi = true;
    m.doraIndicators = [0];
    m.turn = 0;
    return game.evalWin(m, 0, 24, 'tsumo');
  };
  const t0 = mkT(0);
  const t2 = mkT(2);
  ok('ツモ積み棒は各100×本場', t2.settlement.payments.every((p, i) => p.amount - t0.settlement.payments[i].amount === 200));
}

// ---- 喰いタンなし ----
{
  const melds = [{ type: 'pon', tile: 20, tiles: [20, 20, 20], open: true, from: 1, calledIndex: 0 }];
  const hand = [10, 11, 12, 14, 15, 16, 22, 23, 19, 19];
  const mk = (kuitan) => {
    const m = baseMatch({ kuitan });
    m.players[0].hand = [...hand];
    m.players[0].melds = melds;
    m.doraIndicators = [0];
    return game.evalWin(m, 0, 24, 'ron');
  };
  ok('喰いタンありなら開いたタンヤオで和了可', mk(true) !== null);
  ok('喰いタンなしでは開いたタンヤオのみは和了不可', mk(false) === null);
}

// ---- はんしばり ----
{
  const mk = (shibari) => {
    const m = baseMatch({ shibari });
    m.players[0].hand = [...RIICHI_HAND];
    m.players[0].riichi = true;
    m.doraIndicators = [11]; // ドラは4筒（12）: 刻子で3枚 → 役1翻＋ドラ3
    return game.evalWin(m, 0, 24, 'ron');
  };
  ok('縛りなしは和了可', mk(0) !== null);
  ok('1翻縛りは和了可（リーチ1翻）', mk(1) !== null);
  ok('2翻縛りはドラ抜き1翻なので不可', mk(2) === null);
  ok('満貫縛りは4翻なので不可', mk(5) === null);
}

// ---- 裏ドラ ----
{
  const mk = (uraDora) => {
    const m = baseMatch({ uraDora });
    m.players[0].hand = [...RIICHI_HAND];
    m.players[0].riichi = true;
    m.doraIndicators = [11]; // 表ドラ3
    m.uraIndicators = [23]; // 裏ドラは7索（24）: 対子＋和了牌で2枚
    return game.evalWin(m, 0, 24, 'ron');
  };
  const on = mk(true);
  ok('裏ドラありで uraDoraCount=2', on.uraDoraCount === 2);
  ok('裏ドラが合計ドラに加算（3+2=5）', on.doraCount === 5);
  ok('裏ドラなしでは数えない', mk(false).uraDoraCount === 0);
}

// ---- 北抜きオフ ----
{
  const m = baseMatch({ kita: false });
  const p = m.players[0];
  p.hand = [9, 10, 11, 13, 14, 15, 20, 21, 22, 24, 25, 30, 33, 18];
  m.turn = 0;
  m.phase = 'play';
  m.lastDrawn = 18;
  ok('北抜きオフでは nuki が出ない', game.legalPlay(m, 0).nuki === false);
}

// ---- オープンリーチ ----
{
  const m = baseMatch({ openRiichi: true });
  const p = m.players[0];
  p.hand = [...RIICHI_HAND, 24];
  p.riichi = true;
  p.openRiichi = true;
  m.doraIndicators = [0];
  const r = game.evalWin(m, 0, 24, 'tsumo');
  ok('オープンリーチ役が付く（2翻）', r !== null && r.yaku.some((y) => y.name === 'オープンリーチ' && y.han === 2));
  const view = game.publicView(m, 1);
  ok('オープンリーチした席の手牌は他家から見える', Array.isArray(view.players[0].hand));
}

// ---- ダブルロン ----
{
  const setup = (doubleRon) => {
    const m = baseMatch({ doubleRon });
    m.players[0].hand = [...RIICHI_HAND];
    m.players[0].riichi = true;
    m.players[2].hand = [18, 19, 20, 21, 22, 23, 10, 11, 12, 13, 14, 15, 24];
    m.players[2].riichi = true;
    m.players[1].hand = [0, 8, 27, 28, 29, 30, 31, 32, 33, 9, 17, 25, 33, 24];
    m.players.forEach((p) => { p.score = 35000; });
    m.doraIndicators = [0];
    m.kyotaku = 1;
    m.turn = 1;
    m.phase = 'play';
    m.lastDrawn = 24;
    const dr = game.applyDiscard(m, 1, 24, {});
    assert(dr.ok, 'discard ok');
    assert(m.phase === 'call', 'call phase');
    game.applyCallResponse(m, 2, 'ron');
    game.applyCallResponse(m, 0, 'ron');
    assert(game.callSettled(m), 'settled');
    game.resolveCall(m);
    return m;
  };
  const dbl = setup(true);
  ok('ダブルロンで両者が和了', dbl.lastResult.wins && dbl.lastResult.wins.length === 2);
  ok('供託は放銃者に近い和了者（席2）へ', dbl.lastResult.wins[0].winner === 2 && dbl.lastResult.wins[0].riichiSticks === 1);
  const paid = 35000 - dbl.players[1].score;
  const gained = dbl.lastResult.wins.reduce((a, w) => a + w.payments[0].amount, 0);
  ok('放銃者は両方に支払う', paid === gained && paid > 0);
  const single = setup(false);
  ok('頭ハネでは近い席だけ和了', single.lastResult.winner === 2 && !single.lastResult.wins);
}

// ---- 九種九牌 ----
{
  const mk = (abortiveDraws) => {
    const m = baseMatch({ abortiveDraws });
    m.players[0].hand = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33, 12];
    m.turn = 0;
    m.phase = 'play';
    m.lastDrawn = 12;
    return m;
  };
  ok('途中流局オフでは九種九牌が出ない', game.legalPlay(mk(false), 0).kyuushu === false);
  const m = mk(true);
  ok('么九9種以上で九種九牌が出る', game.legalPlay(m, 0).kyuushu === true);
  const r = game.applyKyuushu(m, 0);
  ok('九種九牌で流局し親が残る', r.ok && m.phase === 'roundEnd' && m.lastResult.drawKind === 'kyuushu' && m.nextDealer === m.dealer && m.nextHonba === 1);
}

// ---- 四風連打 ----
{
  const m = baseMatch({ abortiveDraws: true });
  m.players[0].hand = [27, 0, 8, 9, 17, 18, 26, 28, 29, 31, 32, 33, 13, 22];
  m.players[1].hand = [27, 0, 8, 10, 16, 19, 25, 28, 30, 31, 32, 33, 14];
  m.players[2].hand = [27, 0, 8, 11, 15, 20, 24, 29, 30, 31, 32, 33, 21];
  m.turn = 0;
  m.phase = 'play';
  m.lastDrawn = 22;
  game.applyDiscard(m, 0, 27, {});
  game.applyDiscard(m, 1, 27, {});
  game.applyDiscard(m, 2, 27, {});
  ok('全員の第一打が同じ風で四風連打', m.phase === 'roundEnd' && m.lastResult.drawKind === 'suufon');
}

// ---- 延長と最終スコア ----
{
  const m = baseMatch();
  m.roundWind = 27;
  m.roundNum = 3;
  m.dealer = 0;
  m.players.forEach((p, s) => { p.score = [30000, 38000, 37000][s]; });
  const forceDraw = (mm) => {
    mm.players.forEach((p) => { p.hand = [...JUNK13]; });
    mm.players[mm.turn].hand = [...JUNK13, 13];
    mm.lastDrawn = 13;
    mm.wall = [];
    mm.phase = 'play';
    game.applyDiscard(mm, mm.turn, 13, {});
  };
  forceDraw(m);
  ok('最終局でトップが必要点数未満なら延長', m.phase === 'roundEnd' && m.extended === true && m.nextIsLast === false);
  game.startNextRound(m);
  ok('延長は次の風（南1局）へ', m.phase === 'play' && m.roundWind === 28 && m.roundNum === 1);
  m.roundNum = 3;
  m.players.forEach((p, s) => { p.score = [45000, 30000, 30000][s]; });
  forceDraw(m);
  ok('延長の最終局で終了', m.nextIsLast === true);
  game.startNextRound(m);
  ok('終局して最終スコアが付く', m.phase === 'gameEnd' && Array.isArray(m.finalScores));
  const bySeat = Object.fromEntries(m.finalScores.map((f) => [f.seat, f]));
  ok('最終スコア = 素点+ウマ+オカ', bySeat[0].total === 40 && bySeat[1].total === -10 && bySeat[2].total === -30);
  ok('最終スコアの合計は0', m.finalScores.reduce((a, f) => a + f.total, 0) === 0);
}

// ---- あがりやめ ----
{
  const mk = (agariYame) => {
    const m = baseMatch({ agariYame });
    m.roundWind = 27;
    m.roundNum = 3;
    m.dealer = 0;
    m.players.forEach((p, s) => { p.score = [39000, 33000, 33000][s]; });
    m.players[0].hand = [...RIICHI_HAND, 24];
    m.players[0].riichi = true;
    m.doraIndicators = [0];
    m.turn = 0;
    m.phase = 'play';
    m.lastDrawn = 24;
    const r = game.applyTsumo(m, 0);
    assert(r.ok, 'tsumo ok');
    return m;
  };
  ok('あがりやめ: 最終局で親トップ和了なら終了', mk(true).nextIsLast === true);
  ok('あがりやめオフでは連荘で継続', mk(false).nextIsLast === false);
}

// ---- 飛び終了のオン/オフ ----
{
  const mk = (tobi) => {
    const m = baseMatch({ tobi });
    m.players[0].hand = [...RIICHI_HAND];
    m.players[0].riichi = true;
    m.players[1].hand = [0, 8, 27, 28, 29, 30, 31, 32, 33, 9, 17, 25, 33, 24];
    m.players[2].hand = [...JUNK13];
    m.players.forEach((p, s) => { p.score = [35000, 500, 35000][s]; });
    m.doraIndicators = [0];
    m.turn = 1;
    m.phase = 'play';
    m.lastDrawn = 24;
    game.applyDiscard(m, 1, 24, {});
    game.applyCallResponse(m, 0, 'ron');
    game.resolveCall(m);
    return m;
  };
  const off = mk(false);
  ok('飛びオフ: マイナスになっても続行', off.players[1].score < 0 && off.nextIsLast === false);
  ok('飛びオン: マイナスで即終了', mk(true).nextIsLast === true);
}

// ---- 手牌公開 ----
{
  const on = baseMatch({ openHands: true });
  ok('手牌公開では他家の手牌が見える', Array.isArray(game.publicView(on, 0).players[1].hand));
  const off = baseMatch();
  ok('通常は他家の手牌が見えない', game.publicView(off, 0).players[1].hand === null);
}

console.log(`test-mahjong-settings: ${passed} 件すべて成功`);
