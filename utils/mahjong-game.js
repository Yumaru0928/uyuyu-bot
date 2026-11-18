'use strict';

// Web版 三人麻雀の対局進行ロジック（WebSocket サーバーから使う純粋な状態機械）
//
// ・牌・役・点数の計算は utils/mahjong-core.js に委譲し、ここは「進行」だけを持つ:
//   配牌→ツモ→打牌→鳴き応答ウィンドウ→和了/流局→次局→終局。
// ・フェーズ3で北抜きとリーチ後の暗槓を追加（裏ドラは未実装）。
//   リーチ後の暗槓は「待ちが変わらず、手牌の3枚が順子として読めない」場合だけ可。
//   流局は通常流局のみ（途中流局なし）。
// ・三麻の開始点は 35000 点（標準）。北は誰にとっても役牌にならない客風牌で、
//   抜くとドラとして数える（北抜き）。普通に切った北は他家がポン・カンできる。
//
// 牌の表現は core と同じ: 種類 0..33、赤5筒=34 / 赤5索=35（手牌・河はこの生値を保持し、
// 数えるときだけ normalizeTile する）。

const core = require('./mahjong-core.js');

const { normalizeTile, isRed } = core;

const START_SCORE = 35000;
const SEATS = 3;
const WINDS = [27, 28, 29]; // 東・南・西（自風はこの順で回る）
const NORTH = 30; // 北（抜きドラ）

function nextDoraKind(indicatorRaw) {
  const t = normalizeTile(indicatorRaw);
  if (t < 27) {
    const suitBase = Math.floor(t / 9) * 9;
    return suitBase + ((t - suitBase + 1) % 9);
  }
  if (t <= 30) return 27 + ((t - 27 + 1) % 4); // 風: 東→南→西→北→東
  return 31 + ((t - 31 + 1) % 3); // 三元: 白→發→中→白
}

function countsOf(tiles) {
  const counts = new Array(34).fill(0);
  for (const t of tiles) counts[normalizeTile(t)]++;
  return counts;
}

function removeOne(hand, raw) {
  const i = hand.indexOf(raw);
  if (i >= 0) { hand.splice(i, 1); return true; }
  // 赤⇔通常の相互置換（同じ種類なら切れる）
  const kind = normalizeTile(raw);
  const j = hand.findIndex((t) => normalizeTile(t) === kind);
  if (j >= 0) { hand.splice(j, 1); return true; }
  return false;
}

function sortHand(hand) {
  hand.sort((a, b) => normalizeTile(a) - normalizeTile(b) || a - b);
}

function seatWindOf(match, seat) {
  return WINDS[(seat - match.dealer + SEATS) % SEATS];
}

function isClosed(player) {
  return player.melds.every((m) => m.type === 'kan' && !m.open);
}

// ドラ枚数（表ドラ＋赤）。赤5は「その種類がドラなら+1」と「赤自体+1」が重なる標準ルール
function countDora(player, indicators) {
  const doraKinds = indicators.map(nextDoraKind);
  let n = 0;
  const add = (raw) => {
    if (doraKinds.includes(normalizeTile(raw))) n++;
    if (isRed(raw)) n++;
  };
  player.hand.forEach(add);
  for (const m of player.melds) m.tiles.forEach(add);
  return n;
}

// 現在の待ち（種類の一覧）。フリテン判定・Bot 用
function waitsOf(player) {
  const counts = countsOf(player.hand);
  return core.waitingTiles(counts, player.melds.length);
}

function isFuriten(match, seat) {
  const p = match.players[seat];
  const waits = waitsOf(p);
  if (waits.length === 0) return false;
  const discardedKinds = new Set(p.discards.map((d) => normalizeTile(d.tile)));
  if (waits.some((w) => discardedKinds.has(w))) return true; // 自分の河にある＝捨て牌フリテン
  return match.tempFuriten[seat] === true; // 見逃しフリテン（自分のツモまで）
}

// 和了評価（core.evaluateWin のラッパ）。成立すれば結果オブジェクト、しなければ null
function evalWin(match, seat, winRaw, winType, extra = {}) {
  const p = match.players[seat];
  const winTile = normalizeTile(winRaw);
  const counts = countsOf(p.hand);
  if (winType === 'ron') counts[winTile]++;
  const melds = p.melds.map((m) => ({ type: m.type, tile: m.tile, open: m.open }));
  const ctx = {
    winTile,
    winType,
    seatWind: seatWindOf(match, seat),
    roundWind: match.roundWind,
    riichi: p.riichi ? (p.doubleRiichi ? 2 : 1) : 0,
    ippatsu: Boolean(p.ippatsu),
    rinshan: Boolean(extra.rinshan),
    haitei: Boolean(extra.haitei),
    houtei: Boolean(extra.houtei),
    chankan: Boolean(extra.chankan),
    tenhou: Boolean(extra.tenhou),
    doraCount: 0, // ドラは和了形が確定してから数える（下で加算し直す）
    honba: match.honba,
    isDealer: seat === match.dealer,
  };
  // ドラは勝ち手全体（手牌＋副露＋和了牌）で数える。抜いた北も1枚=ドラ1
  const fakePlayer = { hand: winType === 'ron' ? [...p.hand, winRaw] : [...p.hand], melds: p.melds };
  ctx.doraCount = countDora(fakePlayer, match.doraIndicators) + (p.kita || 0);
  const result = core.evaluateWin(counts, melds, ctx);
  if (!result) return null;
  const settlement = core.sanmaSettlement(result.score, { winType, isDealer: ctx.isDealer });
  return { ...result, settlement, doraCount: ctx.doraCount };
}

