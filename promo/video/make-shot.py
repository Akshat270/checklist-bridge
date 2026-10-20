"""Draws shot.png: a plain "API keys" dashboard (no real brand) that the video pastes into a task's note.
Usage: python3 promo/video/make-shot.py   (needs Pillow and the Inter font)"""
import glob, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))

def font(size, weight='Regular'):
    for p in glob.glob('/usr/share/fonts/**/Inter*%s*.ttf' % weight, recursive=True) + glob.glob('/usr/share/fonts/**/Inter*.ttf', recursive=True):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            pass
    return ImageFont.load_default()

W, H = 960, 600
im = Image.new('RGB', (W, H), '#f6f7fb')
d = ImageDraw.Draw(im)
d.rectangle([0, 0, 220, H], fill='#1e2235')
d.text((28, 30), 'Dashboard', font=font(26, 'SemiBold'), fill='#ffffff')
for i, s in enumerate(['Home', 'Payments', 'Products', 'Developers', 'Settings']):
    y = 100 + i * 48
    if s == 'Developers':
        d.rounded_rectangle([14, y - 10, 206, y + 30], 8, fill='#343a5c')
    d.text((30, y), s, font=font(19), fill='#e7e9f5' if s == 'Developers' else '#a9aecb')
d.text((260, 34), 'API keys', font=font(34, 'SemiBold'), fill='#1a1d2b')
d.text((260, 84), 'Use these keys to connect your app.', font=font(19), fill='#5d6276')

def card(y, label, val, badge=None):
    d.rounded_rectangle([260, y, 920, y + 110], 14, fill='#ffffff', outline='#e3e5ee', width=2)
    d.text((290, y + 22), label, font=font(19, 'SemiBold'), fill='#1a1d2b')
    d.rounded_rectangle([290, y + 58, 780, y + 92], 8, fill='#f1f2f7')
    d.text((304, y + 63), val, font=font(18), fill='#3c4157')
    if badge:
        d.rounded_rectangle([700, y + 18, 900, y + 50], 16, fill='#dcf5e4')
        d.text((716, y + 23), badge, font=font(17, 'SemiBold'), fill='#1a7f37')

card(150, 'Publishable key', 'pk_test_51Nx••••••••••••••••4fQ')
card(290, 'Secret key', 'sk_test_51Nx••••••••••••••••9aK', '✓ Rolled just now')
d.rounded_rectangle([260, 430, 920, 560], 14, fill='#ffffff', outline='#e3e5ee', width=2)
d.text((290, 452), 'Old key', font=font(19, 'SemiBold'), fill='#1a1d2b')
d.text((290, 492), 'sk_test_51Nx••••b7Q  ·  expired', font=font(18), fill='#b0263a')
im.save(os.path.join(HERE, 'shot.png'))
print('wrote shot.png')
