// utils/agent-bridge.js
// 自宅PCの常駐スクリプト（pc-agent）が「PC側からこのBotへ」WebSocket接続してくる受け口。
//  - 自宅のポート開放は不要（PC側からの outbound 接続のみ）
//  - 接続時に AGENT_TOKEN（共有シークレット）で認証する
//  - 既存の Express サーバー（index.js の app.listen の戻り値）に相乗りする
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const AGENT_PATH = '/agent';
const HEARTBEAT_TIMEOUT_MS = 90_000;

let agent = null;
let state = 'offline'; // offline | stopped | starting | running
const waiting = new Map(); // 起動指示のID -> resolve

function safeEqual(a, b) {
    const x = Buffer.from(a || '');
    const y = Buffer.from(b || '');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function attach(server) {
    if (!process.env.AGENT_TOKEN) {
        console.warn('[Agent Bridge] AGENT_TOKEN が未設定のため、自宅PCからの接続は受け付けません。');
    }
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, 'http://localhost');
        const token = (req.headers['authorization'] || '').replace(/^Bearer /, '');
        if (url.pathname !== AGENT_PATH || !process.env.AGENT_TOKEN || !safeEqual(token, process.env.AGENT_TOKEN)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    wss.on('connection', (ws, req) => {
        // 接続元（Render のプロキシ越しの場合は x-forwarded-for）。2台が同時につないでいないか見分ける用
        const from = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '不明';
        ws.connectedAt = Date.now();
        ws.lastSeen = Date.now();
        if (agent) {
            console.warn(`[Agent Bridge] 既存の接続があるため、古い接続を破棄します（新しい接続元: ${from}）。agent が2つ動いている可能性があります。`);
            agent.terminate(); // 古い接続は破棄
        }
        agent = ws;
        ws.isAlive = true;
        state = 'stopped';
        console.log(`[Agent Bridge] 自宅PCが接続しました（接続元: ${from}）。`);

        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }
            ws.lastSeen = Date.now();
            if (msg.type === 'heartbeat') {
                // プロキシは ping/pong を途中で処理してしまうことがあるため、データとして生存確認をやり取りする
                ws.supportsHeartbeat = true;
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
                return;
            }
            if (msg.type === 'status' && ['stopped', 'starting', 'running'].includes(msg.state)) {
                state = msg.state;
            } else if ((msg.type === 'start_result' || msg.type === 'command_result') && waiting.has(msg.id)) {
                waiting.get(msg.id)(msg);
                waiting.delete(msg.id);
            }
        });
        ws.on('close', (code, reason) => {
            if (agent === ws) {
                agent = null;
                state = 'offline';
                const upSec = Math.round((Date.now() - ws.connectedAt) / 1000);
                console.log(`[Agent Bridge] 自宅PCが切断しました (code ${code}${reason?.length ? `, ${reason}` : ''}, 接続していた時間 ${upSec}秒)。`);
            }
        });
        ws.on('error', (e) => console.error('[Agent Bridge] WebSocketエラー:', e.message));
    });

    // 生存確認（Renderのプロキシのアイドル切断対策も兼ねる）
    setInterval(() => {
        if (!agent) return;
        if (agent.supportsHeartbeat) {
            // agent は20秒ごとに heartbeat を送ってくる。90秒何も届かなければ死んでいるとみなす
            if (Date.now() - agent.lastSeen > HEARTBEAT_TIMEOUT_MS) {
                console.warn('[Agent Bridge] 自宅PCから90秒間何も届かないため、接続を切ります。');
                agent.terminate();
                return;
            }
        } else {
            // 旧バージョンの agent 向け（pong で判定）
            if (!agent.isAlive) {
                console.warn('[Agent Bridge] 自宅PCから生存確認(pong)が返らないため、接続を切ります。');
                agent.terminate();
                return;
            }
            agent.isAlive = false;
        }
        agent.ping();
    }, 30_000).unref();
}

const getState = () => state;

function requestStart(timeoutMs = 10_000) {
    return new Promise((resolve) => {
        if (!agent) return resolve({ result: 'offline' });
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
            waiting.delete(id);
            resolve({ result: 'timeout' });
        }, timeoutMs);
        waiting.set(id, (msg) => {
            clearTimeout(timer);
            resolve(msg);
        });
        agent.send(JSON.stringify({ type: 'start', id }));
    });
}

/** 自宅PCのサーバーコンソールにコマンドを送り、実行結果を返す。 */
function requestCommand(command, timeoutMs = 15_000) {
    return new Promise((resolve) => {
        if (!agent) return resolve({ ok: false, message: '自宅PCがオフラインです。' });
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
            waiting.delete(id);
            resolve({ ok: false, message: '自宅PCから応答がありませんでした。' });
        }, timeoutMs);
        waiting.set(id, (msg) => {
            clearTimeout(timer);
            resolve(msg);
        });
        agent.send(JSON.stringify({ type: 'command', id, command }));
    });
}

module.exports = { attach, getState, requestStart, requestCommand };