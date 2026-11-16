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
// (6) 待機ルームの有効期限で破棄され、onExpire フックが呼ばれること
// (7) ペア捨てが起きた state では view.lastEvent.pair に捨てた2枚が入っていること
// (8) 多人数ロビー: 3人が参加→Bot追加/取り外し→開始→4人で1局完走して順位が全員一致、
//     全員承諾で再戦が始まること を確認する。
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
  'token-c': { id: '333', name: 'プレイヤーC' },
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
// onState があれば、各 state を受け取るたびに呼ぶ（lastEvent.pair の確認用）
async function playUntilEnd(client, label, onState) {
  for (let guard = 0; guard < 500; guard++) {
    const msg = await client.waitFor((m) => m.type === 'state');
    if (onState) onState(msg);
    const v = msg.view;
    if (v.youWon !== null) return msg;
    if (v.yourTurn) {
      client.send({ type: 'draw', position: Math.floor(Math.random() * v.opponentCount) });
    }
  }
  throw new Error(`${label}: 対局が終わらなかった`);
}

// 多人数用: 順位が確定するまで、自分の番なら引く相手（drawTarget）の手札から引く
async function playUntilEndMulti(client, label) {
  for (let guard = 0; guard < 2000; guard++) {
    const msg = await client.waitFor((m) => m.type === 'state');
    const v = msg.view;
    if (v.placements !== null) return msg;
    if (v.yourTurn) {
      const targetSize = v.counts[v.drawTarget];
      client.send({ type: 'draw', position: Math.floor(Math.random() * targetSize) });
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

  // (7) ペア捨ての state では lastEvent.pair に捨てた2枚（同じ rank・ジョーカーなし）が入ること
  let pairStatesSeen = 0;
  const checkPairEvent = (msg) => {
    const ev = msg.view && msg.view.lastEvent;
    if (!ev || !ev.discardedPair) return;
    pairStatesSeen++;
    assert(Array.isArray(ev.pair), 'discardedPair=true なのに lastEvent.pair がない');
    assert.strictEqual(ev.pair.length, 2, 'lastEvent.pair は2枚のはず');
    assert.strictEqual(ev.pair[0].rank, ev.pair[1].rank, 'lastEvent.pair の2枚は同じ rank のはず');
    assert(!ev.pair[0].joker && !ev.pair[1].joker, 'lastEvent.pair にジョーカーが含まれている');
  };

  // (1) Bot戦（ゲスト）: 最後まで進み、結果が出る
  {
    const c = await connect(port);
    c.send({ type: 'create', mode: 'bot', name: 'ゲスト' });
    const end = await playUntilEnd(c, 'bot', checkPairEvent);
    assert(end.view.youWon !== null);
    console.log(`Bot戦: OK（${end.view.youWon ? 'プレイヤーの勝ち' : 'Botの勝ち'}）`);

    // Bot戦の再戦は即開始（新しい state が来て、手札が配り直される）
    c.send({ type: 'rematch' });
    const next = await c.waitFor((m) => m.type === 'state');
    assert.strictEqual(next.view.youWon, null);
    console.log('Bot戦の再戦（即開始）: OK');
    c.close();
  }

  // (2) 人間同士: ルーム作成（待機ロビー）→参加→ホストが開始→1局→再戦の承諾
  {
    const a = await connect(port);
    const b = await connect(port);
    a.send({ type: 'create', mode: 'human', token: 'token-a' });
    const lobbyA = await a.waitFor((m) => m.type === 'lobby');
    assert.strictEqual(lobbyA.isHost, true);
    assert.strictEqual(lobbyA.canStart, false, '1人では開始できないはず');
    b.send({ type: 'join', code: lobbyA.code, token: 'token-b' });
    const lobbyB = await b.waitFor((m) => m.type === 'lobby');
    assert.strictEqual(lobbyB.players.length, 2);
    a.send({ type: 'start' });

    const [endA, endB] = await Promise.all([
      playUntilEnd(a, 'A', checkPairEvent),
      playUntilEnd(b, 'B', checkPairEvent),
    ]);
    assert.strictEqual(endA.view.youWon, !endB.view.youWon, '両者の勝敗が食い違っている');
    console.log(`人間同士: OK（勝者: ${endA.view.youWon ? 'A' : 'B'}）`);

    assert(pairStatesSeen > 0, 'ペア捨ての state が1局も観測できなかった');
    console.log(`ペア捨てイベント（lastEvent.pair）: OK（${pairStatesSeen}件で2枚を確認）`);

    // 再戦: A が承諾 → B に rematch_status → B も承諾 → 新しい対局の state が両方に来る
    a.send({ type: 'rematch' });
    const status = await b.waitFor((m) => m.type === 'rematch_status');
    assert.deepStrictEqual(status.agreed, ['プレイヤーA']);
    assert.deepStrictEqual(status.waiting, ['プレイヤーB']);
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
    await a.waitFor((m) => m.type === 'player_disconnected');
    const b2 = await connect(port);
    b2.send({ type: 'join', code: lobbyA.code, token: 'token-b' });
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

  // (4) Discordコマンド経由の人間ルーム: 相手が先に参加→待機、ホストが着席→ロビー、開始で対局開始
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
    const lobbyB = await b.waitFor((m) => m.type === 'lobby' || m.type === 'state');
    assert.strictEqual(lobbyB.type, 'lobby', 'ホスト到着前に対局が始まってしまった');
    assert.strictEqual(lobbyB.players.length, 2, 'ホスト席（接続待ち）と参加者の2人が見えるはず');
    console.log('Discord経由ルーム（相手が先に参加→待機）: OK');

    const a = await connect(port);
    a.send({ type: 'join', code: room.code, token: 'token-a' });
    const lobbyA = await a.waitFor((m) => m.type === 'lobby');
    assert.strictEqual(lobbyA.youSeat, 0, 'ホストが seat 0 に着いていない');
    assert.strictEqual(lobbyA.isHost, true);
    a.send({ type: 'start' });
    const [sA, sB] = await Promise.all([
      a.waitFor((m) => m.type === 'state'),
      b.waitFor((m) => m.type === 'state'),
    ]);
    assert.strictEqual(sA.seat, 0, 'ホストがプレイヤー0になっていない');
    assert.strictEqual(sB.seat, 1, '相手がプレイヤー1になっていない');
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(startCalls, 1, 'onStart フックが1回だけ呼ばれるはず');
    console.log('Discord経由ルーム（ホスト着席→開始）: OK');
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

  // (8) 多人数ロビー: 3人参加→Bot追加/取り外し→開始→4人で完走→全員承諾で再戦
  {
    const a = await connect(port);
    const b = await connect(port);
    const c = await connect(port);
    a.send({ type: 'create', mode: 'human', token: 'token-a' });
    const lobbyA = await a.waitFor((m) => m.type === 'lobby');
    const code = lobbyA.code;
    b.send({ type: 'join', code, token: 'token-b' });
    await b.waitFor((m) => m.type === 'lobby');
    c.send({ type: 'join', code, token: 'token-c' });
    const lobbyC = await c.waitFor((m) => m.type === 'lobby' && m.players.length === 3);
    assert.strictEqual(lobbyC.canStart, true);
    console.log('多人数ロビー（3人参加）: OK');

    // ホスト以外は Bot 追加も開始もできない
    c.send({ type: 'add_bot' });
    const errC = await c.waitFor((m) => m.type === 'error');
    assert(errC.message.includes('ホストだけ'));
    b.send({ type: 'start' });
    const errB = await b.waitFor((m) => m.type === 'error');
    assert(errB.message.includes('ホストだけ'));
    console.log('多人数ロビー（ホスト権限の確認）: OK');

    // Bot を追加→4人。外す→3人。もう一度追加→4人
    a.send({ type: 'add_bot' });
    const lobby4 = await a.waitFor((m) => m.type === 'lobby' && m.players.length === 4);
    const botSeat = lobby4.players.find((p) => p.bot).seat;
    a.send({ type: 'remove_bot', seat: botSeat });
    await a.waitFor((m) => m.type === 'lobby' && m.players.length === 3);
    a.send({ type: 'add_bot' });
    await a.waitFor((m) => m.type === 'lobby' && m.players.length === 4);
    console.log('多人数ロビー（Bot の追加・取り外し）: OK');

    // 開始 → 4人で1局完走し、順位が全員一致すること
    a.send({ type: 'start' });
    const [endA, endB, endC] = await Promise.all([
      playUntilEndMulti(a, 'A'),
      playUntilEndMulti(b, 'B'),
      playUntilEndMulti(c, 'C'),
    ]);
    for (const end of [endA, endB, endC]) {
      assert.strictEqual(end.players.length, 4);
      assert.deepStrictEqual([...end.view.placements].sort((x, y) => x - y), [1, 2, 3, 4], '順位が 1〜4 の順列になっていない');
      assert.strictEqual(end.view.yourPlace, end.view.placements[end.seat]);
    }
    assert.deepStrictEqual(endA.view.placements, endB.view.placements, 'A と B で順位が食い違っている');
    assert.deepStrictEqual(endB.view.placements, endC.view.placements, 'B と C で順位が食い違っている');
    console.log(`多人数対局（4人で完走・順位一致）: OK（順位: ${endA.view.placements.join(', ')}）`);

    // 再戦: 全員が承諾したら新しい対局が始まる
    a.send({ type: 'rematch' });
    b.send({ type: 'rematch' });
    c.send({ type: 'rematch' });
    const [rA, rB, rC] = await Promise.all([
      a.waitFor((m) => m.type === 'state' && m.view.placements === null && m.view.lastEvent === null),
      b.waitFor((m) => m.type === 'state' && m.view.placements === null && m.view.lastEvent === null),
      c.waitFor((m) => m.type === 'state' && m.view.placements === null && m.view.lastEvent === null),
    ]);
    assert(rA && rB && rC);
    console.log('多人数の再戦（全員承諾で開始）: OK');

    a.close(); b.close(); c.close();
  }

  // 多人数の記録: C も記録され、4人の対局ログ（players つき）が残っていること
  await new Promise((r) => setTimeout(r, 300));
  await records.flush();
  const saved2 = JSON.parse(fs.readFileSync(process.env.BABANUKI_LOCAL_PATH, 'utf-8'));
  assert(saved2.players['333'], 'プレイヤーC が記録されていない');
  assert.strictEqual(saved2.players['333'].games, 1);
  const multi = saved2.matches.find((m) => m.playerCount === 4);
  assert(multi, '4人の対局ログが残っていない');
  assert.strictEqual(multi.players.length, 4);
  assert.deepStrictEqual(multi.players.map((p) => p.place).sort((x, y) => x - y), [1, 2, 3, 4]);
  assert.strictEqual(multi.vsBot, true);
  console.log('多人数の勝敗記録（順位つき）: OK');

  server.close();
  fs.rmSync(process.env.BABANUKI_LOCAL_PATH, { force: true });
  console.log('check-babanuki-ws: OK');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
