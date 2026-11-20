'use strict';

// mahjong-game の Bot 強さ3段階（フェーズ3 B、先生指定の仕様）の単体チェック:
// - weak: リーチも鳴きもするが牌効率を無視する（愚形でもリーチ、打牌はランダム）
// - normal: 従来どおり（牌効率でリーチ・条件付きポン）
// - strong: ドラを残す（打点）／危険な他家には現物で守備／愚形・ノードラはリーチ見送り（ダマ）
// あわせて各強さで対局シミュレーションが最後まで回り、点数合計が保存されることを確認する
const assert = require('node:assert');
const game = require('../utils/mahjong-game.js');

// 牌は種類番号（0..33）で書く: 0=1m 8=9m / 9=1p 17=9p / 18=1s 26=9s / 27=東 28=南 29=西 30=北 31=白 32=發 33=中

// 手牌・河・副露・リーチ状態・ドラ表示を直接組み立てた対局状態を作る（seat 0 の手番、lastDrawn は手牌の最後）
function craftMatch({ hand, discards = {}, melds = {}, riichi = {}, doraIndicators = null }) {
  const match = game.createMatch({ length: 'east' });
  game.startRound(match);
  match.players[0].hand = [...hand];
  match.players[0].melds = [];
  for (const [s, tiles] of Object.entries(discards)) {
    match.players[s].discards = tiles.map((tile) => ({ tile, riichi: false, called: false }));
  }
  for (const [s, list] of Object.entries(melds)) match.players[s].melds = list;
  for (const [s, v] of Object.entries(riichi)) match.players[s].riichi = Boolean(v);
  if (doraIndicators) match.doraIndicators = [...doraIndicators];
  match.turn = 0;
  match.lastDrawn = hand[hand.length - 1];
  return match;
}

// strong の速度モード（局ごとの抽選）をテスト用に固定する
function setSpeed(match, seat, on) {
  if (!match._botSpeedMode) match._botSpeedMode = {};
  match._botSpeedMode[`${match.roundWind}:${match.roundNum}:${seat}`] = on;
}

// テンパイ手（222p 333p 444p 55p 67p、待ち 5p/8p の両面）＋ツモ 9s
const TENPAI_HAND = [10, 10, 10, 11, 11, 11, 12, 12, 12, 13, 13, 14, 15, 26];
// 愚形テンパイ手（222p 333p 444p 555s ＋西の単騎待ち）＋ツモ 中
const GATA_HAND = [10, 10, 10, 11, 11, 11, 12, 12, 12, 22, 22, 22, 29, 33];
// バラバラの遠い手。現物候補として 3p(11)・1s(18)・東(27) を含む
const FAR_HAND = [11, 0, 8, 9, 17, 18, 19, 22, 26, 27, 28, 29, 31, 32];

// --- normalizeBotLevel ---
assert.strictEqual(game.normalizeBotLevel('weak'), 'weak');
assert.strictEqual(game.normalizeBotLevel('normal'), 'normal');
assert.strictEqual(game.normalizeBotLevel('strong'), 'strong');
assert.strictEqual(game.normalizeBotLevel('xxx'), 'normal');
assert.strictEqual(game.normalizeBotLevel(undefined), 'normal');
console.log('normalizeBotLevel OK');

// --- weak は愚形でもリーチする／normal もリーチする ---
{
  const mWeak = craftMatch({ hand: GATA_HAND });
  const actW = game.botChoosePlay(mWeak, 0, 'weak');
  assert.strictEqual(actW.type, 'discard');
  assert.strictEqual(actW.riichi, true, 'weak は愚形（単騎）でもリーチするはず');

  const mNormal = craftMatch({ hand: TENPAI_HAND });
  const actN = game.botChoosePlay(mNormal, 0, 'normal');
  assert.strictEqual(actN.riichi, true, 'normal はテンパイでリーチするはず');
  const actD = game.botChoosePlay(mNormal, 0); // 引数なし = normal（従来動作の互換）
  assert.strictEqual(actD.riichi, true, 'level 省略時は normal と同じはず');
  console.log('weak/normal のリーチ判定 OK');
}

