// CONFIGURATION
const urlParams = new URLSearchParams(window.location.search);
const PROFILE_TARGET = urlParams.get('u') || 'matei'; 

// FORCE TOP SCROLL IMMEDIATELY
if (history.scrollRestoration) {
    history.scrollRestoration = 'manual';
}
window.scrollTo(0, 0);

let ws;
let currentUser = null;
let currentLikeCount = 0;
let currentFriendCount = 0;
let vantaEffect = null;
let currentSocialLinks = {}; 
let scWidget = null; 
let musicDuration = 0; 

document.addEventListener("DOMContentLoaded", () => {
    window.scrollTo(0, 0);

    const token = localStorage.getItem("chat_token");
    const authContainer = document.getElementById("auth-nav");
    const userContainer = document.getElementById("user-nav");
    const mobileContainer = document.getElementById("mobile-menu-content");
    
    // 1. Auth & Navigation
    if (token) {
        // Desktop
        authContainer.innerHTML = `
            <a href="/chat" class="nav-btn"><span>💬</span> Open Chatroom</a>
            <button onclick="doLogout()" class="nav-btn" style="background:rgba(207, 102, 121, 0.2); border-color:rgba(207, 102, 121, 0.4)">Logout</button>
        `;
        if (userContainer) {
            userContainer.innerHTML = `
                <button onclick="goToMyHome()" class="nav-btn">My Profile</button>
            `;
        }

        // Mobile
        if(mobileContainer) {
            mobileContainer.innerHTML = `
                <div style="display:flex; flex-direction:column; gap:15px;">
                    <h3 style="color:#888; border-bottom:1px solid #333; padding-bottom:5px;">Menu</h3>
                    <button onclick="goToMyHome()" class="nav-btn" style="width:100%; justify-content:center;">My Profile</button>
                    <a href="/chat" class="nav-btn" style="width:100%; justify-content:center;"><span>💬</span> Chatroom</a>
                    <button onclick="doLogout()" class="nav-btn" style="width:100%; justify-content:center; background:rgba(207, 102, 121, 0.2); border-color:rgba(207, 102, 121, 0.4)">Logout</button>
                </div>
            `;
        }

        connectWS(token);
    } else {
        // Desktop
        authContainer.innerHTML = `
            <a href="/login?redirect=%2Fchat" class="nav-btn">Join Chatroom</a>
            <a href="/login?redirect=%2F" class="nav-btn">Login</a>
            <a href="/register?redirect=%2F" class="nav-btn">Register</a>
        `;
        if (userContainer) userContainer.innerHTML = ""; 

        // Mobile
        if(mobileContainer) {
            mobileContainer.innerHTML = `
                <div style="display:flex; flex-direction:column; gap:15px;">
                    <h3 style="color:#888; border-bottom:1px solid #333; padding-bottom:5px;">Welcome</h3>
                    <a href="/login?redirect=%2Fchat" class="nav-btn" style="width:100%; justify-content:center;">Join Chatroom</a>
                    <a href="/login?redirect=%2F" class="nav-btn" style="width:100%; justify-content:center;">Login</a>
                    <a href="/register?redirect=%2F" class="nav-btn" style="width:100%; justify-content:center;">Register</a>
                </div>
            `;
        }
        
        connectWS(null);
        
        // Safety check if elements exist before interacting
        const btnFriend = document.getElementById("btn-friend");
        const btnLike = document.getElementById("btn-like");
        
        if(btnFriend) {
            btnFriend.setAttribute("disabled", "true");
            btnFriend.setAttribute("data-tooltip", "Login to add friend");
        }
        if(btnLike) {
            btnLike.setAttribute("disabled", "true");
            btnLike.setAttribute("data-tooltip", "Login to like");
        }
    }

    const bg = document.getElementById("vanta-bg");
    const cursorLight = document.querySelector(".cursor-light");
    const card = document.querySelector(".profile-card");

    document.addEventListener("mousemove", (e) => {
        if (cursorLight) {
            cursorLight.style.left = e.clientX + "px";
            cursorLight.style.top = e.clientY + "px";
        }

        const bgX = (window.innerWidth / 2 - e.clientX) / 80; 
        const bgY = (window.innerHeight / 2 - e.clientY) / 80;
        if(bg) bg.style.transform = `translate(${bgX}px, ${bgY}px) scale(1.1)`;

        if(card && window.innerWidth > 768 && window.scrollY < 50) {
            const rect = card.getBoundingClientRect();
            const centerY = rect.top + rect.height / 2;
            const rotX = (centerY - e.clientY) / 30; 
            card.style.transform = `perspective(1000px) rotateX(${rotX}deg)`;
        } else if (card) {
            card.style.transform = "none";
        }
    });

    const cardElement = document.querySelector('.profile-card');
    window.addEventListener("scroll", () => {
        if (card) card.style.transform = "none"; 

        if (!cardElement) return;
        if (window.scrollY > 50) {
            document.body.classList.add("header-visible");
        } else {
            document.body.classList.remove("header-visible");
        }
    });

    const stickyHeader = document.getElementById("sticky-header");
    if (stickyHeader) {
        stickyHeader.style.cursor = "pointer";
        stickyHeader.onclick = () => {
            window.scrollTo({ top: 0, behavior: "smooth" });
        };
    }

    initVisuals();
    
    // Initialize SC Widget Wrapper
    const iframeElement = document.getElementById('sc-widget');
    if (iframeElement && typeof SC !== 'undefined') {
        scWidget = SC.Widget(iframeElement);
        
        scWidget.bind(SC.Widget.Events.READY, function() {
            scWidget.setVolume(30);
            scWidget.getDuration(function(dur) {
                musicDuration = dur;
                document.getElementById('total-time').innerText = formatTime(dur);
            });
            // NO AUTO PLAY HERE
        });

        // UPDATE METADATA ON PLAY (Handles Playlist Changes)
        scWidget.bind(SC.Widget.Events.PLAY, function() {
            document.getElementById('play-btn').style.display = 'none';
            document.getElementById('pause-btn').style.display = 'inline-flex';
            
            // Get Current Sound Info (Dynamic update)
            scWidget.getCurrentSound(function(sound) {
                if(sound) {
                    document.getElementById('music-title').innerText = sound.title || "Unknown Track";
                    document.getElementById('music-artist').innerText = sound.user ? sound.user.username : "SoundCloud";
                    const artUrl = sound.artwork_url || sound.user.avatar_url;
                    if(artUrl) {
                        const artImg = document.getElementById('music-artwork');
                        artImg.src = artUrl.replace('large', 't500x500'); 
                        artImg.style.display = 'block';
                    }
                    
                    // Update duration if track changed
                    musicDuration = sound.duration;
                    document.getElementById('total-time').innerText = formatTime(musicDuration);
                }
            });
        });

        scWidget.bind(SC.Widget.Events.PAUSE, function() {
            document.getElementById('play-btn').style.display = 'inline-flex';
            document.getElementById('pause-btn').style.display = 'none';
        });

        scWidget.bind(SC.Widget.Events.PLAY_PROGRESS, function(e) {
            const relativePos = e.relativePosition;
            const currentMs = e.currentPosition;
            const slider = document.getElementById('seek-bar');
            if(slider) slider.value = relativePos * 100;
            document.getElementById('curr-time').innerText = formatTime(currentMs);
        });

        scWidget.bind(SC.Widget.Events.ERROR, function() {
            document.getElementById('music-widget').style.display = 'none';
        });
    }
});

