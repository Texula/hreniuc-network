"use strict";

const net = require("net");
const WebSocket = require("ws");

const TCP_PORT = 5050;
const WS_SERVER = "ws://localhost:3000";
const MAX_CONNECTIONS = 5;

let connectionCount = 0;

// Helper to decode HTML entities sent by the server back to raw text for the DSi
function unescapeHtml(text) {
    if (!text) return text;
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'");
}

const tcpServer = net.createServer((socket) => {
    if (connectionCount >= MAX_CONNECTIONS) {
        socket.destroy();
        return;
    }
    connectionCount++;
    console.log(`\n[Bridge] [+] DSi connected: ${socket.remoteAddress}`);
    socket.setTimeout(120000);

    let ws = new WebSocket(WS_SERVER);
    let loggedIn = false;
    let tcpBuffer = "";
    let wsQueue = []; 

    function sendDS(msg) {
        if (!socket.destroyed) {
            console.log(`[Bridge -> DSi] ${msg}`);
            socket.write(msg + "\n");
        }
    }

    function sendToWS(payload) {
        const msgStr = JSON.stringify(payload);
        console.log(`[Bridge -> Server] ${msgStr}`);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(msgStr);
        } else {
            wsQueue.push(msgStr);
        }
    }

    ws.on("open", () => {
        console.log("[Bridge] Linked to main WebSocket Server.");
        while (wsQueue.length > 0) ws.send(wsQueue.shift());
    });

    ws.on("message", (msg) => {
        try {
            const data = JSON.parse(msg);
            
            if (data.type === "login_success") {
                if (!loggedIn) {
                    sendToWS({ type: "login_token", token: data.token, source: "chat" });
                    loggedIn = true;
                    sendDS("OK|LOGIN");
                    console.log(`[Bridge] User authenticated and upgraded to Chat Source.`);
                }
            } else if (data.type === "error") {
                sendDS("ERR|" + data.msg);
            } else if (data.type === "msg" && (data.target === "general" || !data.target)) {
                // Decode the HTML entities back to normal characters before sending to DS!
                const decodedMsg = unescapeHtml(data.msg);
                sendDS(`[${data.time}] ${data.user}: ${decodedMsg}`);
            } else if (data.type === "join") {
                sendDS(`--> ${data.user} joined the chat`);
            } else if (data.type === "leave") {
                sendDS(`<-- ${data.user} left the chat`);
            }
        } catch (e) { console.error("Parse error from WS:", e); }
    });

    ws.on("close", () => {
        console.log("[Bridge] Server disconnected.");
        sendDS("ERR|Chat server disconnected");
        socket.destroy();
    });

    socket.on("data", (data) => {
        tcpBuffer += data.toString();
        let newlineIdx;
        while ((newlineIdx = tcpBuffer.indexOf('\n')) !== -1) {
            const line = tcpBuffer.substring(0, newlineIdx).trim();
            tcpBuffer = tcpBuffer.substring(newlineIdx + 1);
            if (!line) continue;
            
            console.log(`[DSi -> Bridge] ${line}`);
            
            const parts = line.split("|");
            const cmd = parts[0];

            if (cmd === "LOGIN") {
                if (parts.length < 3) {
                    sendDS("ERR|Bad login format");
                    continue;
                }
                sendToWS({ type: "login", user: parts[1], password: parts[2] });
                
            } else if (cmd === "MSG") {
                if (!loggedIn) {
                    sendDS("ERR|You must login first!");
                    continue;
                }
                const text = parts.slice(1).join("|");
                sendToWS({ type: "msg", msg: text, target: "general" });
                
            } else if (cmd === "PING") {
                sendDS("PONG");
            }
        }
    });

    socket.on("close", () => { connectionCount--; console.log(`[Bridge] [-] DSi disconnected.\n`); if (ws) ws.close(); });
    socket.on("error", (err) => { console.log(`[Bridge] Socket error: ${err.message}`); socket.destroy(); });
    socket.on("timeout", () => { console.log(`[Bridge] Socket timeout.`); socket.destroy(); });
});

tcpServer.listen(TCP_PORT, "0.0.0.0", () => {
    console.log(`========================================`);
    console.log(` DSi PROXY BRIDGE LISTENING ON ${TCP_PORT}`);
    console.log(`========================================`);
});