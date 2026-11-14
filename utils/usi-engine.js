'use strict';

// USI 対応の将棋エンジン（やねうら王）を使うためのクライアント
//
// 動かし方は2通り。どちらも同じコードで使えます（環境変数で選ぶ）。
//
//  A) 別プロセス（ネイティブのバイナリ）
//       YANEURAOU_PATH=/path/to/YaneuraOu-by-gcc      … エンジンの実行ファイル
//       YANEURAOU_ARGS=                               … 引数（省略可。空白区切り）
//       YANEURAOU_EVAL_DIR=/path/to/eval              … 評価関数ファイル(nn.bin)のあるディレクトリ（省略可）
//
//  B) WASM 版（npm パッケージ。ビルド不要）
//       npm i @mizarjp/yaneuraou.halfkp               … 評価関数(水匠5)が同梱されている
//       （YANEURAOU_PATH が無ければ、このパッケージがあれば自動的に使う）
//
//  共通（省略可）
//       SHOGI_ENGINE=process|wasm|none                … 方式を固定する。none ならエンジンを使わない
//       YANEURAOU_HASH_MB=16                          … 置換表のサイズ(MB)。Render の無料枠など、メモリが少ない環境では小さめに
//       YANEURAOU_THREADS=1
//
// ・エンジンは最初に必要になったときに起動し、1つのプロセスを全対局で共有する（要求は1つずつ順番に処理）
// ・応答がなければ強制終了して、次の要求のときに起動し直す
// ・どの方式でも USI プロトコルの文字列（usi / isready / position / go / bestmove）をやり取りするだけ

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');

// 強さの設定。skill は SkillLevel (0〜20)、movetime は1手あたりの思考時間(ms)。
// 実際の強さは環境（CPU・WASM かネイティブか）で変わるので、遊んでみて調整してください。
const LEVELS = {
  easy: { skill: 0, movetime: 100 },
  normal: { skill: 8, movetime: 500 },
  hard: { skill: 20, movetime: 1500 },
};

const START_TIMEOUT_MS = 60 * 1000; // 起動（評価関数の読み込み含む）の待ち時間
const SEARCH_GRACE_MS = 8 * 1000; // movetime に足す、応答待ちの余裕

// ---------- 通信手段（トランスポート） ----------
// { send(line), onLine(cb), onExit(cb), close() } を返す

async function createProcessTransport({ exe, args = [] }) {
  const child = spawn(exe, args, { cwd: path.dirname(exe), stdio: ['pipe', 'pipe', 'ignore'] });
  const lineCbs = [];
  const exitCbs = [];
  let exited = false;
  const notifyExit = (why) => {
    if (exited) return;
    exited = true;
    for (const cb of exitCbs) cb(why);
  };
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    for (const cb of lineCbs) cb(l.trim());
  });
  child.on('exit', (code, signal) => notifyExit(`exit ${code ?? signal}`));
  child.on('error', (err) => notifyExit(`error ${err.message}`));
  child.stdin.on('error', () => {}); // 終了済みプロセスへの書き込み(EPIPE)は無視

  return {
    send: (line) => {
      if (!exited) child.stdin.write(`${line}\n`);
    },
    onLine: (cb) => lineCbs.push(cb),
    onExit: (cb) => exitCbs.push(cb),
    close: () => {
      try { child.stdin.write('quit\n'); } catch { /* 既に終了 */ }
      setTimeout(() => child.kill('SIGKILL'), 500).unref();
    },
  };
}

