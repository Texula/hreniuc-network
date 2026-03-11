let ws;
let currentUser = null;
let currentPostType = null; 
let editPostId = new URLSearchParams(window.location.search).get('id');

document.addEventListener("DOMContentLoaded", () => {
    const token = localStorage.getItem("chat_token");
    if (!token) {
        window.location.href = "/login";
        return;
    }

    ws = new WebSocket("wss://" + window.location.hostname + "/chatws");
    
    ws.onopen = () => {
        ws.send(JSON.stringify({ type: "login_token", token: token, source: 'editor' }));
    };

    ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        
        if (data.type === "login_success") {
            currentUser = data.user;
            const color = data.color || "#bb86fc";
            initVanta(color);
            updateThemeColors(color);
            updateProfileHeader(data);
            
            if (editPostId) {
                document.getElementById('publish-btn').innerText = "Update Post";
                ws.send(JSON.stringify({ type: "get_post_details", id: editPostId }));
            }
        }
        else if (data.type === "post_created") {
            window.location.href = "/";
        }
        else if (data.type === "post_updated") {
            window.location.href = `/post?id=${editPostId}`;
        }
        else if (data.type === "my_posts_for_gallery") {
            renderGalleryOptions(data.blockId, data.posts);
        }
        else if (data.type === "post_content") {
            if (data.error) return alert("Post not found");
            if (data.post.author_username !== currentUser && currentUser !== 'admin') {
                alert("Unauthorized to edit this post.");
                window.location.href = "/";
                return;
            }
            populateEditor(data.post);
        }
    };
});

function populateEditor(post) {
    document.getElementById('post-title').value = decodeHtmlSafe(post.title);
    document.getElementById('post-summary').value = decodeHtmlSafe(post.summary);
    document.getElementById('post-visibility').checked = post.is_visible;
    if (post.tags && post.tags.length > 0) selectPostType(post.tags[0]);
    
    try {
        const blocks = JSON.parse(post.content);
        blocks.forEach(b => addBlock(b.type, b));
    } catch(e) { console.error("Error parsing blocks", e); }
}

function decodeHtmlSafe(html) {
    const txt = document.createElement("textarea");
    txt.innerHTML = html;
    return txt.value;
}

function updateThemeColors(hex) {
    const root = document.documentElement;
    root.style.setProperty('--accent-color', hex);
    
    let c = hex.substring(1).split('');
    if(c.length==3) c = [c[0], c[0], c[1], c[1], c[2], c[2]];
    c = '0x'+c.join('');
    const r = (c>>16)&255, g = (c>>8)&255, b = c&255;
    
    root.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);

    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    if (brightness < 80) {
        root.style.setProperty('--smart-color', '#ffffff');
    } else {
        root.style.setProperty('--smart-color', hex);
    }
}

function initVanta(color) {
    try {
        VANTA.FOG({
            el: "#vanta-bg",
            mouseControls: true, touchControls: true, gyroControls: false,
            minHeight: 200.00, minWidth: 200.00,
            highlightColor: color, 
            midtoneColor: 0x1a1a1a,
            lowlightColor: 0x000000, 
            baseColor: 0x000000,
            blurFactor: 0.90, speed: 1.4, zoom: 1.2
        });
    } catch(e) { console.warn(e); }
}

function updateProfileHeader(data) {
    document.getElementById("user-name").innerText = data.user; 
    document.getElementById("user-handle").innerText = "@" + data.user;
    if(data.avatar) document.getElementById("user-avatar").src = `/uploads/${data.avatar}`;
    else document.getElementById("user-avatar").src = `https://ui-avatars.com/api/?name=${data.user}&background=121212&color=fff`;
}

// --- POST TYPE SYSTEM ---
function togglePostTypeMenu() {
    const menu = document.getElementById("post-type-menu");
    if (menu.classList.contains("open")) {
        menu.classList.remove("open");
    } else {
        menu.classList.add("open");
    }
}

function selectPostType(type) {
    currentPostType = type;
    renderPostType();
    document.getElementById("post-type-menu").classList.remove("open");
}

function removePostType() {
    currentPostType = null;
    renderPostType();
}

function renderPostType() {
    const container = document.getElementById("active-post-type");
    const btnText = document.getElementById("choose-type-btn-text");
    
    if (currentPostType) {
        container.innerHTML = `
            <span class="tag-pill tag-${currentPostType.toLowerCase()}">
                ${currentPostType} 
                <b onclick="removePostType()" style="cursor:pointer; margin-left:8px; opacity:0.7;">✕</b>
            </span>`;
        btnText.innerText = "Change Type";
    } else {
        container.innerHTML = "";
        btnText.innerText = "Choose Post Type";
    }
}