function formatTime(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000).toFixed(0);
    return minutes + ":" + (seconds < 10 ? '0' : '') + seconds;
}

// --- MOBILE MENU FUNCTIONS ---
function toggleMobileMenu() {
    const sidebar = document.getElementById("mobile-sidebar");
    const overlay = document.getElementById("mobile-menu-overlay");
    sidebar.classList.toggle("open");
    overlay.classList.toggle("open");
}

function hexToRgb(hex) {
    var shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
    hex = hex.replace(shorthandRegex, function(m, r, g, b) { return r + r + g + g + b + b; });
    var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : { r: 187, g: 134, b: 252 };
}

function updateTheme(hexColor) {
    if (!hexColor) return;
    const rgb = hexToRgb(hexColor);
    const root = document.documentElement;
    root.style.setProperty('--accent-color', hexColor);
    root.style.setProperty('--accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);

    if (!vantaEffect) {
        try {
            vantaEffect = VANTA.FOG({
                el: "#vanta-bg",
                mouseControls: true, touchControls: true, gyroControls: false,
                minHeight: 200.00, minWidth: 200.00,
                highlightColor: hexColor, 
                midtoneColor: 0x1a1a1a, lowlightColor: 0x000000, baseColor: 0x000000,
                blurFactor: 0.90, speed: 1.4, zoom: 1.2
            });
        } catch(e){}
    } else {
        vantaEffect.setOptions({ highlightColor: hexColor });
    }
}

function initVisuals() {
    updateTheme("#bb86fc");
}

function goToMyHome() {
    if(currentUser) window.location.href = `/?u=${currentUser}`;
}

function doLogout() {
    localStorage.removeItem("chat_token");
    window.location.reload();
}

function connectWS(token) {
    const host = window.location.hostname;
    ws = new WebSocket("wss://" + host + "/chatws");

    ws.onopen = () => {
        if (token) {
            ws.send(JSON.stringify({ type: "login_token", token: token, source: 'home' }));
        } else {
            requestProfileStats();
        }
    };

    ws.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            
            if (data.type === "login_success") {
                currentUser = data.user;
                if (data.token) localStorage.setItem("chat_token", data.token);
                requestProfileStats();
            }
            else if (data.type === "token_invalid") {
                localStorage.removeItem("chat_token");
                window.location.reload();
            }
            else if (data.type === "social_update") {
                checkFriendStatus(data);
            }
            else if (data.type === "profile_stats") {
                updateProfileStats(data);
            }
            else if (data.type === "user_posts") {
                renderUserPosts(data.posts);
            }
            else if (data.type === "post_like_update") {
                updatePostLikeUI(data.id, data.count, data.hasLiked);
            }
            else if (data.type === "delete_success") {
                requestProfileStats(); 
            }
            // NEW: Handle Friends & Feed
            else if (data.type === "home_sidebars_data") {
                renderFriendsHorizontal(data.friends);
                renderFriendsFeedHorizontal(data.feed);
            }

        } catch(err) { console.error(err); }
    };
}

