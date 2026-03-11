let ws;
let currentUser = null;
let currentColor = "#ffffff";
let currentAvatar = null; 
let currentEmail = "";
let allowFriends = true;
let lastDateRendered = null;

// --- TAB SYSTEM DATA ---
let activeTab = "general"; 
let openTabs = ["general"]; 
let chatHistory = { "general": [] };
let lastReadMap = {}; 
let currentReply = null; 
let mutedTabs = JSON.parse(localStorage.getItem("muted_tabs") || "[]");

// --- LISTS DATA ---
let onlineUsersList = [];
let myFriendsList = [];
let requestsIn = [];
let requestsOut = [];

// --- WEBRTC (VOICE CALL) VARIABLES ---
let rtcPeerConnection = null;
let localAudioStream = null;
let activeCallTarget = null;
let inCall = false;
let pendingOffer = null;
const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// --- SOUNDS ---
let recieveSound = new Audio("/sounds/recieve.mp3");
let sendSound = new Audio("/sounds/send.mp3");
let joinSound = new Audio("/sounds/join.mp3");
let leaveSound = new Audio("/sounds/leave.mp3");
recieveSound.volume = 0.6; sendSound.volume = 0.4; joinSound.volume = 0.5; leaveSound.volume = 0.5;

function connectWS() {
    const savedToken = localStorage.getItem("chat_token");
    if (!savedToken) {
        window.location.href = "/login?redirect=/chat";
        return;
    }

    const host = window.location.hostname; 
    ws = new WebSocket("wss://" + host + "/chatws");

    ws.onopen = () => {
        console.log("Connected.");
        ws.send(JSON.stringify({ type: "login_token", token: savedToken, source: 'chat' }));
    };
    
    ws.onclose = () => setTimeout(connectWS, 3000);

    ws.onmessage = (e) => {
        try {
            let data = JSON.parse(e.data);

            if (data.type === "error") alert("Error: " + data.msg);
            else if (data.type === "info") console.log(data.msg);
            
            else if (data.type === "token_invalid") {
                localStorage.removeItem("chat_token");
                window.location.href = "/login?redirect=/chat";
            }

            else if (data.type === "login_success") {
                currentUser = data.user;
                currentColor = data.color;
                currentAvatar = data.avatar; 
                currentEmail = data.email || ""; 
                allowFriends = data.allowFriends;
                lastReadMap = data.lastRead || {}; 
                
                if (data.token) localStorage.setItem("chat_token", data.token);

                updateHeaderProfileUI();

                if (data.openChats && Array.isArray(data.openChats)) {
                    data.openChats.forEach(name => {
                        if (!openTabs.includes(name)) {
                            openTabs.push(name);
                            if (!chatHistory[name]) {
                                chatHistory[name] = [];
                                ws.send(JSON.stringify({type: "get_private_history", withUser: name}));
                            }
                        }
                    });
                }
                renderTabs();
            }
            
            else if (data.type === "profile_updated") {
                alert(data.msg);
                currentColor = data.color;
                currentAvatar = data.avatar;
                allowFriends = data.allowFriends;
                currentEmail = data.email || "";
                
                updateHeaderProfileUI();
                closeProfileModal(); 
            }
            else if (data.type === "history_chunk") handleHistoryChunk(data);
            else if (data.type === "general_history_init") {
                const parsedMsgs = data.messages.map(m => typeof m === 'string' ? JSON.parse(m) : m);
                chatHistory["general"] = parsedMsgs;
                if (activeTab === "general") { renderCurrentChat(); scrollToBottom(); }
            }
            else if (data.type === "private_history_init") {
                const parsedMsgs = data.messages.map(m => typeof m === 'string' ? JSON.parse(m) : m);
                chatHistory[data.target] = parsedMsgs; 
                if (parsedMsgs.length > 0) {
                    const lastMsg = parsedMsgs[parsedMsgs.length - 1];
                    const lastReadTime = lastReadMap[data.target] ? new Date(lastReadMap[data.target]) : new Date(0);
                    const lastMsgTime = new Date(lastMsg.fullDate);
                    if (lastMsg.user !== currentUser && lastMsgTime > lastReadTime && activeTab !== data.target) {
                        document.querySelectorAll(".tab").forEach(el => { if(el.innerText.includes(data.target)) el.classList.add("unread"); });
                    }
                }
                if (activeTab === data.target) { renderCurrentChat(); scrollToBottom(); }
            }
            else if (data.type === "userList") { onlineUsersList = data.users; renderLists(); }
            else if (data.type === "social_update") { myFriendsList = data.friends; requestsIn = data.requests_in; requestsOut = data.requests_out; renderLists(); }
            else if (["join", "leave", "msg"].includes(data.type)) { if(currentUser) handleIncomingMessage(data); }
            else if (data.type === "message_deleted") {
                const el = document.getElementById("msg-" + data.id);
                if (el) { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }
            }
            else if (data.type === "email_verification_required") {
                const code = prompt("We sent a code to your new email. Please enter it to confirm change:");
                if (code) {
                    ws.send(JSON.stringify({ type: "verify_email_change", code: code }));
                }
            }
            // --- WEBRTC EVENT HANDLERS ---
            else if (data.type === "call_invite") {
                if (inCall) return; // Busy
                activeCallTarget = data.user;
                updateCallBannerVisibility();
                updateCallBannerUI();
                document.getElementById("callStatusText").innerHTML = `<b>${data.user}</b> opened a voice channel...`;
            }
            else if (data.type === "rtc_offer") {
                handleRTCOffer(data);
            }
            else if (data.type === "rtc_answer") {
                handleRTCAnswer(data);
            }
            else if (data.type === "rtc_ice") {
                handleRTCIce(data);
            }
            else if (data.type === "call_leave") {
                if (activeCallTarget === data.user) {
                    if (inCall) {
                        leaveCall(false); 
                        alert(`Voice channel closed. ${data.user} left.`);
                    }
                    pendingOffer = null;
                    updateCallBannerUI();
                    document.getElementById("callStatusText").innerHTML = `<b>${data.user}</b> left the channel.`;
                }
            }

        } catch (err) { console.error(err); }
    };
}
connectWS();

