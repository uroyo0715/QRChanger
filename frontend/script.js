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

// AI画像生成管理用の変数
let isGenerating = false;      // 生成中フラグ
let lastGenQR = "";            // 直前に生成したQRデータ
let lastGenMaterial = "";      // 直前に生成した樹種
let isPlayingSound = false;    // 演奏中フラグ

// 入力固定用の変数
let isInputLocked = false;
let lockedQRData = null;
let lockedMaterialType = null;

// ホーム画面のボタンから呼び出す関数
window.startApp = function(mode) {
    selectedMode = mode;
    document.getElementById("home-screen").style.display = "none";
    document.getElementById("app-container").style.display = "block";
    
    // モードタイトル表示
    const titleElem = document.getElementById("mode-display-title");
    if(titleElem) {
        if (mode === 'info') titleElem.innerText = "樹種モード";
        else if (mode === 'music') titleElem.innerText = "音楽変調モード";
        else if (mode === 'instrument') titleElem.innerText = "楽器音色モード";
        else if (mode === 'image_gen') titleElem.innerText = "風景生成モード";
    }

    // モード切り替え時に前の表示をリセット
    outputContent.innerText = "QRコードをスキャンしてください";
    if (musicControls) musicControls.style.display = "none";
    
    // AI画像の表示領域があれば消す
    const existingImg = document.getElementById("ai-result-image");
    if (existingImg) existingImg.style.display = "none";
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

        let finalQRData = null;
        let finalMaterial = null;
        let qrLocation = null;

        if (isInputLocked) {
            // ■ ロック中: 保存された値を使う
            finalQRData = lockedQRData;
            finalMaterial = lockedMaterialType;
            
            // ロック中は画面に「固定中」とわかるように枠などを出す
            canvasCtx.strokeStyle = "red";
            canvasCtx.lineWidth = 10;
            canvasCtx.strokeRect(0, 0, canvas.width, canvas.height);
            
            // 色情報などは更新しない（固定時のまま）
            if(finalMaterial) {
                woodTypeElem.innerText = "🔒 " + finalMaterial;
            }

        } else {
            //カメラから解析する
            const imageData = canvasCtx.getImageData(0, 0, canvas.width, canvas.height);

            // 1. 色の判定
            const avgColor = getSampleAreaColor(imageData);
            displayColorInfo(avgColor);
            finalMaterial = detectMaterial(avgColor);

            // 2. QRコード読み取り
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: "dontInvert",
            });

            if (code) {
                finalQRData = code.data;
                qrLocation = code.location;
                drawRect(qrLocation, "#00FFFF");
            }
            
            // 3. ロック用に現在の値を一時保存しておく
            // (ロックボタンが押された瞬間のために、常に最新を入れ続ける)
            if (finalQRData) lockedQRData = finalQRData;
            if (finalMaterial) lockedMaterialType = finalMaterial;
        }

        // --- 共通処理: データがあれば各モードを実行 ---
        if (finalQRData) {
            if (selectedMode === "music") {
                runMusicMode(finalQRData, finalMaterial);
            } else if (selectedMode === "image_gen") {
                runImageGenMode(finalQRData, finalMaterial);
            } else if (selectedMode === "instrument") {
                runInstrumentMode(finalQRData, finalMaterial); 
            } else {
                handleQRData(finalQRData, finalMaterial);
            }
        }
        // --- ★書き換えここまで ---
    }

    // 再生中にシークバーを更新
    if (!currentAudio.paused && currentAudio.duration) {
        seekBar.max = currentAudio.duration;
        seekBar.value = currentAudio.currentTime;
    }

    requestAnimationFrame(tick);
}

// --- 音楽変調 ---
async function runMusicMode(qrData, material) {
    // 連打防止
    if (isGenerating || (qrData === lastGenQR && material === lastGenMaterial)) {
        return;
    }
    
    isGenerating = true; // 生成中フラグをON
    lastGenQR = qrData;
    lastGenMaterial = material;

    // UI表示更新
    outputContent.innerHTML = "🎵 音楽を生成中...<br><small>QR楽譜と樹種を解析しています</small>";
    if (musicControls) musicControls.style.display = "block"; // プレイヤー表示

    const formData = new FormData();
    formData.append("qr_data", qrData);
    formData.append("wood_type", material);

    try {
        const response = await fetch("http://localhost:8000/generate_music", {
            method: "POST",
            body: formData
        });

        if (!response.ok) throw new Error("Server Error");

        const blob = await response.blob();
        const audioUrl = URL.createObjectURL(blob);
        
        // 生成された音楽を再生
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.src = "";
        }
        currentAudio = new Audio(audioUrl);
        currentAudio.loop = true;
        currentAudio.play();
        
        // 画面表示
        let descText = "生成された楽曲";
        try {
            // QRがJSONなら中身を表示
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
        // 生成完了したらフラグ解除
        isGenerating = false;
    }
}