function requestProfileStats() {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "get_profile_data", targetUser: PROFILE_TARGET }));
        ws.send(JSON.stringify({ type: "fetch_home_sidebars", target: PROFILE_TARGET }));
    }
}

function updateProfileStats(data) {
    if (data.error) {
        document.querySelector(".name-title").innerText = "User Not Found";
        return;
    }

    if (data.isHidden) {
        document.body.classList.add('profile-is-hidden');
        const returnBtn = document.getElementById('return-profile-btn');
        if (currentUser) {
            returnBtn.onclick = () => window.location.href = `/?u=${currentUser}`;
            returnBtn.innerText = "Return to My Profile";
        } else {
            returnBtn.onclick = () => window.location.href = "/login";
            returnBtn.innerText = "Login to View";
        }
        return;
    } else {
        document.body.classList.remove('profile-is-hidden');
    }

    updateTheme(data.displayColor || "#bb86fc");

    const likeBtn = document.getElementById("btn-like");
    const likeLabel = document.getElementById("like-stat-label");
    const friendLabel = document.getElementById("friend-stat-label");
    
    currentLikeCount = data.likeCount || 0;
    currentFriendCount = data.friendsCount || 0;

    if(likeLabel) likeLabel.innerText = `${currentLikeCount} LIKES`;
    if(friendLabel) friendLabel.innerText = `${currentFriendCount} FRIENDS`;

    document.querySelector(".name-title").innerHTML = data.displayName || data.username;
    document.querySelector(".username-pill").innerText = "@" + data.username.toLowerCase();
    document.querySelector("#sticky-header span").innerHTML = data.displayName || data.username;
    document.querySelector(".role-tag").innerHTML = data.title || "User";
    document.querySelector(".bio-text").innerHTML = data.bio || "No bio yet.";
    
    document.title = `${data.displayName || data.username} - Profile`;

    const mainImg = document.getElementById("main-profile-img");
    const headerImg = document.getElementById("header-profile-img");
    
    if (data.avatar) {
        const url = `/uploads/${data.avatar}`;
        if(mainImg) {
            mainImg.src = url;
            mainImg.classList.remove('default-tint'); 
        }
        if(headerImg) headerImg.src = url;
    } else {
        const url = "/uploads/default.png";
        if(mainImg) {
            mainImg.src = url;
            mainImg.classList.add('default-tint'); 
        }
        if(headerImg) headerImg.src = url;
    }

    // --- MUSIC WIDGET LOGIC ---
    if (data.musicUrl && scWidget) {
        document.getElementById('music-widget').style.display = 'flex';
        
        let seekTime = 0;
        const timeMatch = data.musicUrl.match(/#t=(\d+):?(\d+)?/);
        if (timeMatch) {
            if (timeMatch[2]) { 
                seekTime = (parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2])) * 1000;
            } else { 
                seekTime = parseInt(timeMatch[1]) * 1000;
            }
        }

        // LOAD: Auto play is true, BUT ONLY when we actually load a url
        scWidget.load(data.musicUrl, {
            auto_play: false, 
            hide_related: true,
            show_comments: false,
            show_user: false,
            show_reposts: false,
            visual: false,
            callback: function() {
                scWidget.setVolume(30);
                scWidget.getCurrentSound(function(sound) {
                    if(sound) {
                        document.getElementById('music-title').innerText = sound.title || "Unknown Track";
                        document.getElementById('music-artist').innerText = sound.user ? sound.user.username : "SoundCloud";
                        const artUrl = sound.artwork_url || sound.user.avatar_url;
                        if(artUrl) {
                            const artImg = document.getElementById('music-artwork');
                            artImg.src = artUrl.replace('large', 't500x500'); 
                            artImg.style.display = 'block';
                        }
                    }
                });
                if (seekTime > 0) {
                    scWidget.seekTo(seekTime);
                }
            }
        });
    } else {
        document.getElementById('music-widget').style.display = 'none';
        if(scWidget) scWidget.pause();
    }

    if (data.isSpecial) {
        // Obsolete custom music player logic removal handled by hiding container if not used
    }

    if (likeBtn) {
        if (data.hasLiked) {
            likeBtn.classList.add("like-active");
            likeBtn.innerHTML = `❤️`;
            likeBtn.setAttribute("data-tooltip", "Liked!");
        } else {
            likeBtn.classList.remove("like-active");
            likeBtn.innerHTML = `🤍`;
            likeBtn.setAttribute("data-tooltip", "Like");
        }
    }

    currentSocialLinks = data.socialLinks || {};
    const socialBar = document.getElementById("social-links-bar");
    if(socialBar) {
        socialBar.innerHTML = "";
        
        Object.keys(currentSocialLinks).forEach(platform => {
            const link = currentSocialLinks[platform];
            if (link) {
                const pill = document.createElement("a");
                pill.href = link.startsWith('http') ? link : `https://${link}`;
                pill.target = "_blank";
                pill.className = "social-pill";
                pill.innerHTML = `<img src="/assets/${platform}.svg" alt="${platform}"> ${platform.charAt(0).toUpperCase() + platform.slice(1)}`;
                socialBar.appendChild(pill);
            }
        });
    }

    if (currentUser && currentUser.toLowerCase() === data.targetUser.toLowerCase()) {
        const tools = document.getElementById("owner-tools");
        if (tools) tools.style.display = "flex";
        
        const createPostBtn = document.getElementById("create-post-container");
        if (createPostBtn) createPostBtn.style.display = "block";
        
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = data.displayName || "";
        document.getElementById("edit-display-name").value = tempDiv.innerText;
        tempDiv.innerHTML = data.title || "";
        document.getElementById("edit-title").value = tempDiv.innerText;
        tempDiv.innerHTML = data.bio || "";
        document.getElementById("edit-bio").value = tempDiv.innerText;
        document.getElementById("edit-music-url").value = data.musicUrl || "";
        document.getElementById("edit-visibility").checked = data.isVisible;
        const socialInputs = document.querySelectorAll(".social-input");
        socialInputs.forEach(input => {
            const platform = input.getAttribute("data-platform");
            input.value = currentSocialLinks[platform] || "";
        });
    }
}