// ---- 対局（マッチ）の生成と局の開始 ----

function createMatch({ length = 'east' } = {}) {
  return {
    length: length === 'south' ? 'south' : 'east',
    players: Array.from({ length: SEATS }, () => ({
      hand: [], melds: [], discards: [], kita: 0,
      riichi: false, doubleRiichi: false, ippatsu: false, riichiDiscardIndex: -1,
      score: START_SCORE,
    })),
    dealer: 0,
    firstDealer: 0,
    roundWind: 27,
    roundNum: 1, // その風での局数（1..3）
    honba: 0,
    kyotaku: 0,
    wall: [],
    deadWall: [],
    doraIndicators: [],
    turn: 0,
    phase: 'idle', // 'play' | 'call' | 'roundEnd' | 'gameEnd'
    call: null,
    lastDrawn: null, // 現在の手番プレイヤーがツモった牌（生値）
    drawnFromRinshan: false,
    pristine: true, // 誰も打牌・鳴きしていない（天和・地和・ダブルリーチ判定用）
    tempFuriten: [false, false, false],
    lastResult: null,
    placements: null,
    kanCount: 0,
  };
}

function totalRounds(match) {
  return (match.length === 'south' ? 2 : 1) * SEATS;
}

// 現在の局が全体の何局目か（0始まり）
function roundIndex(match) {
  const windIdx = match.roundWind === 27 ? 0 : 1;
  return windIdx * SEATS + (match.roundNum - 1);
}

function roundLabel(match) {
  const windName = match.roundWind === 27 ? '東' : '南';
  return `${windName}${match.roundNum}局`;
}

function startRound(match) {
  const wall = core.buildWall();
  match.deadWall = wall.splice(wall.length - 14, 14);
  match.wall = wall;
  match.doraIndicators = [match.deadWall[4]];
  match.kanCount = 0;
  match.pristine = true;
  match.tempFuriten = [false, false, false];
  match.lastDrawn = null;
  match.drawnFromRinshan = false;
  match.call = null;
  match.lastResult = null;
  for (const p of match.players) {
    p.hand = [];
    p.melds = [];
    p.discards = [];
    p.kita = 0;
    p.riichi = false;
    p.doubleRiichi = false;
    p.ippatsu = false;
    p.riichiDiscardIndex = -1;
  }
  for (let i = 0; i < 13; i++) {
    for (let s = 0; s < SEATS; s++) {
      match.players[(match.dealer + s) % SEATS].hand.push(match.wall.shift());
    }
  }
  for (const p of match.players) sortHand(p.hand);
  match.turn = match.dealer;
  match.phase = 'play';
  doDraw(match); // 親の初ツモ
}

// ツモ（通常 or 嶺上）。phase='play' の手番プレイヤーの手牌に加える
function doDraw(match, rinshan = false) {
  const p = match.players[match.turn];
  let tile;
  if (rinshan) {
    tile = match.deadWall.shift();
    // 王牌を14枚に保つ: 山の最後尾を王牌へ回す
    match.deadWall.push(match.wall.pop());
  } else {
    if (match.wall.length === 0) return null;
    tile = match.wall.shift();
  }
  p.hand.push(tile);
  match.lastDrawn = tile;
  match.drawnFromRinshan = rinshan;
  if (rinshan) p.ippatsu = false; // 嶺上開花と一発は複合しない
  match.tempFuriten[match.turn] = false; // 自分のツモで見逃しフリテン解除
  return tile;
}

function liveWallCount(match) {
  return match.wall.length;
}

// ---- 手番プレイヤーの合法手 ----

function kanOptionsOf(match, seat) {
  const p = match.players[seat];
  if (p.riichi) return []; // リーチ後は riichiKanOptionsOf で別途判定する
  const out = [];
  const counts = countsOf(p.hand);
  for (let t = 0; t < 34; t++) {
    if (counts[t] === 4) out.push({ kind: 'ankan', tile: t });
  }
  for (const m of p.melds) {
    if (m.type === 'pon' && counts[m.tile] > 0) out.push({ kind: 'shouminkan', tile: m.tile });
  }
  return out;
}

// 北抜きできるか（ツモ後に手牌に北がある。リーチ後でも可）
function canNuki(match, seat) {
  const p = match.players[seat];
  return match.lastDrawn !== null && p.hand.some((t) => normalizeTile(t) === NORTH);
}

