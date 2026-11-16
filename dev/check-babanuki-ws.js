#!/usr/bin/env node
'use strict';

// Web版ババ抜きの WebSocket 動作確認（npm test には含めない手動チェック）。
//   node dev/check-babanuki-ws.js
// web.js の Express アプリを一時ポートで起動し、対局サーバーだけ相乗りさせて、
// (1) Bot戦が1局最後まで進むこと (2) 人間同士が2クライアントで1局最後まで進むこと
// (3) 再戦（人間同士=承諾制 / Bot戦=即開始）が始まること
// (4) Discordコマンド経由のルーム（createRoom）で、相手が先に参加しても待機になり、
//     ホストがログイン接続で着席したら対局が始まること
// (5) Discord経由のBotルームはホスト以外参加できず、ホストが入ると即始まること
// (6) 待機ルームの有効期限で破棄され、onExpire フックが呼ばれること を確認する。
// Discord ログインの代わりに、検証用トークンの verifyToken スタブを使う。

process.env.BABANUKI_LOCAL_PATH = require('node:path').join(__dirname, 'tmp-babanuki-results.json');

const assert = require('node:assert');
const fs = require('node:fs');
const WebSocket = require('ws');

const app = require('../web.js');
const babanukiServer = require('../utils/babanuki-server.js');