// ... [Friend Status, Like, Share, etc. - Unchanged] ...
function checkFriendStatus(socialData) {
    if (!currentUser || currentUser.toLowerCase() === PROFILE_TARGET.toLowerCase()) {
        const btn = document.getElementById("btn-friend");
        if(btn) {
            btn.innerHTML = "👤";
            btn.setAttribute("disabled", "true");
        }
        return;
    }
    const friends = socialData.friends || [];
    const reqOut = socialData.requests_out || [];
    const btn = document.getElementById("btn-friend");
    if(!btn) return;
    if (friends.some(f => f.user.toLowerCase() === PROFILE_TARGET.toLowerCase())) {
        friendStatus = "friends";
        btn.innerHTML = `💬`; 
        btn.classList.add("active");
        btn.classList.remove("pending");
        btn.setAttribute("data-tooltip", "Send Message");
        btn.onclick = () => window.location.href = "/chat";
    } 
    else if (reqOut.some(r => r.user.toLowerCase() === PROFILE_TARGET.toLowerCase())) {
        friendStatus = "pending_out";
        btn.innerHTML = `⏳`;
        btn.classList.add("pending");
        btn.setAttribute("data-tooltip", "Request Pending");
        btn.onclick = () => alert("Friend request already sent.");
    }
    else {
        friendStatus = "none";
        btn.innerHTML = `➕`;
        btn.classList.remove("active", "pending");
        btn.setAttribute("data-tooltip", "Add Friend");
        btn.onclick = sendFriendRequest;
    }
    requestProfileStats();
}