// --- BLOCK SYSTEM ---
function toggleAddMenu() {
    document.getElementById("add-options").classList.toggle("open");
}

function addBlock(type, initialData = null) {
    const container = document.getElementById("blocks-container");
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const div = document.createElement("div");
    div.className = `content-block block-${type}`;
    div.id = `block-${id}`;
    
    let contentHtml = "";
    let initialVal = initialData ? initialData.value : "";
    
    if (type === 'text') {
        contentHtml = `<textarea class="block-input" placeholder="Write your thoughts...">${initialVal}</textarea>`;
    }
    else if (type === 'chapter') {
        contentHtml = `<input type="text" class="block-input" placeholder="Subtitle" value="${initialVal}">`;
    }
    else if (type === 'code') {
        contentHtml = `<textarea class="block-input" placeholder="// Paste code here">${initialVal}</textarea>`;
    }
    else if (type === 'gallery') {
        contentHtml = `
            <div class="block-gallery-container" id="gallery-container-${id}">
                <div style="text-align:center; padding: 20px; color: #888;">Loading your posts...</div>
            </div>`;
        if (initialData && initialData.value) {
            div.dataset.initialGallery = JSON.stringify(initialData.value);
        }
        ws.send(JSON.stringify({ type: "get_my_posts_for_gallery", blockId: id }));
    }
    else if (type === 'image') {
        let imgStyle = initialVal ? `style="display:block; max-height:${initialData.height || 600}px;" src="${initialVal}"` : `style="display:none; max-height: 600px;"`;
        let placeholderStyle = initialVal ? `style="display:none;"` : "";
        let captionVal = initialData && initialData.caption ? initialData.caption : "";
        let heightVal = initialData && initialData.height ? initialData.height : "600";
        
        contentHtml = `
            <div class="block-image-wrapper">
                <input type="file" id="file-${id}" class="file-input-hidden" accept="image/*" onchange="handleImageUpload(this, '${id}')">
                
                <div class="image-upload-box" onclick="document.getElementById('file-${id}').click()">
                    <span id="placeholder-${id}" ${placeholderStyle}>Click to Upload Image</span>
                    <img id="img-${id}" class="preview-img" ${imgStyle}>
                </div>

                <div class="image-controls">
                    <label>Crop Height:</label>
                    <input type="range" class="height-slider" min="200" max="800" value="${heightVal}" oninput="updateImageHeight('${id}', this.value)">
                </div>

                <input type="text" class="caption-input" placeholder="Add a caption (optional)..." value="${captionVal}">
            </div>`;
    }

    // NEW: Block Controls Container
    div.innerHTML = `
        <div class="block-controls">
            <button class="control-btn move-btn" onclick="moveBlockUp('${id}')" title="Move Up">▲</button>
            <button class="control-btn move-btn" onclick="moveBlockDown('${id}')" title="Move Down">▼</button>
            <button class="control-btn delete-btn" onclick="removeBlock('${id}')" title="Delete Block">×</button>
        </div>
        ${contentHtml}
    `;
    
    container.appendChild(div);
    if (!initialData) {
        div.scrollIntoView({ behavior: 'smooth', block: 'center' });
        toggleAddMenu(); 
    }
}

