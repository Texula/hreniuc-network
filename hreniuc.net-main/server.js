const path = require("path");
require('dotenv').config({ path: path.join(__dirname, '.env') }); 

const express = require('express');
const http = require('http');
const WebSocket = require("ws");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const crypto = require("crypto"); 
const { Client } = require('pg');

// --- CONFIGURATION ---
const PORT = 3000;
const UPLOADS_DIR = "/var/www/hreniuc.net/uploads"; 
const SILENT_USERS = ["admin", "bot"]; 
const VIP_USERS = ["matei", "admin"]; 
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; 

// --- APP SETUP ---
const app = express();
const server = http.createServer(app);

const wss = new WebSocket.Server({ 
    server,
    maxPayload: MAX_PAYLOAD_BYTES 
});

// --- SECURITY: STORAGE ---
const loginAttempts = new Map(); 
const pendingRegistrations = new Map(); 
const pendingEmailChanges = new Map(); 
const emailRateLimits = new Map(); 
const pendingPasswordResets = new Map();

// --- DATABASE ---
const db = new Client({
    user: 'chat_admin',
    host: 'localhost',
    database: 'hreniuc_chat',
    password: process.env.DB_PASS,
    port: 5432,
});

async function initDB() {
    try {
        await db.connect();
        console.log("✅ PostgreSQL Connected");

        await db.query(`
            CREATE TABLE IF NOT EXISTS profile_likes (
                liker_username VARCHAR(255), 
                target_username VARCHAR(255), 
                PRIMARY KEY(liker_username, target_username)
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS post_likes (
                liker_username VARCHAR(255), 
                post_id VARCHAR(50), 
                PRIMARY KEY(liker_username, post_id)
            )
        `);

        await db.query(`
            CREATE TABLE IF NOT EXISTS posts (
                id VARCHAR(50) PRIMARY KEY,
                author_username VARCHAR(255),
                title TEXT,
                content TEXT,
                summary TEXT,
                image_url VARCHAR(255),
                created_at TIMESTAMP
            )
        `);

        const columns = [
            "ADD COLUMN IF NOT EXISTS display_name VARCHAR(255)",
            "ADD COLUMN IF NOT EXISTS title VARCHAR(255) DEFAULT 'User'",
            "ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT 'Welcome to my profile!'",
            "ADD COLUMN IF NOT EXISTS is_visible BOOLEAN DEFAULT TRUE",
            "ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'",
            "ADD COLUMN IF NOT EXISTS social_links JSONB DEFAULT '{}'",
            "ADD COLUMN IF NOT EXISTS music_url TEXT" 
        ];
        for (const col of columns) {
            try { await db.query(`ALTER TABLE users ${col}`); } catch (err) {}
        }
        
        try { await db.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'"); } catch(e){}
        
        // --- NEW: Post Visibility Column ---
        try { 
            await db.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_visible BOOLEAN DEFAULT TRUE"); 
            await db.query("UPDATE posts SET is_visible = TRUE WHERE is_visible IS NULL");
        } catch(e) {}

        console.log("✅ DB Structure Ready");

    } catch (err) {
        console.error("❌ DB Init Failed:", err);
    }
}
initDB();

// --- EMAIL ---
const emailConfig = {
    host: process.env.EMAIL_HOST || "mail.hreniuc.net",
    port: process.env.EMAIL_PORT || 587,
    secure: false, 
    auth: { user: process.env.EMAIL_AUTH_USER || "chat", pass: process.env.EMAIL_PASS },
    tls: { rejectUnauthorized: false }
};
const senderEmail = process.env.EMAIL_ADDRESS || "chat@hreniuc.net";
let transporter = null;

if (process.env.EMAIL_PASS) {
    transporter = nodemailer.createTransport(emailConfig);
} else {
    console.warn("⚠️ EMAIL_PASS missing in .env! Emails will fail to send. Please configure SMTP.");
}

// --- MIDDLEWARE ---
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.json());