// 手牌（13枚形）の読み方を列挙し、種類 kind が順子の一部として使われる読み方が
// あるかを返す。リーチ後暗槓の可否判定用（刻子としてしか読めない場合だけ槓できる）
function hasSequenceReading(counts13, meldCount, kind) {
  const c = counts13.slice();
  const unitsNeeded = 4 - meldCount;
  let found = false;
  function rec(units, headUsed, seqHasKind) {
    if (found) return;
    let i = 0;
    while (i < 34 && c[i] === 0) i++;
    if (i === 34) {
      if (units === unitsNeeded && headUsed) found = seqHasKind;
      return;
    }
    if (units > unitsNeeded) return;
    if (c[i] >= 3) { // 刻子
      c[i] -= 3; rec(units + 1, headUsed, seqHasKind); c[i] += 3;
    }
    if (i < 27) {
      const r = i % 9;
      if (r <= 6 && c[i + 1] > 0 && c[i + 2] > 0) { // 順子
        const has = seqHasKind || kind === i || kind === i + 1 || kind === i + 2;
        c[i]--; c[i + 1]--; c[i + 2]--;
        rec(units + 1, headUsed, has);
        c[i]++; c[i + 1]++; c[i + 2]++;
      }
      if (r <= 7 && c[i + 1] > 0) { // 搭子（両面・辺張）
        c[i]--; c[i + 1]--; rec(units + 1, headUsed, seqHasKind); c[i]++; c[i + 1]++;
      }
      if (r <= 6 && c[i + 2] > 0) { // 搭子（嵌張）
        c[i]--; c[i + 2]--; rec(units + 1, headUsed, seqHasKind); c[i]++; c[i + 2]++;
      }
    }
    if (!headUsed && c[i] >= 2) { // 雀頭
      c[i] -= 2; rec(units, true, seqHasKind); c[i] += 2;
    }
    if (!headUsed) { // 単騎
      c[i] -= 1; rec(units, true, seqHasKind); c[i] += 1;
    }
  }
  rec(0, false, false);
  return found;
}

// リーチ後の暗槓候補。ツモ牌と同種が手牌に3枚あり、槓の前後で待ちが変わらず、
// かつ手牌の3枚が順子の一部として読める読み方が存在しない場合だけ許可する
// （例: 222333444 に 3 が来た場合は 234 の読み方が壊れるので不可）
function riichiKanOptionsOf(match, seat) {
  const p = match.players[seat];
  if (!p.riichi || match.lastDrawn === null) return [];
  const kind = normalizeTile(match.lastDrawn);
  if (countsOf(p.hand)[kind] !== 4) return []; // 手牌3枚＋ツモ牌で4枚
  const hand13 = [...p.hand];
  removeOne(hand13, match.lastDrawn);
  const counts13 = countsOf(hand13);
  const waitsBefore = core.waitingTiles(counts13, p.melds.length);
  if (waitsBefore.length === 0) return [];
  const countsAfter = counts13.slice();
  countsAfter[kind] -= 3;
  const waitsAfter = core.waitingTiles(countsAfter, p.melds.length + 1);
  if (waitsAfter.length !== waitsBefore.length || waitsAfter.some((w, i) => w !== waitsBefore[i])) return [];
  if (hasSequenceReading(counts13, p.melds.length, kind)) return [];
  return [{ kind: 'ankan', tile: kind }];
}

// リーチ可能になる切り牌（生値の一覧）
function riichiOptionsOf(match, seat) {
  const p = match.players[seat];
  if (p.riichi || !isClosed(p) || p.score < 1000 || liveWallCount(match) < 4) return [];
  const out = [];
  const seen = new Set();
  for (const raw of p.hand) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const rest = [...p.hand];
    removeOne(rest, raw);
    if (core.shanten(countsOf(rest), p.melds.length) === 0) out.push(raw);
  }
  return out;
}

function legalPlay(match, seat) {
  const none = { discards: [], riichi: [], tsumo: false, kan: [], nuki: false };
  if (match.phase !== 'play' || match.turn !== seat) return none;
  const p = match.players[seat];
  if (p.riichi) {
    // リーチ後はツモ切り固定。ただし条件を満たす暗槓と北抜きは選べる
    return {
      discards: match.lastDrawn !== null ? [match.lastDrawn] : [],
      riichi: [],
      tsumo: Boolean(evalWin(match, seat, match.lastDrawn, 'tsumo', tsumoExtra(match, seat))),
      kan: riichiKanOptionsOf(match, seat),
      nuki: canNuki(match, seat),
    };
  }
  const tsumo = match.lastDrawn !== null &&
    Boolean(evalWin(match, seat, match.lastDrawn, 'tsumo', tsumoExtra(match, seat)));
  return {
    discards: [...new Set(p.hand)],
    riichi: riichiOptionsOf(match, seat),
    tsumo,
    kan: match.lastDrawn === null ? [] : kanOptionsOf(match, seat), // ポン直後は槓できない
    nuki: canNuki(match, seat),
  };
}