function sendFriendRequest() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return alert("Connection error.");
    const btn = document.getElementById("btn-friend");
    btn.innerHTML = `⏳`;
    btn.classList.add("pending");
    ws.send(JSON.stringify({ type: "send_request", targetUser: PROFILE_TARGET }));
}

function toggleLike() {
    const btn = document.getElementById("btn-like");
    if (btn && btn.hasAttribute("disabled")) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "toggle_like", targetUser: PROFILE_TARGET }));
}

function shareProfile() {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
        const btn = document.getElementById("btn-share");
        if(btn) {
            const originalText = btn.getAttribute("data-tooltip");
            btn.setAttribute("data-tooltip", "Copied!");
            setTimeout(() => btn.setAttribute("data-tooltip", originalText || "Share Link"), 2000);
        }
    });
}

function togglePostLike(e, postId) {
    e.stopPropagation(); 
    if (!currentUser) return alert("Please login to like posts.");
    ws.send(JSON.stringify({ type: "toggle_post_like", id: postId }));
}

function updatePostLikeUI(postId, count, hasLiked) {
    const btn = document.getElementById(`post-like-btn-${postId}`);
    const label = document.getElementById(`post-like-count-${postId}`);
    if (btn && label) {
        if (hasLiked) {
            btn.innerHTML = "❤️";
            btn.classList.add("like-active");
        } else {
            btn.innerHTML = "🤍";
            btn.classList.remove("like-active");
        }
        label.innerText = count + " LIKES";
    }
}