// --- WEBRTC (VOICE CALL) FUNCTIONS ---

function openPrivateCall(targetUser) {
    closeAllDropdowns();
    openPrivateChat(targetUser); 
    activeCallTarget = targetUser;
    updateCallBannerVisibility();
    updateCallBannerUI();
    ws.send(JSON.stringify({ type: "call_invite", target: targetUser }));
}

function updateCallBannerVisibility() {
    const banner = document.getElementById("callBanner");
    if (activeCallTarget && (activeTab === activeCallTarget || inCall)) {
        banner.style.display = "flex";
    } else {
        banner.style.display = "none";
    }
}

function updateCallBannerUI() {
    const banner = document.getElementById("callBanner");
    if (!activeCallTarget) {
        banner.style.display = "none";
        return;
    }
    document.getElementById("callTargetName").innerText = activeCallTarget;

    if (inCall) {
        document.getElementById("callStatusText").innerHTML = `In voice channel with <b>${activeCallTarget}</b>`;
        document.getElementById("joinCallBtn").style.display = "none";
        document.getElementById("leaveCallBtn").style.display = "flex";
        document.getElementById("closeCallBtn").style.display = "none";
        banner.style.borderColor = "#03dac6";
    } else {
        document.getElementById("callStatusText").innerHTML = `Voice channel with <b>${activeCallTarget}</b>`;
        document.getElementById("joinCallBtn").style.display = "flex";
        document.getElementById("leaveCallBtn").style.display = "none";
        document.getElementById("closeCallBtn").style.display = "flex";
        banner.style.borderColor = "#bb86fc";
    }
}

async function joinCall() {
    try {
        // Need HTTPS for this to work typically!
        localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
        alert("Microphone access denied or unavailable."); 
        return;
    }
    
    inCall = true;
    updateCallBannerUI();
    createPeerConnection();

    if (pendingOffer) {
        await rtcPeerConnection.setRemoteDescription(new RTCSessionDescription(pendingOffer));
        const answer = await rtcPeerConnection.createAnswer();
        await rtcPeerConnection.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: "rtc_answer", target: activeCallTarget, answer: answer }));
        pendingOffer = null;
    } else {
        const offer = await rtcPeerConnection.createOffer();
        await rtcPeerConnection.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: "rtc_offer", target: activeCallTarget, offer: offer }));
    }
}

function createPeerConnection() {
    if (rtcPeerConnection) rtcPeerConnection.close();
    rtcPeerConnection = new RTCPeerConnection(rtcConfig);

    localAudioStream.getTracks().forEach(track => rtcPeerConnection.addTrack(track, localAudioStream));

    rtcPeerConnection.onicecandidate = event => {
        if (event.candidate) {
            ws.send(JSON.stringify({ type: "rtc_ice", target: activeCallTarget, candidate: event.candidate }));
        }
    };

    rtcPeerConnection.ontrack = event => {
        document.getElementById("remoteAudio").srcObject = event.streams[0];
    };
}

