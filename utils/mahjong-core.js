'use strict';

// 三麻中心の麻雀コアエンジン（フェーズ1：判定・計算のみ。対局進行はフェーズ2）
//
// 牌の表現：
//   種類は 0..33 の整数。0-8=萬子(1-9), 9-17=筒子(1-9), 18-26=索子(1-9), 27-33=字牌(東南西北白發中)
//   手牌は「種類→枚数」の34要素配列（counts）で扱う。
//   赤ドラは種類に畳んで数え、赤の枚数は別途 redCount として渡す（三麻は赤5筒・赤5索のみ）。
//   壁（牌山）は種類の配列。赤は特殊値 RED_5P / RED_5S で表し、normalizeTile で種類に戻す。
//
// 三麻の前提：
//   ・萬子は 1 と 9 のみ（各種4枚）。筒子・索子・字牌は通常通り。合計108枚。
//   ・チーは無し（フェーズ2の進行側で禁止する。コアは判定専用）。
//   ・北（種類30）は抜きドラに使えるが、手牌評価では通常の字牌としても扱えるよう素通しする
//     （抜いた北はフェーズ2側で手牌から外して数える想定）。

const RED_5P = 34; // 赤5筒（種類は13）
const RED_5S = 35; // 赤5索（種類は22）

const WINDS = { east: 27, south: 28, west: 29, north: 30 };
const DRAGONS = { white: 31, green: 32, red: 33 };

function normalizeTile(t) {
  if (t === RED_5P) return 13;
  if (t === RED_5S) return 22;
  return t;
}
function isRed(t) { return t === RED_5P || t === RED_5S; }
function suitOf(t) { return t < 9 ? 0 : t < 18 ? 1 : t < 27 ? 2 : 3; } // 0=萬 1=筒 2=索 3=字
function rankOf(t) { return t % 9 + 1; }
function isHonor(t) { return t >= 27; }
function isTerminal(t) { return !isHonor(t) && (rankOf(t) === 1 || rankOf(t) === 9); }
function isTerminalOrHonor(t) { return isHonor(t) || isTerminal(t); }
function isSimple(t) { return !isTerminalOrHonor(t); }

function countsFromTiles(tiles) {
  const c = new Array(34).fill(0);
  for (const t of tiles) c[normalizeTile(t)]++;
  return c;
}
function totalTiles(counts) { return counts.reduce((a, b) => a + b, 0); }

/** 三麻の牌山（108枚、赤5筒・赤5索つき）をシャッフルして返す。rng はテスト用に差し替え可能。 */
function buildWall(rng = Math.random) {
  const wall = [];
  const push4 = (t) => { for (let i = 0; i < 4; i++) wall.push(t); };
  push4(0); push4(8); // 萬子は1と9のみ
  for (let t = 9; t <= 26; t++) {
    if (t === 13) { wall.push(RED_5P, 13, 13, 13); }
    else if (t === 22) { wall.push(RED_5S, 22, 22, 22); }
    else push4(t);
  }
  for (let t = 27; t <= 33; t++) push4(t);
  for (let i = wall.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [wall[i], wall[j]] = [wall[j], wall[i]];
  }
  return wall;
}

// ---------- シャンテン数 ----------
// 戻り値： -1 = 和了、0 = 聴牌、1以上 = あと何枚で聴牌か。
// 副露がある場合は「閉じた手の枚数 = 3*n+2 型」になるよう、面子数を引いて評価する
// （呼び出し側が closedCounts だけを渡し、meldCount を申告する）。