// ... [User Posts Render - Unchanged] ...
function renderUserPosts(posts) {
    const feed = document.getElementById("posts-feed");
    if (!feed) return;
    feed.innerHTML = "";
    if (!posts || posts.length === 0) {
        feed.innerHTML = `<div style="text-align:center; color:#555; padding:20px; grid-column: 1/-1;">No posts yet.</div>`;
        return;
    }
    posts.forEach(post => {
        const date = new Date(post.created_at).toLocaleDateString();
        let imgHtml = "";
        let tagsHtml = "";
        if (post.tags && post.tags.length > 0) {
            tagsHtml = `<div class="hanging-tags">`;
            post.tags.forEach(tag => {
                tagsHtml += `<span class="post-tag tag-${tag.toLowerCase()}">${tag}</span>`;
            });
            tagsHtml += `</div>`;
        }
        const likeHtml = `
            <div class="hanging-like-wrapper">
                <button id="post-like-btn-${post.id}" 
                        class="bubble-btn small-bubble ${post.hasLiked ? 'like-active' : ''}" 
                        onclick="togglePostLike(event, '${post.id}')">
                    ${post.hasLiked ? '❤️' : '🤍'}
                </button>
                <div id="post-like-count-${post.id}" class="stat-label small-stat">${post.likeCount || 0} LIKES</div>
            </div>
        `;
        const summaryText = post.summary || "No description available.";
        const titleText = post.title || "Untitled";
        if (post.image_url) {
            imgHtml = `
                <div class="post-img-wrapper">
                    <img src="/uploads/${post.image_url}" class="post-thumb" alt="Cover">
                    ${tagsHtml}
                    ${likeHtml}
                </div>
            `;
        } else {
            imgHtml = `
                <div class="post-img-wrapper" style="background: linear-gradient(45deg, #1a1a1a, #2a2a2a); display:flex; align-items:center; justify-content:center;">
                    <span style="font-size:2em; opacity:0.1;">📄</span>
                    ${tagsHtml}
                    ${likeHtml}
                </div>
            `;
        }
        const html = `
            <div class="post-card" onclick="window.location.href='/post?id=${post.id}'">
                ${imgHtml}
                <div class="post-info">
                    <span class="post-date">${date}</span>
                    <h3 class="post-title">${titleText}</h3>
                    <div class="post-snippet">${summaryText}</div>
                </div>
            </div>
        `;
        feed.innerHTML += html;
    });
}

function openEditor() { document.getElementById("editor-modal").style.display = "flex"; }
function closeEditor() { document.getElementById("editor-modal").style.display = "none"; }

async function saveHomeProfile() {
    const dName = document.getElementById("edit-display-name").value;
    const title = document.getElementById("edit-title").value;
    const bio = document.getElementById("edit-bio").value;
    const isVis = document.getElementById("edit-visibility").checked;
    const fileInput = document.getElementById("edit-avatar-upload");
    const musicUrl = document.getElementById("edit-music-url").value;
    const socialInputs = document.querySelectorAll(".social-input");
    const socialLinks = {};
    socialInputs.forEach(input => {
        if (input.value.trim()) {
            socialLinks[input.getAttribute("data-platform")] = input.value.trim();
        }
    });
    let payload = {
        type: "update_home_profile",
        displayName: dName,
        title: title,
        bio: bio,
        isVisible: isVis,
        socialLinks: socialLinks,
        musicUrl: musicUrl 
    };
    if (fileInput.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            payload.image = e.target.result;
            ws.send(JSON.stringify(payload));
            closeEditor();
        };
        reader.readAsDataURL(fileInput.files[0]);
    } else {
        ws.send(JSON.stringify(payload));
        closeEditor();
    }
}

