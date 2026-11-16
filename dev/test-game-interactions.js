#!/usr/bin/env node
'use strict';

// 対局のインタラクション模擬テスト。 node dev/test-game-interactions.js
// Discord のオブジェクトをスタブ化し、セッション復元の経路で対局を開始して操作を流す。
//  ・オセロ: 段階ガード（古い画面の操作は無効）、置く前の確認（ON/OFF・保存）、手番通知（送信と前通知の削除）、投了確認
//  ・将棋: 投了確認が「確認メッセージ自身」で待つこと（盤面メッセージ対象だとタイムアウトする不具合の回帰防止）、手番通知

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uyuyu-games-'));
process.env.SESSIONS_LOCAL_PATH = path.join(tmp, 'sessions.json');
process.env.RATINGS_LOCAL_PATH = path.join(tmp, 'ratings.json');

const sessions = require('../utils/sessions.js');

function makeCollector() {
  const handlers = {};
  return {
    on(ev, fn) { handlers[ev] = fn; },
    stop(reason) { this.stopped = reason; if (handlers.end) handlers.end(null, reason); },
    async fire(i) { await handlers.collect(i); },
  };
}

function makeMessage(id, channel) {
  return {
    id, channelId: channel.id, channel,
    edits: [],
    async edit(p) { this.edits.push(p); return this; },
    createMessageComponentCollector() { this.collector = makeCollector(); return this.collector; },
  };
}

function makeChannel(id) {
  const sent = [];
  const byId = new Map();
  return {
    id, sent, byId,
    messages: {
      fetch: async (mid) => {
        const m = byId.get(mid);
        if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return m;
      },
    },
    async send(p) {
      const m = {
        id: `notify-${sent.length + 1}`, content: p.content, deleted: false,
        async delete() { this.deleted = true; },
      };
      sent.push(m);
      byId.set(m.id, m);
      return m;
    },
  };
}