function shantenRegular(counts, meldCount) {
  const c = counts.slice();
  let best = 8;
  // 再帰：面子・搭子・雀頭を抜きながら最小シャンテンを探す古典的探索
  function dfs(i, mentsu, taatsu, pair) {
    while (i < 34 && c[i] === 0) i++;
    if (i >= 34) {
      const m = mentsu + meldCount;
      const t = Math.min(taatsu, 4 - m); // 面子+搭子は4までしか意味を持たない
      const s = 8 - 2 * m - t - (pair ? 1 : 0);
      if (s < best) best = s;
      return;
    }
    // 刻子
    if (c[i] >= 3) { c[i] -= 3; dfs(i, mentsu + 1, taatsu, pair); c[i] += 3; }
    // 順子
    const s = suitOf(i), r = rankOf(i);
    if (s < 3 && r <= 7 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--; c[i + 1]--; c[i + 2]--;
      dfs(i, mentsu + 1, taatsu, pair);
      c[i]++; c[i + 1]++; c[i + 2]++;
    }
    // 雀頭
    if (!pair && c[i] >= 2) { c[i] -= 2; dfs(i, mentsu, taatsu, true); c[i] += 2; }
    // 搭子（対子）
    if (c[i] >= 2) { c[i] -= 2; dfs(i, mentsu, taatsu + 1, pair); c[i] += 2; }
    // 搭子（両面・辺張）
    if (s < 3 && r <= 8 && c[i + 1] > 0) { c[i]--; c[i + 1]--; dfs(i, mentsu, taatsu + 1, pair); c[i]++; c[i + 1]++; }
    // 搭子（嵌張）
    if (s < 3 && r <= 7 && c[i + 2] > 0) { c[i]--; c[i + 2]--; dfs(i, mentsu, taatsu + 1, pair); c[i]++; c[i + 2]++; }
    // 何も取らずに進める（浮き牌）
    c[i]--;
    dfs(i, mentsu, taatsu, pair);
    c[i]++;
  }
  dfs(0, 0, 0, false);
  return best;
}

function shantenChiitoi(counts) {
  let pairs = 0, unique = 0;
  for (let t = 0; t < 34; t++) {
    if (counts[t] > 0) unique++;
    if (counts[t] >= 2) pairs++;
  }
  return 6 - pairs + Math.max(0, 7 - unique);
}

function shantenKokushi(counts) {
  let unique = 0, hasPair = false;
  for (let t = 0; t < 34; t++) {
    if (!isTerminalOrHonor(t)) continue;
    if (counts[t] > 0) unique++;
    if (counts[t] >= 2) hasPair = true;
  }
  return 13 - unique - (hasPair ? 1 : 0);
}

/**
 * シャンテン数。meldCount は副露面子の数（0-4）。
 * 七対子・国士無双は門前（meldCount=0）のときだけ評価する。
 */
function shanten(counts, meldCount = 0) {
  let s = shantenRegular(counts, meldCount);
  if (meldCount === 0) {
    s = Math.min(s, shantenChiitoi(counts), shantenKokushi(counts));
  }
  return s;
}

function isWinningCounts(counts, meldCount = 0) {
  return shanten(counts, meldCount) === -1;
}

/** 聴牌の待ち牌一覧（種類の配列）。既に和了している場合は空。 */
function waitingTiles(counts, meldCount = 0) {
  if (shanten(counts, meldCount) !== 0) return [];
  const waits = [];
  for (let t = 0; t < 34; t++) {
    if (counts[t] >= 4) continue;
    counts[t]++;
    if (shanten(counts, meldCount) === -1) waits.push(t);
    counts[t]--;
  }
  return waits;
}

// ---------- 手の分解 ----------
// 面子は { type:'pon'|'chi'|'kan', tile, closed } で表す（tile は刻子/槓子ならその種類、順子なら最小の種類）。
// 副露（melds）の入力形式： { type:'pon'|'chi'|'kan', tile, open }（kan の open=false は暗槓）。

function decomposeClosed(counts) {
  const c = counts.slice();
  const results = [];
  function dfs(sets, pair) {
    let i = 0;
    while (i < 34 && c[i] === 0) i++;
    if (i >= 34) {
      if (pair !== null) results.push({ sets: sets.slice(), pair });
      return;
    }
    // 雀頭
    if (pair === null && c[i] >= 2) {
      c[i] -= 2;
      dfs(sets, i);
      c[i] += 2;
    }
    // 刻子
    if (c[i] >= 3) {
      c[i] -= 3;
      sets.push({ type: 'pon', tile: i, closed: true });
      dfs(sets, pair);
      sets.pop();
      c[i] += 3;
    }
    // 順子
    const s = suitOf(i), r = rankOf(i);
    if (s < 3 && r <= 7 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--; c[i + 1]--; c[i + 2]--;
      sets.push({ type: 'chi', tile: i, closed: true });
      dfs(sets, pair);
      sets.pop();
      c[i]++; c[i + 1]++; c[i + 2]++;
    }
  }
  dfs([], null);
  return results;
}