// --- NEW: RENDER HORIZONTAL FRIENDS & FEED ---
function renderFriendsHorizontal(friends) {
    const section = document.getElementById('friends-section');
    const container = document.getElementById('friends-horizontal-list');
    
    if (!friends || friends.length === 0) {
        section.style.display = 'none';
        return;
    }
    
    section.style.display = 'block';
    container.innerHTML = '';
    
    friends.forEach(f => {
        const bubble = document.createElement('div');
        bubble.className = 'friend-bubble';
        bubble.onclick = () => window.location.href = `/?u=${f.username}`;
        
        const img = document.createElement('img');
        img.className = 'friend-bubble-img';
        img.src = `/uploads/${f.avatar || 'default.png'}`;
        img.onerror = () => img.src = '/uploads/default.png';
        
        const name = document.createElement('span');
        name.className = 'friend-name';
        name.innerText = f.display_name || f.username;

        bubble.appendChild(img);
        bubble.appendChild(name);
        container.appendChild(bubble);
    });
}

function renderFriendsFeedHorizontal(feedPosts) {
    const section = document.getElementById('friends-feed-section');
    const container = document.getElementById('friends-horizontal-feed');

    if (!feedPosts || feedPosts.length === 0) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    container.innerHTML = '';

    feedPosts.forEach(post => {
        const card = document.createElement('div');
        card.className = 'h-post-card';
        card.onclick = () => window.location.href = `/post?id=${post.id}`;

        const imgUrl = post.image_url ? `/uploads/${post.image_url}` : '/img/code_pattern.png';
        
        card.innerHTML = `
            <img src="${imgUrl}" class="h-post-img" onerror="this.src='/img/code_pattern.png'">
            <div class="h-post-info">
                <div class="h-post-title">${post.title}</div>
                <div class="h-post-meta">
                    <img src="/uploads/${post.avatar || 'default.png'}" class="h-post-avatar" onerror="this.src='/uploads/default.png'">
                    <span>${post.display_name || post.username}</span>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

// ... [Music Controls] ...
function toggleMusic() {
    if (scWidget) {
        scWidget.isPaused(function(paused) {
            if (paused) scWidget.play();
            else scWidget.pause();
        });
    }
}
function stopMusic() {
    if (scWidget) {
        scWidget.pause();
        scWidget.seekTo(0);
        document.getElementById('play-btn').style.display = 'inline-flex';
        document.getElementById('pause-btn').style.display = 'none';
        document.getElementById('seek-bar').value = 0;
        document.getElementById('curr-time').innerText = "0:00";
    }
}
function scNext() { if(scWidget) scWidget.next(); }
function scPrev() { if(scWidget) scWidget.prev(); }
function seekMusic(percent) {
    if (scWidget && musicDuration) {
        const ms = (percent / 100) * musicDuration;
        scWidget.seekTo(ms);
    }
}
function setVolume(val) {
    if (scWidget) scWidget.setVolume(val);
}
function toggleWidgetState() {
    const widget = document.getElementById('music-widget');
    const btn = document.getElementById('toggle-widget-btn');
    if (widget.classList.contains('minimized')) {
        widget.classList.remove('minimized');
        btn.innerText = '▼';
    } else {
        widget.classList.add('minimized');
        btn.innerText = '♪';
    }
}
function toggleVolumePopup() {
    const popup = document.getElementById('volume-popup');
    if (popup.style.display === 'flex') {
        popup.style.display = 'none';
    } else {
        popup.style.display = 'flex';
    }
}
document.addEventListener('click', function(e) {
    const popup = document.getElementById('volume-popup');
    const btn = document.querySelector('.media-volume-wrapper button');
    if (popup && popup.style.display === 'flex' && !popup.contains(e.target) && !btn.contains(e.target)) {
        popup.style.display = 'none';
    }
});
//HERE I WANT YOU TO MAKE SOME CHANGES>>> MAKE THE MOBILE VERSION WORK IT DOESNT WORK ANYMORE 