async function handleRTCOffer(data) {
    if (data.user !== activeCallTarget) {
        activeCallTarget = data.user;
        updateCallBannerVisibility();
    }

    if (!inCall) {
        pendingOffer = data.offer;
        updateCallBannerUI();
        document.getElementById("callStatusText").innerHTML = `<b>${data.user}</b> joined the voice channel!`;
    } else {
        const isPolite = currentUser > data.user;
        if (rtcPeerConnection.signalingState !== "stable" && !isPolite) {
            return; // Ignore collision
        }
        await rtcPeerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await rtcPeerConnection.createAnswer();
        await rtcPeerConnection.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: "rtc_answer", target: activeCallTarget, answer: answer }));
    }
}

async function handleRTCAnswer(data) {
    if (!rtcPeerConnection) return;
    await rtcPeerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
}

async function handleRTCIce(data) {
    if (!rtcPeerConnection) return;
    try {
        await rtcPeerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (e) { console.error("Error adding ice candidate"); }
}

function leaveCall(broadcast = true) {
    if (localAudioStream) localAudioStream.getTracks().forEach(t => t.stop());
    if (rtcPeerConnection) rtcPeerConnection.close();
    
    rtcPeerConnection = null;
    localAudioStream = null;
    inCall = false;
    pendingOffer = null;

    if (broadcast && activeCallTarget) {
        ws.send(JSON.stringify({ type: "call_leave", target: activeCallTarget }));
    }

    updateCallBannerUI();
    document.getElementById("remoteAudio").srcObject = null;
}

function closeCallBanner() {
    if (inCall) leaveCall(true);
    activeCallTarget = null;
    updateCallBannerVisibility();
}


// --- HEADER PROFILE UI FUNCTIONS ---
function updateHeaderProfileUI() {
    const box = document.getElementById("headerProfileBtn");
    if(!box) return;
    let avatarSrc = currentAvatar ? `/uploads/${currentAvatar}` : `https://ui-avatars.com/api/?name=${currentUser}&background=121212&color=bb86fc`;
    box.innerHTML = `<img src="${avatarSrc}" class="header-mini-avatar" onerror="this.src='https://ui-avatars.com/api/?name=${currentUser}&background=121212&color=bb86fc'"><span class="header-username">${currentUser}</span>`;
}
function goToMyHome() { if(currentUser) window.location.href = `/?u=${currentUser}`; }

// --- SCROLL & NEW MSG HELPERS ---
function scrollToBottom() {
    const chat = document.getElementById("chat");
    chat.scrollTop = chat.scrollHeight;
    document.getElementById("newMsgBtn").style.display = "none";
}
function isNearBottom() {
    const chat = document.getElementById("chat");
    return chat.scrollHeight - chat.scrollTop <= chat.clientHeight + 150;
}
function checkScroll() { if (isNearBottom()) document.getElementById("newMsgBtn").style.display = "none"; }
document.getElementById("chat").addEventListener("scroll", checkScroll);

// --- IMAGE MODAL ---
function openImageModal(src) {
    const modal = document.getElementById("imageModal");
    const img = document.getElementById("fullImage");
    const dlBtn = document.getElementById("downloadBtn");
    img.src = src; dlBtn.href = src; dlBtn.download = "chat_image.png"; 
    modal.style.display = "flex";
}
function closeImageModal() { document.getElementById("imageModal").style.display = "none"; }

function switchTab(tabName) {
    activeTab = tabName;
    lastDateRendered = null; 
    cancelReply(); 
    
    if (tabName !== "general") {
        ws.send(JSON.stringify({ type: "mark_read", target: tabName }));
        lastReadMap[tabName] = new Date().toISOString(); 
    }

    document.querySelectorAll(".tab").forEach(el => {
        if(el.innerText.includes(tabName === "general" ? "General" : tabName)) el.classList.remove("unread");
    });

    if (!openTabs.includes(tabName)) {
        openTabs.push(tabName);
        if (!chatHistory[tabName]) {
            chatHistory[tabName] = [];
            ws.send(JSON.stringify({type: "get_private_history", withUser: tabName}));
        }
    }

    renderTabs();         
    renderCurrentChat();
    updateCallBannerVisibility(); // Added Call Banner Sync
    
    scrollToBottom();
    setTimeout(scrollToBottom, 100); 
    setTimeout(scrollToBottom, 400); 
}

function closeTab(e, tabName) {
    e.stopPropagation(); 
    if (tabName === "general") return; 
    ws.send(JSON.stringify({ type: "close_chat", target: tabName }));
    openTabs = openTabs.filter(t => t !== tabName);
    if (activeTab === tabName) switchTab("general");
    else renderTabs();
}

function updateCallBannerUI() {
    const banner = document.getElementById("callBanner");
    if (!activeCallTarget) {
        banner.style.display = "none";
        return;
    }

    if (inCall) {
        document.getElementById("callStatusText").innerHTML = `In voice channel with <b>${activeCallTarget}</b>`;
        document.getElementById("joinCallBtn").style.display = "none";
        document.getElementById("leaveCallBtn").style.display = "flex";
        document.getElementById("closeCallBtn").style.display = "none";
        banner.style.borderColor = "#03dac6";
    } else {
        document.getElementById("callStatusText").innerHTML = `Voice channel with <b>${activeCallTarget}</b>`;
        document.getElementById("joinCallBtn").style.display = "flex";
        document.getElementById("leaveCallBtn").style.display = "none";
        document.getElementById("closeCallBtn").style.display = "flex";
        banner.style.borderColor = "#bb86fc";
    }
}

// --- ADDED: Mute Toggle ---
function toggleMute(e, tabName) {
    e.stopPropagation();
    if (mutedTabs.includes(tabName)) { mutedTabs = mutedTabs.filter(t => t !== tabName); } 
    else { mutedTabs.push(tabName); }
    localStorage.setItem("muted_tabs", JSON.stringify(mutedTabs));
    renderTabs();
}

function renderTabs() {
    const container = document.getElementById("tabsContainer");
    const currentUnreads = [];
    document.querySelectorAll(".tab.unread").forEach(t => currentUnreads.push(t.innerText.replace("✕","").trim()));

    container.innerHTML = "";
    openTabs.forEach(name => {
        const div = document.createElement("div");
        div.className = `tab ${name === activeTab ? 'active' : ''}`;
        if (name !== activeTab && currentUnreads.includes(name === "general" ? "General" : name)) div.classList.add("unread");
        div.onclick = () => switchTab(name);
        
        const span = document.createElement("span");
        span.innerText = name === "general" ? "General" : name;
        div.appendChild(span);

        const actionsDiv = document.createElement("div");
        actionsDiv.className = "tab-actions";

        const isMuted = mutedTabs.includes(name);
        const muteBtn = document.createElement("button");
        muteBtn.className = `tab-mute ${isMuted ? 'muted' : ''}`;
        muteBtn.innerHTML = isMuted ? "🔕" : "🔔";
        muteBtn.onclick = (e) => toggleMute(e, name);
        actionsDiv.appendChild(muteBtn);

        if (name !== "general") {
            const closeBtn = document.createElement("button");
            closeBtn.className = "tab-close";
            closeBtn.innerHTML = "✕";
            closeBtn.onclick = (e) => closeTab(e, name);
            actionsDiv.appendChild(closeBtn);
        }
        div.appendChild(actionsDiv); container.appendChild(div);
    });
}

function handleIncomingMessage(data) {
    let context = "general";
    if (data.type === "join" || data.type === "leave") context = "general";
    else if (data.type === "msg") {
        if (data.target === "general" || !data.target) context = "general";
        else context = (data.user === currentUser) ? data.target : data.user; 
    }

    if (!chatHistory[context]) chatHistory[context] = [];
    chatHistory[context].push(data);

    if (context === activeTab) {
        const shouldScroll = isNearBottom();
        renderSingleMessage(data, true); 
        if (shouldScroll) scrollToBottom();
        else document.getElementById("newMsgBtn").style.display = "block";
        
        if (context !== "general") {
            ws.send(JSON.stringify({ type: "mark_read", target: context }));
            lastReadMap[context] = new Date().toISOString();
        }
        playSounds(data);
    } else {
        if (context !== "general" && !openTabs.includes(context)) { openTabs.push(context); renderTabs(); }
        setTimeout(() => { document.querySelectorAll(".tab").forEach(t => { if(t.innerText.includes(context === "general" ? "General" : context)) t.classList.add("unread"); }); }, 50);
        playSounds(data);
    }
}

function requestLoadMore() {
    const currentCount = chatHistory[activeTab].length;
    ws.send(JSON.stringify({ type: "load_history_chunk", target: activeTab, offset: currentCount }));
}

function handleHistoryChunk(data) {
    if (data.messages && data.messages.length > 0) {
        const parsedMsgs = data.messages.map(m => typeof m === 'string' ? JSON.parse(m) : m);
        chatHistory[data.target] = parsedMsgs.concat(chatHistory[data.target]);
        
        if (activeTab === data.target) {
            const chatDiv = document.getElementById("chat");
            const oldHeight = chatDiv.scrollHeight;
            const oldScroll = chatDiv.scrollTop;
            renderCurrentChat();
            const newHeight = chatDiv.scrollHeight;
            chatDiv.scrollTop = newHeight - oldHeight + oldScroll;
        }
    } else {
        const btn = document.getElementById("loadMoreBtn");
        if(btn) { btn.innerText = "No more messages"; btn.disabled = true; btn.style.opacity = "0.5"; }
    }
}

function renderCurrentChat() {
    const chatDiv = document.getElementById("chat");
    chatDiv.innerHTML = "";
    const loadBtn = document.createElement("button");
    loadBtn.id = "loadMoreBtn"; loadBtn.className = "load-more-btn"; loadBtn.innerText = "Load Previous"; loadBtn.onclick = requestLoadMore;
    chatDiv.appendChild(loadBtn);

    const messages = chatHistory[activeTab] || [];
    messages.forEach(msg => renderSingleMessage(msg, false)); 
}

function toggleMsgOptions(msgId) {
    document.querySelectorAll('.msg-options-menu').forEach(el => { if(el.id !== `opts-${msgId}`) el.style.display = 'none'; });
    const menu = document.getElementById(`opts-${msgId}`);
    if (menu) {
        if (menu.style.display === 'block') menu.style.display = 'none';
        else {
            menu.style.top = "20px"; menu.style.bottom = "auto"; menu.style.display = 'block';
            const rect = menu.getBoundingClientRect();
            if (rect.bottom > window.innerHeight - 20) { menu.style.top = "auto"; menu.style.bottom = "20px"; }
        }
    }
}

function copyMsgText(text) { navigator.clipboard.writeText(text); closeAllDropdowns(); }
function deleteMsg(id, target) { if(confirm("Delete this message?")) { ws.send(JSON.stringify({ type: "delete_msg", id: id, target: target })); closeAllDropdowns(); } }

function startReply(msgId, user, text) {
    closeAllDropdowns();
    currentReply = { id: msgId, user: user, text: text };
    document.getElementById("replyPreview").innerHTML = `<strong>Replying to ${user}:</strong> ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`;
    document.getElementById("replyBar").style.display = "flex";
    document.getElementById("msg").focus();
}
function cancelReply() { currentReply = null; document.getElementById("replyBar").style.display = "none"; }

function scrollToMessage(msgId) {
    const el = document.getElementById(`msg-${msgId}`);
    if (el) {
        el.scrollIntoView({behavior: 'smooth', block: 'center'});
        el.style.background = "rgba(187, 134, 252, 0.2)";
        setTimeout(() => el.style.background = "", 1000);
    }
}

function renderSingleMessage(data, animate = false) {
    let chat = document.getElementById("chat");
    let div = document.createElement("div");
    if (animate) div.className = "msg-animate"; 
    if (data.id) div.id = `msg-${data.id}`;

    let avatarHtml = getAvatarHTML(data);
    const clickAttr = `onclick="openUserMenu('${data.user}', this); event.stopPropagation();" class="clickable-wrapper" style="cursor:pointer"`;

    if (data.type === 'join') {
        div.className = "system-msg join";
        div.innerHTML = `➔ <span ${clickAttr}>${avatarHtml} <b style="color:${data.color}">${data.user}</b></span> ${data.msg}`;
    } else if (data.type === 'leave') {
        div.className = "system-msg leave";
        div.innerHTML = `← <span ${clickAttr}>${avatarHtml} <b style="color:${data.color}">${data.user}</b></span> ${data.msg}`;
    } else {
        div.className += " message-line";
        if (data.replyTo) div.className += " has-reply";
        div.setAttribute("onclick", `if(window.innerWidth < 768) this.classList.toggle('tapped');`);
        if (data.target && data.target !== "general") { div.style.background = "rgba(187, 134, 252, 0.05)"; div.style.borderRadius = "4px"; }
        
        let replyHtml = "";
        if (data.replyTo) replyHtml = `<div class="reply-context" onclick="scrollToMessage('${data.replyTo.id}'); event.stopPropagation();"><span class="reply-line"></span><span class="reply-label">Replying to ${data.replyTo.user}:</span><span class="reply-snippet">${data.replyTo.msg.substring(0, 40)}...</span></div>`;

        let contentHtml = ""; let rawText = "";
        if (data.msg) {
            let safeMsg = data.msg.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            rawText = safeMsg; contentHtml += `<span class="text">${safeMsg}</span>`;
        }
        if (data.image) {
            const scrollScript = `onload="if(isNearBottom()) scrollToBottom()"`;
            contentHtml += `<br><img src="/uploads/${data.image}" class="chat-image" ${scrollScript} onclick="openImageModal('/uploads/${data.image}')">`;
            if (!rawText) rawText = "[Image]";
        }

        let deleteOption = "";
        if (currentUser === "admin") deleteOption = `<div onclick="deleteMsg('${data.id}', '${activeTab}');" style="color:#cf6679">Delete Message</div>`;

        const safeRawText = rawText.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\n/g, '\\n');
        const optionsHtml = `
            <div class="msg-options-btn" onclick="toggleMsgOptions('${data.id}'); event.stopPropagation();">⋮</div>
            <div class="msg-options-menu" id="opts-${data.id}">
                <div onclick="openUserMenu('${data.user}', this.parentElement)">Profile</div>
                <div onclick="copyMsgText('${safeRawText}')">Copy Text</div>
                <div onclick="startReply('${data.id}', '${data.user}', '${safeRawText}')">Reply</div>
                ${deleteOption}
            </div>
        `;

        div.innerHTML = `${replyHtml}<div class="msg-main-body"><span class="time">[${data.time}]</span><div class="msg-avatar-wrapper" ${clickAttr}>${avatarHtml}</div><div class="msg-content-block"><span class="username" style="color: ${data.color}" ${clickAttr}>${data.user}:</span>${contentHtml}</div>${optionsHtml}</div>`;
    }
    chat.appendChild(div);
}