function tsumoExtra(match, seat) {
  return {
    rinshan: match.drawnFromRinshan,
    haitei: !match.drawnFromRinshan && liveWallCount(match) === 0,
    tenhou: match.pristine, // 天和/地和は core が isDealer で出し分ける
  };
}

// ---- 打牌と鳴き応答ウィンドウ ----

// 打牌する。riichi=true ならリーチ宣言牌として切る。
// 戻り値: { ok } / { ok:false, reason }
function applyDiscard(match, seat, raw, { riichi = false } = {}) {
  if (match.phase !== 'play' || match.turn !== seat) return { ok: false, reason: 'あなたの番ではありません' };
  const p = match.players[seat];
  const legal = legalPlay(match, seat);
  if (riichi && !legal.riichi.includes(raw) && !legal.riichi.some((t) => normalizeTile(t) === normalizeTile(raw))) {
    return { ok: false, reason: 'その牌ではリーチできません' };
  }
  if (!riichi && p.riichi && normalizeTile(raw) !== normalizeTile(match.lastDrawn)) {
    return { ok: false, reason: 'リーチ後はツモ切りだけです' };
  }
  if (!p.hand.some((t) => normalizeTile(t) === normalizeTile(raw))) {
    return { ok: false, reason: 'その牌は持っていません' };
  }
  const wasPristine = match.pristine;
  removeOne(p.hand, raw);
  sortHand(p.hand);
  if (riichi) {
    const isFirst = wasPristine;
    p.riichi = true;
    p.doubleRiichi = isFirst;
    p.ippatsu = true;
    p.score -= 1000;
    match.kyotaku += 1;
    p.riichiDiscardIndex = p.discards.length;
  }
  p.discards.push({ tile: raw, riichi, called: false });
  if (p.ippatsu && !riichi) p.ippatsu = false; // 自分が切り終えたら一発消滅（宣言時はこの後クリアしない）
  if (riichi) p.ippatsu = true;
  match.pristine = false;
  match.lastDrawn = null;
  match.drawnFromRinshan = false;

  // 鳴き・ロンの応答ウィンドウを作る
  const options = {};
  for (let i = 1; i < SEATS; i++) {
    const s = (seat + i) % SEATS;
    const o = callOptionsFor(match, s, raw, seat);
    if (o.ron || o.pon || o.kan) options[s] = o;
  }
  if (Object.keys(options).length === 0) {
    advanceAfterDiscard(match, seat);
  } else {
    match.phase = 'call';
    match.call = {
      discarder: seat, tile: raw, kind: 'discard',
      options, responses: {},
    };
  }
  return { ok: true };
}

// あるプレイヤーが他家の捨て牌に対して取れるアクション
function callOptionsFor(match, seat, raw, fromSeat) {
  const p = match.players[seat];
  const kind = normalizeTile(raw);
  const out = { ron: false, pon: false, kan: false };
  if (core.shanten(countsOf([...p.hand, raw]), p.melds.length) === -1 || canWinWith(match, seat, raw)) {
    out.ron = Boolean(canWinWith(match, seat, raw)) && !isFuriten(match, seat);
  }
  const n = countsOf(p.hand)[kind];
  if (!p.riichi && n >= 2) out.pon = true;
  if (!p.riichi && n >= 3) out.kan = true;
  void fromSeat;
  return out;
}

function canWinWith(match, seat, raw) {
  const houtei = liveWallCount(match) === 0;
  return evalWin(match, seat, raw, 'ron', { houtei });
}

// 応答を記録する。全員分そろうか、ロンが出そろったらサーバーが resolveCall を呼ぶ
function applyCallResponse(match, seat, action) {
  if (match.phase !== 'call' || !match.call) return { ok: false, reason: '応答できる場面ではありません' };
  const opts = match.call.options[seat];
  if (!opts) return { ok: false, reason: 'あなたに取れるアクションはありません' };
  if (action !== 'pass' && !opts[action]) return { ok: false, reason: 'そのアクションは取れません' };
  match.call.responses[seat] = action;
  return { ok: true };
}

// 全員応答済みか（ロン即決判定に使う）
function callSettled(match) {
  if (!match.call) return true;
  const { options, responses } = match.call;
  const seats = Object.keys(options).map(Number);
  // ロン宣言者がいて、他のロン候補も全員応答済みなら即決できる
  const ronners = seats.filter((s) => responses[s] === 'ron');
  if (ronners.length > 0) {
    const otherRonCandidates = seats.filter((s) => options[s].ron && responses[s] === undefined);
    if (otherRonCandidates.length === 0) return true;
  }
  return seats.every((s) => responses[s] !== undefined);
}