// 風景生成モードの処理 ---
async function runImageGenMode(qrData, material) {
    // 既に同じ組み合わせで生成済みなら何もしない（連打防止）
    if (qrData === lastGenQR && material === lastGenMaterial) {
        return; 
    }
    // 生成中なら何もしない
    if (isGenerating) {
        return;
    }

    isGenerating = true;
    lastGenQR = qrData;
    lastGenMaterial = material;

    outputContent.innerHTML = "🎨 風景を生成中...<br><small>しばらくお待ちください</small>";

    // サーバーに送るデータ
    const formData = new FormData();
    formData.append("qr_data", qrData);
    formData.append("wood_type", material);

    try {
        // Pythonバックエンドへ送信
        const response = await fetch("http://localhost:8000/generate", {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Server Error: ${response.statusText}`);
        }

        // 画像データの受け取り
        const blob = await response.blob();
        const imageUrl = URL.createObjectURL(blob);

        // 既存のコンテンツをクリアして画像を表示
        outputContent.innerHTML = ""; 
        
        let img = document.getElementById("ai-result-image");
        if (!img) {
            img = document.createElement("img");
            img.id = "ai-result-image";
            img.style.maxWidth = "100%"; // 画面幅に合わせる
            img.style.borderRadius = "10px";
            img.style.marginTop = "10px";
            // output-contentの中に追加
            outputContent.appendChild(img);
        }
        
        img.src = imageUrl;
        img.style.display = "block";
        
        // テキストも追加
        const caption = document.createElement("div");
        caption.innerHTML = `🌲 <b>${material}</b> の風景<br><small>QR: ${qrData}</small>`;
        outputContent.appendChild(caption);

    } catch (error) {
        console.error("AI生成エラー:", error);
        outputContent.innerText = "生成エラー: サーバーを確認してください";
        // エラー時はリセットして再試行できるようにする
        lastGenQR = ""; 
        lastGenMaterial = "";
    } finally {
        // クールタイム（5秒間は次の生成をしない）
        setTimeout(() => {
            isGenerating = false;
        }, 5000);
    }
}

// 楽器音色モードの処理
async function runInstrumentMode(qrData, material) {
    // 連打防止
    if (isPlayingSound || (qrData === lastGenQR && material === lastGenMaterial)) {
        return;
    }
    
    isPlayingSound = true;
    lastGenQR = qrData;
    lastGenMaterial = material;
    
    outputContent.innerHTML = "🎻 音色を生成中...<br><small>樹種特性を解析しています</small>";

    const formData = new FormData();
    formData.append("qr_data", qrData);
    formData.append("wood_type", material);
    formData.append("instrument", "violin"); // 必要に応じて変更可

    try {
        const response = await fetch("http://localhost:8000/generate_sound", {
            method: "POST",
            body: formData
        });

        if (!response.ok) throw new Error("Server Error");

        const blob = await response.blob();
        const audioUrl = URL.createObjectURL(blob);
        
        // 生成された音声を再生
        const audio = new Audio(audioUrl);
        audio.play();
        
        outputContent.innerHTML = `🎻 <b>${material}</b> の音色<br><small>特性: ${getWoodTrait(material)}</small>`;
        
        // 再生が終わったらロック解除（連打防止用）
        audio.onended = () => {
            // 少し余韻を持たせてから解除
            setTimeout(() => { isPlayingSound = false; }, 2000);
        };

    } catch (e) {
        console.error(e);
        outputContent.innerText = "生成エラー: サーバーを確認してください";
        isPlayingSound = false;
        lastGenQR = ""; // エラー時はリトライ可能に
    }
}

// 画面表示用のヘルパー関数
function getWoodTrait(material) {
    if(material === "sugi") return "Warm / Soft (温かい・柔らかい)";
    if(material === "walnut") return "Rich / Balanced (豊か・バランス)";
    if(material === "kiri") return "Light / Resonant (軽い・響く)";
    return "Standard";
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

//固定ボタンが押されたときの処理
window.toggleInputLock = function() {
    const btn = document.getElementById("lock-btn");
    
    if (isInputLocked) {
        // ロック解除（カメラ入力に戻す）
        isInputLocked = false;
        lockedQRData = null;
        lockedMaterialType = null;
        btn.innerText = "🔓 検出値を固定する";
        btn.style.backgroundColor = "#7f8c8d"; // グレーに戻す
    } else {
        // 現在の状態をロックする
        // 直近の認識結果がない場合はロックさせないなどの判定も可能ですが、
        // ここでは単純に今の変数を保存します
        isInputLocked = true;
        btn.innerText = "🔒 固定中（手を離してOK）";
        btn.style.backgroundColor = "#e74c3c"; // 赤色で強調
    }
};