function openPrivateChat(targetUser) {
    if (targetUser === currentUser) return alert("Cannot chat with yourself.");
    const isFriend = myFriendsList.some(f => f.user === targetUser);
    if (!isFriend) return alert("You must be friends to send private messages.");
    switchTab(targetUser);
    document.getElementById("mySidebar").classList.remove("active");
    document.getElementById("sidebarOverlay").classList.remove("active");
}

function send() {
    let msgInput = document.getElementById("msg");
    let msg = msgInput.value;
    if (msg.trim() === "") return;
    if (!mutedTabs.includes(activeTab)) { sendSound.currentTime = 0; sendSound.play().catch(()=>{}); }
    const payload = { type: "msg", msg: msg, target: activeTab };
    if (currentReply) { payload.replyTo = { id: currentReply.id, user: currentReply.user, msg: currentReply.text }; cancelReply(); }
    ws.send(JSON.stringify(payload));
    msgInput.value = ""; msgInput.focus();
}

function triggerImageUpload() { document.getElementById("chatImgInput").click(); }

async function sendImage(inputElement) {
    const file = inputElement.files[0];
    if (!file) return;
    if (file.type === 'image/gif') {
        if (file.size > 2 * 1024 * 1024) { alert("GIF too large (Max 2MB). Compression skipped."); inputElement.value = ""; return; }
        const reader = new FileReader();
        reader.onload = function(e) {
            const base64 = e.target.result; let msgInput = document.getElementById("msg");
            ws.send(JSON.stringify({ type: "msg", msg: msgInput.value, imageData: base64, target: activeTab }));
            msgInput.value = ""; inputElement.value = ""; 
            if (!mutedTabs.includes(activeTab)) { sendSound.currentTime = 0; sendSound.play().catch(()=>{}); }
        };
        reader.readAsDataURL(file);
        return;
    }
    const options = { maxSizeMB: 1, maxWidthOrHeight: 1920, useWebWorker: true };
    try {
        const compressedFile = await imageCompression(file, options);
        const reader = new FileReader();
        reader.onload = function(e) {
            const base64 = e.target.result; let msgInput = document.getElementById("msg");
            ws.send(JSON.stringify({ type: "msg", msg: msgInput.value, imageData: base64, target: activeTab }));
            msgInput.value = ""; inputElement.value = ""; 
            if (!mutedTabs.includes(activeTab)) { sendSound.currentTime = 0; sendSound.play().catch(()=>{}); }
        };
        reader.readAsDataURL(compressedFile);
    } catch (error) { alert("Image processing failed."); }
}

