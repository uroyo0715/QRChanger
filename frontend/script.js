import jsQR from "jsqr";
// 楽曲データベースをインポート
import { musicDatabase } from "./musicData.js";

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const canvasCtx = canvas.getContext("2d", { willReadFrequently: true });
const woodTypeElem = document.getElementById("wood-type");
const rgbValElem = document.getElementById("rgb-val");
const colorPreview = document.getElementById("color-preview");
const outputContent = document.getElementById("output-content");

// --- プレイヤー用のDOM要素取得 ---
const musicControls = document.getElementById("music-controls");
const seekBar = document.getElementById("seek-bar");
const songInfo = document.getElementById("song-info");

const BACKEND_URL = "https://6pvhqjr4-8000.asse.devtunnels.ms"; 

// 音楽管理用の変数
let selectedMode = null; 
let currentAudio = new Audio();
let lastPlayedPath = "";

// AI画像生成管理用の変数
let isGenerating = false;
let lastGenQR = "";
let lastGenMaterial = "";
let isPlayingSound = false;

// 入力固定用の変数
let isInputLocked = false;
let lockedQRData = null;
let lockedMaterialType = null;

// ★Unlockモード用の制御変数
let unlockLastQR = "";
let unlockLastHtml = "";
let unlockFetching = false;
let unlockLastFetchAt = 0;
let latestQRData = null;
let latestTextureScore = 0;

// ホーム画面のボタンから呼び出す関数
window.startApp = function(mode) {
    selectedMode = mode;
    document.getElementById("home-screen").style.display = "none";
    document.getElementById("app-container").style.display = "block";
    
    // モードタイトル表示
    const titleElem = document.getElementById("mode-display-title");
    if(titleElem) {
        if (mode === 'info') titleElem.innerText = "URL変化モード";
        else if (mode === 'unlock') titleElem.innerText = "経年変化読み取りモード";
        else if (mode === 'music') titleElem.innerText = "音楽変調モード";
        else if (mode === 'instrument') titleElem.innerText = "楽器音色モード";
        else if (mode === 'image_gen') titleElem.innerText = "風景生成モード";
    }

    const unlockCtrl = document.getElementById("unlock-controls");
    const lockBtn = document.getElementById("lock-btn");
    
    if (mode === 'unlock') {
        if(unlockCtrl) unlockCtrl.style.display = "block";
        if(lockBtn) lockBtn.style.display = "none"; // 既存のロックボタンは隠す
    } else {
        if(unlockCtrl) unlockCtrl.style.display = "none";
        if(lockBtn) lockBtn.style.display = "inline-block"; // 他のモードでは戻す
    }

    // モード切り替え時に前の表示をリセット
    outputContent.innerText = "QRコードをスキャンしてください";
    if (musicControls) musicControls.style.display = "none";
    
    const existingImg = document.getElementById("ai-result-image");
    if (existingImg) existingImg.style.display = "none";
};

// --- カメラ起動処理 ---
navigator.mediaDevices.getUserMedia({ 
    video: { 
        facingMode: "environment",
        // width: { ideal: 1920 }, // 重い場合はコメントアウト推奨
        // height: { ideal: 1080 } 
    } 
})
.then((stream) => {
    video.srcObject = stream;
    video.setAttribute("playsinline", true);
    video.play();
    requestAnimationFrame(tick);
})
.catch(err => {
    console.error("カメラ起動エラー:", err);
    outputContent.innerText = "カメラエラー: " + err.message;
});

