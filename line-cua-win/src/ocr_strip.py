import sys
from PIL import Image
import driver_post
img = Image.open(sys.argv[1])
W, H = img.size
# composer strip = bottom of the conversation pane (right ~60% of width)
crop = img.crop((int(0.32 * W), H - 78, int(0.92 * W), H - 8))
print("composer OCR:", repr(driver_post.ocr_pil(crop)))
