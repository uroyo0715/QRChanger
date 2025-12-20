import torch

print("-" * 30)
if torch.cuda.is_available():
    print("★ 成功！GPUが認識されています ★")
    print(f"GPU名: {torch.cuda.get_device_name(0)}")
else:
    print("▲ 注意：GPUが認識されていません")
print("-" * 30)