// ウィンドウを解決する（全員応答 or タイムアウト後にサーバーが呼ぶ）
function resolveCall(match) {
  if (match.phase !== 'call' || !match.call) return;
  const call = match.call;
  match.call = null;
  if (call.kind === 'chankan') {
    const ronner = [0, 1, 2].find((s) => call.responses[s] === 'ron');
    if (ronner !== undefined) {
      applyRon(match, ronner, call.discarder, call.tile, { chankan: true });
      return;
    }
    // 搶槓されなかった: 槓を確定させて嶺上ツモへ
    completeKan(match, call.discarder, call.kanMeld);
    return;
  }
  const { discarder, tile } = call;
  // ロン（頭ハネ: 放銃者に近い順）
  for (let i = 1; i < SEATS; i++) {
    const s = (discarder + i) % SEATS;
    if (call.responses[s] === 'ron') {
      applyRon(match, s, discarder, tile, { houtei: liveWallCount(match) === 0 });
      return;
    }
  }
  // 見逃したロン候補は見逃しフリテン
  for (const s of Object.keys(call.options).map(Number)) {
    if (call.options[s].ron && call.responses[s] !== 'ron') match.tempFuriten[s] = true;
  }
  // ポン/カン
  for (let i = 1; i < SEATS; i++) {
    const s = (discarder + i) % SEATS;
    const act = call.responses[s];
    if (act === 'pon') { applyPon(match, s, discarder, tile); return; }
    if (act === 'kan') { applyDaiminkan(match, s, discarder, tile); return; }
  }
  advanceAfterDiscard(match, discarder);
}

// 誰も鳴かなかった場合の次手番処理（山が尽きていれば流局）
function advanceAfterDiscard(match, discarder) {
  if (liveWallCount(match) === 0) {
    applyExhaustiveDraw(match);
    return;
  }
  match.turn = (discarder + 1) % SEATS;
  match.phase = 'play';
  doDraw(match);
}

function markCalledDiscard(match, seat) {
  const p = match.players[seat];
  const d = p.discards[p.discards.length - 1];
  if (d) d.called = true;
  // 鳴かれたら全員の一発は消える
  for (const pl of match.players) pl.ippatsu = false;
  match.pristine = false;
}

function applyPon(match, seat, fromSeat, raw) {
  const p = match.players[seat];
  const kind = normalizeTile(raw);
  const used = [];
  for (let i = 0; i < 2; i++) {
    const idx = p.hand.findIndex((t, j) => normalizeTile(t) === kind && !used.includes(j));
    used.push(idx);
  }
  const tiles = used.map((j) => p.hand[j]).sort((a, b) => a - b);
  for (const j of used.sort((a, b) => b - a)) p.hand.splice(j, 1);
  p.melds.push({ type: 'pon', tile: kind, tiles: [...tiles, raw], open: true, from: fromSeat });
  markCalledDiscard(match, fromSeat);
  match.turn = seat;
  match.phase = 'play';
  match.lastDrawn = null; // ポン後はツモなしで打牌
  match.drawnFromRinshan = false;
}

function applyDaiminkan(match, seat, fromSeat, raw) {
  const p = match.players[seat];
  const kind = normalizeTile(raw);
  const idxs = [];
  p.hand.forEach((t, j) => { if (normalizeTile(t) === kind) idxs.push(j); });
  const tiles = idxs.map((j) => p.hand[j]);
  for (const j of idxs.sort((a, b) => b - a)) p.hand.splice(j, 1);
  const meld = { type: 'kan', tile: kind, tiles: [...tiles, raw], open: true, from: fromSeat };
  p.melds.push(meld);
  markCalledDiscard(match, fromSeat);
  match.turn = seat;
  flipKanDora(match);
  match.phase = 'play';
  doDraw(match, true);
}

function flipKanDora(match) {
  match.kanCount += 1;
  match.doraIndicators.push(match.deadWall[4 + match.kanCount]);
}

// 自分の手番での槓（暗槓/小明槓）。小明槓は搶槓ウィンドウを開く
function applyKan(match, seat, kanTile, kanKind) {
  if (match.phase !== 'play' || match.turn !== seat) return { ok: false, reason: 'あなたの番ではありません' };
  const legal = legalPlay(match, seat);
  const opt = legal.kan.find((k) => k.tile === kanTile && k.kind === kanKind);
  if (!opt) return { ok: false, reason: 'その槓はできません' };
  const p = match.players[seat];
  if (kanKind === 'ankan') {
    const idxs = [];
    p.hand.forEach((t, j) => { if (normalizeTile(t) === kanTile) idxs.push(j); });
    const tiles = idxs.map((j) => p.hand[j]);
    for (const j of idxs.sort((a, b) => b - a)) p.hand.splice(j, 1);
    const meld = { type: 'kan', tile: kanTile, tiles, open: false, from: seat };
    p.melds.push(meld);
    match.pristine = false;
    flipKanDora(match);
    match.phase = 'play';
    doDraw(match, true);
    return { ok: true };
  }
  // 小明槓: 加槓牌を他家がロンできる（搶槓）
  const meld = p.melds.find((m) => m.type === 'pon' && m.tile === kanTile);
  const idx = p.hand.findIndex((t) => normalizeTile(t) === kanTile);
  const added = p.hand[idx];
  p.hand.splice(idx, 1);
  meld.type = 'kan';
  meld.tiles.push(added);
  match.pristine = false;
  const options = {};
  for (let i = 1; i < SEATS; i++) {
    const s = (seat + i) % SEATS;
    if (canWinWith(match, s, added) && !isFuriten(match, s)) options[s] = { ron: true, pon: false, kan: false };
  }
  if (Object.keys(options).length === 0) {
    completeKan(match, seat, meld);
  } else {
    match.phase = 'call';
    match.call = { discarder: seat, tile: added, kind: 'chankan', options, responses: {}, kanMeld: meld };
  }
  return { ok: true };
}