// --- ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat', 'index.html')));
app.get('/editor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'editor.html')));
app.get('/post', (req, res) => res.sendFile(path.join(__dirname, 'public', 'post.html')));
app.get('/forgor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'forgor.html')));
app.get('/password_change', (req, res) => res.sendFile(path.join(__dirname, 'public', 'password_change.html')));

// --- GLOBAL STATE ---
const clientsMap = new Map();               
const pendingLeaves = new Map();

// --- HELPERS ---
function escapeHtml(text) {
    if (!text) return text;
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function isValidUsername(username) { return /^[a-zA-Z0-9_-]{3,20}$/.test(username); }

function getActiveChatConnectionCount(username) {
    let count = 0;
    for (let clientData of clientsMap.values()) { 
        if (clientData.user === username && clientData.source === 'chat') count++; 
    }
    return count;
}
function getActiveConnectionCount(username) {
    let count = 0;
    for (let clientData of clientsMap.values()) { if (clientData.user === username) count++; }
    return count;
}
function formatTime(dateObj) { return new Date(dateObj).toLocaleTimeString("ro-RO", {hour: "2-digit", minute: "2-digit"}); }
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

// Send Verification Code Email (Rate Limited)
async function sendVerificationCode(email, code, type = "registration") {
    const lastSent = emailRateLimits.get(email);
    if (lastSent && Date.now() - lastSent < 60000) {
        const remaining = Math.ceil((60000 - (Date.now() - lastSent)) / 1000);
        return { success: false, msg: `Please wait ${remaining}s before requesting another code.` };
    }

    if (!transporter) return { success: false, msg: "Email service not available. Check Server logs." };

    emailRateLimits.set(email, Date.now());

    try {
        const subject = type === "email_change" ? "Verify Email Change" : "Verify Your Account";
        const mailOptions = {
            from: `"Hreniuc Auth" <${senderEmail}>`,
            to: email,
            subject: `${subject}: ${code}`,
            html: `
                <div style="background:#121212; color:#e0e0e0; padding:20px; font-family:sans-serif; text-align:center;">
                    <h2 style="color:#bb86fc;">${subject}</h2>
                    <p>Enter this code to verify:</p>
                    <div style="font-size:2em; font-weight:bold; letter-spacing:5px; background:#1e1e1e; padding:15px; display:inline-block; border-radius:8px; margin:20px 0; border:1px solid #333;">
                        ${code}
                    </div>
                    <p style="color:#888; font-size:0.9em;">This code expires in 10 minutes.</p>
                </div>`
        };
        await transporter.sendMail(mailOptions);
        return { success: true };
    } catch(e) {
        console.error("❌ Email Sending Error:", e);
        emailRateLimits.delete(email); 
        return { success: false, msg: "Failed to send email. Ensure SMTP configuration is valid." };
    }
}

async function sendOfflineNotification(targetUser, fromUser, msgContent) {
    if (!transporter) return;
    try {
        const res = await db.query('SELECT email FROM users WHERE username = $1', [targetUser]);
        if (res.rows.length === 0 || !res.rows[0].email) return;
        const previewText = msgContent ? escapeHtml(msgContent) : "[Image Sent]";
        const mailOptions = {
            from: `"Hreniuc Chat" <${senderEmail}>`,
            to: res.rows[0].email,
            subject: `New message from ${fromUser}`,
            html: `<p><strong>${escapeHtml(fromUser)}</strong> sent you a message: ${previewText}</p>`
        };
        transporter.sendMail(mailOptions, (err) => { if(err) console.error("Email Error:", err); });
    } catch(e) {}
}

async function getSocialData(username) {
    const friendsRes = await db.query(`SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END as username FROM friendships WHERE (user_a = $1 OR user_b = $1) AND status = 'accepted'`, [username]);
    const reqIn = await db.query(`SELECT user_a as username FROM friendships WHERE user_b = $1 AND status = 'pending'`, [username]);
    const reqOut = await db.query(`SELECT user_b as username FROM friendships WHERE user_a = $1 AND status = 'pending'`, [username]);

    const enrich = async (list) => {
        if (list.length === 0) return [];
        const names = list.map(r => r.username);
        const res = await db.query(`SELECT username, color, avatar FROM users WHERE username = ANY($1)`, [names]);
        return res.rows.map(r => ({ user: r.username, color: r.color, avatar: r.avatar }));
    };
    return { type: "social_update", friends: await enrich(friendsRes.rows), requests_in: await enrich(reqIn.rows), requests_out: await enrich(reqOut.rows) };
}

// --- PROFILE & POSTS ---
async function getPosts(targetUser, requestingUser) {
    try {
        let query = `SELECT id, title, summary, image_url, created_at, tags FROM posts WHERE author_username ILIKE $1 AND is_visible = TRUE ORDER BY created_at DESC`;
        let params = [targetUser];

        if (requestingUser) {
            if (requestingUser.toLowerCase() === 'admin' || requestingUser.toLowerCase() === targetUser.toLowerCase()) {
                query = `SELECT id, title, summary, image_url, created_at, tags, is_visible FROM posts WHERE author_username ILIKE $1 ORDER BY created_at DESC`;
            }
        }
        
        const res = await db.query(query, params);
        
        const enrichedPosts = await Promise.all(res.rows.map(async (p) => {
            const likesRes = await db.query('SELECT COUNT(*) FROM post_likes WHERE post_id = $1', [p.id]);
            let hasLiked = false;
            if (requestingUser) {
                const checkRes = await db.query('SELECT 1 FROM post_likes WHERE post_id = $1 AND liker_username = $2', [p.id, requestingUser]);
                hasLiked = (checkRes.rowCount > 0);
            }
            return { ...p, likeCount: parseInt(likesRes.rows[0].count), hasLiked };
        }));

        return { type: "user_posts", posts: enrichedPosts };
    } catch (e) { return { type: "user_posts", posts: [] }; }
}

async function getPostById(id, requestingUser) {
    try {
        const res = await db.query(`SELECT * FROM posts WHERE id = $1`, [id]);
        if(res.rows.length === 0) return { type: "post_content", error: "404" };
        const p = res.rows[0];
        
        const likesRes = await db.query('SELECT COUNT(*) FROM post_likes WHERE post_id = $1', [p.id]);
        let hasLiked = false;
        if (requestingUser) {
            const checkRes = await db.query('SELECT 1 FROM post_likes WHERE post_id = $1 AND liker_username = $2', [p.id, requestingUser]);
            hasLiked = (checkRes.rowCount > 0);
        }
        
        const u = await db.query('SELECT username, display_name, avatar, color FROM users WHERE username = $1', [p.author_username]);
        const author = u.rows.length > 0 ? u.rows[0] : { username: p.author_username };
        
        return { type: "post_content", post: p, author: author, likeCount: parseInt(likesRes.rows[0].count), hasLiked };
    } catch(e) { return { type: "post_content", error: "Server Error" }; }
}

async function getProfileStats(targetUser, requestingUser) {
    try {
        let userRes;
        try { userRes = await db.query('SELECT * FROM users WHERE username ILIKE $1', [targetUser]); } 
        catch (e) { userRes = await db.query('SELECT username, avatar, color FROM users WHERE username ILIKE $1', [targetUser]); }
        
        if (userRes.rows.length === 0) return { type: "profile_stats", error: "User not found", targetUser: targetUser, displayName: targetUser };

        const u = userRes.rows[0];
        const isVisible = (u.is_visible !== false);
        const isOwner = requestingUser && requestingUser.toLowerCase() === u.username.toLowerCase();
        const isAdmin = requestingUser === 'admin';
        
        if (!isVisible && !isOwner && !isAdmin) return { type: "profile_stats", isHidden: true, targetUser: u.username };

        const fRes = await db.query(`SELECT COUNT(*) FROM friendships WHERE (user_a = $1 OR user_b = $1) AND status = 'accepted'`, [u.username]);
        const lRes = await db.query(`SELECT COUNT(*) FROM profile_likes WHERE target_username = $1`, [u.username]);
        
        let hasLiked = false;
        if (requestingUser) {
            const checkLike = await db.query(`SELECT 1 FROM profile_likes WHERE liker_username = $1 AND target_username = $2`, [requestingUser, u.username]);
            hasLiked = checkLike.rowCount > 0;
        }

        return { 
            type: "profile_stats", targetUser: u.username, username: u.username, 
            displayName: u.display_name || u.username, title: u.title || "User", bio: u.bio,
            isVisible: isVisible, displayColor: u.color, friendsCount: parseInt(fRes.rows[0].count), 
            likeCount: parseInt(lRes.rows[0].count), hasLiked: hasLiked, avatar: u.avatar, 
            isSpecial: VIP_USERS.includes(u.username.toLowerCase()),
            socialLinks: u.social_links || {},
            musicUrl: u.music_url
        };
    } catch (e) { return { type: "profile_stats", error: "Server Error" }; }
}

async function fetchAndFormatHistory(targetUser, userA, offset = 0) {
    const limit = 100;
    let query, params;
    if (targetUser === 'general') {
        query = `SELECT * FROM messages WHERE target_username = 'general' ORDER BY created_at DESC LIMIT $1 OFFSET $2`;
        params = [limit, offset];
    } else {
        query = `SELECT * FROM messages WHERE ((sender_username = $1 AND target_username = $2) OR (sender_username = $2 AND target_username = $1)) AND type = 'msg' ORDER BY created_at DESC LIMIT $3 OFFSET $4`;
        params = [userA, targetUser, limit, offset];
    }
    const res = await db.query(query, params);
    const messages = [];
    for (let row of res.rows) {
        const uRes = await db.query('SELECT color, avatar FROM users WHERE username = $1', [row.sender_username]);
        const userData = uRes.rows[0] || { color: '#ffffff', avatar: null };
        messages.push({
            id: row.id,
            type: row.type, 
            user: row.sender_username, msg: row.content, target: targetUser, image: row.image_url,
            replyTo: row.reply_to_json, fullDate: row.created_at.toISOString(), time: formatTime(row.created_at),
            color: userData.color, avatar: userData.avatar
        });
    }
    return messages.reverse();
}

async function performLogin(ws, username, userData, existingToken = null, source = 'chat') {
    let sessionToken = existingToken;
    if (!sessionToken) {
        sessionToken = crypto.randomBytes(32).toString('hex');
        await db.query('UPDATE users SET session_token = $1 WHERE username = $2', [sessionToken, username]);
    }
    clientsMap.set(ws, { user: username, color: userData.color, avatar: userData.avatar, source: source, email: userData.email });

    ws.send(JSON.stringify({ 
        type: "login_success", user: username, displayName: userData.display_name || username, 
        color: userData.color, avatar: userData.avatar, email: userData.email || "", 
        allowFriends: userData.allow_friends, token: sessionToken, openChats: userData.open_chats || [], lastRead: userData.last_read || {}   
    }));
    
    try {
        ws.send(JSON.stringify(await getSocialData(username)));
        const messages = await fetchAndFormatHistory('general');
        ws.send(JSON.stringify({ type: "general_history_init", messages: messages }));
    } catch(e) { console.error("Login Data Fetch Error", e); }

    if (source === 'chat') {
        const activeChatCount = getActiveChatConnectionCount(username);
        if (pendingLeaves.has(username)) {
            clearTimeout(pendingLeaves.get(username));
            pendingLeaves.delete(username);
        } else if (activeChatCount <= 1 && !SILENT_USERS.includes(username)) {
            const now = new Date();
            const joinMsg = { type: "join", user: username, color: userData.color, msg: "joined!", avatar: userData.avatar, time: formatTime(now) };
            broadcast(joinMsg);
            await db.query(`INSERT INTO messages (id, type, sender_username, target_username, content, created_at) VALUES ($1, $2, $3, 'general', $4, $5)`, [generateId(), 'join', username, 'joined!', now]);
        }
    }
    broadcastUserList();
}

function broadcast(obj) {
    const json = JSON.stringify(obj);
    for (let client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && (clientsMap.has(client) || obj.type === 'userList')) {
            client.send(json);
        }
    }
}

function broadcastUserList() {
    const activeUsers = Array.from(clientsMap.values());
    broadcast({ type: "userList", users: activeUsers });
}

function checkRateLimit(ip) {
    const now = Date.now();
    let record = loginAttempts.get(ip);
    
    if (record && record.lockUntil !== 0 && now > record.lockUntil) {
        loginAttempts.delete(ip);
        record = null;
    }

    if (!record) {
        record = { attempts: 0, lockUntil: 0 };
        loginAttempts.set(ip, record);
    }

    if (record.lockUntil > now) {
        return Math.ceil((record.lockUntil - now) / 1000); 
    }
    return 0; 
}

function failLoginAttempt(ip) {
    const now = Date.now();
    let record = loginAttempts.get(ip);
    if (!record) record = { attempts: 0, lockUntil: 0 };
    
    record.attempts++;
    if (record.attempts >= 5) record.lockUntil = now + (15 * 60 * 1000); 
    
    loginAttempts.set(ip, record);
}

// --- CONNECTION HANDLER ---
wss.on("connection", (ws, req) => {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;

    ws.on("message", async (msg) => {
        try {
            const data = JSON.parse(msg);
            let now = new Date();
            
            // --- WEBRTC SIGNALING FOR VOICE CALLS ---
            if (["rtc_offer", "rtc_answer", "rtc_ice", "call_invite", "call_leave"].includes(data.type)) {
                const senderData = clientsMap.get(ws);
                if (senderData && data.target) {
                    data.user = senderData.user; // Attach sender info
                    const jsonToSend = JSON.stringify(data);
                    
                    for (let [client, cData] of clientsMap.entries()) {
                        if (cData.user === data.target && client.readyState === WebSocket.OPEN) {
                            client.send(jsonToSend);
                        }
                    }
                }
                return; // End processing for signaling
            }

            if (data.type === "login") {
                const waitTime = checkRateLimit(ip);
                if (waitTime > 0) return ws.send(JSON.stringify({ type: "error", msg: `Too many attempts. Try again in ${waitTime} seconds.` }));

                const username = data.user ? data.user.trim() : "";
                const res = await db.query('SELECT * FROM users WHERE username = $1', [username]);
                
                if (res.rows.length === 0 || !bcrypt.compareSync(data.password, res.rows[0].password)) {
                    failLoginAttempt(ip);
                    return ws.send(JSON.stringify({ type: "error", msg: "Incorrect credentials." }));
                }
                
                loginAttempts.delete(ip);
                await performLogin(ws, username, res.rows[0], null, 'auth'); 
            }
            
            // --- REGISTER ---
            else if (data.type === "register") {
                const username = data.user ? data.user.trim() : "";
                if (!isValidUsername(username)) return ws.send(JSON.stringify({ type: "error", msg: "Invalid username." }));
                if (!username || !data.password || !data.email) return ws.send(JSON.stringify({ type: "error", msg: "All fields required." }));
                
                const check = await db.query('SELECT 1 FROM users WHERE username = $1 OR email = $2', [username, data.email]);
                if (check.rowCount > 0) return ws.send(JSON.stringify({ type: "error", msg: "Username or Email taken." }));

                const code = Math.floor(100000 + Math.random() * 900000).toString(); 
                const hash = bcrypt.hashSync(data.password, 10);
                
                const emailResult = await sendVerificationCode(data.email, code);
                if (!emailResult.success) return ws.send(JSON.stringify({ type: "error", msg: emailResult.msg }));

                pendingRegistrations.set(data.email, {
                    user: username,
                    pass: hash,
                    email: data.email,
                    color: escapeHtml(data.color) || "#ffffff",
                    code: code,
                    expires: Date.now() + (10 * 60 * 1000),
                    attempts: 0
                });

                ws.send(JSON.stringify({ type: "verification_sent", email: data.email }));
            }

            // --- VERIFY EMAIL (REGISTRATION) ---
            else if (data.type === "verify_email") {
                const record = pendingRegistrations.get(data.email);
                if (!record) return ws.send(JSON.stringify({ type: "error", msg: "Verification expired or invalid." }));
                if (Date.now() > record.expires) {
                    pendingRegistrations.delete(data.email);
                    return ws.send(JSON.stringify({ type: "error", msg: "Code expired." }));
                }
                
                if (record.code !== data.code) {
                    record.attempts++;
                    if (record.attempts >= 3) {
                        pendingRegistrations.delete(data.email);
                        return ws.send(JSON.stringify({ type: "error", msg: "Too many failed attempts. Register again." }));
                    }
                    return ws.send(JSON.stringify({ type: "error", msg: `Invalid code. ${3 - record.attempts} attempts left.` }));
                }

                try {
                    await db.query(`INSERT INTO users (username, password, email, color, allow_friends) VALUES ($1, $2, $3, $4, $5)`, 
                        [record.user, record.pass, record.email, record.color, true]);
                    pendingRegistrations.delete(data.email);
                    ws.send(JSON.stringify({ type: "register_success", msg: "Account verified and created!" }));
                } catch (e) {
                    ws.send(JSON.stringify({ type: "error", msg: "Database error during creation." }));
                }
            }

            // --- UPDATE PROFILE (CHAT APP) ---
            else if (data.type === "update_profile") {
                const s = clientsMap.get(ws);
                if (s) {
                    let updates = []; 
                    let params = []; 
                    let idx = 1;
                    
                    if (data.newColor) { 
                        updates.push(`color = $${idx++}`); 
                        params.push(escapeHtml(data.newColor)); 
                        s.color = escapeHtml(data.newColor); 
                    }
                    if (data.allowFriends !== undefined) {
                        updates.push(`allow_friends = $${idx++}`);
                        params.push(data.allowFriends);
                    }
                    
                    if (data.email && data.email !== s.email) { 
                        const code = Math.floor(100000 + Math.random() * 900000).toString();
                        
                        const emailResult = await sendVerificationCode(data.email, code, "email_change");
                        if (emailResult.success) {
                            pendingEmailChanges.set(s.user, {
                                newEmail: data.email,
                                code: code,
                                expires: Date.now() + (10 * 60 * 1000),
                                attempts: 0
                            });
                            ws.send(JSON.stringify({ type: "info", msg: "Verification code sent to new email." }));
                            ws.send(JSON.stringify({ type: "email_verification_required" }));
                        } else {
                            ws.send(JSON.stringify({ type: "error", msg: emailResult.msg }));
                            return; 
                        }
                    }

                    if (data.image) {
                        const m = data.image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
                        if(m) {
                            const fname = `${s.user}_${Date.now()}.png`;
                            try {
                                await fs.promises.writeFile(path.join(UPLOADS_DIR, fname), Buffer.from(m[2], 'base64'));
                                updates.push(`avatar = $${idx++}`); params.push(fname); s.avatar = fname;
                            } catch(err) { console.error("File write error", err); }
                        }
                    }

                    if (updates.length > 0) {
                        params.push(s.user);
                        await db.query(`UPDATE users SET ${updates.join(", ")} WHERE username = $${idx}`, params);
                    }
                    
                    const u = await db.query('SELECT email FROM users WHERE username = $1', [s.user]);
                    ws.send(JSON.stringify({ type:"profile_updated", color:s.color, avatar:s.avatar, email: u.rows[0].email, msg:"Profile Updated" }));
                    broadcastUserList();
                }
            }

            else if (data.type === "verify_email_change") {
                const s = clientsMap.get(ws);
                if(s) {
                    const record = pendingEmailChanges.get(s.user);
                    if (!record) return ws.send(JSON.stringify({ type: "error", msg: "No pending email change." }));
                    
                    if (record.code !== data.code) {
                        return ws.send(JSON.stringify({ type: "error", msg: "Invalid code." }));
                    }
                    
                    await db.query('UPDATE users SET email = $1 WHERE username = $2', [record.newEmail, s.user]);
                    s.email = record.newEmail; 
                    pendingEmailChanges.delete(s.user);
                    ws.send(JSON.stringify({ type: "info", msg: "Email updated successfully." }));
                    const u = await db.query('SELECT email, color, avatar, allow_friends FROM users WHERE username = $1', [s.user]);
                    ws.send(JSON.stringify({ 
                        type: "profile_updated", 
                        color: u.rows[0].color, 
                        avatar: u.rows[0].avatar, 
                        email: u.rows[0].email,
                        allowFriends: u.rows[0].allow_friends,
                        msg: "Email Changed!" 
                    }));
                }
            }

            // --- FORGOT PASSWORD ---
            else if (data.type === "request_password_reset") {
                const email = data.email ? data.email.trim() : "";
                if (!email) return ws.send(JSON.stringify({ type: "error", msg: "Email is required." }));

                // 1. Rate Limit Check
                const lastSent = emailRateLimits.get(email);
                if (lastSent && Date.now() - lastSent < 60000) {
                    const remaining = Math.ceil((60000 - (Date.now() - lastSent)) / 1000);
                    return ws.send(JSON.stringify({ type: "error", msg: `Please wait ${remaining}s before requesting another code.` }));
                }

                if (!transporter) return ws.send(JSON.stringify({ type: "error", msg: "Email service not configured. Check Server logs." }));

                // 2. Lock Rate Limit Immediately
                emailRateLimits.set(email, Date.now());

                try {
                    // Check if email exists in DB
                    const res = await db.query('SELECT username FROM users WHERE email = $1', [email]);
                    if (res.rows.length === 0) {
                        return ws.send(JSON.stringify({ type: "reset_code_sent", email: email }));
                    }

                    // Generate complex 9 character code
                    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
                    let code = "";
                    for(let i=0; i<9; i++) code += charset.charAt(Math.floor(Math.random() * charset.length));

                    const mailOptions = {
                        from: `"Hreniuc Support" <${senderEmail}>`,
                        to: email,
                        subject: `Password Reset Code: ${code}`,
                        html: `
                            <div style="background:#121212; color:#e0e0e0; padding:20px; font-family:sans-serif; text-align:center;">
                                <h2 style="color:#bb86fc;">Password Reset</h2>
                                <p>You requested a password reset. Here is your secure 9-character code:</p>
                                <div style="font-size:2.2em; font-weight:bold; letter-spacing:8px; background:#1e1e1e; padding:15px; display:inline-block; border-radius:8px; margin:20px 0; border:1px solid #333;">
                                    ${code}
                                </div>
                                <p style="color:#888; font-size:0.9em;">This code expires in 15 minutes.</p>
                                <p style="margin-top: 20px;">Or click the link below to verify directly:</p>
                                <a href="https://${req.headers.host}/password_change?email=${encodeURIComponent(email)}&code=${code}" style="color:#bb86fc;">Change Password Now</a>
                            </div>`
                    };
                    
                    await transporter.sendMail(mailOptions);
                    
                    // Save to memory
                    pendingPasswordResets.set(email, {
                        code: code,
                        expires: Date.now() + (15 * 60 * 1000), 
                        verified: false,
                        attempts: 0
                    });

                    ws.send(JSON.stringify({ type: "reset_code_sent", email: email }));
                } catch(e) {
                    console.error("Forgot Password Email Error:", e);
                    emailRateLimits.delete(email); // Unlock so they can try again
                    ws.send(JSON.stringify({ type: "error", msg: "Failed to send email." }));
                }
            }

            else if (data.type === "verify_reset_code") {
                const record = pendingPasswordResets.get(data.email);
                if (!record || Date.now() > record.expires) {
                    return ws.send(JSON.stringify({ type: "error", msg: "Code expired or invalid." }));
                }

                if (record.code !== data.code.toUpperCase()) {
                    record.attempts++;
                    if (record.attempts >= 5) {
                        pendingPasswordResets.delete(data.email);
                        return ws.send(JSON.stringify({ type: "error", msg: "Too many failed attempts. Request a new code." }));
                    }
                    return ws.send(JSON.stringify({ type: "error", msg: `Invalid code. ${5 - record.attempts} attempts left.` }));
                }

                record.verified = true;
                ws.send(JSON.stringify({ type: "reset_code_verified", email: data.email, code: record.code }));
            }

            else if (data.type === "change_password") {
                const record = pendingPasswordResets.get(data.email);
                
                if (!record || !record.verified || record.code !== data.code) {
                    return ws.send(JSON.stringify({ type: "error", msg: "Unauthorized. Session expired or invalid." }));
                }

                if (!data.newPassword || data.newPassword.length < 3) {
                    return ws.send(JSON.stringify({ type: "error", msg: "Password is too short." }));
                }

                try {
                    const hash = bcrypt.hashSync(data.newPassword, 10);
                    await db.query('UPDATE users SET password = $1 WHERE email = $2', [hash, data.email]);
                    
                    pendingPasswordResets.delete(data.email);
                    
                    ws.send(JSON.stringify({ type: "password_changed_success" }));
                } catch(e) {
                    ws.send(JSON.stringify({ type: "error", msg: "Database error updating password." }));
                }
            }

            else if (data.type === 'fetch_home_sidebars') {
                const target = data.target;
                try {
                    const friendsRes = await db.query(`
                        SELECT u.username, u.display_name, u.avatar 
                        FROM users u
                        JOIN friendships f ON (f.user_a = u.username OR f.user_b = u.username)
                        WHERE (f.user_a = $1 OR f.user_b = $1) 
                        AND f.status = 'accepted' 
                        AND u.username != $1
                        LIMIT 20
                    `, [target]);

                    // Make sure we only feed VISIBLE posts or posts by the user themselves in the sidebar feed
                    const feedRes = await db.query(`
                        SELECT p.id, p.title, p.image_url, p.created_at, 
                               u.username, u.display_name, u.avatar
                        FROM posts p
                        JOIN users u ON p.author_username = u.username
                        JOIN friendships f ON (f.user_a = p.author_username OR f.user_b = p.author_username)
                        WHERE (f.user_a = $1 OR f.user_b = $1)
                        AND f.status = 'accepted'
                        AND p.author_username != $1
                        AND p.is_visible = TRUE
                        ORDER BY p.created_at DESC
                        LIMIT 8
                    `, [target]);

                    ws.send(JSON.stringify({ 
                        type: "home_sidebars_data", 
                        friends: friendsRes.rows, 
                        feed: feedRes.rows 
                    }));

                } catch(e) { console.error("Sidebar Error:", e); }
            }
            
            else if (data.type === "create_post") {
                const s = clientsMap.get(ws);
                if (s) {
                    const postId = generateId();
                    let imageUrl = null;
                    if (data.image && data.image.startsWith('data:')) {
                        const m = data.image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
                        const fname = `post_${Date.now()}_${Math.floor(Math.random()*1000)}.png`;
                        try {
                            await fs.promises.writeFile(path.join(UPLOADS_DIR, fname), Buffer.from(m[2], 'base64'));
                            imageUrl = fname;
                        } catch (err) {}
                    }
                    const tags = data.tags || [];
                    const isVisible = data.isVisible !== false; // defaults to true
                    
                    await db.query(`INSERT INTO posts (id, author_username, title, content, summary, image_url, created_at, tags, is_visible) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                        [postId, s.user, escapeHtml(data.title), data.blocks, escapeHtml(data.summary), imageUrl, new Date(), tags, isVisible]);
                    ws.send(JSON.stringify({ type: "post_created", id: postId }));
                }
            }

            else if (data.type === "update_post") {
                const s = clientsMap.get(ws);
                if (s) {
                    const check = await db.query("SELECT author_username, image_url FROM posts WHERE id = $1", [data.id]);
                    if (check.rows.length > 0 && (check.rows[0].author_username === s.user || s.user === 'admin')) {
                        let imageUrl = check.rows[0].image_url;
                        
                        // Handle Cover Image updating
                        if (data.image === null) {
                            imageUrl = null;
                        } else if (data.image && data.image.startsWith('data:')) {
                            const m = data.image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
                            const fname = `post_${Date.now()}_${Math.floor(Math.random()*1000)}.png`;
                            try {
                                await fs.promises.writeFile(path.join(UPLOADS_DIR, fname), Buffer.from(m[2], 'base64'));
                                imageUrl = fname;
                            } catch (err) {}
                        } else if (data.image) {
                            imageUrl = data.image.replace('/uploads/', ''); 
                        }

                        const tags = data.tags || [];
                        const isVisible = data.isVisible !== false;
                        
                        await db.query(`UPDATE posts SET title = $1, content = $2, summary = $3, image_url = $4, tags = $5, is_visible = $6 WHERE id = $7`,
                            [escapeHtml(data.title), data.blocks, escapeHtml(data.summary), imageUrl, tags, isVisible, data.id]);
                        ws.send(JSON.stringify({ type: "post_updated", id: data.id }));
                    } else {
                        ws.send(JSON.stringify({ type: "error", msg: "Unauthorized" }));
                    }
                }
            }

            // --- NEW: FETCH USER POSTS FOR GALLERY BLOCK ---
            else if (data.type === "get_my_posts_for_gallery") {
                const s = clientsMap.get(ws);
                if (s) {
                    try {
                        const res = await db.query(`SELECT id, title, image_url FROM posts WHERE author_username = $1 ORDER BY created_at DESC`, [s.user]);
                        ws.send(JSON.stringify({ type: "my_posts_for_gallery", blockId: data.blockId, posts: res.rows }));
                    } catch(e) {}
                }
            }

            // --- NEW: FETCH LINKED POSTS FOR GALLERY VIEWING ---
            else if (data.type === "get_gallery_posts") {
                if (Array.isArray(data.ids) && data.ids.length > 0) {
                    try {
                        const placeholders = data.ids.map((_, i) => `$${i+1}`).join(',');
                        // Notice we don't filter by is_visible here because linking it gives them permission to view it within that gallery
                        const res = await db.query(`SELECT id, title, summary, image_url, created_at, tags, author_username FROM posts WHERE id IN (${placeholders})`, data.ids);
                        
                        const s = clientsMap.get(ws);
                        const enriched = await Promise.all(res.rows.map(async (p) => {
                            const likesRes = await db.query('SELECT COUNT(*) FROM post_likes WHERE post_id = $1', [p.id]);
                            let hasLiked = false;
                            if (s) {
                                const checkRes = await db.query('SELECT 1 FROM post_likes WHERE post_id = $1 AND liker_username = $2', [p.id, s.user]);
                                hasLiked = (checkRes.rowCount > 0);
                            }
                            return { ...p, likeCount: parseInt(likesRes.rows[0].count), hasLiked };
                        }));
                        ws.send(JSON.stringify({ type: "gallery_posts_data", blockId: data.blockId, posts: enriched }));
                    } catch(e) {}
                }
            }

            else if (data.type === "update_home_profile") {
                 const s = clientsMap.get(ws);
                if (s) {
                    let updates = []; let params = []; let idx = 1;
                    if (data.displayName !== undefined) { updates.push(`display_name = $${idx++}`); params.push(escapeHtml(data.displayName)); }
                    if (data.title !== undefined) { updates.push(`title = $${idx++}`); params.push(escapeHtml(data.title)); }
                    if (data.bio !== undefined) { updates.push(`bio = $${idx++}`); params.push(escapeHtml(data.bio)); }
                    if (data.isVisible !== undefined) { updates.push(`is_visible = $${idx++}`); params.push(data.isVisible); }
                    if (data.socialLinks) { updates.push(`social_links = $${idx++}`); params.push(JSON.stringify(data.socialLinks)); }
                    
                    if (data.musicUrl !== undefined) { 
                        updates.push(`music_url = $${idx++}`); 
                        params.push(data.musicUrl.trim()); 
                    }

                    if (data.image) {
                        const m = data.image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
                        if(m) {
                            const fname = `${s.user}_${Date.now()}.png`;
                            try { await fs.promises.writeFile(path.join(UPLOADS_DIR, fname), Buffer.from(m[2], 'base64')); } catch(e){}
                            updates.push(`avatar = $${idx++}`); params.push(fname); s.avatar = fname;
                        }
                    }
                    if (updates.length > 0) { params.push(s.user); await db.query(`UPDATE users SET ${updates.join(", ")} WHERE username = $${idx}`, params); }
                    const stats = await getProfileStats(s.user, s.user);
                    ws.send(JSON.stringify(stats));
                }
            }
            else if (data.type === "delete_post") {
                const s = clientsMap.get(ws);
                if (s) {
                    const res = await db.query("SELECT author_username FROM posts WHERE id = $1", [data.id]);
                    if (res.rows.length > 0) {
                        if (res.rows[0].author_username === s.user || s.user === 'admin') {
                            await db.query("DELETE FROM posts WHERE id = $1", [data.id]);
                            ws.send(JSON.stringify({ type: "delete_success" }));
                        } else {
                            ws.send(JSON.stringify({ type: "error", msg: "Unauthorized" }));
                        }
                    }
                }
            }
            else if (data.type === "toggle_post_like") {
                const s = clientsMap.get(ws);
                if (s) {
                    const check = await db.query(`SELECT 1 FROM post_likes WHERE liker_username = $1 AND post_id = $2`, [s.user, data.id]);
                    if (check.rowCount > 0) {
                        await db.query(`DELETE FROM post_likes WHERE liker_username = $1 AND post_id = $2`, [s.user, data.id]);
                    } else {
                        await db.query(`INSERT INTO post_likes (liker_username, post_id) VALUES ($1, $2)`, [s.user, data.id]);
                    }
                    const countRes = await db.query('SELECT COUNT(*) FROM post_likes WHERE post_id = $1', [data.id]);
                    const hasLiked = (check.rowCount === 0);
                    ws.send(JSON.stringify({ type: "post_like_update", id: data.id, count: parseInt(countRes.rows[0].count), hasLiked }));
                }
            }
            else if (data.type === "get_posts") {
                const s = clientsMap.get(ws);
                ws.send(JSON.stringify(await getPosts(data.targetUser, s ? s.user : null)));
            }
            else if (data.type === "get_post_details") {
                const s = clientsMap.get(ws);
                ws.send(JSON.stringify(await getPostById(data.id, s ? s.user : null)));
            }
            else if (data.type === "get_profile_data") {
                const requester = clientsMap.get(ws) ? clientsMap.get(ws).user : null;
                ws.send(JSON.stringify(await getProfileStats(data.targetUser, requester)));
                ws.send(JSON.stringify(await getPosts(data.targetUser, requester)));
            }
            else if (data.type === "toggle_like") {
                const s = clientsMap.get(ws);
                if (s) {
                    const target = data.targetUser;
                    const check = await db.query(`SELECT 1 FROM profile_likes WHERE liker_username = $1 AND target_username = $2`, [s.user, target]);
                    if (check.rowCount > 0) await db.query(`DELETE FROM profile_likes WHERE liker_username = $1 AND target_username = $2`, [s.user, target]);
                    else await db.query(`INSERT INTO profile_likes (liker_username, target_username) VALUES ($1, $2)`, [s.user, target]);
                    const stats = await getProfileStats(target, s.user);
                    ws.send(JSON.stringify(stats));
                }
            }
            else if (data.type === "login_token") {
                const res = await db.query('SELECT * FROM users WHERE session_token = $1', [data.token]);
                if (res.rows.length > 0) {
                    await performLogin(ws, res.rows[0].username, res.rows[0], data.token, data.source);
                }
                else ws.send(JSON.stringify({ type: "token_invalid" }));
            }
            else if (data.type === "mark_read") {
                const senderData = clientsMap.get(ws);
                if (senderData) await db.query(`UPDATE users SET last_read = last_read || jsonb_build_object($1::text, $2::text) WHERE username = $3`, [data.target, now.toISOString(), senderData.user]);
            }
            else if (data.type === "delete_msg") {
                const senderData = clientsMap.get(ws);
                if (senderData && senderData.user === "admin") {
                    await db.query('DELETE FROM messages WHERE id = $1', [data.id]);
                    const deleteNotification = JSON.stringify({ type: "message_deleted", id: data.id, target: data.target });
                    if (data.target === "general") broadcast(JSON.parse(deleteNotification));
                    else {
                        ws.send(deleteNotification); 
                        for (let [client, cData] of clientsMap.entries()) {
                            if (cData.user === data.target && client.readyState === WebSocket.OPEN) client.send(deleteNotification);
                        }
                    }
                }
            }
            else if (data.type === "close_chat") {
                const s = clientsMap.get(ws);
                if (s) {
                    const res = await db.query('SELECT open_chats FROM users WHERE username=$1', [s.user]);
                    let chats = res.rows[0].open_chats || [];
                    chats = chats.filter(c => c !== data.target);
                    await db.query('UPDATE users SET open_chats = $1 WHERE username = $2', [JSON.stringify(chats), s.user]);
                }
            }
            else if (data.type === "load_history_chunk") {
                const messages = await fetchAndFormatHistory(data.target, clientsMap.get(ws).user, data.offset || 0);
                ws.send(JSON.stringify({ type: "history_chunk", target: data.target, messages: messages }));
            }
            else if (data.type === "get_private_history") {
                const messages = await fetchAndFormatHistory(data.withUser, clientsMap.get(ws).user);
                ws.send(JSON.stringify({ type: "private_history_init", target: data.withUser, messages: messages }));
            }
            else if (data.type === "msg") {
                const senderData = clientsMap.get(ws);
                if (senderData) {
                    const safeMsg = escapeHtml(data.msg || "");
                    let imageUrl = null;
                    if (data.imageData) {
                        const matches = data.imageData.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
                        if (matches && matches.length === 3) {
                            const buffer = Buffer.from(matches[2], 'base64');
                            if (buffer.length <= 2 * 1024 * 1024) {
                                const filename = `chat_${Date.now()}_${Math.floor(Math.random()*1000)}.png`;
                                fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
                                imageUrl = filename;
                            }
                        }
                    }
                    if (safeMsg || imageUrl) {
                        const replyJson = data.replyTo ? JSON.stringify(data.replyTo) : null;
                        const target = data.target || 'general';
                        const msgId = generateId();
                        await db.query(`INSERT INTO messages (id, type, sender_username, target_username, content, image_url, reply_to_json) VALUES ($1, 'msg', $2, $3, $4, $5, $6)`, [msgId, senderData.user, target, safeMsg, imageUrl, replyJson]);
                        const msgObj = { id: msgId, type: "msg", user: senderData.user, color: senderData.color, avatar: senderData.avatar, msg: safeMsg, target: target, image: imageUrl, replyTo: data.replyTo, fullDate: now.toISOString(), time: formatTime(now) };
                        const jsonToSend = JSON.stringify(msgObj);
                        if (target === "general") broadcast(msgObj);
                        else {
                            const friendCheck = await db.query(`SELECT 1 FROM friendships WHERE ((user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)) AND status = 'accepted'`, [senderData.user, target]);
                            if (friendCheck.rowCount === 0) return ws.send(JSON.stringify({type: "error", msg: "Not friends."}));
                            const updateChatList = async (u, other) => {
                                const r = await db.query('SELECT open_chats FROM users WHERE username=$1', [u]);
                                let list = r.rows[0].open_chats || [];
                                if (!list.includes(other)) { list.push(other); await db.query('UPDATE users SET open_chats=$1 WHERE username=$2', [JSON.stringify(list), u]); }
                            };
                            await updateChatList(senderData.user, target);
                            await updateChatList(target, senderData.user);
                            await db.query(`UPDATE users SET last_read = last_read || jsonb_build_object($1::text, $2::text) WHERE username = $3`, [target, now.toISOString(), senderData.user]);
                            ws.send(jsonToSend);
                            let targetOnline = false;
                            for (let [client, cData] of clientsMap.entries()) {
                                if (cData.user === target && client.readyState === WebSocket.OPEN) { client.send(jsonToSend); targetOnline = true; }
                            }
                            if (!targetOnline) sendOfflineNotification(target, senderData.user, safeMsg);
                        }
                    }
                }
            }
            else if (data.type === "send_request") {
                const s = clientsMap.get(ws);
                try {
                    await db.query(`INSERT INTO friendships (user_a, user_b, status) VALUES ($1, $2, 'pending')`, [s.user, data.targetUser]);
                    ws.send(JSON.stringify(await getSocialData(s.user)));
                    for (let [c, cData] of clientsMap.entries()) { if (cData.user === data.targetUser) c.send(JSON.stringify(await getSocialData(data.targetUser))); }
                } catch(e) {}
            }
            else if (data.type === "accept_request") {
                const s = clientsMap.get(ws);
                await db.query(`UPDATE friendships SET status='accepted' WHERE user_b=$1 AND user_a=$2`, [s.user, data.targetUser]);
                ws.send(JSON.stringify(await getSocialData(s.user)));
                for (let [c, cData] of clientsMap.entries()) { if (cData.user === data.targetUser) c.send(JSON.stringify(await getSocialData(data.targetUser))); }
            }
            else if (data.type === "deny_request" || data.type === "cancel_request") {
                const s = clientsMap.get(ws);
                await db.query(`DELETE FROM friendships WHERE ((user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)) AND status = 'pending'`, [s.user, data.targetUser]);
                ws.send(JSON.stringify(await getSocialData(s.user)));
                for (let [c, cData] of clientsMap.entries()) { if (cData.user === data.targetUser) c.send(JSON.stringify(await getSocialData(data.targetUser))); }
            }
            else if (data.type === "remove_friend") {
                const s = clientsMap.get(ws);
                await db.query(`DELETE FROM friendships WHERE ((user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)) AND status = 'accepted'`, [s.user, data.targetUser]);
                ws.send(JSON.stringify(await getSocialData(s.user)));
                for (let [c, cData] of clientsMap.entries()) { if (cData.user === data.targetUser) c.send(JSON.stringify(await getSocialData(data.targetUser))); }
            }
        } catch(e) { console.error("Error:", e); }
    });

    ws.on("close", () => {
        const u = clientsMap.get(ws);
        if(u) {
            clientsMap.delete(ws);
            if(u.source === 'chat' && getActiveChatConnectionCount(u.user) === 0) {
                const timer = setTimeout(async () => {
                    if (getActiveChatConnectionCount(u.user) === 0 && !SILENT_USERS.includes(u.user)) {
                        const now = new Date();
                        broadcast({ type: "leave", user: u.user, color: u.color, msg: "left...", avatar: u.avatar, time: formatTime(now) });
                        await db.query(`INSERT INTO messages (id, type, sender_username, target_username, content, created_at) VALUES ($1, $2, $3, 'general', $4, $5)`, [generateId(), 'leave', u.user, 'left...', now]);
                    }
                    pendingLeaves.delete(u.user);
                }, 5000);
                pendingLeaves.set(u.user, timer);
            }
            broadcastUserList();
        }
    });
});

server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));