function tick() {
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
        // キャンバスサイズを映像に合わせる
        canvas.height = video.videoHeight;
        canvas.width = video.videoWidth;
        
        // 映像を描画
        canvasCtx.drawImage(video, 0, 0, canvas.width, canvas.height);
        let imageData = canvasCtx.getImageData(0, 0, canvas.width, canvas.height);
        
        // 変数初期化
        let finalQRData = null;
        let finalMaterial = null;
        let qrLocation = null;
        const lockBtn = document.getElementById("lock-btn");

        // ■ Unlockモード用：QR有無に関わらず、常にテクスチャ解析を行う
        let currentTextureScore = 0;
        if (selectedMode === "unlock") {
            currentTextureScore = calculateTextureScore(imageData);
        }

        if (isInputLocked) {
            // --- ロック中 ---
            finalQRData = lockedQRData;
            finalMaterial = lockedMaterialType;
            
            // 赤枠描画
            canvasCtx.strokeStyle = "red";
            canvasCtx.lineWidth = 10;
            canvasCtx.strokeRect(0, 0, canvas.width, canvas.height);
            
            if(finalMaterial) woodTypeElem.innerText = "🔒 " + finalMaterial;
            if (!finalQRData) outputContent.innerHTML = "<span style='color:red;'>⚠️ QR読み取り失敗 (再ロック推奨)</span>";

        } else {
            // --- ロックしていない時 ---
            
            // 1. 色の判定
            const avgColor = getSampleAreaColor(imageData);
            displayColorInfo(avgColor);
            finalMaterial = detectMaterial(avgColor);

            // 2. QRコード読み取り
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: "attemptBoth",
            });

            if (code) {
                finalQRData = code.data;
                qrLocation = code.location;
                drawRect(qrLocation, "#00FFFF");
            }
            
            // 3. データがあればロック用変数に一時保存
            if (finalQRData) lockedQRData = finalQRData;
            if (finalMaterial) lockedMaterialType = finalMaterial;

            // ボタン表示更新
            if (lockBtn) {
                if (lockedQRData) {
                    lockBtn.innerText = "🔓 検出値を固定する (OK!)";
                    lockBtn.style.backgroundColor = "#27ae60";
                    lockBtn.disabled = false;
                } else {
                    lockBtn.innerText = "⏳ QRコードを探しています...";
                    lockBtn.style.backgroundColor = "#95a5a6";
                }
            }
        }

        // --- モード別実行 ---
        const dataToUse = finalQRData || lockedQRData;
        const materialToUse = finalMaterial || lockedMaterialType;

        if (selectedMode === "unlock") {
            // Unlockモードは自動実行せず、変数と画面表示を更新するだけ
            latestTextureScore = currentTextureScore; // tick内で計算済みのスコア
            latestQRData = finalQRData;               // その瞬間のQR

            const previewElem = document.getElementById("live-preview");
            if (previewElem) {
                const qrStatus = finalQRData ? "OK" : "未検出";
                previewElem.innerText = `現在の深度: ${latestTextureScore}% (QR: ${qrStatus})`;
            }
        } 
        else if (dataToUse) {
            if (selectedMode === "music") runMusicMode(dataToUse, materialToUse);
            else if (selectedMode === "image_gen") runImageGenMode(dataToUse, materialToUse);
            else if (selectedMode === "instrument") runInstrumentMode(dataToUse, materialToUse);
            else handleQRData(dataToUse, materialToUse);
        }
    }

    // オーディオシークバー更新
    if (!currentAudio.paused && currentAudio.duration) {
        seekBar.max = currentAudio.duration;
        seekBar.value = currentAudio.currentTime;
    }

    requestAnimationFrame(tick);
}

