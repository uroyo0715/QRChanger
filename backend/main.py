import io
import torch
import scipy.io.wavfile as wav
import numpy as np
import json
from fastapi import FastAPI, File, UploadFile, Form
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from diffusers import StableDiffusionControlNetPipeline, ControlNetModel, UniPCMultistepScheduler
from PIL import Image
from diffusers import AudioLDMPipeline
from fastapi.responses import JSONResponse

# === 設定エリア ===
# GPU設定
device = "cuda"
dtype = torch.float16

# 保存した構図画像のパス
LAYOUT_MAP = {
    "layout_A": "control_images/layout_A.png", 
}

# 経年変化モード用データベース
ITEM_DATABASE = {
    "chair009": {
        "title": "プロトタイプ - 椅子 No.009",
        "lv1": "【公式説明】人間工学に基づき、3Dプリント技術と伝統工芸を融合させた次世代の椅子。座り心地を追求したカーブが特徴です。",
        "lv2": "【開発日誌】正直に言うと、このカーブは計算して作ったわけじゃない。コーヒーをこぼして図面が歪んだのを『これだ！』と勘違いして採用してしまったんだ。",
        "lv3": "【極秘メモ】実は耐久テストで一度大破している。社長には『斬新なデザインのための空洞です』と嘘をついて誤魔化した。絶対に飛び跳ねないでくれよ…絶対にだぞ。"
    },
    
    "art01": {
        "title": "作品名：『無題』",
        "lv1": "2025年作。北海道産のナラ材を使用。素材の持つ力強さを最大限に引き出すため、あえて塗装を最小限に抑えています。",
        "lv2": "若い頃の私は、技術を見せつけることばかり考えていた。だが、この木に出会って気づいたんだ。俺が削るんじゃない、木が『こうなりたい』と言っている形にするだけだと。",
        "lv3": "君がこのメッセージを読んでいるということは、この作品はもうボロボロになっているだろう。だが、それこそが私の望んだ『完成』だ。傷の数だけ、誰かの生活に寄り添えたのだから。"
    }
}

# 樹種ごとのプロンプト設定
WOOD_PROMPTS = {
    # スギ
    "sugi": (
        "Dense Japanese cedar forest, straight tall vertical trunks, "
        "mossy green rocks, spiritual atmosphere like Yakushima, "
        "misty morning light, sunbeams filtering through trees, "
        "hyper realistic, 8k resolution, raw photo, national geographic"
    ),

    # クルミ
    "walnut": (
        "Majestic walnut forest, rich dark brown bark, golden autumn leaves, "
        "warm sunset lighting, cinematic depth of field, elegant atmosphere, "
        "falling leaves, detailed texture, photorealistic, masterpiece"
    ),

    # ナラ
    "oak": (
        "Giant ancient oak tree with sprawling twisted branches, "
        "sunny open meadow, vivid green grass, clear blue sky, "
        "strong contrast, sharp focus, summer midday, "
        "highly detailed nature photography, uncompressed"
    ),
}

# 樹種ごとの音響特性データ
WOOD_ACOUSTICS = {
    "sugi": {
        "density": "low",
        "adjectives": "warm, soft, gentle, mellow, wooden resonance",
        "desc": "日本のスギ：温かみのある柔らかい音色"
    },
    "walnut": {
        "density": "medium",
        "adjectives": "rich, earthy, deep, balanced, complex overtones",
        "desc": "クルミ：深みとバランスのある豊かな音色"
    },
    "kiri": {
        "density": "high",
        "adjectives": "bright, sharp, clear, strong attack, crisp",
        "desc": "キリ：明るくはっきりとした力強い音色"
    },
    "default": {
        "density": "medium",
        "adjectives": "standard acoustic, clear",
        "desc": "標準的な音色"
    }
}

app = FastAPI()

# フロントエンドからのアクセスを許可
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

print("--- AIモデルを読み込み中 (これには数分かかります) ---")

