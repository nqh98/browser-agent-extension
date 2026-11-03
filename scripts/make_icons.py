#!/usr/bin/env python3
"""Draws the Browser Agent icon: a browser window with a pointer, on the panel's blue.

Writes icons/icon-{16,32,48,128}.png for the extension and
claude-code/.claude-plugin/icon.png (512 px) for the Claude Code plugin.
Needs Pillow: python3 -m pip install pillow
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BLUE = (47, 95, 208, 255)
WHITE = (255, 255, 255, 255)


def draw(size=1024):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([40, 40, size - 40, size - 40], radius=220, fill=BLUE)
    # Browser window with a title bar and three dots.
    d.rounded_rectangle([170, 230, 820, 740], radius=70, outline=WHITE, width=56)
    d.line([170, 375, 820, 375], fill=WHITE, width=48)
    for x in (258, 340, 422):
        d.ellipse([x - 27, 302 - 27, x + 27, 302 + 27], fill=WHITE)
    # Pointer: tip, left edge, notch, tail, right wing; a blue band separates it from the frame.
    shape = [(0, 0), (0, 330), (85, 255), (150, 395), (215, 365), (150, 228), (262, 228)]
    pointer = [(545 + x, 455 + y) for x, y in shape]
    d.polygon(pointer, fill=WHITE)
    d.line(pointer + [pointer[0]], fill=BLUE, width=46, joint='curve')
    d.polygon(pointer, fill=WHITE)
    return img


def main():
    img = draw()
    (ROOT / 'icons').mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        img.resize((size, size), Image.LANCZOS).save(ROOT / 'icons' / f'icon-{size}.png')
    img.resize((512, 512), Image.LANCZOS).save(ROOT / 'claude-code' / '.claude-plugin' / 'icon.png')
    print('icons written')


if __name__ == '__main__':
    main()