const TOKENS = {
  'token-a': { id: '111', name: 'プレイヤーA' },
  'token-b': { id: '222', name: 'プレイヤーB' },
};
const verifyToken = (t) => TOKENS[t] || null;

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/play/babanuki/ws`);
    const client = {
      ws,
      inbox: [],
      waiters: [],
      send(obj) { ws.send(JSON.stringify(obj)); },
      waitFor(pred, timeoutMs = 15000) {
        const found = client.inbox.findIndex(pred);
        if (found >= 0) return Promise.resolve(client.inbox.splice(found, 1)[0]);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('waitFor タイムアウト')), timeoutMs);
          client.waiters.push({ pred, res, timer });
        });
      },
      close() { try { ws.close(); } catch { /* noop */ } },
    };
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = client.waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const [w] = client.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.res(msg);
      } else {
        client.inbox.push(msg);
      }
    });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}

// state を受け取るたびに、自分の番ならランダムな位置を引く。勝敗が決まったらその state を返す
async function playUntilEnd(client, label) {
  for (let guard = 0; guard < 500; guard++) {
    const msg = await client.waitFor((m) => m.type === 'state');
    const v = msg.view;
    if (v.youWon !== null) return msg;
    if (v.yourTurn) {
      client.send({ type: 'draw', position: Math.floor(Math.random() * v.opponentCount) });
    }
  }
  throw new Error(`${label}: 対局が終わらなかった`);
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  babanukiServer.attach(server, { verifyToken });
  console.log(`チェック用サーバー: http://127.0.0.1:${port}`);

  // HTTP: 対戦ページと /api/babanuki/me（未ログイン）が返ること
  {
    const page = await fetch(`http://127.0.0.1:${port}/play/babanuki`);
    assert.strictEqual(page.status, 200);
    assert((await page.text()).includes('Web版ババ抜き'));
    const me = await (await fetch(`http://127.0.0.1:${port}/api/babanuki/me`)).json();
    assert.strictEqual(me.loggedIn, false);
    console.log('HTTP（ページ / me）: OK');
  }

  // (1) Bot戦（ゲスト）: 最後まで進み、結果が出る
  {
    const c = await connect(port);
    c.send({ type: 'create', mode: 'bot', name: 'ゲスト' });
    const end = await playUntilEnd(c, 'bot');
    assert(end.view.youWon !== null);
    console.log(`Bot戦: OK（${end.view.youWon ? 'プレイヤーの勝ち' : 'Botの勝ち'}）`);

    // Bot戦の再戦は即開始（新しい state が来て、手札が配り直される）
    c.send({ type: 'rematch' });
    const next = await c.waitFor((m) => m.type === 'state');
    assert.strictEqual(next.view.youWon, null);
    console.log('Bot戦の再戦（即開始）: OK');
    c.close();
  }

  // (2) 人間同士: ルーム作成→参加→1局→再戦の申し込みと承諾
  {
    const a = await connect(port);
    const b = await connect(port);
    a.send({ type: 'create', mode: 'human', token: 'token-a' });
    const waiting = await a.waitFor((m) => m.type === 'waiting');
    b.send({ type: 'join', code: waiting.code, token: 'token-b' });

    const [endA, endB] = await Promise.all([playUntilEnd(a, 'A'), playUntilEnd(b, 'B')]);
    assert.strictEqual(endA.view.youWon, !endB.view.youWon, '両者の勝敗が食い違っている');
    console.log(`人間同士: OK（勝者: ${endA.view.youWon ? 'A' : 'B'}）`);

    // 再戦: A が申し込み → B に offer → B が rematch で承諾 → 新しい対局の state が両方に来る
    a.send({ type: 'rematch' });
    await b.waitFor((m) => m.type === 'rematch_offer');
    b.send({ type: 'rematch' });
    const [sA, sB] = await Promise.all([
      a.waitFor((m) => m.type === 'state'),
      b.waitFor((m) => m.type === 'state'),
    ]);
    assert.strictEqual(sA.view.youWon, null);
    assert.strictEqual(sB.view.youWon, null);
    console.log('人間同士の再戦（承諾制）: OK');

    // 切断→猶予内に再接続すると席を取り戻せる
    b.ws.terminate();
    await a.waitFor((m) => m.type === 'opponent_disconnected');
    const b2 = await connect(port);
    b2.send({ type: 'join', code: waiting.code, token: 'token-b' });
    const rejoined = await b2.waitFor((m) => m.type === 'state');
    assert(rejoined.view, '再接続で state が返らなかった');
    console.log('切断→再接続での復帰: OK');

    a.close(); b2.close();
  }

  // (3) ゲストは人間同士のルームを作れない
  {
    const g = await connect(port);
    g.send({ type: 'create', mode: 'human', name: 'ゲスト' });
    const err = await g.waitFor((m) => m.type === 'error');
    assert(err.message.includes('Discord ログイン'));
    console.log('ゲストの人間対戦ブロック: OK');
    g.close();
  }

  // (4) Discordコマンド経由の人間ルーム: 相手が先に参加→待機、ホストが後から着席→対局開始
  {
    let startCalls = 0;
    const room = babanukiServer.createRoom({
      mode: 'human',
      hostId: '111',
      hostName: 'プレイヤーA',
      hooks: { onStart: () => { startCalls++; } },
    });
    assert(room && room.code, 'Discord経由のルームが作れなかった');

    const b = await connect(port);
    b.send({ type: 'join', code: room.code, token: 'token-b' });
    const waitingB = await b.waitFor((m) => m.type === 'waiting' || m.type === 'state');
    assert.strictEqual(waitingB.type, 'waiting', 'ホスト到着前に対局が始まってしまった');
    console.log('Discord経由ルーム（相手が先に参加→待機）: OK');

    const a = await connect(port);
    a.send({ type: 'join', code: room.code, token: 'token-a' });
    const [sA, sB] = await Promise.all([
      a.waitFor((m) => m.type === 'state'),
      b.waitFor((m) => m.type === 'state'),
    ]);
    assert.strictEqual(sA.seat, 0, 'ホストが seat 0 に着いていない');
    assert.strictEqual(sB.seat, 1, '相手が seat 1 に着いていない');
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(startCalls, 1, 'onStart フックが1回だけ呼ばれるはず');
    console.log('Discord経由ルーム（ホスト着席→対局開始）: OK');
    a.close(); b.close();
  }

  // (5) Discordコマンド経由のBotルーム: ホスト以外は参加できず、ホストが入ると即開始
  {
    const room = babanukiServer.createRoom({ mode: 'bot', hostId: '111', hostName: 'プレイヤーA' });
    assert(room && room.code, 'Discord経由のBotルームが作れなかった');

    const b = await connect(port);
    b.send({ type: 'join', code: room.code, token: 'token-b' });
    const err = await b.waitFor((m) => m.type === 'error');
    assert(err.message.includes('参加できません'));
    b.close();

    const a = await connect(port);
    a.send({ type: 'join', code: room.code, token: 'token-a' });
    const s = await a.waitFor((m) => m.type === 'state');
    assert.strictEqual(s.seat, 0);
    console.log('Discord経由のBotルーム（ホスト即開始）: OK');
    a.close();
  }

  // (6) 待機ルームの有効期限: 対局が始まらなければ破棄され、onExpire が呼ばれる
  {
    let expireCalls = 0;
    const room = babanukiServer.createRoom({
      mode: 'human',
      hostId: '999',
      hostName: '来ないホスト',
      ttlMs: 250,
      hooks: { onExpire: () => { expireCalls++; } },
    });
    assert(room && room.code);
    await new Promise((r) => setTimeout(r, 600));
    assert(!babanukiServer.rooms.has(room.code), '期限切れのルームが残っている');
    assert.strictEqual(expireCalls, 1, 'onExpire フックが呼ばれていない');

    const c = await connect(port);
    c.send({ type: 'join', code: room.code, token: 'token-a' });
    const err = await c.waitFor((m) => m.type === 'error');
    assert(err.message.includes('見つかりませんでした'));
    c.close();
    console.log('待機ルームの有効期限（破棄＋onExpire）: OK');
  }

  // 勝敗記録: ログイン済み同士の結果が記録されている（ゲストの Bot 戦は記録されない）
  await new Promise((r) => setTimeout(r, 300));
  const records = require('../utils/babanuki-records.js');
  await records.flush();
  const saved = JSON.parse(fs.readFileSync(process.env.BABANUKI_LOCAL_PATH, 'utf-8'));
  assert.strictEqual(Object.keys(saved.players).length, 2, '記録されたプレイヤーは A と B の2人のはず');
  const totalWins = Object.values(saved.players).reduce((n, p) => n + p.wins, 0);
  assert.strictEqual(totalWins, 1);
  console.log('勝敗記録（ログイン済みのみ）: OK');

  server.close();
  fs.rmSync(process.env.BABANUKI_LOCAL_PATH, { force: true });
  console.log('check-babanuki-ws: OK');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
