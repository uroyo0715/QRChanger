import io
import torch
from fastapi import FastAPI, File, UploadFile, Form
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from diffusers import StableDiffusionControlNetPipeline, ControlNetModel, UniPCMultistepScheduler
from PIL import Image

# === 設定エリア ===
# GPU設定
device = "cuda"
dtype = torch.float16

# 保存した構図画像のパス
LAYOUT_MAP = {
    "layout_A": "control_images/layout_A.png", 
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
        generator=generator,  # ★これを追加！
    ).images[0]

    # 4. 画像をバイナリ変換して返却
    img_byte_arr = io.BytesIO()
    image.save(img_byte_arr, format='PNG')
    return Response(content=img_byte_arr.getvalue(), media_type="image/png")