function completeKan(match, seat, meld) {
  void meld;
  match.turn = seat;
  flipKanDora(match);
  match.phase = 'play';
  doDraw(match, true);
}

// 北抜き: 手牌の北を1枚抜いて公開し（抜いた北はドラとして数える）、嶺上から1枚補充する。
// 手牌の構成は変わらないのでリーチ後でもできる。補充で引いた牌が北なら続けて抜ける
function applyNuki(match, seat) {
  if (match.phase !== 'play' || match.turn !== seat) return { ok: false, reason: 'あなたの番ではありません' };
  if (match.lastDrawn === null) return { ok: false, reason: 'ツモした後だけ抜けます' };
  const p = match.players[seat];
  const idx = p.hand.findIndex((t) => normalizeTile(t) === NORTH);
  if (idx < 0) return { ok: false, reason: '北を持っていません' };
  p.hand.splice(idx, 1);
  p.kita += 1;
  doDraw(match, true); // 嶺上から補充
  return { ok: true };
}

// ツモ和了
function applyTsumo(match, seat) {
  if (match.phase !== 'play' || match.turn !== seat) return { ok: false, reason: 'あなたの番ではありません' };
  const result = evalWin(match, seat, match.lastDrawn, 'tsumo', tsumoExtra(match, seat));
  if (!result) return { ok: false, reason: '和了できません' };
  settleWin(match, seat, null, match.lastDrawn, 'tsumo', result);
  return { ok: true };
}

function applyRon(match, winner, fromSeat, raw, extra = {}) {
  const result = evalWin(match, winner, raw, 'ron', extra);
  if (!result) return;
  settleWin(match, winner, fromSeat, raw, 'ron', result);
}

// 点数移動と局の終了処理
function settleWin(match, winner, fromSeat, winRaw, winType, result) {
  const p = match.players[winner];
  const payments = [];
  if (winType === 'ron') {
    const amount = result.settlement.total;
    match.players[fromSeat].score -= amount;
    p.score += amount;
    payments.push({ from: fromSeat, to: winner, amount });
  } else {
    const others = [0, 1, 2].filter((s) => s !== winner);
    const childPool = others.filter((s) => s !== match.dealer);
    const sorted = result.settlement.payments.map((pay) => {
      if (pay.from === 'dealer') return { from: match.dealer, amount: pay.amount };
      return { from: childPool.shift(), amount: pay.amount }; // 親ツモは子2人から1回ずつ
    });
    for (const pay of sorted) {
      match.players[pay.from].score -= pay.amount;
      p.score += pay.amount;
      payments.push({ from: pay.from, to: winner, amount: pay.amount });
    }
  }
  const sticks = match.kyotaku;
  if (sticks > 0) { p.score += sticks * 1000; match.kyotaku = 0; }
  match.lastResult = {
    type: winType,
    winner,
    from: fromSeat,
    winTile: winRaw,
    hand: [...p.hand],
    melds: p.melds,
    yaku: result.yaku,
    yakumans: result.yakumans,
    han: result.han,
    fu: result.fu,
    doraCount: result.doraCount,
    payments,
    riichiSticks: sticks,
    scores: match.players.map((pl) => pl.score),
  };
  match.phase = 'roundEnd';
  afterRound(match, { winner });
}

// 流局（荒牌平局）: テンパイ料の授受
function applyExhaustiveDraw(match) {
  const tenpai = match.players.map((p, s) => core.shanten(countsOf(p.hand), p.melds.length) === 0);
  const changes = [0, 0, 0];
  const nTenpai = tenpai.filter(Boolean).length;
  if (nTenpai === 1) {
    tenpai.forEach((t, s) => { changes[s] = t ? 3000 : -1500; });
  } else if (nTenpai === 2) {
    tenpai.forEach((t, s) => { changes[s] = t ? 1500 : -3000; });
  }
  match.players.forEach((p, s) => { p.score += changes[s]; });
  match.lastResult = {
    type: 'draw',
    tenpai,
    payments: changes.map((amount, s) => ({ seat: s, amount })).filter((x) => x.amount !== 0),
    scores: match.players.map((pl) => pl.score),
    hands: match.players.map((p) => [...p.hand]),
  };
  match.phase = 'roundEnd';
  afterRound(match, { winner: null, dealerTenpai: tenpai[match.dealer] });
}