// --- 経年変化読み取りモード ---
// ★追加: 解析ボタンを押したときの処理
document.getElementById("analyze-btn").addEventListener("click", async () => {
    const outputContent = document.getElementById("output-content");
    const score = latestTextureScore;
    const qr = latestQRData;

    if (!qr) {
        alert("QRコードが見つかりません");
        return;
    }

    // UIをロード中に
    outputContent.innerHTML = `⏳ 解析中... (深度: ${score}%)`;

    // サーバーへ問い合わせ
    try {
        const formData = new FormData();
        formData.append("qr_data", qr);
        
        // ★ご自身のURLに合わせてください
        const response = await fetch(`${BACKEND_URL}/get_item_info`, {
            method: "POST",
            body: formData
        });

        let itemData = null;
        if (response.ok) itemData = await response.json();
        if (!itemData) { try { itemData = JSON.parse(qr); } catch(e){} }

        // レベル判定
        let level = 1;
        let levelText = "(Lv.1 新品)";
        // ★判定基準
        if (score >= 50) { level = 3; levelText = "(Lv.3 激レア)"; }
        else if (score >= 20) { level = 2; levelText = "(Lv.2 並品)"; }

        // 表示データの準備
        let title = "未登録アイテム";
        let infoLv1 = "情報なし";
        let infoLv2 = "🔒 ロックされています";
        let infoLv3 = "🔒 ロックされています";

        if (itemData) {
            title = itemData.title || title;
            infoLv1 = itemData.lv1 || itemData.default || infoLv1;
            infoLv2 = itemData.lv2 || infoLv2;
            infoLv3 = itemData.lv3 || infoLv3;
        }

        // HTML生成
        let html = `<h3>📦 ${title}</h3>`;
        html += `<p><b>結果: ${score}% ${levelText}</b></p>`;
        html += `<div style="text-align:left; background:#fff; padding:10px; border-radius:5px;">`;
        html += `<p>✅ Lv.1: ${infoLv1}</p>`;

        if (level >= 2) html += `<p style="color:#d35400;">🔓 Lv.2: ${infoLv2}</p>`;
        else html += `<p style="color:#999;">🔒 Lv.2 (深度20%で解禁)</p>`;

        if (level >= 3) html += `<p style="color:#c0392b; font-weight:bold;">🗝️ Lv.3: ${infoLv3}</p>`;
        else html += `<p style="color:#999;">🔒 Lv.3 (深度50%で解禁)</p>`;
        
        html += `</div>`;

        outputContent.innerHTML = html;

    } catch (e) {
        outputContent.innerHTML = "通信エラー: " + e.message;
    }
});

// --- 他モードのfetchもDevTunnels URLに変更 ---

async function runMusicMode(qrData, material) {
    if (isGenerating || (qrData === lastGenQR && material === lastGenMaterial)) return;
    
    isGenerating = true; 
    lastGenQR = qrData;
    lastGenMaterial = material;

    outputContent.innerHTML = "🎵 音楽を生成中...<br><small>QR楽譜と樹種を解析しています</small>";
    if (musicControls) musicControls.style.display = "block";

    const formData = new FormData();
    formData.append("qr_data", qrData);
    formData.append("wood_type", material);

    try {
        // ★URL修正
        const response = await fetch(`${BACKEND_URL}/generate_music`, {
            method: "POST",
            body: formData
        });

        if (!response.ok) throw new Error("Server Error");
        const blob = await response.blob();
        const audioUrl = URL.createObjectURL(blob);
        
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.src = "";
        }
        currentAudio = new Audio(audioUrl);
        currentAudio.loop = true;
        currentAudio.play();
        
        let descText = "生成された楽曲";
        try {
            const json = JSON.parse(qrData);
            if(json.inst) descText = `楽器: ${json.inst}`;
        } catch(e) {}

        songInfo.innerHTML = `🎵 AI生成ミュージック<br><small>${descText} / 材質: ${material}</small>`;
        outputContent.innerHTML = `🎵 <b>演奏中</b><br><small>${descText} × ${getWoodTrait(material)}</small>`;

    } catch (e) {
        console.error(e);
        outputContent.innerText = "音楽生成エラー";
        lastGenQR = "";
    } finally {
        isGenerating = false;
    }
}