function interaction(userId, customId, values, promptAnswer) {
  const i = {
    user: { id: userId }, customId, values,
    replies: [], updates: [],
    async reply(p) {
      this.replies.push(p);
      if (promptAnswer) {
        // 投了確認のプロンプト（withResponse で返る resource.message）を模す
        return {
          resource: {
            message: {
              awaitMessageComponent: async (opts) => {
                i.promptWaited = opts;
                return {
                  customId: promptAnswer,
                  async update(pp) { i.promptUpdated = pp; },
                };
              },
            },
          },
        };
      }
      return {};
    },
    async fetchReply() {
      if (this.replyMessage) return this.replyMessage;
      throw new Error('fetchReply は使われないはず');
    },
    async deferReply() { this.deferred = true; },
    async editReply(p) { this.editedReply = p; },
    async update(p) { this.updates.push(p); return {}; },
    async deferUpdate() {},
  };
  return i;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ============ オセロ ============
  {
    const oc = require('../utils/othello-core.js');
    const othello = require('../commands/games/othello.js');
    const channel = makeChannel('c1');
    const board = makeMessage('m-oth', channel);
    channel.byId.set('m-oth', board);

    sessions.put('othello', 'm-oth', {
      channelId: 'c1', guildId: 'g1',
      board: oc.createBoard(), turn: oc.BLACK,
      players: {
        [oc.BLACK]: { id: 'alice', displayName: 'Alice', isAi: false },
        [oc.WHITE]: { id: 'bob', displayName: 'Bob', isAi: false },
      },
      ranked: true, level: 'normal', events: [],
    });
    const client = { channels: { fetch: async () => channel } };
    await othello.restoreSessions(client);
    await sleep(50);
    assert(board.collector, 'コレクタが張られた');
    assert.strictEqual(channel.sent.length, 1, '復元時に手番通知が送られた');
    assert(channel.sent[0].content.includes('<@alice>'), '先手(alice)への通知');

    const col = board.collector;
    // alice: 列を選ぶ → 行を選ぶ → 確認画面 → 置く
    await col.fire(interaction('alice', 'col', ['2']));
    // 古い画面の操作（段階が違う 'col' をもう一度）→ 何も起きず画面更新だけ
    const stale = interaction('alice', 'col', ['3']);
    await col.fire(stale);
    assert.strictEqual(stale.updates.length, 1, '古い画面操作は画面更新のみ');
    const row = interaction('alice', 'row', ['3']);
    await col.fire(row);
    assert(row.updates[0].content.includes('この手でよろしいですか'), '確認画面が出た');
    const conf = interaction('alice', 'confirm');
    await col.fire(conf);
    await sleep(50);
    const saved = sessions.list('othello')[0];
    assert(saved, '対局が保存されている');
    assert.strictEqual(saved.board[3][2], oc.BLACK, 'C4(2,3)に黒が置かれた');
    assert.strictEqual(saved.turn, oc.WHITE, '手番がbobへ');
    assert(channel.sent.some((m) => m.content.includes('<@bob>')), 'bobへ手番通知');
    assert(channel.sent[0].deleted, '前の通知は削除された');

    // bob: 確認をOFFにしてから置く（即置き）
    await col.fire(interaction('bob', 'toggle'));
    await col.fire(interaction('bob', 'col', ['2']));
    const bobRow = interaction('bob', 'row', ['2']);
    await col.fire(bobRow);
    await sleep(50);
    const saved2 = sessions.list('othello')[0];
    assert.strictEqual(saved2.board[2][2], oc.WHITE, '確認OFFでは選んだらすぐ置かれる');
    assert.strictEqual(saved2.players[oc.WHITE].confirm, false, '確認OFFが保存された');

    // alice: 投了（確認つき）
    const resign = interaction('alice', 'resign', undefined, 'resign:yes');
    await col.fire(resign);
    await sleep(50);
    assert(resign.promptWaited, '投了確認は確認メッセージ自身で待っている');
    assert(board.edits.some((e) => (e.content || '').includes('投了')), '盤面が投了結果に更新された');
    assert.strictEqual(sessions.list('othello').length, 0, '終局でセッション削除');
    const resultEdit = board.edits[board.edits.length - 1];
    assert(JSON.stringify(resultEdit.components || []).includes('rematch'), '結果画面に再戦ボタンがある');

    // alice: 再戦 → bob へ申し込み → bob が承諾 → 先手・後手を入れ替えて新しい対局
    const rematchMsg = makeMessage('m-oth-rematch', channel);
    channel.byId.set('m-oth-rematch', rematchMsg);
    const rematch = interaction('alice', 'rematch');
    rematch.replyMessage = rematchMsg;
    const rematchDone = col.fire(rematch);
    await sleep(50);
    const challengeCol = rematchMsg.collector;
    assert(challengeCol, '再戦の申し込みメッセージが出た');
    await challengeCol.fire(interaction('bob', 'challenge:accept'));
    await rematchDone;
    await sleep(50);
    const rematchSession = sessions.list('othello').find((x) => x.messageId === 'm-oth-rematch');
    assert(rematchSession, '再戦の対局が保存された');
    assert.strictEqual(rematchSession.players[oc.BLACK].id, 'bob', '再戦では先手・後手が入れ替わる');
    assert(rematchMsg.collector && rematchMsg.collector !== challengeCol, '再戦の対局にコレクタが張られた');
    console.log('OTHELLO INTERACTION TESTS PASSED');
  }

  // ============ 将棋（投了確認の修正） ============
  {
    const sc = require('../utils/shogi-core.js');
    const shogi = require('../commands/games/shogi.js');
    const channel = makeChannel('c2');
    const board = makeMessage('m-sho', channel);
    channel.byId.set('m-sho', board);

    sessions.put('shogi', 'm-sho', {
      channelId: 'c2', guildId: 'g1',
      moves: [],
      players: {
        [sc.BLACK]: { id: 'alice', displayName: 'Alice', isAi: false },
        [sc.WHITE]: { id: 'bob', displayName: 'Bob', isAi: false },
      },
      ranked: true, level: 'normal',
    });
    const client = { channels: { fetch: async () => channel } };
    await shogi.restoreSessions(client);
    await sleep(50);
    assert(board.collector, '将棋コレクタが張られた');
    assert(channel.sent.some((m) => m.content.includes('<@alice>')), '将棋でも手番通知');

    const resign = interaction('bob', 'resign', undefined, 'resign:yes');
    await board.collector.fire(resign);
    await sleep(50);
    assert(resign.promptWaited, '将棋: 投了確認は確認メッセージ自身で待っている（修正点）');
    assert.strictEqual(resign.promptWaited.time, 30000, '制限時間30秒');
    assert(board.edits.some((e) => (e.content || '').includes('投了')), '将棋: 投了結果が盤面に反映');
    assert.strictEqual(sessions.list('shogi').length, 0, '将棋: 終局でセッション削除');

    // alice: 再戦 → bob が承諾 → 先手・後手を入れ替えて新しい対局
    const rematchMsg = makeMessage('m-sho-rematch', channel);
    channel.byId.set('m-sho-rematch', rematchMsg);
    const rematch = interaction('alice', 'rematch');
    rematch.replyMessage = rematchMsg;
    const rematchDone = board.collector.fire(rematch);
    await sleep(50);
    const challengeCol = rematchMsg.collector;
    assert(challengeCol, '将棋: 再戦の申し込みメッセージが出た');
    await challengeCol.fire(interaction('bob', 'challenge:accept'));
    await rematchDone;
    await sleep(50);
    const rematchSession = sessions.list('shogi').find((x) => x.messageId === 'm-sho-rematch');
    assert(rematchSession, '将棋: 再戦の対局が保存された');
    assert.strictEqual(rematchSession.players[sc.BLACK].id, 'bob', '将棋: 再戦では先手・後手が入れ替わる');
    console.log('SHOGI RESIGN TESTS PASSED');
  }

  // ============ 四目並べ ============
  {
    const c4 = require('../utils/connect4-core.js');
    const connect4 = require('../commands/games/connect4.js');
    const channel = makeChannel('c3');
    const board = makeMessage('m-c4', channel);
    channel.byId.set('m-c4', board);

    const b = c4.createBoard();
    c4.drop(b, 0, c4.RED); c4.drop(b, 1, c4.RED); c4.drop(b, 2, c4.RED);
    c4.drop(b, 5, c4.YELLOW); c4.drop(b, 6, c4.YELLOW);
    sessions.put('connect4', 'm-c4', {
      channelId: 'c3', guildId: 'g1',
      board: b, turn: c4.RED,
      players: {
        [c4.RED]: { id: 'alice', displayName: 'Alice', isAi: false },
        [c4.YELLOW]: { id: 'bob', displayName: 'Bob', isAi: false },
      },
      ranked: true, level: 'normal', events: [],
    });
    const client = { channels: { fetch: async () => channel } };
    await connect4.restoreSessions(client);
    await sleep(50);
    assert(board.collector, '四目並べコレクタが張られた');
    assert(channel.sent.some((m) => m.content.includes('<@alice>')), '四目並べでも手番通知');

    const col = board.collector;
    // alice: 列を選ぶ → 確認画面 → 落とす → 横4つで勝ち
    await col.fire(interaction('alice', 'col', ['3']));
    const conf = interaction('alice', 'confirm');
    // 確認画面を経ずに直接は進まないこと（段階ガード）も含め、確認で確定する
    await col.fire(conf);
    await sleep(50);
    assert.strictEqual(sessions.list('connect4').length, 0, '終局でセッション削除');
    assert(conf.updates.some((e) => (e.content || '').includes('🏆')), '勝ちの結果が盤面に反映');
    const resultPayload = conf.updates[conf.updates.length - 1];
    assert(JSON.stringify(resultPayload.components || []).includes('rematch'), '結果画面に再戦ボタンがある');

    // alice: 再戦 → bob が承諾 → 先手・後手を入れ替えて新しい対局
    const rematchMsg = makeMessage('m-c4-rematch', channel);
    channel.byId.set('m-c4-rematch', rematchMsg);
    const rematch = interaction('alice', 'rematch');
    rematch.replyMessage = rematchMsg;
    const rematchDone = col.fire(rematch);
    await sleep(50);
    const challengeCol = rematchMsg.collector;
    assert(challengeCol, '再戦の申し込みメッセージが出た');
    await challengeCol.fire(interaction('bob', 'challenge:accept'));
    await rematchDone;
    await sleep(50);
    const rematchSession = sessions.list('connect4').find((x) => x.messageId === 'm-c4-rematch');
    assert(rematchSession, '再戦の対局が保存された');
    assert.strictEqual(rematchSession.players[c4.RED].id, 'bob', '再戦では先手・後手が入れ替わる');
    console.log('CONNECT4 INTERACTION TESTS PASSED');
  }

  // ============ Bot戦の再戦（オセロ・将棋） ============
  {
    const oc = require('../utils/othello-core.js');
    const othello = require('../commands/games/othello.js');
    const channel = makeChannel('c4');
    const board = makeMessage('m-oth-bot', channel);
    channel.byId.set('m-oth-bot', board);

    sessions.put('othello', 'm-oth-bot', {
      channelId: 'c4', guildId: 'g1',
      board: oc.createBoard(), turn: oc.BLACK,
      players: {
        [oc.BLACK]: { id: 'alice', displayName: 'Alice', isAi: false },
        [oc.WHITE]: { id: 'uyuyu-bot', displayName: 'うゆゆBot', isAi: true },
      },
      ranked: false, level: 'normal', events: [],
    });
    const client = { channels: { fetch: async () => channel } };
    await othello.restoreSessions(client);
    await sleep(50);
    assert(board.collector, 'Bot戦コレクタが張られた');

    // alice が投了 → 結果画面 → 再戦（Bot戦は申し込みなしで即開始）
    await board.collector.fire(interaction('alice', 'resign', undefined, 'resign:yes'));
    await sleep(50);
    assert.strictEqual(sessions.list('othello').filter((x) => x.messageId === 'm-oth-bot').length, 0, 'Bot戦: 終局でセッション削除');

    const board2 = makeMessage('m-oth-bot2', channel);
    channel.byId.set('m-oth-bot2', board2);
    const rematch = interaction('alice', 'rematch');
    rematch.replyMessage = board2;
    await board.collector.fire(rematch);
    await sleep(50);
    const next = sessions.list('othello').find((x) => x.messageId === 'm-oth-bot2');
    assert(next, 'Bot戦: 再戦の対局が保存された');
    assert.strictEqual(next.players[oc.BLACK].isAi, true, 'Bot戦再戦: 先手がBotに入れ替わった');
    const stones = next.board.flat().filter((c) => c !== oc.EMPTY).length;
    assert.strictEqual(stones, 5, 'Bot戦再戦: Botの初手が打たれている（初期4+1）');
    assert(board2.collector, 'Bot戦再戦: コレクタが張られた');
    console.log('OTHELLO BOT REMATCH TESTS PASSED');
  }

  {
    const sc = require('../utils/shogi-core.js');
    const shogi = require('../commands/games/shogi.js');
    const channel = makeChannel('c5');
    const board = makeMessage('m-sho-bot', channel);
    channel.byId.set('m-sho-bot', board);

    // Bot（先手）が1手目（7七歩→7六歩）を指した後の局面を復元する
    sessions.put('shogi', 'm-sho-bot', {
      channelId: 'c5', guildId: 'g1',
      moves: ['7g7f'],
      players: {
        [sc.BLACK]: { id: 'uyuyu-bot', displayName: 'うゆゆBot', isAi: true },
        [sc.WHITE]: { id: 'alice', displayName: 'Alice', isAi: false },
      },
      ranked: false, level: 'normal',
    });
    const client = { channels: { fetch: async () => channel } };
    await shogi.restoreSessions(client);
    await sleep(50);
    assert(board.collector, '将棋Bot戦コレクタが張られた');

    // alice（後手）が投了 → 再戦すると alice が先手になって即開始（エンジンは不要な側）
    await board.collector.fire(interaction('alice', 'resign', undefined, 'resign:yes'));
    await sleep(50);
    const board2 = makeMessage('m-sho-bot2', channel);
    channel.byId.set('m-sho-bot2', board2);
    const rematch = interaction('alice', 'rematch');
    rematch.replyMessage = board2;
    await board.collector.fire(rematch);
    await sleep(50);
    const next = sessions.list('shogi').find((x) => x.messageId === 'm-sho-bot2');
    assert(next, '将棋Bot戦: 再戦の対局が保存された');
    assert.strictEqual(next.players[sc.BLACK].id, 'alice', '将棋Bot戦再戦: 先手がaliceに入れ替わった');
    assert.strictEqual(next.moves.length, 0, '将棋Bot戦再戦: 初期局面から');
    console.log('SHOGI BOT REMATCH TESTS PASSED');
  }

  console.log('ALL INTERACTION TESTS PASSED');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
