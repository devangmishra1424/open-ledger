"""The document reader: what kind of file is it, can the page be made fit for OCR, and does a real read of each
kind of invoice come back with its key figures. The last group runs the real Docling/OCR models on the generated
test set (eval/documents/invoices, built by eval/documents/generate.py), so it is slow (about a minute) but it
tests the thing itself, not a mock of it.

    docreader/.venv/Scripts/python -m pytest docreader/tests -q
"""

from __future__ import annotations

import io
import json
import math
import sys
from pathlib import Path

import importlib.util

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import reader  # noqa: E402
import scan  # noqa: E402

INVOICES = Path(__file__).resolve().parents[2] / "eval" / "documents" / "invoices"


def _squash(s: str) -> str:
    return "".join(s.split()).lower()


# ------------------------------------------------------------------------------------------------ file type
@pytest.mark.parametrize(
    "head, name, kind",
    [
        (b"%PDF-1.7\n", "x.pdf", "pdf"),
        (b"\x89PNG\r\n\x1a\n" + b"0" * 8, "x.png", "image"),
        (b"\xff\xd8\xff\xe0" + b"0" * 12, "photo.JPG", "image"),
        (b"%PDF-1.4\n", "named-wrong.jpg", "pdf"),  # the content decides, not the name
        (b"PK\x03\x04" + b"0" * 12, "invoice.docx", "office"),
        (b"<html><body>Invoice</body></html>", "invoice.html", "web"),
    ],
)
def test_the_file_type_comes_from_its_content(head, name, kind):
    assert reader.sniff(head, name)[0] == kind


def test_a_renamed_or_damaged_file_is_refused_not_guessed():
    with pytest.raises(reader.ReaderError, match="content is not"):
        reader.sniff(b"just some text", "invoice.pdf")


def test_an_unsupported_type_is_refused_with_the_supported_list():
    with pytest.raises(reader.UnsupportedDocument) as err:
        reader.sniff(b"MZ\x90\x00", "setup.exe")
    assert ".pdf" in err.value.message and ".jpg" in err.value.message


def test_empty_and_oversized_files_are_refused_before_any_model_runs():
    with pytest.raises(reader.ReaderError, match="empty"):
        reader.read_document(b"", "x.pdf")
    with pytest.raises(reader.DocumentTooLarge):
        reader.read_document(b"%PDF-" + b"0" * reader.MAX_FILE_BYTES, "x.pdf")


# ------------------------------------------------------------------------------------------------ scanner steps
def _text_page(width=1400, height=1000) -> Image.Image:
    img = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("arial.ttf", 28)
    except OSError:
        font = ImageFont.load_default()
    for i in range(18):
        draw.text((80, 60 + i * 48), f"Line {i + 1}: Hex Bolt M10 x 50 zinc plated   500 Nos   6.40   3,200.00", font=font, fill=0)
    return img


@pytest.mark.parametrize("angle", [-2.5, -1.2, 1.5, 3.0])
def test_skew_is_measured_to_within_a_few_tenths_of_a_degree(angle):
    tilted = _text_page().rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=255)
    measured = scan.estimate_skew(np.asarray(tilted))
    # rotating the page back by the measured angle levels it: measured is minus the tilt
    assert math.isclose(measured, -angle, abs_tol=0.3), measured


def test_a_level_page_is_left_alone():
    _, steps = scan.prepare_page(_text_page(width=1800), photo=False)
    assert not any("skew" in s for s in steps)


def test_the_page_is_found_in_a_photo_and_flattened():
    page = _text_page()
    desk = Image.new("L", (1800, 1500), 70)
    desk.paste(page, (200, 250))
    corners = scan.find_page(np.asarray(desk))
    assert corners is not None
    xs, ys = corners[:, 0], corners[:, 1]
    assert abs(xs.min() - 200) < 25 and abs(ys.min() - 250) < 25 and abs(xs.max() - 1600) < 25 and abs(ys.max() - 1250) < 25


def test_a_scan_with_no_border_is_not_cropped():
    assert scan.find_page(np.asarray(_text_page())) is None


# ------------------------------------------------------------------------------------------------ real reads
needs_models = pytest.mark.skipif(importlib.util.find_spec("docling") is None, reason="needs the Docling/OCR models (pip install -r docreader/requirements.txt)")
needs_test_set = pytest.mark.skipif(not INVOICES.exists() or importlib.util.find_spec("docling") is None,
                                    reason="needs eval/documents/invoices and the Docling/OCR models")


def _read(layout: str, form: str) -> reader.Reading:
    path = INVOICES / layout / form
    return reader.read_document(path.read_bytes(), path.name)


def _truth(layout: str) -> dict:
    return json.loads((INVOICES / layout / "truth.json").read_text(encoding="utf-8"))


@needs_test_set
def test_a_digital_pdf_is_read_from_its_text_layer_with_each_item_row_whole():
    # A Tally-style boxed grid: Docling's table model merges this one (several rows in a cell), which is why the
    # reading also carries `layout`, the page's text by printed row. Each item row must come back whole there.
    r = _read("tally_gst", "digital.pdf")
    assert r.source_kind == "digital_pdf" and not r.ocr_used
    assert "SGIS/2026-27/0412" in r.markdown
    rows = r.layout_text.splitlines()
    assert any("Hex Bolt M10 x 50 (Zinc Plated)" in row and "500 Nos" in row and "6.40" in row and "3,200.00" in row for row in rows), rows


@needs_test_set
@pytest.mark.parametrize("form", ["scan_clean.pdf", "scan_messy.pdf"])
def test_a_scanned_pdf_is_ocrd_and_its_figures_survive(form):
    r = _read("us_invoice", form)
    assert r.source_kind == "scanned_pdf" and r.ocr_used and r.ocr_confidence is not None
    text = _squash(r.markdown)
    for figure in ("10442", "1,377.45", "PO-7731"):
        assert _squash(figure) in text, f"{figure} lost in OCR"


@needs_test_set
def test_a_phone_photo_is_flattened_straightened_and_read():
    r = _read("zoho_igst", "photo.jpg")
    assert r.source_kind == "image" and r.ocr_used
    steps = " ".join(s for p in r.preparation for s in p["steps"])
    assert "perspective" in steps
    text = _squash(r.markdown)
    for figure in ("KCS-INV-00982", "71,980.00"):
        assert _squash(figure) in text, f"{figure} lost in the photo"


@needs_test_set
def test_a_word_invoice_is_read_without_ocr():
    r = _read("service_bill", "document.docx")
    assert r.source_kind == "office" and not r.ocr_used
    assert "AMA/112/26-27" in r.markdown and r.tables


@needs_test_set
def test_a_two_page_invoice_keeps_both_pages():
    r = _read("multipage_gst", "digital.pdf")
    assert r.page_count == 2
    last_item = _truth("multipage_gst")["line_items"][-1]["description"]
    assert _squash(last_item) in _squash(r.markdown)


@needs_models
def test_a_blank_photo_is_refused_as_unreadable():
    buf = io.BytesIO()
    Image.new("RGB", (1200, 1600), (245, 245, 245)).save(buf, "JPEG")
    with pytest.raises(reader.UnreadableDocument, match="no readable text"):
        reader.read_document(buf.getvalue(), "blank.jpg")