// --- NEW: Block Movement Logic ---
function moveBlockUp(id) {
    const el = document.getElementById(`block-${id}`);
    if (el && el.previousElementSibling) {
        el.parentNode.insertBefore(el, el.previousElementSibling);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function moveBlockDown(id) {
    const el = document.getElementById(`block-${id}`);
    if (el && el.nextElementSibling) {
        el.parentNode.insertBefore(el.nextElementSibling, el);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function removeBlock(id) {
    const el = document.getElementById(`block-${id}`);
    el.style.opacity = '0';
    el.style.transform = 'translateY(10px)';
    setTimeout(() => el.remove(), 300);
}

function updateImageHeight(id, val) {
    const img = document.getElementById(`img-${id}`);
    if (img) img.style.maxHeight = val + "px";
}

// --- GALLERY SELECTION ---
function renderGalleryOptions(blockId, posts) {
    const container = document.getElementById(`gallery-container-${blockId}`);
    if (!container) return;
    
    const blockDiv = document.getElementById(`block-${blockId}`);
    let initialSelection = [];
    if (blockDiv && blockDiv.dataset.initialGallery) {
        try { initialSelection = JSON.parse(blockDiv.dataset.initialGallery); } catch(e){}
    }
    
    if (posts.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding: 20px; color: #888;">You don't have any posts yet.</div>`;
        return;
    }

    let html = `<div class="gallery-selection-grid">`;
    posts.forEach(p => {
        const img = p.image_url ? `/uploads/${p.image_url}` : '/img/code_pattern.png';
        const isChecked = initialSelection.includes(p.id) ? "checked" : "";
        html += `
            <label class="gallery-select-item" title="${p.title}">
                <input type="checkbox" class="gallery-checkbox" value="${p.id}" ${isChecked}>
                <img src="${img}" onerror="this.src='/uploads/default.png'">
                <span>${p.title || "Untitled"}</span>
            </label>
        `;
    });
    html += `</div>`;
    container.innerHTML = html;
}

// --- IMAGE HANDLING ---
async function handleImageUpload(input, id) {
    const file = input.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        alert("Please upload a valid image file.");
        input.value = "";
        return;
    }

    const imgPreview = document.getElementById(`img-${id}`);
    const placeholder = document.getElementById(`placeholder-${id}`);
    if(placeholder) placeholder.style.display = 'none';

    if (file.type === 'image/gif') {
        const reader = new FileReader();
        reader.onload = (e) => {
            imgPreview.src = e.target.result;
            imgPreview.style.display = 'block';
        };
        reader.readAsDataURL(file);
        return;
    }

    try {
        const compressedDataUrl = await compressImage(file);
        imgPreview.src = compressedDataUrl;
        imgPreview.style.display = 'block';
    } catch (err) {
        console.error("Compression failed", err);
        alert("Could not process image.");
    }
}

function compressImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const MAX_WIDTH = 1200;
                const MAX_HEIGHT = 1200;
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
                } else {
                    if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
                }

                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.7));
            };
            img.onerror = (e) => reject(e);
        };
        reader.onerror = (e) => reject(e);
    });
}

// --- PUBLISH ---
async function publishPost() {
    const title = document.getElementById("post-title").value;
    const summary = document.getElementById("post-summary").value;
    const isVisible = document.getElementById("post-visibility").checked;
    
    if (!title) return alert("Please add a title.");

    const blockElements = document.getElementById("blocks-container").children;
    let gatheredBlocks = [];

    for (let el of blockElements) {
        let type = 'text';
        if (el.classList.contains('block-chapter')) type = 'chapter';
        else if (el.classList.contains('block-code')) type = 'code';
        else if (el.classList.contains('block-image')) type = 'image';
        else if (el.classList.contains('block-gallery')) type = 'gallery';
        
        let value = "";
        let caption = "";
        let height = "600"; 

        if (type === 'image') {
            const img = el.querySelector('img');
            const capInput = el.querySelector('.caption-input');
            const slider = el.querySelector('.height-slider');
            
            if (img.src && (img.src.startsWith('data:') || img.src.includes('/uploads/'))) {
                value = img.getAttribute('src'); // Preserves base64 or absolute path
                if (capInput) caption = capInput.value;
                if (slider) height = slider.value;
            }
        } else if (type === 'gallery') {
            const checkboxes = el.querySelectorAll('.gallery-checkbox:checked');
            value = Array.from(checkboxes).map(cb => cb.value);
        } else {
            value = el.querySelector('.block-input').value;
        }

        if (value && (!Array.isArray(value) || value.length > 0)) {
            if (type === 'image') gatheredBlocks.push({ type, value, caption, height });
            else gatheredBlocks.push({ type, value });
        }
    }

    const tagsArray = currentPostType ? [currentPostType] : [];
    
    // Auto-detect Cover Image
    let coverImage = null;
    const firstImgBlock = gatheredBlocks.find(b => b.type === 'image');
    if (firstImgBlock) {
        if (firstImgBlock.value.startsWith('data:')) coverImage = firstImgBlock.value;
        else coverImage = firstImgBlock.value; // Send path back; Server handles stripping it
    }

    const payload = {
        type: editPostId ? "update_post" : "create_post",
        id: editPostId,
        title: title,
        summary: summary,
        tags: tagsArray, 
        blocks: JSON.stringify(gatheredBlocks),
        image: coverImage,
        isVisible: isVisible 
    };
    
    ws.send(JSON.stringify(payload));
}