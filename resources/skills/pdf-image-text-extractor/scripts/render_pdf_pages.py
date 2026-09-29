#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pdf-image-text-extractor/scripts/render_pdf_pages.py

扫描版 PDF 页面渲染脚本（纯本地，无任何网络请求）。

用途：将 PDF 中文字层稀少的页面（扫描页）或指定页面渲染为 PNG 图片，
     供 Agent 用内置 read 工具（本地视觉模型）识别其中文字。

依赖：pymupdf（pip install pymupdf）

用法：
  python render_pdf_pages.py <pdf_path>                     # 自动检测扫描页并渲染
  python render_pdf_pages.py <pdf_path> --pages 1,3-5       # 渲染指定页
  python render_pdf_pages.py <pdf_path> --all               # 渲染全部页
  python render_pdf_pages.py <pdf_path> --scan-dir ./pages --dpi 300

stdout 输出 JSON：
  success     bool
  page_count  int    总页数
  images      list   [{'page': 页码, 'image': 图片绝对路径}]
  warnings    list   非致命警告
  error       str    失败原因（success=false 时）
"""

import sys
import json
import contextlib
import argparse
from pathlib import Path

try:
    import pymupdf as fitz
except ImportError:
    try:
        import fitz  # noqa: F401
    except ImportError:
        print(json.dumps({
            'success': False,
            'error': '缺少依赖：pymupdf。请安装：pip install pymupdf',
            'page_count': 0, 'images': [], 'warnings': []
        }, ensure_ascii=False))
        sys.exit(1)


def parse_page_ranges(spec: str, page_count: int) -> list:
    """解析 '1,3-5' 形式的页码描述，返回 0 基页码列表。"""
    pages = set()
    for part in spec.split(','):
        part = part.strip()
        if not part:
            continue
        if '-' in part:
            start, end = part.split('-', 1)
            start, end = int(start), int(end)
            if start < 1 or end < start or end > page_count:
                raise ValueError(f'无效页码范围：{part}（文档共 {page_count} 页）')
            pages.update(range(start - 1, end))
        else:
            num = int(part)
            if num < 1 or num > page_count:
                raise ValueError(f'页码超出范围：{num}（文档共 {page_count} 页）')
            pages.add(num - 1)
    return sorted(pages)


def page_text_length(page) -> int:
    try:
        return len(page.get_text().strip())
    except Exception:
        return 0


def render_page(page, out_path: str, dpi: int) -> bool:
    try:
        mat = fitz.Matrix(dpi / 72.0, dpi / 72.0)
        pix = page.get_pixmap(matrix=mat)
        pix.save(out_path)
        return True
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser(
        description='扫描版 PDF 页面渲染工具（纯本地，仅需 pymupdf）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('pdf_path', help='PDF 文件路径')
    parser.add_argument('--pages', default=None,
                        help='仅渲染指定页，如 1,3-5（默认自动检测扫描页）')
    parser.add_argument('--all', action='store_true', help='渲染全部页')
    parser.add_argument('--threshold', type=int, default=20,
                        help='自动检测时判定扫描页的文字字符数阈值（默认 20）')
    parser.add_argument('--scan-dir', default=None,
                        help='图片输出目录（默认 <pdf名>_ocr_pages/）')
    parser.add_argument('--dpi', type=int, default=200,
                        help='渲染分辨率（默认 200）')
    args = parser.parse_args()

    warnings = []
    result = {
        'success': False, 'page_count': 0,
        'images': [], 'warnings': warnings, 'error': ''
    }

    pdf_file = Path(args.pdf_path)
    if not pdf_file.exists():
        result['error'] = f'文件不存在：{args.pdf_path}'
        print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(1)
    if pdf_file.suffix.lower() != '.pdf':
        result['error'] = f'文件格式错误：{pdf_file.suffix}，仅支持 PDF 格式'
        print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(1)

    # pymupdf 处理时可能往 stdout 打印非 JSON 提示，重定向到 stderr 保持输出干净
    with contextlib.redirect_stdout(sys.stderr):
        try:
            doc = fitz.open(pdf_file)
        except Exception as e:
            result['error'] = f'无法打开 PDF（可能已加密或损坏）：{e}'
            print(json.dumps(result, ensure_ascii=False, indent=2))
            sys.exit(1)

        page_count = len(doc)
        result['page_count'] = page_count
        if page_count == 0:
            result['error'] = 'PDF 文件为空，无任何页面'
            doc.close()
            print(json.dumps(result, ensure_ascii=False, indent=2))
            sys.exit(1)

        try:
            if args.all:
                targets = list(range(page_count))
            elif args.pages:
                targets = parse_page_ranges(args.pages, page_count)
            else:
                targets = [
                    i for i in range(page_count)
                    if page_text_length(doc[i]) < args.threshold
                ]
        except ValueError as e:
            result['error'] = str(e)
            doc.close()
            print(json.dumps(result, ensure_ascii=False, indent=2))
            sys.exit(1)

        if not targets:
            warnings.append('未检测到扫描页（所有页面均有文字层），未渲染任何图片')

        out_dir = Path(args.scan_dir) if args.scan_dir else (
            pdf_file.parent / f'{pdf_file.stem}_ocr_pages'
        )

        for page_idx in targets:
            page = doc[page_idx]
            out_dir.mkdir(parents=True, exist_ok=True)
            img_path = str((out_dir / f'{pdf_file.stem}_p{page_idx + 1}.png').resolve())
            if render_page(page, img_path, dpi=args.dpi):
                result['images'].append({'page': page_idx + 1, 'image': img_path})
            else:
                warnings.append(f'第 {page_idx + 1} 页渲染图片失败')

        doc.close()

    result['success'] = True
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