async function runImageGenMode(qrData, material) {
    if (qrData === lastGenQR && material === lastGenMaterial) return; 
    if (isGenerating) return;

    isGenerating = true;
    lastGenQR = qrData;
    lastGenMaterial = material;

    outputContent.innerHTML = "🎨 風景を生成中...<br><small>しばらくお待ちください</small>";

    const formData = new FormData();
    formData.append("qr_data", qrData);
    formData.append("wood_type", material);

    try {
        // ★URL修正
        const response = await fetch(`${BACKEND_URL}/generate`, {
            method: "POST",
            body: formData
        });

        if (!response.ok) throw new Error(`Server Error: ${response.statusText}`);

        const blob = await response.blob();
        const imageUrl = URL.createObjectURL(blob);

        outputContent.innerHTML = ""; 
        let img = document.getElementById("ai-result-image");
        if (!img) {
            img = document.createElement("img");
            img.id = "ai-result-image";
            img.style.maxWidth = "100%"; 
            img.style.borderRadius = "10px";
            img.style.marginTop = "10px";
            outputContent.appendChild(img);
        }
        
        img.src = imageUrl;
        img.style.display = "block";
        
        const caption = document.createElement("div");
        caption.innerHTML = `🌲 <b>${material}</b> の風景<br><small>QR: ${qrData}</small>`;
        outputContent.appendChild(caption);

    } catch (error) {
        console.error("AI生成エラー:", error);
        outputContent.innerText = "生成エラー: サーバーを確認してください";
        lastGenQR = ""; 
        lastGenMaterial = "";
    } finally {
        setTimeout(() => { isGenerating = false; }, 5000);
    }
}

async function runInstrumentMode(qrData, material) {
    if (isPlayingSound || (qrData === lastGenQR && material === lastGenMaterial)) return;
    
    isPlayingSound = true;
    lastGenQR = qrData;
    lastGenMaterial = material;
    
    outputContent.innerHTML = "🎻 音色を生成中...<br><small>樹種特性を解析しています</small>";

    const formData = new FormData();
    formData.append("qr_data", qrData);
    formData.append("wood_type", material);
    formData.append("instrument", "violin"); 

    try {
        // ★URL修正
        const response = await fetch(`${BACKEND_URL}/generate_sound`, {
            method: "POST",
            body: formData
        });

        if (!response.ok) throw new Error("Server Error");

        const blob = await response.blob();
        const audioUrl = URL.createObjectURL(blob);
        
        const audio = new Audio(audioUrl);
        audio.play();
        
        outputContent.innerHTML = `🎻 <b>${material}</b> の音色<br><small>特性: ${getWoodTrait(material)}</small>`;
        
        audio.onended = () => {
            setTimeout(() => { isPlayingSound = false; }, 2000);
        };

    } catch (e) {
        console.error(e);
        outputContent.innerText = "生成エラー: サーバーを確認してください";
        isPlayingSound = false;
        lastGenQR = ""; 
    }
}

function getWoodTrait(material) {
    if(material === "sugi") return "Warm / Soft (温かい・柔らかい)";
    if(material === "walnut") return "Rich / Balanced (豊か・バランス)";
    if(material === "kiri") return "Light / Resonant (軽い・響く)";
    return "Standard";
}

// プレイヤー操作イベント
document.getElementById("play-btn").onclick = () => currentAudio.play();
document.getElementById("pause-btn").onclick = () => currentAudio.pause();
document.getElementById("stop-btn").onclick = () => {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    seekBar.value = 0;
};
seekBar.oninput = () => {
    if (currentAudio.duration) {
        currentAudio.currentTime = seekBar.value;
    }
};

function drawRect(location, color) {
    canvasCtx.beginPath();
    canvasCtx.moveTo(location.topLeftCorner.x, location.topLeftCorner.y);
    canvasCtx.lineTo(location.topRightCorner.x, location.topRightCorner.y);
    canvasCtx.lineTo(location.bottomRightCorner.x, location.bottomRightCorner.y);
    canvasCtx.lineTo(location.bottomLeftCorner.x, location.bottomLeftCorner.y);
    canvasCtx.lineTo(location.topLeftCorner.x, location.topLeftCorner.y);
    canvasCtx.lineWidth = 4;
    canvasCtx.strokeStyle = color;
    canvasCtx.stroke();
}

function getSampleAreaColor(imageData) {
    const w = imageData.width;
    const h = imageData.height;
    const sampleY = Math.floor(h * 0.3); 
    const centerX = Math.floor(w / 2);
    const size = 40; 
    let r = 0, g = 0, b = 0, count = 0;
    const startY = Math.max(0, sampleY - size / 2);
    const endY = Math.min(h, sampleY + size / 2);
    const startX = Math.max(0, centerX - size / 2);
    const endX = Math.min(w, centerX + size / 2);
    for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
            const index = (Math.floor(y) * w + Math.floor(x)) * 4;
            r += imageData.data[index];
            g += imageData.data[index + 1];
            b += imageData.data[index + 2];
            count++;
        }
    }
    canvasCtx.strokeStyle = "yellow";
    canvasCtx.lineWidth = 3;
    canvasCtx.strokeRect(startX, startY, endX - startX, endY - startY);
    return { r: Math.floor(r / count), g: Math.floor(g / count), b: Math.floor(b / count) };
}

