'use strict';

// mahjong-server の結合スモークテスト（手動実行用・npm test には含めない）:
// ローカル HTTP サーバーに attach し、WS クライアント1人＋Bot 2人の対局を
// クライアント側も Bot 判断で操作して、終局まで到達できることを確認する。
const http = require('node:http');
const { WebSocket } = require('ws');
const server = require('../utils/mahjong-server.js');
const game = require('../utils/mahjong-game.js');

const httpServer = http.createServer();
server.attach(httpServer, { verifyToken: (t) => (t === 'ok' ? { id: 'u1', name: 'テスト' } : null) });

httpServer.listen(0, async () => {
  const port = httpServer.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/play/mahjong/ws`);
  let mySeat = -1;
  let done = false;
  const timer = setTimeout(() => {
    console.error('[smoke] タイムアウト: 終局に到達しなかった');
    process.exit(1);
  }, 480_000);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'create', mode: 'bot', length: 'east', token: 'ok' }));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'error') {
      console.error('[smoke] エラー:', msg.message);
      process.exit(1);
    }
    if (msg.type === 'lobby') {
      // Bot戦も待機ルーム経由になったので、ホストとして開始を送る
      ws.send(JSON.stringify({ type: 'start' }));
      return;
    }
    if (msg.type !== 'state') return;
    mySeat = msg.seat;
    const view = msg.view;
    if (view.phase === 'gameEnd') {
      if (!done) {
        done = true;
        clearTimeout(timer);
        console.log('[smoke] 終局到達 placements=', view.placements, 'scores=', view.players.map((p) => p.score).join('/'));
        ws.close();
        httpServer.close();
        process.exit(0);
      }
      return;
    }
    const a = view.actions;
    if (!a) return;
    // 自分の手番・応答も Bot 判断で操作する（少し待ってから送る）
    setTimeout(() => {
      try {
        if (a.type === 'call') {
          // view からは match を復元できないので、簡易判断: ロン可ならロン、それ以外パス
          ws.send(JSON.stringify({ type: 'call_response', action: a.ron ? 'ron' : 'pass' }));
          return;
        }
        // play: 手牌情報から Bot 判断を再現する（簡易版: ツモ可ならツモ、なければ先頭の合法牌を切る/リーチ牌があればリーチ）
        if (a.tsumo) { ws.send(JSON.stringify({ type: 'tsumo' })); return; }
        if (a.kan && a.kan.length > 0) { ws.send(JSON.stringify({ type: 'kan', tile: a.kan[0].tile, kanKind: a.kan[0].kind })); return; }
        if (a.riichi && a.riichi.length > 0) {
          ws.send(JSON.stringify({ type: 'discard', tile: a.riichi[0], riichi: true }));
          return;
        }
        ws.send(JSON.stringify({ type: 'discard', tile: a.discards[0] }));
      } catch { /* 終了直後の送信は無視 */ }
    }, 30);
  });
  ws.on('error', (e) => { console.error('[smoke] ws error', e.message); process.exit(1); });
  void game;
  void mySeat;
});
