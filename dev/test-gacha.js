#!/usr/bin/env node
'use strict';

// うゆゆガチャ（抽選ロジック＋図鑑の記録）のテスト。 node dev/test-gacha.js

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 記録ストアの保存先をテスト用の一時ファイルに向ける（require 前に設定すること）
const TMP_FILE = path.join(os.tmpdir(), `uyuyu-gacha-test-${process.pid}.json`);
try { fs.unlinkSync(TMP_FILE); } catch { /* 無ければ何もしない */ }
process.env.GACHA_LOCAL_PATH = TMP_FILE;

const gacha = require('../utils/gacha.js');
const { GACHA_POOL, GACHA_ALL } = require('../utils/emojis.js');
const collection = require('../utils/gacha-collection.js');

// 決定的な乱数（テスト用 LCG）
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// JST の日時を作る（JST = UTC+9）
const jst = (y, mo, d, h = 12, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h - 9, mi));

async function main() {
  // ---- JST 判定 ----
  {
    // UTC 2026-11-16 18:00 = JST 11-17 03:00（深夜・日付は17日）
    const t = new Date(Date.UTC(2026, 10, 16, 18, 0));
    assert.strictEqual(gacha.jstDateKey(t), '2026-11-17');
    assert.strictEqual(gacha.isNightJst(t), true);
    // JST 正午は深夜ではない
    assert.strictEqual(gacha.isNightJst(jst(2026, 11, 17, 12)), false);
    // JST 05:00 は深夜帯の外、04:59 は内
    assert.strictEqual(gacha.isNightJst(jst(2026, 11, 17, 5, 0)), false);
    assert.strictEqual(gacha.isNightJst(jst(2026, 11, 17, 4, 59)), true);
    console.log('JST 判定（日付キー・深夜帯）: OK');
  }

  // ---- 週替わりローテーション ----
  {
    // 2026-11-16(月) と 2026-11-22(日) は同じ ISO 週、2026-11-23(月) は翌週
    const mon = jst(2026, 11, 16);
    const sun = jst(2026, 11, 22);
    const nextMon = jst(2026, 11, 23);
    assert.strictEqual(gacha.isoWeekKey(mon), gacha.isoWeekKey(sun));
    assert.notStrictEqual(gacha.isoWeekKey(mon), gacha.isoWeekKey(nextMon));

    const restMon = gacha.getRestingNames(mon);
    assert.deepStrictEqual(gacha.getRestingNames(sun), restMon, '同じ週なのにお休みが変わる');
    assert.strictEqual(restMon.length, gacha.REST_COUNT);
    const eligible = new Set(GACHA_POOL.filter((e) => e.rarity !== 'SSR').map((e) => e.name));
    assert.strictEqual(eligible.size, 13);
    for (const name of restMon) assert(eligible.has(name), `お休み対象外が含まれている: ${name}`);
    assert(!restMon.includes('uyuyun'), 'SSR がお休みになっている');

    // 週が変われば組み合わせが変わりうること（30週のうち2通り以上あること）
    const patterns = new Set();
    for (let w = 0; w < 30; w++) {
      const d = new Date(mon.getTime() + w * 7 * 24 * 60 * 60 * 1000);
      patterns.add(gacha.getRestingNames(d).join(','));
    }
    assert(patterns.size >= 2, '30週すべて同じお休みの組み合わせになっている');
    console.log('週替わりローテーション（週内安定・3種・SSR除外）: OK');
  }

  // ---- 抽選 ----
  const DAY = jst(2026, 11, 17, 12); // 平日昼（深夜条件なし）
  const resting = new Set(gacha.getRestingNames(DAY));
  {
    const pool = gacha.buildPool({ date: DAY, wonToday: false });
    const names = new Set(pool.map((e) => e.name));
    for (const name of resting) assert(!names.has(name), `お休み中がプールにいる: ${name}`);
    assert(!names.has('uyuyu_take'), '条件なしで uyuyu_take が混ざっている');
    assert(!names.has('uyuyu_sleeping'), '昼間で uyuyu_sleeping が混ざっている');
    assert(!names.has('rolling_uyuyu'), 'ガチャから rolling_uyuyu が出るようになっている');

    const rng = lcg(42);
    for (let n = 0; n < 300; n++) {
      const results = gacha.drawTen({ date: DAY, wonToday: false, rng });
      assert.strictEqual(results.length, 10);
      for (const r of results) {
        assert(!resting.has(r.name), `お休み中が排出された: ${r.name}`);
        assert(!['uyuyu_take', 'uyuyu_sleeping', 'rolling_uyuyu'].includes(r.name), `条件枠が排出された: ${r.name}`);
      }
      // 最後の1枠は R 以上確定
      assert(['SSR', 'SR', 'R'].includes(results[9].rarity), `最後の枠が ${results[9].rarity} だった`);
    }
    console.log('抽選（お休み除外・条件なしで条件枠なし・最後の枠はR以上）: OK');
  }

  // ---- 条件ドロップの混入 ----
  {
    const winPool = gacha.buildPool({ date: DAY, wonToday: true });
    assert(winPool.some((e) => e.name === 'uyuyu_take'), '勝利日に uyuyu_take がプールに無い');
    const rng = lcg(7);
    let takeSeen = 0;
    for (let n = 0; n < 300; n++) {
      for (const r of gacha.drawTen({ date: DAY, wonToday: true, rng })) {
        if (r.name === 'uyuyu_take') takeSeen++;
      }
    }
    assert(takeSeen > 0, '勝利日プールから uyuyu_take が1回も出なかった');

    const NIGHT = jst(2026, 11, 17, 3);
    const nightPool = gacha.buildPool({ date: NIGHT, wonToday: false });
    assert(nightPool.some((e) => e.name === 'uyuyu_sleeping'), '深夜に uyuyu_sleeping がプールに無い');
    let sleepSeen = 0;
    for (let n = 0; n < 300; n++) {
      for (const r of gacha.drawTen({ date: NIGHT, wonToday: false, rng })) {
        if (r.name === 'uyuyu_sleeping') sleepSeen++;
      }
    }
    assert(sleepSeen > 0, '深夜プールから uyuyu_sleeping が1回も出なかった');
    console.log('条件ドロップ（勝利日=take / 深夜=sleeping が混ざって排出される）: OK');
  }

  // ---- 育成枠 ----
  {
    assert.strictEqual(gacha.frameTier(0), 'none');
    assert.strictEqual(gacha.frameTier(1), 'normal');
    assert.strictEqual(gacha.frameTier(29), 'normal');
    assert.strictEqual(gacha.frameTier(30), 'silver');
    assert.strictEqual(gacha.frameTier(99), 'silver');
    assert.strictEqual(gacha.frameTier(100), 'gold');
    assert.strictEqual(gacha.frameTier(500), 'gold');
    console.log('育成枠の段階判定（1=登録 / 30=銀 / 100=金）: OK');
  }

  // ---- 記録（所持・勝利） ----
  {
    const first = collection.addItems('user-a', ['uyuyu', 'uyuyu', 'uyuyun']);
    assert.deepStrictEqual(first.newNames.sort(), ['uyuyu', 'uyuyun']);
    assert.strictEqual(first.counts.uyuyu, 2);
    const second = collection.addItems('user-a', ['uyuyu']);
    assert.deepStrictEqual(second.newNames, []);
    const col = collection.getCollection('user-a');
    assert.strictEqual(col.items.uyuyu, 3);
    assert.strictEqual(col.items.uyuyun, 1);
    assert.strictEqual(col.total, 4);
    assert.strictEqual(col.kinds, 2);

    const add1 = collection.addItem('user-a', 'rolling_uyuyu');
    assert.strictEqual(add1.isNew, true);
    const add2 = collection.addItem('user-a', 'rolling_uyuyu');
    assert.strictEqual(add2.isNew, false);
    assert.strictEqual(add2.count, 2);
    // 未知の名前は記録しない
    assert.strictEqual(collection.addItem('user-a', 'no_such_emoji').count, 0);

    // 勝利記録は JST の日付で判定する
    collection.markWin('user-a', jst(2026, 11, 17, 23, 59));
    assert.strictEqual(collection.wonToday('user-a', jst(2026, 11, 17, 0, 1)), true);
    assert.strictEqual(collection.wonToday('user-a', jst(2026, 11, 18, 0, 1)), false);
    assert.strictEqual(collection.wonToday('user-b', jst(2026, 11, 17, 12)), false);
    console.log('記録（所持の追加・新規判定・勝利日の判定）: OK');
  }

  // ---- 保存と読み戻し ----
  {
    await collection.flush();
    assert(fs.existsSync(TMP_FILE), '保存ファイルが作られていない');
    const saved = JSON.parse(fs.readFileSync(TMP_FILE, 'utf-8'));
    assert.strictEqual(saved.users['user-a'].items.uyuyu, 3);
    assert.strictEqual(saved.wins['user-a'], '2026-11-17');

    // モジュールを読み直すと、起動時にローカルファイルから読み戻される
    const modPath = require.resolve('../utils/gacha-collection.js');
    delete require.cache[modPath];
    const reloaded = require('../utils/gacha-collection.js');
    const col = reloaded.getCollection('user-a');
    assert.strictEqual(col.items.uyuyu, 3);
    assert.strictEqual(col.items.rolling_uyuyu, 2);
    assert.strictEqual(reloaded.wonToday('user-a', jst(2026, 11, 17, 12)), true);
    await reloaded.flush();
    console.log('記録の保存と読み戻し: OK');
  }

  // 図鑑の全種は17種（通常プール14＋条件枠3）
  assert.strictEqual(GACHA_ALL.length, 17);

  try { fs.unlinkSync(TMP_FILE); } catch { /* 後片付け */ }
  console.log('test-gacha: OK');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