function doLogout() { localStorage.removeItem("chat_token"); window.location.href = "/login"; }

function saveProfile() {
    const newColor = document.getElementById("editColor").value;
    const allow = document.getElementById("allowFriends").checked;
    const newEmail = document.getElementById("editEmail").value; 
    const fileInput = document.getElementById("editAvatar");
    const file = fileInput.files[0];
    let payload = { type: "update_profile", newColor: newColor, allowFriends: allow, email: newEmail };

    if (file) {
        const options = { maxSizeMB: 0.5, maxWidthOrHeight: 500, useWebWorker: true };
        imageCompression(file, options).then(compressedFile => {
             const reader = new FileReader();
             reader.onload = function(e) { payload.image = e.target.result; ws.send(JSON.stringify(payload)); };
             reader.readAsDataURL(compressedFile);
        }).catch(e => { alert("File error"); });
    } else { ws.send(JSON.stringify(payload)); }
}

function openProfileModal() {
    document.getElementById("editColor").value = currentColor; document.getElementById("allowFriends").checked = allowFriends; document.getElementById("editEmail").value = currentEmail; 
    document.getElementById("profileModal").style.display = "flex";
}
function closeProfileModal() { document.getElementById("profileModal").style.display = "none"; }
function toggleSidebar() {
    const sidebar = document.getElementById("mySidebar"); const overlay = document.getElementById("sidebarOverlay");
    if (sidebar.classList.contains("active")) { sidebar.classList.remove("active"); overlay.classList.remove("active"); } 
    else { sidebar.classList.add("active"); overlay.classList.add("active"); }
}
function closeAllDropdowns() { 
    document.querySelectorAll('.user-dropdown').forEach(el => el.remove()); 
    document.querySelectorAll('.msg-options-menu').forEach(el => el.style.display = 'none');
}
function playSounds(data) {
    if (data.type === "join") joinSound.play().catch(()=>{});
    else if (data.type === "leave") leaveSound.play().catch(()=>{});
    else if (data.type === "msg" && data.user !== currentUser) { recieveSound.play().catch(()=>{}); }
}
function getAvatarHTML(userObj) {
    if (userObj.avatar) { return `<img src="/uploads/${userObj.avatar}" class="avatar-img" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-block'"><span class="avatar-dot fallback" style="background:${userObj.color}; display:none;"></span>`; } 
    else { return `<span class="avatar-dot" style="background:${userObj.color}"></span>`; }
}

