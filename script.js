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

// 音楽管理用の変数
let selectedMode = null; 
let currentAudio = new Audio();
let lastPlayedPath = "";

// ホーム画面のボタンから呼び出す関数
window.startApp = function(mode) {
    selectedMode = mode;
    document.getElementById("home-screen").style.display = "none";
    document.getElementById("app-container").style.display = "block";
    
    // モードタイトル表示
    const titleElem = document.getElementById("mode-display-title");
    if(titleElem) {
        titleElem.innerText = mode === 'info' ? "樹種モード" : "音楽変調モード";
    }
};

// --- カメラ起動処理 ---
navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
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
        canvas.height = video.videoHeight;
        canvas.width = video.videoWidth;
        
        // ビデオを描画
        canvasCtx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const imageData = canvasCtx.getImageData(0, 0, canvas.width, canvas.height);

        // 色の判定
        const avgColor = getSampleAreaColor(imageData);
        displayColorInfo(avgColor);
        const currentMaterial = detectMaterial(avgColor);

        // QRコード読み取り
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: "dontInvert",
        });

        if (code) {
            // QRコードの読み取り時、水色の枠を描画
            drawRect(code.location, "#00FFFF");
            
            // モード別の分岐
            if (selectedMode === "music") {
                runMusicMode(code.data, currentMaterial);
            } else {
                handleQRData(code.data, currentMaterial);
            }
        }
    }

    // 再生中にシークバーを更新
    if (!currentAudio.paused && currentAudio.duration) {
        seekBar.max = currentAudio.duration;
        seekBar.value = currentAudio.currentTime;
    }

    requestAnimationFrame(tick);
}

// --- 音楽変調 ---
function runMusicMode(qrData, material) {
    const songEntry = musicDatabase[qrData];
    if (songEntry) {
        const audioPath = songEntry.variations[material] || songEntry.variations["default"];
        
        // パネルを表示
        if (musicControls) musicControls.style.display = "block";

        if (audioPath && audioPath !== lastPlayedPath) {
            lastPlayedPath = audioPath;
            currentAudio.src = audioPath;
            currentAudio.loop = true;
            currentAudio.play().catch(err => console.warn("再生待機中...", err));
            
            if (songInfo) songInfo.innerHTML = `🎵 ${songEntry.title}<br><small>材質[${material}]に合わせて変調中</small>`;
            outputContent.innerText = "音楽再生モード実行中";
        }
    } else {
        outputContent.innerText = "楽曲ID未登録: " + qrData;
    }
}

// --- プレイヤー操作イベントの登録 ---
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
    
    // 基本パラメータ
    const brightness = (r + g + b) / 3;
    const redness = r - b;

    // デバッグ用
    console.log(`明:${Math.floor(brightness)} 赤:${redness}`);

    // --- 人工物除外 ---
    if (g > r + 10) return displayResult("除外 (Green)", "#ccc", "default");
    if (b > r) return displayResult("除外 (Blue)", "#ccc", "default");
    if (r - g > 70) return displayResult("除外 (Vivid Red)", "#ccc", "default");

    // キリ 
    if (brightness > 220 || redness < 15) { 
        return displayResult(`キリ`, "#f0e68c", "kiri");
    }

    // クルミ
    else if (redness > 35 || brightness < 155) { 
        return displayResult(`クルミ`, "#5d4037", "kurumi");
    }

    // スギ
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