function meldToSet(m) {
  return { type: m.type, tile: m.tile, closed: m.type === 'kan' ? !m.open : false, fromMeld: true };
}

// ---------- 役判定・符・点数 ----------
// ctx: {
//   winTile, winType: 'ron'|'tsumo',
//   seatWind, roundWind,           // 種類番号（27=東…）
//   riichi: 0|1|2,                  // 1=リーチ, 2=ダブルリーチ
//   ippatsu, rinshan, haitei, houtei, chankan, tenhou: bool（特殊条件は呼び出し側が申告）
//   doraCount,                      // ドラ＋赤＋抜きドラの合計（役とは別に加算）
//   honba,                          // 本場（点数に上乗せして返す）
// }
// 戻り値： 和了でなければ null。和了なら最良の解釈で
//   { yaku: [{name, han}], han, fu, yakuman, score: {...}, sanma: {...} }

function basePoints(han, fu) {
  if (han >= 13) return 8000;
  if (han >= 11) return 6000;
  if (han >= 8) return 4000;
  if (han >= 6) return 3000;
  if (han >= 5) return 2000;
  const base = fu * Math.pow(2, 2 + han);
  return Math.min(base, 2000);
}
function ceil100(n) { return Math.ceil(n / 100) * 100; }

function scoreFromHanFu(han, fu, isDealer, honba) {
  const base = basePoints(han, fu);
  if (han >= 5 || base >= 2000) {
    // 満貫以上
    const ron = isDealer ? base * 6 : base * 4;
    return {
      ron: ron + honba * 300,
      tsumoEach: isDealer ? base * 2 : null, // 親ツモは全員同額
      tsumoChild: isDealer ? null : base,
      tsumoDealer: isDealer ? null : base * 2,
      total: isDealer ? base * 6 : base * 4,
      isDealer,
    };
  }
  const ron = ceil100(base * (isDealer ? 6 : 4)) + honba * 300;
  const tsumoChild = ceil100(base) + honba * 100;
  const tsumoDealer = ceil100(base * 2) + honba * 100;
  const tsumoAll = ceil100(base * 2) + honba * 100; // 親ツモ
  return {
    ron,
    tsumoEach: isDealer ? tsumoAll : null,
    tsumoChild: isDealer ? null : tsumoChild,
    tsumoDealer: isDealer ? null : tsumoDealer,
    total: ron - honba * 300,
    isDealer,
  };
}

function setTiles(set) {
  if (set.type === 'chi') return [set.tile, set.tile + 1, set.tile + 2];
  return [set.tile, set.tile, set.tile];
}
function allTilesOf(sets, pair) {
  const out = [];
  for (const s of sets) out.push(...setTiles(s));
  out.push(pair, pair);
  return out;
}
function isYakuhaiPair(pair, ctx) {
  return pair >= 31 || pair === ctx.seatWind || pair === ctx.roundWind;
}

/** 待ちの形を判定する。component: {kind:'pair'} | {kind:'set', set} */
function waitTypeOf(decomp, winTile, comp) {
  if (comp.kind === 'pair') return decomp.pair === winTile ? 'tanki' : null;
  const s = comp.set;
  if (s.type === 'pon') return s.tile === winTile ? 'shanpon' : null;
  if (s.type === 'kan') return null;
  // chi
  if (winTile === s.tile + 1) return 'kanchan';
  if (winTile === s.tile) return rankOf(s.tile) === 7 ? 'penchan' : 'ryanmen';
  if (winTile === s.tile + 2) return rankOf(s.tile) === 1 ? 'penchan' : 'ryanmen';
  return null;
}