// 局終了後の進行（連荘・次局・終局）。サーバーが roundEnd を見てから呼ぶのではなく、
// 結果を保持したまま「次の局の準備ができたか」を nextRoundReady で表す。
// ここでは進行先（dealer/honba/round）を先に確定させておき、サーバーが
// 表示時間をおいて startNextRound() を呼ぶ。
function afterRound(match, { winner = null, dealerTenpai = false } = {}) {
  const busted = match.players.some((p) => p.score < 0);
  const dealerKept = winner === match.dealer || (winner === null && dealerTenpai);
  match.nextDealer = dealerKept ? match.dealer : (match.dealer + 1) % SEATS;
  match.nextHonba = dealerKept ? match.honba + 1 : 0;
  match.nextIsLast = false;
  if (busted) { match.nextIsLast = true; return; }
  if (!dealerKept && roundIndex(match) === totalRounds(match) - 1) {
    match.nextIsLast = true;
  }
}

function startNextRound(match) {
  if (match.phase !== 'roundEnd') return;
  if (match.nextIsLast) {
    finishMatch(match);
    return;
  }
  const prevDealer = match.dealer;
  match.dealer = match.nextDealer;
  match.honba = match.nextHonba;
  if (match.dealer === (prevDealer + 1) % SEATS && match.nextHonba === 0) {
    // 親が流れ: 局数を進める
    match.roundNum += 1;
    if (match.roundNum > SEATS) {
      match.roundNum = 1;
      match.roundWind = 28; // 東→南
    }
  }
  startRound(match);
}

function finishMatch(match) {
  match.phase = 'gameEnd';
  // 残った供託は1位へ（同点は起家に近い順）
  const order = [0, 1, 2].sort((a, b) => {
    const d = match.players[b].score - match.players[a].score;
    if (d !== 0) return d;
    return ((a - match.firstDealer + SEATS) % SEATS) - ((b - match.firstDealer + SEATS) % SEATS);
  });
  if (match.kyotaku > 0) {
    match.players[order[0]].score += match.kyotaku * 1000;
    match.kyotaku = 0;
  }
  match.placements = [0, 0, 0];
  order.forEach((seat, i) => { match.placements[seat] = i + 1; });
  match.lastResult = {
    ...(match.lastResult || {}),
    type: 'gameEnd',
    placements: match.placements,
    scores: match.players.map((p) => p.score),
  };
}

// ---- 画面表示用のビュー（席ごとに秘匿情報を落とす） ----

function publicView(match, seat) {
  const players = match.players.map((p, s) => ({
    seat: s,
    score: p.score,
    riichi: p.riichi,
    kita: p.kita || 0,
    melds: p.melds,
    discards: p.discards,
    handCount: p.hand.length,
    isDealer: s === match.dealer,
    wind: seatWindOf(match, s),
    hand: s === seat || match.phase === 'gameEnd' || (match.phase === 'roundEnd' && match.lastResult && match.lastResult.winner === s)
      ? [...p.hand]
      : null,
    drawnTile: s === match.turn && match.phase === 'play' ? match.lastDrawn : null,
  }));
  let actions = null;
  if (match.phase === 'play' && match.turn === seat) {
    actions = { type: 'play', ...legalPlay(match, seat) };
  } else if (match.phase === 'call' && match.call && match.call.options[seat]) {
    actions = { type: 'call', ...match.call.options[seat], tile: match.call.tile, from: match.call.discarder };
  }
  return {
    you: seat,
    phase: match.phase,
    players,
    turn: match.turn,
    dealer: match.dealer,
    roundLabel: roundLabel(match),
    roundWind: match.roundWind,
    honba: match.honba,
    kyotaku: match.kyotaku,
    wallCount: liveWallCount(match),
    doraIndicators: [...match.doraIndicators],
    doraKinds: match.doraIndicators.map(nextDoraKind),
    callInfo: match.phase === 'call' && match.call
      ? { discarder: match.call.discarder, tile: match.call.tile }
      : null,
    actions,
    lastResult: match.phase === 'roundEnd' || match.phase === 'gameEnd' ? match.lastResult : null,
    placements: match.placements,
  };
}

// ---- Bot の簡易判断（フェーズ2: 牌効率ベース。押し引きはフェーズ3） ----

// 受け入れ枚数（その牌を引くとシャンテンが下がる種類と残り枚数の概算）
function ukeire(match, seat, handTiles) {
  const p = match.players[seat];
  const counts = countsOf(handTiles);
  const now = core.shanten(counts, p.melds.length);
  const visible = new Array(34).fill(0);
  for (const pl of match.players) {
    for (const d of pl.discards) visible[normalizeTile(d.tile)]++;
    for (const m of pl.melds) for (const t of m.tiles) visible[normalizeTile(t)]++;
  }
  for (const t of handTiles) visible[normalizeTile(t)]++;
  match.doraIndicators.forEach((t) => { visible[normalizeTile(t)]++; });
  let kinds = 0, total = 0;
  for (let t = 0; t < 34; t++) {
    if (counts[t] >= 4) continue;
    counts[t]++;
    if (core.shanten(counts, p.melds.length) < now) {
      kinds++;
      total += Math.max(0, 4 - visible[t]);
    }
    counts[t]--;
  }
  return { kinds, total };
}

