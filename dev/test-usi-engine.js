#!/usr/bin/env node
'use strict';

// USI クライアント（utils/usi-engine.js）の検証。 node dev/test-usi-engine.js
// 本物のやねうら王は使わず、dev/fake-usi-engine.js（合法手からランダムに指す偽エンジン）に対して
// 起動・オプション設定・強さの切り替え・順番待ち・応答なし・クラッシュ後の再起動などを確認する。

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../utils/shogi-core.js');
const { UsiEngine, resolveConfig, LEVELS } = require('../utils/usi-engine.js');

const FAKE = path.join(__dirname, 'fake-usi-engine.js');
const quiet = { log() {}, warn() {}, error() {} };
const procConfig = (mode, logFile) => resolveConfig({
  SHOGI_ENGINE: 'process', YANEURAOU_PATH: process.execPath, YANEURAOU_ARGS: FAKE,
  YANEURAOU_HASH_MB: '32', YANEURAOU_THREADS: '2', ...(mode ? {} : {}),
});
// モード/ログはプロセスの環境変数で渡す(子プロセスが継承)
const withEnv = async (env, fn) => {
  const old = {}; for (const k of Object.keys(env)) { old[k] = process.env[k]; process.env[k] = env[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(env)) old[k] === undefined ? delete process.env[k] : (process.env[k] = old[k]); }
};

(async () => {
  // ---- 設定の解決 ----
  let wasmInstalled = true; try { require.resolve('@mizarjp/yaneuraou.halfkp'); } catch { wasmInstalled = false; }
  if (!wasmInstalled) assert.strictEqual(resolveConfig({}), null, '何も設定が無く、WASMパッケージも無ければ null');
  assert.strictEqual(resolveConfig({ SHOGI_ENGINE: 'none', YANEURAOU_PATH: '/x' }), null);
  assert.strictEqual(resolveConfig({ SHOGI_ENGINE: 'process' }), null, 'process指定でパス無しは null');
  assert.strictEqual(resolveConfig({ YANEURAOU_PATH: '/x/y' }).kind, 'process');
  if (!wasmInstalled) assert.strictEqual(resolveConfig({ SHOGI_ENGINE: 'wasm' }), null, 'wasm指定でも未インストールなら null');
  console.log('設定の解決 ✔');

  // ---- 正常系: 起動→オプション設定→指し手 ----
  const logFile = path.join(os.tmpdir(), 'fake-usi.log'); fs.rmSync(logFile, { force: true });
  await withEnv({ FAKE_LOG: logFile, FAKE_MODE: 'normal' }, async () => {
    const eng = new UsiEngine(procConfig(), { log: quiet });
    assert(eng.configured);
    const game = new core.ShogiGame();
    const r = await eng.bestMove([], 'hard');
    assert(core.findLegalByUsi(game.legalMoves(), r.move), '合法手が返る: ' + r.move);
    game.play(core.findLegalByUsi(game.legalMoves(), r.move));
    const r2 = await eng.bestMove(game.moves, 'easy');
    assert(r2.move);
    const lines = fs.readFileSync(logFile, 'utf-8').split('\n');
    const has = (re) => lines.some((l) => re.test(l));
    assert(has(/^setoption name USI_Hash value 32$/), 'ハッシュ設定');
    assert(has(/^setoption name Threads value 2$/), 'スレッド設定');
    assert(has(/^setoption name EnteringKingRule value NoEnteringKing$/), '入玉宣言オフ');
    assert(has(/^setoption name USI_OwnBook value false$/));
    assert(!has(/EvalDir/), 'エンジンに無いオプションは設定しない');
    assert(has(/^setoption name SkillLevel value 20$/) && has(/^setoption name SkillLevel value 0$/), '強さに応じてSkillLevel');
    assert(has(new RegExp(`^go movetime ${LEVELS.hard.movetime}$`)) && has(new RegExp(`^go movetime ${LEVELS.easy.movetime}$`)));
    assert(has(/^position startpos$/) && has(/^position startpos moves \w+/));
    assert(has(/^usinewgame$/));
    // 同時に複数要求しても順番に処理される
    const rs = await Promise.all([eng.bestMove([], 'easy'), eng.bestMove([], 'easy'), eng.bestMove([], 'easy')]);
    assert(rs.every((x) => x.move));
    eng.close();
  });
  console.log('正常系(起動/オプション/強さ/直列化) ✔');

  // ---- resign / 不正な手はそのまま文字列で返る(判断は呼び出し側) ----
  await withEnv({ FAKE_MODE: 'resign' }, async () => {
    const eng = new UsiEngine(procConfig(), { log: quiet });
    assert.strictEqual((await eng.bestMove([], 'easy')).move, 'resign'); eng.close();
  });

  // ---- 応答なし: bestMove が失敗し、次の要求でエンジンを作り直して復帰する ----
  {
    const eng = new UsiEngine({ ...procConfig(), searchGraceMs: 300 }, { log: quiet });
    await withEnv({ FAKE_MODE: 'hang' }, async () => {
      const t0 = Date.now();
      await assert.rejects(eng.bestMove([], 'easy'), /タイムアウト/);
      assert(Date.now() - t0 < 3000, '短い待ち時間で失敗する');
    });
    assert.strictEqual(eng.ready, false, '失敗したのでエンジンは破棄される');
    await withEnv({ FAKE_MODE: 'normal' }, async () => {
      const r = await eng.bestMove([], 'easy');
      assert(r.move && r.move !== 'resign', '作り直して指せる');
    });
    eng.close();
  }
  console.log('応答なし → 失敗 → 再起動して復帰 ✔');

  // ---- クラッシュ: エラーになり、次の要求で自動再起動 ----
  const crashLog = path.join(os.tmpdir(), 'fake-usi-crash.log'); fs.rmSync(crashLog, { force: true });
  const eng = new UsiEngine(procConfig(), { log: quiet });
  await withEnv({ FAKE_MODE: 'crash', FAKE_LOG: crashLog }, async () => {
    await assert.rejects(eng.bestMove([], 'easy'), /終了|エンジン/);
  });
  assert.strictEqual(eng.ready, false);
  await withEnv({ FAKE_MODE: 'normal' }, async () => {
    const r = await eng.bestMove([], 'easy');
    assert(r.move && r.move !== 'resign', '再起動して指せる');
  });
  eng.close();
  console.log('クラッシュ→自動再起動 ✔');

  // ---- 起動できない(存在しない実行ファイル) ----
  const bad = new UsiEngine(resolveConfig({ SHOGI_ENGINE: 'process', YANEURAOU_PATH: '/nonexistent/engine' }), { log: quiet });
  assert.strictEqual(await bad.ensureStarted(), false);
  await assert.rejects(bad.bestMove([], 'easy'));
  // 設定なし
  const none = new UsiEngine(null, { log: quiet });
  assert.strictEqual(none.configured, false); assert.strictEqual(await none.ensureStarted(), false);
  console.log('起動失敗/未設定の扱い ✔');

  console.log('ENGINE TESTS PASSED'); process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