function evaluateDecomp(sets, pair, ctx, winComp, wait) {
  const isMenzen = !sets.some((s) => s.fromMeld && s.closed === false);
  const yaku = [];
  const add = (name, han) => yaku.push({ name, han });
  const tiles = allTilesOf(sets, pair);
  const ponSets = sets.filter((s) => s.type === 'pon' || s.type === 'kan');
  const chiSets = sets.filter((s) => s.type === 'chi');
  const kanCount = sets.filter((s) => s.type === 'kan').length;

  // 役満系（先に判定し、該当すれば通常役は数えない）
  const yakumans = [];
  const dragonPons = ponSets.filter((s) => s.tile >= 31).length;
  const windPons = ponSets.filter((s) => s.tile >= 27 && s.tile <= 30).length;
  if (dragonPons === 3) yakumans.push({ name: '大三元', mult: 1 });
  if (windPons === 4) yakumans.push({ name: '大四喜', mult: 1 });
  else if (windPons === 3 && pair >= 27 && pair <= 30) yakumans.push({ name: '小四喜', mult: 1 });
  if (tiles.every((t) => isHonor(t))) yakumans.push({ name: '字一色', mult: 1 });
  if (tiles.every((t) => isTerminal(t))) yakumans.push({ name: '清老頭', mult: 1 });
  const GREEN = new Set([19, 20, 21, 23, 25, 32]); // 2,3,4,6,8索＋發
  if (tiles.every((t) => GREEN.has(t))) yakumans.push({ name: '緑一色', mult: 1 });
  if (kanCount === 4) yakumans.push({ name: '四槓子', mult: 1 });
  // 四暗刻：閉じた刻子/槓子が4つ
  const closedPons = sets.filter((s, idx) => {
    if (s.type !== 'pon' && s.type !== 'kan') return false;
    if (!s.closed) return false;
    if (ctx.winType === 'ron' && winComp.kind === 'set' && winComp.set === s) return false;
    return true;
  }).length;
  if (closedPons === 4) {
    yakumans.push({ name: wait === 'tanki' ? '四暗刻単騎' : '四暗刻', mult: wait === 'tanki' ? 2 : 1 });
  }
  if (ctx.tenhou) yakumans.push({ name: ctx.isDealer ? '天和' : '地和', mult: 1 });
  if (yakumans.length > 0) {
    return { yakumans, yaku: [], sets, pair, wait };
  }

  // 通常役
  if (ctx.riichi === 2) add('ダブルリーチ', 2);
  else if (ctx.riichi === 1) add('リーチ', 1);
  if (ctx.riichi > 0 && ctx.ippatsu) add('一発', 1);
  if (ctx.haitei && ctx.winType === 'tsumo') add('海底撈月', 1);
  if (ctx.houtei && ctx.winType === 'ron') add('河底撈魚', 1);
  if (ctx.rinshan) add('嶺上開花', 1);
  if (ctx.chankan) add('搶槓', 1);
  if (isMenzen && ctx.winType === 'tsumo') add('門前清自摸和', 1);
  if (tiles.every((t) => isSimple(t))) add('断ヤオ九', 1);
  // 役牌
  for (const s of ponSets) {
    if (s.tile >= 31) add('役牌', 1);
    else {
      const n = (s.tile === ctx.roundWind ? 1 : 0) + (s.tile === ctx.seatWind ? 1 : 0);
      if (n > 0) add('役牌', n); // ダブ風は2翻
    }
  }
  // 平和
  const isPinfuShape = chiSets.length === 4 && !isYakuhaiPair(pair, ctx) && wait === 'ryanmen';
  if (isMenzen && isPinfuShape) add('平和', 1);
  // 一盃口・二盃口（門前のみ）
  if (isMenzen) {
    const chiKeys = chiSets.map((s) => s.tile).sort((a, b) => a - b);
    let pairsOfChi = 0;
    for (let i = 0; i + 1 < chiKeys.length; i++) {
      if (chiKeys[i] === chiKeys[i + 1]) { pairsOfChi++; i++; }
    }
    if (pairsOfChi === 2) add('二盃口', 3);
    else if (pairsOfChi === 1) add('一盃口', 1);
  }
  if (ponSets.length === 4) add('対々和', 2);
  if (closedPons === 3) add('三暗刻', 2);
  if (kanCount === 3) add('三槓子', 2);
  if (dragonPons === 2 && pair >= 31) add('小三元', 2);
  // 三色同順・三色同刻
  for (let r = 1; r <= 9; r++) {
    const base = [r - 1, 9 + r - 1, 18 + r - 1];
    if (base.every((b) => chiSets.some((s) => s.tile === b))) { add('三色同順', isMenzen ? 2 : 1); break; }
  }
  for (let r = 1; r <= 9; r++) {
    const base = [r - 1, 9 + r - 1, 18 + r - 1];
    if (base.every((b) => ponSets.some((s) => s.tile === b))) { add('三色同刻', 2); break; }
  }
  // 一気通貫
  for (let s0 = 0; s0 < 3; s0++) {
    const base = s0 * 9;
    if ([0, 3, 6].every((o) => chiSets.some((s) => s.tile === base + o))) { add('一気通貫', isMenzen ? 2 : 1); break; }
  }
  // チャンタ系
  const touches = (t) => isTerminalOrHonor(t);
  const everyTouches = sets.every((s) => setTiles(s).some(touches)) && touches(pair);
  if (everyTouches && chiSets.length > 0) {
    if (tiles.every((t) => isTerminal(t))) add('純全帯ヤオ九', isMenzen ? 3 : 2);
    else if (tiles.every((t) => isTerminalOrHonor(t))) add('混全帯ヤオ九', isMenzen ? 2 : 1);
  }
  if (tiles.every((t) => isTerminalOrHonor(t)) && chiSets.length === 0) {
    // 順子なしで全てヤオ九＝混老頭（純老頭・字一色は役満で処理済み）
    add('混老頭', 2);
  }
  // 混一色・清一色
  const suits = new Set(tiles.filter((t) => !isHonor(t)).map((t) => suitOf(t)));
  const hasHonor = tiles.some((t) => isHonor(t));
  if (suits.size === 1) {
    if (hasHonor) add('混一色', isMenzen ? 3 : 2);
    else add('清一色', isMenzen ? 6 : 5);
  }
  return { yakumans: [], yaku, sets, pair, wait, isPinfuShape };
}