// --- weak は牌効率を無視して切る（同じ手から多様な打牌が出る） ---
{
  const m = craftMatch({ hand: FAR_HAND });
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const act = game.botChoosePlay(m, 0, 'weak');
    assert.strictEqual(act.type, 'discard');
    assert.strictEqual(act.riichi, false);
    assert(FAR_HAND.includes(act.tile), 'weak の打牌は手牌の中から選ばれるはず');
    seen.add(act.tile);
  }
  assert(seen.size >= 4, `weak の打牌は効率無視でばらけるはず (実際 ${seen.size} 種類)`);
  // 対照: normal は同じ手では常に同じ最善手を切る
  const seenN = new Set();
  for (let i = 0; i < 20; i++) seenN.add(game.botChoosePlay(m, 0, 'normal').tile);
  assert.strictEqual(seenN.size, 1, 'normal は決定的に最善手を切るはず');
  console.log('weak の効率無視 OK');
}

// --- 鳴き: weak は効率を判断せずポン／normal は条件付きポン／どちらもロンは拾う ---
{
  const fake = {
    dealer: 0, roundWind: 27,
    call: { tile: 31, options: { 0: { pon: true } } },
    players: [
      { hand: [31, 31, 10, 10, 10, 11, 11, 11, 12, 20, 21, 26, 27], melds: [], riichi: false },
      { hand: [], melds: [], riichi: false },
      { hand: [], melds: [], riichi: false },
    ],
  };
  assert.strictEqual(game.botChooseCall(fake, 0, 'normal'), 'pon', 'normal は役牌ポンでシャンテンが進むなら鳴くはず');
  assert.strictEqual(game.botChooseCall(fake, 0, 'weak'), 'pon', 'weak はポンできるなら鳴くはず');
  fake.call.options[0] = { ron: true, pon: true };
  assert.strictEqual(game.botChooseCall(fake, 0, 'weak'), 'ron', 'weak でもロンは拾うはず');
  console.log('鳴き判定 OK');
}

// --- strong: 他家リーチ時、手が遠ければ現物を切る ---
{
  const genbutsu = new Set([11, 18, 27]); // 下家（seat 1）の河にある種類
  const m = craftMatch({
    hand: FAR_HAND,
    discards: { 1: [11, 18, 27, 20] },
    riichi: { 1: true },
  });
  const act = game.botChoosePlay(m, 0, 'strong');
  assert.strictEqual(act.type, 'discard');
  assert.strictEqual(act.riichi, false);
  assert(genbutsu.has(act.tile), `strong は現物を切るはず (実際: ${act.tile})`);
  console.log('strong の守備（リーチへの現物） OK');
}

// --- strong: リーチしていなくても、3つ鳴いている他家には現物で回る ---
{
  const genbutsu = new Set([11, 18, 27]);
  const pon = (t) => ({ type: 'pon', tiles: [t, t, t], open: true });
  const m = craftMatch({
    hand: FAR_HAND,
    discards: { 1: [11, 18, 27, 20] },
    melds: { 1: [pon(22), pon(24), pon(31)] },
  });
  const act = game.botChoosePlay(m, 0, 'strong');
  assert.strictEqual(act.type, 'discard');
  assert(genbutsu.has(act.tile), `strong は仕掛けている他家にも現物を切るはず (実際: ${act.tile})`);
  console.log('strong の守備（仕掛けへの現物） OK');
}

// --- strong: テンパイ（両面）なら他家リーチ中でも押す（リーチする） ---
{
  const m = craftMatch({
    hand: TENPAI_HAND,
    discards: { 1: [20, 21, 28] },
    riichi: { 1: true },
  });
  const act = game.botChoosePlay(m, 0, 'strong');
  assert.strictEqual(act.type, 'discard');
  assert.strictEqual(act.riichi, true, 'strong は両面テンパイなら押してリーチするはず');
  console.log('strong の押し OK');
}