# 1. ControlNetの読み込み
# 今回はセグメンテーションモデルを使います
controlnet = ControlNetModel.from_pretrained(
    "lllyasviel/sd-controlnet-seg",
    torch_dtype=dtype
)

# 2. Stable Diffusion の読み込み
pipe = StableDiffusionControlNetPipeline.from_pretrained(
    "runwayml/stable-diffusion-v1-5",
    controlnet=controlnet,
    torch_dtype=dtype,
    safety_checker=None  # メモリ節約のためセーフティフィルター無効化
)

# 省メモリ設定
pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config)
pipe.enable_model_cpu_offload() # 使わない部品をCPUに逃がす
pipe.enable_vae_slicing()       # 画像処理を分割してメモリ節約

# 3. AudioLDM の読み込み
print("--- AudioLDMモデルを読み込み中 ---")
audio_pipe = AudioLDMPipeline.from_pretrained(
    "cvssp/audioldm-s-full-v2",
    torch_dtype=dtype
).to(device)

print("--- 準備完了！サーバーを起動します ---")

@app.post("/generate")
async def generate_image(
    qr_data: str = Form(...),         # QRコードのデータ
    wood_type: str = Form(...),       # 樹種
):
    print(f"★リクエスト受信: QR={qr_data}, 樹種={wood_type}")

    # 1. 構図画像の決定
    # QRデータに対応する画像がなければ、デフォルトで 'layout_A' を使う
    layout_path = LAYOUT_MAP.get(qr_data, LAYOUT_MAP["layout_A"])
    
    try:
        # 画像を読み込んでサイズ調整
        control_image = Image.open(layout_path).convert("RGB").resize((512, 512))
    except FileNotFoundError:
        print(f"エラー: 構図画像が見つかりません: {layout_path}")
        return Response(status_code=500, content="Layout image not found")

    # 2. プロンプトの決定
    prompt = WOOD_PROMPTS.get(wood_type, "A beautiful forest landscape")
    negative_prompt = "low quality, bad anatomy, worst quality, blurry"

    # 3. 画像生成実行
    generator = torch.Generator(device="cpu").manual_seed(torch.randint(0, 1000000, (1,)).item())

    image = pipe(
        prompt=prompt,
        image=control_image,
        negative_prompt=negative_prompt,
        num_inference_steps=20, 
        guidance_scale=7.5,
        generator=generator,
    ).images[0]

    # 4. 画像をバイナリ変換して返却
    img_byte_arr = io.BytesIO()
    image.save(img_byte_arr, format='PNG')
    return Response(content=img_byte_arr.getvalue(), media_type="image/png")

@app.post("/get_item_info")
async def get_item_info(qr_data: str = Form(...)):
    print(f"★アイテム検索リクエスト: {qr_data}")
    
    target_id = None
    
    # 1. JSON形式として解析を試みる
    try:
        data = json.loads(qr_data)
        if isinstance(data, dict) and "id" in data:
            target_id = data["id"]
    except:
        pass
    
    # 2. JSONじゃなければ、文字列全体をIDとして扱う
    if not target_id:
        target_id = qr_data.strip()

    # 3. データベース検索
    if target_id in ITEM_DATABASE:
        print(f"  -> ID一致: {target_id}")
        return JSONResponse(content=ITEM_DATABASE[target_id])
    
    # 4. 【追加】見つからない場合も、デモ用に「chair009」を返す (開発用)
    print(f"  -> ID不一致({target_id})のため、デモデータを返却します")
    
    # デモデータであることをタイトルに追加して返す
    demo_data = ITEM_DATABASE["chair009"].copy()
    demo_data["title"] = f"【Demo】{demo_data['title']}"
    
    return JSONResponse(content=demo_data)