// ※ npm の @mizarjp/yaneuraou.halfkp の使い方（パッケージの README のサンプル）に合わせている:
//    const engine = await require('@mizarjp/yaneuraou.halfkp')();
//    engine.addMessageListener((line) => ...);  engine.postMessage('usi');
async function createWasmTransport() {
  const mod = require('@mizarjp/yaneuraou.halfkp');
  const factory = typeof mod === 'function' ? mod : mod.default;
  const engine = await factory();
  const lineCbs = [];
  engine.addMessageListener((line) => {
    for (const cb of lineCbs) cb(String(line).trim());
  });
  return {
    send: (line) => engine.postMessage(line),
    onLine: (cb) => lineCbs.push(cb),
    onExit: () => {}, // WASM はプロセスとして落ちない
    close: () => {
      try { engine.postMessage('quit'); } catch { /* 無視 */ }
      try { engine.terminate?.(); } catch { /* 無視 */ }
    },
  };
}

/** 環境変数から使うエンジンの設定を決める。使えなければ null */
function resolveConfig(env = process.env) {
  const mode = (env.SHOGI_ENGINE || '').toLowerCase();
  if (mode === 'none') return null;

  if (mode === 'process' || (!mode && env.YANEURAOU_PATH)) {
    if (!env.YANEURAOU_PATH) return null;
    const args = env.YANEURAOU_ARGS ? env.YANEURAOU_ARGS.split(/\s+/).filter(Boolean) : [];
    return {
      kind: 'process',
      label: `process:${path.basename(env.YANEURAOU_PATH)}`,
      factory: () => createProcessTransport({ exe: env.YANEURAOU_PATH, args }),
      evalDir: env.YANEURAOU_EVAL_DIR || null,
      hashMb: Number(env.YANEURAOU_HASH_MB) || 16,
      threads: Number(env.YANEURAOU_THREADS) || 1,
    };
  }

  if (mode === 'wasm' || !mode) {
    try {
      require.resolve('@mizarjp/yaneuraou.halfkp');
    } catch {
      return null;
    }
    return {
      kind: 'wasm',
      label: 'wasm:@mizarjp/yaneuraou.halfkp',
      factory: createWasmTransport,
      evalDir: null,
      hashMb: Number(env.YANEURAOU_HASH_MB) || 16,
      threads: Number(env.YANEURAOU_THREADS) || 1,
    };
  }
  return null;
}

// ---------- クライアント ----------
class UsiEngine {
  /**
   * @param {object|null} config resolveConfig() の戻り値（テストでは { factory, ... } を直接渡せる）
   */
  constructor(config, { log = console } = {}) {
    this.config = config;
    this.log = log;
    this.transport = null;
    this.ready = false;
    this.optionNames = new Map(); // 小文字の名前 → エンジンが使う正式な名前
    this.currentSkill = null;
    this.waiters = [];
    this.queue = Promise.resolve();
    this.starting = null;
  }

  /** 設定上は使える状態か（実際に起動できるかは ensureStarted で分かる） */
  get configured() {
    return this.config !== null;
  }