function openUserMenu(targetUser, eventElement) {
    closeAllDropdowns();
    if (targetUser === currentUser) return;
    const isFriend = myFriendsList.some(f => f.user === targetUser);
    const isReqSent = requestsOut.some(r => r.user === targetUser);
    const isReqReceived = requestsIn.some(r => r.user === targetUser);
    let avatar = null; let color = "#ffffff";
    const online = onlineUsersList.find(u => u.user === targetUser);
    const friend = myFriendsList.find(f => f.user === targetUser);
    if (online) { avatar = online.avatar; color = online.color; }
    else if (friend) { avatar = friend.avatar; color = friend.color; }
    let avatarHtml = avatar ? `<img src="/uploads/${avatar}" class="popup-avatar">` : `<div class="popup-avatar-placeholder" style="background:${color}"></div>`;

    let actionsHtml = "";
    if (isFriend) {
        actionsHtml += `<button class="dropdown-action" onclick="openPrivateChat('${targetUser}')">Open Private Chat</button>`;
        actionsHtml += `<button class="dropdown-action" style="color:#bb86fc;" onclick="openPrivateCall('${targetUser}')">Open Voice Channel</button>`;
        actionsHtml += `<button class="dropdown-action remove" onclick="removeFriend('${targetUser}')">Remove Friend</button>`;
    } else if (isReqReceived) {
        actionsHtml += `<button class="dropdown-action add" onclick="acceptRequest('${targetUser}')">Accept Request</button>`;
        actionsHtml += `<button class="dropdown-action remove" onclick="denyRequest('${targetUser}')">Deny Request</button>`;
    } else if (isReqSent) {
        actionsHtml += `<button class="dropdown-action cancel" onclick="cancelRequest('${targetUser}')">Cancel Request</button>`;
    } else {
        actionsHtml += `<button class="dropdown-action add" onclick="sendRequest('${targetUser}')">Add Friend</button>`;
    }
    
    actionsHtml += `<button class="dropdown-action" onclick="window.location.href='/?u=${targetUser}'">View Full Profile</button>`;

    const menu = document.createElement("div"); menu.className = "user-dropdown";
    menu.innerHTML = `<div class="popup-top-section">${avatarHtml}<div class="popup-name" style="color:${color}">${targetUser}</div></div><div class="popup-actions">${actionsHtml}</div>`;
    
    document.body.appendChild(menu);
    const rect = eventElement ? eventElement.getBoundingClientRect() : null;
    if (window.innerWidth < 768) {
        menu.style.position = "fixed"; menu.style.top = "50%"; menu.style.left = "50%"; menu.style.transform = "translate(-50%, -50%)"; menu.style.zIndex = "10000"; 
    } else if (rect) {
        let top = rect.bottom + 5; let left = rect.left;
        if (top + menu.offsetHeight > window.innerHeight) top = rect.top - menu.offsetHeight - 5;
        if (left + menu.offsetWidth > window.innerWidth) left = window.innerWidth - menu.offsetWidth - 10;
        menu.style.top = top + "px"; menu.style.left = left + "px";
    }
}

