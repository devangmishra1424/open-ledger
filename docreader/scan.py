"""Making a page image fit for OCR, the way a scanner app does: find the page in a photo and flatten its
perspective, straighten a skewed scan, even out uneven light, and bring small images up to a resolution OCR
reads well.

Every function returns the steps it actually took, in plain words, so a reading can say what was done to the
page instead of quietly changing it. Nothing here guesses content: these are geometric and lighting fixes only.
"""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image

# OCR (RapidOCR) reads best at roughly 200-300 dpi for A4 text; below this width a page is upscaled.
MIN_PAGE_WIDTH_PX = 1700
# A skew smaller than this is left alone (rotating costs sharpness); larger than MAX is not a skew but a
# sideways page, which this module does not try to fix.
MIN_SKEW_DEG = 0.3
MAX_SKEW_DEG = 8.0


def to_gray(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert("L"))


def _order_corners(pts: np.ndarray) -> np.ndarray:
    """Top-left, top-right, bottom-right, bottom-left."""
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], dtype=np.float32)


def find_page(gray: np.ndarray) -> np.ndarray | None:
    """The four corners of a sheet of paper in a photo, or None when no clear page edge is found (a scan or a
    screenshot, where the page IS the image, or a photo cropped to the page already).

    A page is the largest four-sided outline covering 30-97% of the image: smaller is a table or a logo, larger is
    the image border itself.
    """
    h, w = gray.shape
    scale = 1000.0 / max(h, w)
    small = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else gray.copy()
    blurred = cv2.GaussianBlur(small, (5, 5), 0)
    edges = cv2.Canny(blurred, 40, 120)
    edges = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)), iterations=2)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    area = small.shape[0] * small.shape[1]
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) != 4:
            continue
        share = cv2.contourArea(approx) / area
        if 0.30 <= share <= 0.97:
            return _order_corners(approx.reshape(4, 2).astype(np.float32) / (scale if scale < 1 else 1.0))
    return None


def flatten_perspective(gray: np.ndarray, corners: np.ndarray) -> np.ndarray:
    tl, tr, br, bl = corners
    width = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    height = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    target = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(corners, target)
    return cv2.warpPerspective(gray, matrix, (width, height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def estimate_skew(gray: np.ndarray) -> float:
    """The page's skew in degrees (positive = counter-clockwise), by projection profile: text lines are sharpest
    (the row sums vary most) when the page is level. Searched in a downscaled, binarised copy for speed."""
    h, w = gray.shape
    scale = 900.0 / w if w > 900 else 1.0
    small = cv2.resize(gray, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else gray
    _, binary = cv2.threshold(small, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    center = (binary.shape[1] / 2, binary.shape[0] / 2)

    def sharpness(angle: float) -> float:
        m = cv2.getRotationMatrix2D(center, angle, 1.0)
        rotated = cv2.warpAffine(binary, m, (binary.shape[1], binary.shape[0]), flags=cv2.INTER_NEAREST, borderValue=0)
        return float(np.var(rotated.sum(axis=1)))

    coarse = max(np.arange(-MAX_SKEW_DEG, MAX_SKEW_DEG + 0.01, 0.5), key=sharpness)
    fine = max(np.arange(coarse - 0.5, coarse + 0.51, 0.1), key=sharpness)
    return float(round(fine, 2))


def rotate(gray: np.ndarray, angle: float) -> np.ndarray:
    h, w = gray.shape
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    cos, sin = abs(m[0, 0]), abs(m[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    m[0, 2] += nw / 2 - w / 2
    m[1, 2] += nh / 2 - h / 2
    return cv2.warpAffine(gray, m, (nw, nh), flags=cv2.INTER_CUBIC, borderValue=255)


def even_lighting(gray: np.ndarray) -> np.ndarray:
    """Divides out the page's background brightness (estimated by a wide median), so a shadow or a bright corner
    becomes plain white paper and the text keeps its contrast. The window is an eighth of the page: wide enough that
    a dark table-header band (white text on a dark fill) is treated as print, not as background, and keeps its
    contrast; a narrower window flattened such a band to grey and the OCR lost the header row."""
    k = max(31, (min(gray.shape) // 8) | 1)
    background = cv2.medianBlur(cv2.resize(gray, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA), k // 4 | 1)
    background = cv2.resize(background, (gray.shape[1], gray.shape[0]), interpolation=cv2.INTER_CUBIC)
    flat = cv2.divide(gray, np.maximum(background, 1), scale=255)
    return flat


def lighting_is_uneven(gray: np.ndarray) -> bool:
    """True when the paper's brightness varies across the page by more than a scanner's would (photos, shadows)."""
    small = cv2.resize(gray, (64, 64), interpolation=cv2.INTER_AREA)
    background = cv2.dilate(small, np.ones((9, 9), np.uint8))  # text removed, paper kept
    return float(np.percentile(background, 95) - np.percentile(background, 5)) > 25


def upscale_if_small(gray: np.ndarray) -> tuple[np.ndarray, float]:
    h, w = gray.shape
    if w >= MIN_PAGE_WIDTH_PX:
        return gray, 1.0
    factor = MIN_PAGE_WIDTH_PX / w
    return cv2.resize(gray, (MIN_PAGE_WIDTH_PX, int(h * factor)), interpolation=cv2.INTER_CUBIC), factor


def prepare_page(img: Image.Image, *, photo: bool) -> tuple[Image.Image, list[str]]:
    """One page made ready for OCR. `photo` = it came as a camera/image file (look for the page edges and uneven
    light); otherwise it is a scanned PDF page (straighten and clean only). Returns the page and the steps taken."""
    steps: list[str] = []
    gray = to_gray(img)

    if photo:
        corners = find_page(gray)
        if corners is not None:
            gray = flatten_perspective(gray, corners)
            steps.append("found the page edges and flattened the perspective")

    gray, factor = upscale_if_small(gray)
    if factor > 1.01:
        steps.append(f"upscaled {factor:.1f}x for OCR (the image was small)")

    angle = estimate_skew(gray)
    if MIN_SKEW_DEG <= abs(angle) < MAX_SKEW_DEG:
        gray = rotate(gray, angle)
        steps.append(f"straightened a {abs(angle):.1f}° skew")

    if photo or lighting_is_uneven(gray):
        gray = even_lighting(gray)
        steps.append("evened out the lighting")

    return Image.fromarray(gray, "L"), steps