function calcFu(sets, pair, ctx, winComp, wait, isPinfuShape, isMenzen) {
  if (isPinfuShape && isMenzen) return ctx.winType === 'tsumo' ? 20 : 30;
  let fu = 20;
  if (ctx.winType === 'ron' && isMenzen) fu += 10;
  if (ctx.winType === 'tsumo') fu += 2;
  for (const s of sets) {
    if (s.type === 'chi') continue;
    let closed = s.closed;
    if (ctx.winType === 'ron' && winComp.kind === 'set' && winComp.set === s && s.type === 'pon') closed = false;
    const base = isTerminalOrHonor(s.tile) ? 4 : 2;
    let v = closed ? base * 2 : base;
    if (s.type === 'kan') v *= 4;
    fu += v;
  }
  if (pair >= 31) fu += 2;
  if (pair === ctx.seatWind) fu += 2;
  if (pair === ctx.roundWind) fu += 2;
  if (wait === 'tanki' || wait === 'kanchan' || wait === 'penchan') fu += 2;
  if (fu === 20 && ctx.winType === 'ron') fu = 30; // 喰い平和形などは30符
  return Math.ceil(fu / 10) * 10;
}

/**
 * 和了評価の入口。
 * @param {number[]} counts 閉じた手の枚数表（和了牌を含み、3*副露数+2 枚相当）
 * @param {Array} melds 副露（meldToSet の入力形式）
 * @param {object} ctx 上記コメント参照
 */