  // 受け取った行を待つ。test(line) が真になった行で解決する
  _expect(test, timeoutMs, what) {
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`エンジンの応答待ちがタイムアウトしました (${what})`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  _onLine(line) {
    if (line.startsWith('option name ')) {
      const m = /^option name (.+?) type /.exec(line);
      if (m) this.optionNames.set(m[1].toLowerCase(), m[1]);
    }
    for (const w of [...this.waiters]) {
      if (w.test(line)) {
        clearTimeout(w.timer);
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(line);
      }
    }
  }

  _onExit(why) {
    engine.stderr.on('data', (d) => console.error('[USI stderr]', d.toString()));
    this.log.warn?.(`[USI] エンジンが終了しました: ${why}`);
    const err = new Error(`エンジンが終了しました (${why})`);
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters = [];
    this.transport = null;
    this.ready = false;
  }

  _setOption(name, value) {
    const real = this.optionNames.get(name.toLowerCase());
    if (!real) return false; // このエンジンに無いオプションは設定しない
    this.transport.send(`setoption name ${real} value ${value}`);
    return true;
  }

  async _sync() {
    const readyok = this._expect((l) => l === 'readyok', START_TIMEOUT_MS, 'readyok');
    this.transport.send('isready');
    await readyok;
  }

  async _start() {
    const t = await this.config.factory();
    this.transport = t;
    this.optionNames = new Map();
    this.currentSkill = null;
    // 破棄した古いエンジンの出力・終了通知が、新しいエンジンの処理に紛れ込まないようにする
    t.onLine((line) => {
      if (this.transport === t) this._onLine(line);
    });
    t.onExit((why) => {
      if (this.transport === t) this._onExit(why);
    });

    const usiok = this._expect((l) => l === 'usiok', START_TIMEOUT_MS, 'usiok');
    t.send('usi');
    await usiok;

    this._setOption('USI_Hash', this.config.hashMb);
    this._setOption('Threads', this.config.threads);
    this._setOption('MultiPV', 1);
    this._setOption('PvInterval', 0); // info 行の出力を減らす
    this._setOption('USI_OwnBook', 'false'); // 定跡ファイルが無くても動くように
    // 入玉宣言は人間側に実装していないので、エンジンも使わない（手数上限で引き分けにする）
    this._setOption('EnteringKingRule', 'NoEnteringKing');
    if (this.config.evalDir) this._setOption('EvalDir', this.config.evalDir);
    await this._sync();
    this.ready = true;
    this.log.log?.(`[USI] エンジンを起動しました (${this.config.label})`);
  }

  /** エンジンを起動しておく。起動できれば true */
  async ensureStarted() {
    if (!this.config) return false;
    if (this.ready) return true;
    this.starting ??= this._start()
      .catch((err) => {
        this._reset();
        throw err;
      })
      .finally(() => {
        this.starting = null;
      });
    try {
      await this.starting;
      return true;
    } catch (err) {
      this.log.error?.('[USI] エンジンを起動できませんでした:', err.message);
      return false;
    }
  }

  _reset() {
    const t = this.transport;
    this.transport = null;
    this.ready = false;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('エンジンを再起動します'));
    }
    this.waiters = [];
    try { t?.close(); } catch { /* 無視 */ }
  }

  /**
   * 局面（初期局面からの指し手の列）に対するエンジンの指し手を返す。要求は順番に1つずつ処理される。
   * @param {string[]} moves USI の指し手の列
   * @param {'easy'|'normal'|'hard'} level
   * @returns {Promise<{ move: string }>} move は '7g7f' や 'resign'
   */
  bestMove(moves, level = 'normal') {
    const job = this.queue.then(() => this._search(moves, level));
    this.queue = job.catch(() => {});
    return job;
  }

  async _search(moves, levelName) {
    if (!this.config) throw new Error('エンジンが設定されていません');
    const lv = LEVELS[levelName] ?? LEVELS.normal;
    if (!(await this.ensureStarted())) throw new Error('エンジンを起動できません');

    try {
      const t = this.transport;
      if (this.currentSkill !== lv.skill) {
        this._setOption('SkillLevel', lv.skill);
        this.currentSkill = lv.skill;
        await this._sync();
      }
      if (moves.length <= 1) t.send('usinewgame'); // 新しい対局の最初の手番のとき
      t.send(`position startpos${moves.length ? ` moves ${moves.join(' ')}` : ''}`);
      const grace = this.config.searchGraceMs ?? SEARCH_GRACE_MS;
      const best = this._expect((l) => l.startsWith('bestmove'), lv.movetime + grace, 'bestmove');
      t.send(`go movetime ${lv.movetime}`);
      const line = await best;
      return { move: line.split(/\s+/)[1] ?? '' };
    } catch (err) {
      this._reset(); // 応答がない・落ちたときは作り直す
      throw err;
    }
  }

  close() {
    this._reset();
  }
}

let shared = null;
/** 全対局で共有するエンジン（環境変数で設定） */
function getEngine() {
  shared ??= new UsiEngine(resolveConfig());
  return shared;
}

module.exports = { UsiEngine, getEngine, resolveConfig, LEVELS };
