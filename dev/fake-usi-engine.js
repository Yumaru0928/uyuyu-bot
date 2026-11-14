#!/usr/bin/env node
'use strict';

// 開発・テスト用の「偽のUSIエンジン」。やねうら王の代わりに、合法手からランダムに指す。
// 実エンジンが無い環境で Bot 戦の流れを確認するのに使える:
//
//   SHOGI_ENGINE=process YANEURAOU_PATH=$(which node) YANEURAOU_ARGS="$PWD/dev/fake-usi-engine.js" node index.js
//
// 環境変数 FAKE_MODE でエンジンの異常も再現できる:
//   normal(既定) / slow(300ms考える) / hang(go に応答しない) / crash(go で終了) / resign / illegal(不正な手を返す)
// FAKE_LOG=/path/to/file を指定すると、受け取った USI コマンドを追記する。

const fs = require('node:fs');
const readline = require('node:readline');
const core = require('../utils/shogi-core.js');

const mode = process.env.FAKE_MODE || 'normal';
const log = (line) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, `${line}\n`);
const out = (line) => process.stdout.write(`${line}\n`);

let moves = [];
let seed = 12345;
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};

readline.createInterface({ input: process.stdin }).on('line', (raw) => {
  const line = raw.trim();
  log(line);
  if (line === 'usi') {
    out('id name FakeShogi 1.0');
    out('id author dev');
    for (const o of [
      'option name USI_Hash type spin default 16 min 1 max 1024',
      'option name Threads type spin default 1 min 1 max 32',
      'option name MultiPV type spin default 1 min 1 max 800',
      'option name PvInterval type spin default 300 min 0 max 100000',
      'option name USI_OwnBook type check default true',
      'option name EnteringKingRule type combo default CSARule27 var NoEnteringKing var CSARule27',
      'option name SkillLevel type spin default 20 min 0 max 20',
    ]) out(o);
    out('usiok');
  } else if (line === 'isready') {
    out('readyok');
  } else if (line === 'usinewgame') {
    moves = [];
  } else if (line.startsWith('position')) {
    const m = /moves\s+(.*)$/.exec(line);
    moves = m ? m[1].split(/\s+/) : [];
  } else if (line.startsWith('go')) {
    if (mode === 'hang') return;
    if (mode === 'crash') process.exit(1);
    const answer = () => {
      if (mode === 'resign') return out('bestmove resign');
      if (mode === 'illegal') return out('bestmove 0z0z');
      const game = new core.ShogiGame(moves);
      const legal = game.legalMoves();
      if (legal.length === 0) return out('bestmove resign');
      const mv = legal[rand(legal.length)];
      out('info depth 1 score cp 0 nodes 1 pv ' + core.moveToUsi(mv));
      out(`bestmove ${core.moveToUsi(mv)}`);
    };
    mode === 'slow' ? setTimeout(answer, 300) : answer();
  } else if (line === 'quit') {
    process.exit(0);
  }
});
