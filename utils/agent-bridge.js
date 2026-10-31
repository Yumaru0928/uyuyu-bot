// utils/agent-bridge.js
// 自宅PCの常駐スクリプト（pc-agent）が「PC側からこのBotへ」WebSocket接続してくる受け口。
//  - 自宅のポート開放は不要（PC側からの outbound 接続のみ）
//  - 接続時に AGENT_TOKEN（共有シークレット）で認証する
//  - 既存の Express サーバー（index.js の app.listen の戻り値）に相乗りする
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const AGENT_PATH = '/agent';

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
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
    });

    wss.on('connection', (ws) => {
        if (agent) agent.terminate(); // 古い接続は破棄
        agent = ws;
        ws.isAlive = true;
        state = 'stopped';
        console.log('[Agent Bridge] 自宅PCが接続しました。');

        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('message', (raw) => {
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }
            if (msg.type === 'status' && ['stopped', 'starting', 'running'].includes(msg.state)) {
                state = msg.state;
            } else if ((msg.type === 'start_result' || msg.type === 'command_result') && waiting.has(msg.id)) {
                waiting.get(msg.id)(msg);
                waiting.delete(msg.id);
            }
        });
        ws.on('close', () => {
            if (agent === ws) {
                agent = null;
                state = 'offline';
                console.log('[Agent Bridge] 自宅PCが切断しました。');
            }
        });
        ws.on('error', (e) => console.error('[Agent Bridge] WebSocketエラー:', e.message));
    });

    // 生存確認（Renderのプロキシのアイドル切断対策も兼ねる）
    setInterval(() => {
        if (!agent) return;
        if (!agent.isAlive) { agent.terminate(); return; }
        agent.isAlive = false;
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