function displayColorInfo(color) {
    const { r, g, b } = color;
    const brightness = Math.floor((r + g + b) / 3);
    const redness = r - b;
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);
    rgbValElem.innerHTML = `R:${r} G:${g} B:${b}<br>明:${brightness} 赤:${redness} 彩:${saturation}`;
    colorPreview.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
}

function detectMaterial(color) {
    const { r, g, b } = color;
    const brightness = (r + g + b) / 3;
    const redness = r - b;

    if (g > r + 10) return displayResult("除外 (Green)", "#ccc", "default");
    if (b > r) return displayResult("除外 (Blue)", "#ccc", "default");
    if (r - g > 70) return displayResult("除外 (Vivid Red)", "#ccc", "default");

    if (brightness > 220 || redness < 15) { 
        return displayResult(`キリ`, "#f0e68c", "kiri");
    }
    else if (redness > 35 || brightness < 155) { 
        // ★修正: 返却値を kurumi から walnut に変更して統一
        return displayResult(`クルミ`, "#5d4037", "walnut");
    }
    else {
        return displayResult(`スギ`, "#d35400", "sugi");
    }
}

function displayResult(text, colorCode, materialKey) {
    woodTypeElem.innerText = text;
    woodTypeElem.style.color = colorCode;
    return materialKey;
}

function handleQRData(dataString, material) {
    try {
        const dataObj = JSON.parse(dataString);
        let content = dataObj[material] || dataObj["default"] || "データなし";
        renderContent(content);
    } catch (e) {
        outputContent.innerText = dataString;
    }
}

function renderContent(content) {
    if (content.startsWith("http")) {
         outputContent.innerHTML = `<a href="${content}" target="_blank" style="font-size: 20px;">🔗 リンクを開く</a><br><small>${content}</small>`;
    } else {
        outputContent.innerText = content;
    }
}

window.toggleInputLock = function() {
    const btn = document.getElementById("lock-btn");
    
    if (isInputLocked) {
        isInputLocked = false;
        lockedQRData = null;
        lockedMaterialType = null;
        btn.innerText = "⏳ QRコードを探しています...";
        btn.style.backgroundColor = "#95a5a6"; 
    } else {
        if (!lockedQRData) {
            alert("QRコードがまだ読み取れていません！\n水色の枠が出るまでかざしてください。");
            return;
        }
        isInputLocked = true;
        btn.innerText = "🔒 固定中（手を離してOK）";
        btn.style.backgroundColor = "#e74c3c";
    }
};

function calculateTextureScore(imageData) {
    const w = imageData.width;
    const h = imageData.height;
    const sampleY = Math.floor(h * 0.3); 
    const size = 40; 
    const startX = Math.max(0, Math.floor(w / 2) - size / 2);
    const startY = Math.max(0, sampleY - size / 2);
    const endX = Math.min(w, Math.floor(w / 2) + size / 2);
    const endY = Math.min(h, sampleY + size / 2);

    let luminances = [];
    let sum = 0;

    for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
            const i = (Math.floor(y) * w + Math.floor(x)) * 4;
            const r = imageData.data[i];
            const g = imageData.data[i + 1];
            const b = imageData.data[i + 2];
            
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            luminances.push(lum);
            sum += lum;
        }
    }

    if (luminances.length === 0) return 0;

    const mean = sum / luminances.length;
    let varianceSum = 0;
    for (let l of luminances) {
        varianceSum += Math.pow(l - mean, 2);
    }
    const stdDev = Math.sqrt(varianceSum / luminances.length);

    let score = Math.min(100, (stdDev * 1.0)); 
    return Math.floor(score);
}