// --- strong: 愚形・ノードラのテンパイはリーチせず様子を見る（ダマ） ---
{
  // ドラ表示は 9m(8) → ドラは 1m(0)。手牌にドラは無い
  const m = craftMatch({ hand: GATA_HAND, doraIndicators: [8] });
  setSpeed(m, 0, false);
  const act = game.botChoosePlay(m, 0, 'strong');
  assert.strictEqual(act.type, 'discard');
  assert.strictEqual(act.riichi, false, 'strong は愚形・ノードラならリーチを見送るはず');
  const mN = craftMatch({ hand: GATA_HAND, doraIndicators: [8] });
  assert.strictEqual(game.botChoosePlay(mN, 0, 'normal').riichi, true, '対照: normal は同じ手でリーチするはず');
  console.log('strong のリーチ見送り（ダマ） OK');
}

// --- strong: ドラを残す（効率だけなら切るドラを切らない） ---
{
  // ドラ表示 9m(8) → ドラは 1m(0)。1シャンテン手で、浮き牌は 1m（ドラ）と 1p。
  // 効率（normal）は隣接のある 1p を残して 1m を切るが、strong はドラの 1m を残す
  const hand = [0, 9, 10, 11, 12, 14, 15, 19, 20, 21, 22, 22, 25, 26];
  const mN = craftMatch({ hand, doraIndicators: [8] });
  const actN = game.botChoosePlay(mN, 0, 'normal');
  assert.strictEqual(actN.tile, 0, `対照: normal はドラの 1m を切るはず (実際: ${actN.tile})`);
  const mS = craftMatch({ hand, doraIndicators: [8] });
  setSpeed(mS, 0, false);
  const actS = game.botChoosePlay(mS, 0, 'strong');
  assert.strictEqual(actS.tile, 9, `strong はドラを残して 1p を切るはず (実際: ${actS.tile})`);
  console.log('strong の打点（ドラ残し） OK');
}

// --- 各強さで対局シミュレーション（東風・全席 Bot）が最後まで回る ---
function playMatch(level) {
  const match = game.createMatch({ length: 'east' });
  game.startRound(match);
  let guard = 0;
  while (match.phase !== 'gameEnd') {
    assert(++guard < 200000, `${level}: ループが収束しない`);
    if (match.phase === 'roundEnd') { game.startNextRound(match); continue; }
    if (match.phase === 'call') {
      for (const seat of Object.keys(match.call.options).map(Number)) {
        game.applyCallResponse(match, seat, game.botChooseCall(match, seat, level));
      }
      assert(game.callSettled(match), `${level}: 応答がそろわない`);
      game.resolveCall(match);
      continue;
    }
    const seat = match.turn;
    const act = game.botChoosePlay(match, seat, level);
    let r;
    if (act.type === 'tsumo') r = game.applyTsumo(match, seat);
    else if (act.type === 'nuki') r = game.applyNuki(match, seat);
    else if (act.type === 'kan') r = game.applyKan(match, seat, act.tile, act.kanKind);
    else if (act.type === 'kyuushu') r = game.applyKyuushu(match, seat);
    else r = game.applyDiscard(match, seat, act.tile, { riichi: act.riichi });
    assert(r.ok, `${level}: アクション失敗 (${act.type}): ${r.reason}`);
    const total = match.players.reduce((a, p) => a + p.score, 0) + match.kyotaku * 1000;
    assert.strictEqual(total, game.START_SCORE * 3, `${level}: 点数合計が合わない (${total})`);
  }
  assert(match.placements, `${level}: 順位が確定していない`);
  return match.players.map((p) => p.score);
}
for (const level of game.BOT_LEVELS) {
  const scores = playMatch(level);
  console.log(`シミュレーション (${level}) OK: ${scores.join(' / ')}`);
}

console.log('test-mahjong-bot-levels: all OK');