function renderLists() {
    const onlineContainer = document.getElementById("userListContent");
    if(!onlineContainer) return;
    onlineContainer.innerHTML = ""; document.getElementById("usersCount").innerText = `Online: ${onlineUsersList.length}`;
    onlineUsersList.sort((a, b) => a.user.localeCompare(b.user));
    onlineUsersList.forEach(u => {
        let div = document.createElement("div"); div.className = "user-item";
        div.onclick = function(e) { if(e.target.tagName === 'BUTTON' || e.target.tagName === 'IMG') return; openUserMenu(u.user, this); };
        const isFriend = myFriendsList.some(f => f.user === u.user);
        let chatBtn = isFriend ? `<img src="/assets/send.png" class="action-icon" onclick="openPrivateChat('${u.user}')" onerror="this.style.display='none'">` : '';
        if(isFriend && !chatBtn) chatBtn = `<span onclick="openPrivateChat('${u.user}')" style="cursor:pointer;">✉</span>`;
        div.innerHTML = `${getAvatarHTML(u)} <span class="u-name">${u.user}</span> <div style="margin-left:auto">${chatBtn}</div>`;
        onlineContainer.appendChild(div);
    });

    const friendsContainer = document.getElementById("friendsListContent"); friendsContainer.innerHTML = "";
    if (requestsIn.length > 0) {
        let header = document.createElement("div"); header.style.padding = "5px 10px"; header.style.fontSize = "0.8em"; header.style.color = "#bb86fc"; header.innerText = "REQUESTS"; friendsContainer.appendChild(header);
        requestsIn.forEach(r => {
            let div = document.createElement("div"); div.className = "user-item"; div.style.background = "#292020";
            const btns = `<div class="req-actions"><button class="req-btn accept" onclick="acceptRequest('${r.user}')">✓</button><button class="req-btn deny" onclick="denyRequest('${r.user}')">✕</button></div>`;
            div.innerHTML = `${getAvatarHTML(r)} <span class="u-name">${r.user}</span> ${btns}`; friendsContainer.appendChild(div);
        });
    }
    if (myFriendsList.length > 0 || requestsOut.length > 0) {
        if(requestsIn.length > 0) { let sep = document.createElement("hr"); sep.style.border = "0"; sep.style.borderTop="1px solid #333"; sep.style.margin="5px 0"; friendsContainer.appendChild(sep); }
        myFriendsList.sort((a, b) => { const aOnline = onlineUsersList.some(o => o.user === a.user); const bOnline = onlineUsersList.some(o => o.user === b.user); return bOnline - aOnline; });
        myFriendsList.forEach(f => {
            let div = document.createElement("div"); div.className = "user-item";
            div.onclick = function(e) { if(e.target.tagName === 'BUTTON' || e.target.tagName === 'IMG') return; openUserMenu(f.user, this); };
            const isOnline = onlineUsersList.some(o => o.user === f.user);
            const statusColor = isOnline ? "#00ff00" : "#555";
            const statusIndicator = `<span class="status-ind" style="background:${statusColor}"></span>`;
            let chatBtn = `<img src="/assets/send.png" class="action-icon" onclick="openPrivateChat('${f.user}')" onerror="this.style.display='none'">`;
            div.innerHTML = `<div style="position:relative; display:inline-block;">${getAvatarHTML(f)}${statusIndicator}</div><span class="u-name" style="opacity: ${isOnline ? 1 : 1}">${f.user}</span><div style="margin-left:auto">${chatBtn}</div>`;
            friendsContainer.appendChild(div);
        });
        requestsOut.forEach(r => {
            let div = document.createElement("div"); div.className = "user-item"; div.style.opacity = "0.7"; div.onclick = function() { openUserMenu(r.user, this); };
            div.innerHTML = `${getAvatarHTML(r)} <span class="u-name">${r.user}</span> <span class="pending-label">Pending...</span>`; friendsContainer.appendChild(div);
        });
    } else if (requestsIn.length === 0) { friendsContainer.innerHTML = `<div style="padding:10px; color:#666; font-size:0.8em; text-align:center;">No friends yet</div>`; }
}

function sendRequest(target) { ws.send(JSON.stringify({type: "send_request", targetUser: target})); closeAllDropdowns(); }
function acceptRequest(target) { ws.send(JSON.stringify({type: "accept_request", targetUser: target})); closeAllDropdowns(); }
function denyRequest(target) { ws.send(JSON.stringify({type: "deny_request", targetUser: target})); closeAllDropdowns(); }
function cancelRequest(target) { ws.send(JSON.stringify({type: "cancel_request", targetUser: target})); closeAllDropdowns(); }
function removeFriend(target) { if(confirm("Remove friend?")) { ws.send(JSON.stringify({type: "remove_friend", targetUser: target})); closeAllDropdowns(); } }

document.addEventListener('click', function(e) { 
    if (!e.target.closest('.user-item') && !e.target.closest('.user-dropdown') && !e.target.closest('.msg-avatar-wrapper') && !e.target.closest('.username') && !e.target.closest('.clickable-wrapper') && !e.target.closest('.msg-options-menu') && !e.target.closest('.msg-options-btn')) closeAllDropdowns(); 
});

document.getElementById("msg").addEventListener("keyup", e => { if(e.key==="Enter") send(); });