function evaluateWin(counts, melds = [], ctx = {}) {
  const c = {
    riichi: 0, ippatsu: false, rinshan: false, haitei: false, houtei: false,
    chankan: false, tenhou: false, doraCount: 0, honba: 0,
    seatWind: WINDS.east, roundWind: WINDS.east, isDealer: false, ...ctx,
  };
  const meldCount = melds.length;
  if (!isWinningCounts(counts, meldCount)) return null;
  const meldSets = melds.map(meldToSet);
  const candidates = [];

  // 七対子（門前のみ）
  if (meldCount === 0 && shantenChiitoi(counts) === -1) {
    const yaku = [];
    const tiles = counts.flatMap((n, t) => Array(n).fill(t));
    if (tiles.every((t) => isSimple(t))) yaku.push({ name: '断ヤオ九', han: 1 });
    if (tiles.every((t) => isTerminalOrHonor(t))) yaku.push({ name: '混老頭', han: 2 });
    const suits = new Set(tiles.filter((t) => !isHonor(t)).map((t) => suitOf(t)));
    const hasHonor = tiles.some((t) => isHonor(t));
    if (suits.size === 1) yaku.push(hasHonor ? { name: '混一色', han: 3 } : { name: '清一色', han: 6 });
    if (tiles.every((t) => isHonor(t))) {
      candidates.push({ yakumans: [{ name: '字一色', mult: 1 }], yaku: [], fu: 25 });
    } else {
      if (c.riichi === 2) yaku.push({ name: 'ダブルリーチ', han: 2 });
      else if (c.riichi === 1) yaku.push({ name: 'リーチ', han: 1 });
      if (c.riichi > 0 && c.ippatsu) yaku.push({ name: '一発', han: 1 });
      if (c.winType === 'tsumo') yaku.push({ name: '門前清自摸和', han: 1 });
      if (c.haitei && c.winType === 'tsumo') yaku.push({ name: '海底撈月', han: 1 });
      if (c.houtei && c.winType === 'ron') yaku.push({ name: '河底撈魚', han: 1 });
      yaku.push({ name: '七対子', han: 2 });
      candidates.push({ yakumans: [], yaku, fu: 25 });
    }
  }

  // 国士無双（門前のみ）
  if (meldCount === 0 && shantenKokushi(counts) === -1) {
    // 13面待ち：和了牌を除いても全13種がそろっている（＝和了牌の種類が2枚ある）
    const is13Wait = counts[c.winTile] === 2;
    candidates.push({ yakumans: [{ name: is13Wait ? '国士無双13面待ち' : '国士無双', mult: is13Wait ? 2 : 1 }], yaku: [], fu: 0 });
  }

  // 九蓮宝燈（門前・清一色形）： 1112345678999＋同種1枚
  if (meldCount === 0) {
    for (let s0 = 0; s0 < 3; s0++) {
      const base = s0 * 9;
      const shape = [3, 1, 1, 1, 1, 1, 1, 1, 3];
      let ok = true, extra = 0;
      for (let r = 0; r < 9; r++) {
        const n = counts[base + r];
        if (n < shape[r]) { ok = false; break; }
        extra += n - shape[r];
      }
      const others = counts.reduce((a, n, t) => a + (t >= base && t < base + 9 ? 0 : n), 0);
      if (ok && extra === 1 && others === 0) {
        candidates.push({ yakumans: [{ name: '九蓮宝燈', mult: 1 }], yaku: [], fu: 0 });
      }
    }
  }

  // 通常形
  for (const decomp of decomposeClosed(counts)) {
    const sets = [...decomp.sets, ...meldSets];
    const comps = [{ kind: 'pair' }];
    for (const s of decomp.sets) comps.push({ kind: 'set', set: s });
    for (const comp of comps) {
      const wait = waitTypeOf(decomp, c.winTile, comp);
      if (wait === null) continue;
      const ev = evaluateDecomp(sets, decomp.pair, c, comp, wait);
      if (ev.yakumans.length > 0) {
        candidates.push({ yakumans: ev.yakumans, yaku: [], fu: 0 });
        continue;
      }
      if (ev.yaku.length === 0) continue;
      const isMenzen = !sets.some((s) => s.fromMeld && s.closed === false);
      const fu = calcFu(sets, decomp.pair, c, comp, wait, ev.isPinfuShape && isMenzen, isMenzen);
      candidates.push({ yakumans: [], yaku: ev.yaku, fu });
    }
  }

  if (candidates.length === 0) return null;
  // 最良候補： 役満倍率 → 点数（ロン/ツモの実収）→ 翻数 の順
  let best = null;
  for (const cand of candidates) {
    const mult = cand.yakumans.reduce((a, y) => a + y.mult, 0);
    let han = 0, score = null, yakuman = 0;
    if (mult > 0) {
      yakuman = mult;
      const unit = c.isDealer ? 48000 : 32000;
      score = {
        ron: unit * mult + c.honba * 300,
        tsumoEach: c.isDealer ? 16000 * mult + c.honba * 100 : null,
        tsumoChild: c.isDealer ? null : 8000 * mult + c.honba * 100,
        tsumoDealer: c.isDealer ? null : 16000 * mult + c.honba * 100,
        total: unit * mult,
        isDealer: c.isDealer,
      };
      if (c.winType === 'tsumo') {
        score.total = c.isDealer ? (16000 * mult + c.honba * 100) * 3 : 32000 * mult + c.honba * 300; // 4人分の総点
        score.ron = score.total;
      }
    } else {
      han = cand.yaku.reduce((a, y) => a + y.han, 0) + c.doraCount;
      if (han === c.doraCount) continue; // 役なし（ドラだけ）は和了不可
      score = scoreFromHanFu(han, cand.fu, c.isDealer, c.honba);
    }
    const value = c.winType === 'tsumo'
      ? (score.tsumoEach ? score.tsumoEach * 3 : (score.tsumoChild ?? 0) + (score.tsumoDealer ?? 0))
      : score.ron;
    const entry = { ...cand, han, yakuman, score, value };
    if (!best || entry.yakuman > best.yakuman ||
        (entry.yakuman === best.yakuman && entry.value > best.value) ||
        (entry.yakuman === best.yakuman && entry.value === best.value && entry.han > best.han)) {
      best = entry;
    }
  }
  if (!best) return null;
  const { value, ...result } = best;
  void value;
  // ツモのとき score.total を4人分の実収合計にそろえる（ron はそのままで正しい）
  if (c.winType === 'tsumo' && result.score) {
    result.score.total = result.score.tsumoEach
      ? result.score.tsumoEach * 3
      : (result.score.tsumoChild ?? 0) * 2 + (result.score.tsumoDealer ?? 0);
  }
  // 三麻の精算：ツモは不在の1席分を除いた2人から受け取る
  result.sanma = sanmaSettlement(result.score, c);
  result.doraCount = c.doraCount;
  return result;
}

/** 三麻用：4人分の score を、実際に存在する2人の対戦相手からの収支に直す */
function sanmaSettlement(score, ctx) {
  if (ctx.winType === 'ron') {
    return { total: score.ron, payments: [{ from: 'discarder', amount: score.ron }] };
  }
  if (ctx.isDealer) {
    return { total: score.tsumoEach * 2, payments: [{ from: 'child', amount: score.tsumoEach }, { from: 'child', amount: score.tsumoEach }] };
  }
  return {
    total: score.tsumoChild + score.tsumoDealer,
    payments: [{ from: 'child', amount: score.tsumoChild }, { from: 'dealer', amount: score.tsumoDealer }],
  };
}

module.exports = {
  RED_5P, RED_5S, WINDS, DRAGONS,
  normalizeTile, isRed, suitOf, rankOf, isHonor, isTerminal, isTerminalOrHonor, isSimple,
  countsFromTiles, totalTiles, buildWall,
  shanten, shantenRegular, shantenChiitoi, shantenKokushi, isWinningCounts, waitingTiles,
  decomposeClosed, evaluateWin, scoreFromHanFu, sanmaSettlement,
};
