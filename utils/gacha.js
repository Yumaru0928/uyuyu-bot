'use strict';

// うゆゆガチャの抽選ロジック（コマンドから分離してテスト可能にしてある）
//
// ・レアリティ確率: SSR 3% / SR 合計10% / R 合計17% / N 残り（プール内での重みで表す）
// ・週替わりローテーション: SR/R/N の13種から毎週3種が「お休み」（排出されない）。
//   組み合わせは ISO 週番号から決定的に算出するので全員共通・DB不要。
// ・条件ドロップ: 対戦で勝った日（uyuyu_take）／深夜 JST 0〜5時（uyuyu_sleeping）／
//   12月（uyuyu_santa）のときだけ低確率枠としてプールに混ざる。
//   rolling_uyuyu はガチャからは出ない（リアクション経由のみ）
// ・10連の最後の1枠は R 以上確定
// ・時刻判定（深夜・日次）はすべて JST 基準（サーバーが UTC でもずれないよう +9時間で計算する）

const { GACHA_POOL, GACHA_CONDITIONALS } = require('./emojis.js');

// ---- 調整用定数（確率・閾値はここを変える） ----
const RARITY_RATE = { SSR: 0.03, SR: 0.10, R: 0.17 }; // N は残り全部
const CONDITIONAL_RATE = 0.03; // 条件枠1種あたりの排出率（条件を満たしたとき）
const ROLLING_RATE = 0.03; // 自動リアクションが rolling_uyuyu に変化する確率（events/send-uyuyu.js が使う）
const REST_COUNT = 3; // 毎週お休みになる種類数
const PULL_COUNT = 10; // 1回のガチャで引く数
const FRAME_SILVER = 30; // 銀枠になる所持数
const FRAME_GOLD = 100; // 金枠になる所持数

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Date を JST の壁時計として扱うためのずらした Date（getUTC* で JST の値を読む） */
function toJst(date) {
  return new Date(date.getTime() + JST_OFFSET_MS);
}

/** JST の日付キー 'YYYY-MM-DD' */
function jstDateKey(date = new Date()) {
  const j = toJst(date);
  const m = String(j.getUTCMonth() + 1).padStart(2, '0');
  const d = String(j.getUTCDate()).padStart(2, '0');
  return `${j.getUTCFullYear()}-${m}-${d}`;
}

/** 深夜帯（JST 0時〜5時）かどうか */
function isNightJst(date = new Date()) {
  const h = toJst(date).getUTCHours();
  return h >= 0 && h < 5;
}

/** 12月（JST）かどうか（uyuyu_santa の季節判定） */
function isDecemberJst(date = new Date()) {
  return toJst(date).getUTCMonth() === 11;
}

/** ISO 週番号キー 'YYYY-Www'（週の区切りは JST の月曜） */
function isoWeekKey(date = new Date()) {
  const j = toJst(date);
  // ISO週: 木曜が属する年がその週の年。週の始まりは月曜
  const d = new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate()));
  const day = (d.getUTCDay() + 6) % 7; // 月曜=0
  d.setUTCDate(d.getUTCDate() - day + 3); // その週の木曜へ
  const year = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// 文字列から決定的なシードを作る（簡易ハッシュ）
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32: シード付き疑似乱数
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// お休み対象（SSR を除く通常プール = SR/R/N の13種）
const REST_ELIGIBLE = GACHA_POOL.filter((e) => e.rarity !== 'SSR');

/**
 * その週のお休み絵文字（名前の配列、REST_COUNT 種）。
 * 週が同じなら誰がいつ計算しても同じ組み合わせになる。
 */
function getRestingNames(date = new Date()) {
  const rng = mulberry32(hashSeed(`uyuyu-gacha-rest:${isoWeekKey(date)}`));
  const names = REST_ELIGIBLE.map((e) => e.name);
  // Fisher-Yates で決定的にシャッフルして先頭 REST_COUNT 件
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  return names.slice(0, REST_COUNT);
}

/**
 * 抽選プールを構築する。各要素は { name, id, rarity, weight }。
 * @param {object} [opts]
 * @param {Date} [opts.date] 基準時刻（お休み・深夜判定に使う）
 * @param {boolean} [opts.wonToday] 今日対戦で勝ったかどうか（uyuyu_take が混ざる）
 */
function buildPool({ date = new Date(), wonToday = false } = {}) {
  const resting = new Set(getRestingNames(date));
  const available = GACHA_POOL.filter((e) => !resting.has(e.name));

  // レアリティごとの合計確率を、そのレアリティの在庫数で等分する
  const counts = {};
  for (const e of available) counts[e.rarity] = (counts[e.rarity] ?? 0) + 1;
  const rateOf = (rarity) => {
    if (rarity === 'N') return (1 - RARITY_RATE.SSR - RARITY_RATE.SR - RARITY_RATE.R) / (counts.N ?? 1);
    return (RARITY_RATE[rarity] ?? 0) / (counts[rarity] ?? 1);
  };

  const pool = available.map((e) => ({ ...e, weight: rateOf(e.rarity) }));

  // 条件枠: 合計確率が CONDITIONAL_RATE になる重みを足す（在庫側の合計は 1.0 前提）
  const condWeight = CONDITIONAL_RATE / (1 - CONDITIONAL_RATE);
  for (const c of GACHA_CONDITIONALS) {
    if (c.condition === 'win' && wonToday) pool.push({ ...c, weight: condWeight });
    if (c.condition === 'night' && isNightJst(date)) pool.push({ ...c, weight: condWeight });
    if (c.condition === 'december' && isDecemberJst(date)) pool.push({ ...c, weight: condWeight });
  }
  return pool;
}

function drawOne(pool, rng) {
  const total = pool.reduce((s, e) => s + e.weight, 0);
  let r = rng() * total;
  for (const e of pool) {
    r -= e.weight;
    if (r < 0) return e;
  }
  return pool[pool.length - 1];
}

const RARITY_ORDER = { N: 0, R: 1, SR: 2, SSR: 3, SP: 4 };

/**
 * 10連を引く。最後の1枠は R 以上（SSR/SR/R）確定。
 * @param {object} [opts] buildPool と同じ条件＋ rng（テスト用に差し替え可能）
 * @returns {Array<{name, id, rarity}>}
 */
function drawTen({ date = new Date(), wonToday = false, rng = Math.random } = {}) {
  const pool = buildPool({ date, wonToday });
  const results = [];
  for (let i = 0; i < PULL_COUNT - 1; i++) results.push(drawOne(pool, rng));
  const highPool = pool.filter((e) => RARITY_ORDER[e.rarity] >= RARITY_ORDER.R && e.rarity !== 'SP');
  results.push(drawOne(highPool.length ? highPool : pool, rng));
  return results.map(({ name, id, rarity }) => ({ name, id, rarity }));
}

/** 所持数から図鑑の枠段階を返す: 'none' | 'normal' | 'silver' | 'gold' */
function frameTier(count) {
  if (!Number.isInteger(count) || count <= 0) return 'none';
  if (count >= FRAME_GOLD) return 'gold';
  if (count >= FRAME_SILVER) return 'silver';
  return 'normal';
}

module.exports = {
  RARITY_RATE,
  CONDITIONAL_RATE,
  ROLLING_RATE,
  REST_COUNT,
  PULL_COUNT,
  FRAME_SILVER,
  FRAME_GOLD,
  jstDateKey,
  isNightJst,
  isDecemberJst,
  isoWeekKey,
  getRestingNames,
  buildPool,
  drawTen,
  frameTier,
};