@app.post("/generate_sound")
async def generate_sound(
    qr_data: str = Form(...),
    wood_type: str = Form(...),
    instrument: str = Form("violin") # デフォルトはバイオリン
):
    print(f"★音声生成リクエスト: 樹種={wood_type}, 楽器={instrument}")

    # 1. 樹種特性の取得
    acoustics = WOOD_ACOUSTICS.get(wood_type, WOOD_ACOUSTICS["default"])
    adjectives = acoustics["adjectives"]
    
    # 2. プロンプト作成
    prompt = (
        f"A high quality recording of a single {instrument} note, "
        f"{adjectives}, made of specific tonewood, "
        f"photorealistic sound, 44.1kHz"
    )
    
    negative_prompt = "noise, distortion, low quality, electronic, synth, robotic"

    # 3. 生成実行
    # audio_length_in_s で長さを指定
    audio = audio_pipe(
        prompt=prompt,
        negative_prompt=negative_prompt,
        num_inference_steps=10, 
        audio_length_in_s=5.0
    ).audios[0]

    # 4. Wav形式で返却
    # float配列(-1〜1)を16bit整数に変換
    audio_data = (audio * 32767).astype(np.int16)
    
    wav_io = io.BytesIO()
    wav.write(wav_io, 16000, audio_data)
    
    return Response(content=wav_io.getvalue(), media_type="audio/wav")


# 音楽生成モード (QRを楽譜として利用)
@app.post("/generate_music")
async def generate_music(
    qr_data: str = Form(...),
    wood_type: str = Form(...)
):
    print(f"★音楽生成リクエスト: 樹種={wood_type}, QR楽譜={qr_data}")

    # 1. 樹種特性の取得
    acoustics = WOOD_ACOUSTICS.get(wood_type, WOOD_ACOUSTICS["default"])
    wood_adjectives = acoustics["adjectives"]
    
    # 2. QRコードの解析
    target_instrument = "piano"
    target_pitch = "medium tempo"
    target_mood = "harmonious"
    
    try:
        data = json.loads(qr_data)
        if "inst" in data: target_instrument = data["inst"]
        if "pitch" in data: target_pitch = data["pitch"]
        if "mood" in data: target_mood = data["mood"]
    except json.JSONDecodeError:
        target_mood = qr_data

    # 3. プロンプト作成 (ここを大幅強化！)
    # "Instrumental, no vocals" を先頭に入れて歌声を阻止
    # 樹種の特徴(wood_adjectives)を楽器の直前に置いて、音色への影響を強める
    prompt = (
        f"High quality instrumental recording, no vocals. "
        f"A {target_instrument} solo with {wood_adjectives} tone. "
        f"The music is {target_mood} and {target_pitch}. "
        f"Clear sound, high fidelity, 44.1kHz, studio quality, reverb"
    )
    
    # ネガティブプロンプトでノイズと歌声を徹底排除
    negative_prompt = (
        "vocals, singing, voice, human voice, speech, talking, "
        "distortion, noise, crackle, static, low quality, low fidelity, "
        "worst quality, blurry sound"
    )

    print(f"  -> 生成プロンプト: {prompt}")

    # 4. 生成実行
    audio = audio_pipe(
        prompt=prompt,
        negative_prompt=negative_prompt,
        num_inference_steps=30,  # ★ 10→30に変更 (計算時間を増やして質を上げる)
        guidance_scale=3.5,      # ★ AIの創造性を少し抑えて、指示通りにする
        audio_length_in_s=10.0
    ).audios[0]

    # 5. Wav形式で返却 (音割れ防止の正規化を追加)
    # 最大音量が大きすぎる場合に備えて少しマージンを取る
    max_val = np.abs(audio).max()
    if max_val > 0:
        audio = audio / max_val * 0.9  # 0.9倍に抑える

    audio_data = (audio * 32767).astype(np.int16)
    wav_io = io.BytesIO()
    wav.write(wav_io, 16000, audio_data)
    
    return Response(content=wav_io.getvalue(), media_type="audio/wav")