// Bot の打牌選択: { tile, riichi }
function botChooseDiscard(match, seat) {
  const p = match.players[seat];
  const legal = legalPlay(match, seat);
  if (p.riichi) return { tile: match.lastDrawn, riichi: false };
  // リーチできるなら受入の広い切り方でリーチ
  if (legal.riichi.length > 0) {
    let best = null;
    for (const raw of legal.riichi) {
      const rest = [...p.hand];
      removeOne(rest, raw);
      const waits = core.waitingTiles(countsOf(rest), p.melds.length);
      if (!best || waits.length > best.waits.length) best = { tile: raw, waits };
    }
    if (best && best.waits.length >= 1) return { tile: best.tile, riichi: true };
  }
  let best = null;
  for (const raw of new Set(p.hand)) {
    const rest = [...p.hand];
    removeOne(rest, raw);
    const sh = core.shanten(countsOf(rest), p.melds.length);
    const uk = ukeire(match, seat, rest);
    // 切りたくなくなさ: 孤立した客風・端牌を先に切る。赤は温存
    const kind = normalizeTile(raw);
    let keep = 0;
    const counts = countsOf(p.hand);
    if (counts[kind] >= 2) keep += 3; // 対子以上は温存
    if (kind < 27) {
      const r = kind % 9;
      if (counts[kind - 1] > 0 || counts[kind + 1] > 0) keep += 2; // 順子の種
      if (r >= 1 && r <= 7) keep += 0.5; // 中張は少し温存
    } else if (kind >= 31 || kind === seatWindOf(match, seat) || kind === match.roundWind) {
      keep += 1.5; // 役牌は温存
    }
    if (isRed(raw)) keep += 2;
    const score = -sh * 1000 + uk.total * 10 + uk.kinds * 3 - keep;
    if (!best || score > best.score) best = { tile: raw, score };
  }
  return { tile: best.tile, riichi: false };
}

// Bot の鳴き応答: 'ron' | 'pon' | 'pass'（大明槓はフェーズ2では見送る）
function botChooseCall(match, seat) {
  const opts = match.call.options[seat];
  if (!opts) return 'pass';
  if (opts.ron) return 'ron';
  const p = match.players[seat];
  if (p.riichi) return 'pass';
  if (opts.pon) {
    const kind = normalizeTile(match.call.tile);
    const before = core.shanten(countsOf(p.hand), p.melds.length);
    const rest = [...p.hand];
    removeOne(rest, rest.find((t) => normalizeTile(t) === kind));
    removeOne(rest, rest.find((t) => normalizeTile(t) === kind));
    const after = core.shanten(countsOf(rest), p.melds.length + 1);
    const yakuhai = kind >= 31 || kind === seatWindOf(match, seat) || kind === match.roundWind;
    if (after < before && (after === 0 || yakuhai)) return 'pon';
  }
  return 'pass';
}

// Bot の手番アクション全体: { type:'tsumo' } | { type:'nuki' } | { type:'kan', ... } | { type:'discard', tile, riichi }
function botChoosePlay(match, seat) {
  const legal = legalPlay(match, seat);
  if (legal.tsumo) return { type: 'tsumo' };
  if (legal.nuki) return { type: 'nuki' }; // 北は持ったら抜く（リーチ後も）
  const p = match.players[seat];
  if (!p.riichi && legal.kan.length > 0) {
    const ankan = legal.kan.find((k) => k.kind === 'ankan');
    if (ankan) {
      const counts = countsOf(p.hand);
      // 七対子狙い（七対シャンテンの方が小さい）なら暗槓で壊さない
      if (core.shantenRegular(counts, p.melds.length) <= core.shantenChiitoi(counts)) {
        return { type: 'kan', tile: ankan.tile, kanKind: 'ankan' };
      }
    }
    const shou = legal.kan.find((k) => k.kind === 'shouminkan');
    if (shou) return { type: 'kan', tile: shou.tile, kanKind: 'shouminkan' };
  }
  const d = botChooseDiscard(match, seat);
  return { type: 'discard', tile: d.tile, riichi: d.riichi };
}

module.exports = {
  START_SCORE, SEATS,
  createMatch, startRound, startNextRound,
  legalPlay, applyDiscard, applyTsumo, applyKan, applyNuki,
  applyCallResponse, callSettled, resolveCall,
  publicView, botChoosePlay, botChooseCall,
  evalWin, waitsOf, isFuriten, countDora, nextDoraKind,
  roundLabel, liveWallCount,
};
