"""Capture SplitSnap demo beats for the hackathon video (real app, real sandbox)."""
import time
from playwright.sync_api import sync_playwright

URL = 'http://127.0.0.1:3000/'
OUT = '/home/star/paypal-split-agent/video'

beats = [
    ('01-welcome', None),
    ('02-split', 'Split $64 between video-a@example.com and video-b@example.com'),
    ('03-bill', None),  # same state, tighter scroll to bill
    ('04-remind', 'Remind video-b'),
    ('05-nudge', None),
    ('06-paid', 'video-b paid'),
    ('07-settled', None),
]

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome',
                          args=['--no-sandbox', '--disable-gpu'])
    pg = b.new_page(viewport={'width': 480, 'height': 900}, device_scale_factor=2)
    pg.goto(URL)
    pg.wait_for_timeout(2500)
    for name, msg in beats:
        if msg:
            pg.fill('#box', msg)
            pg.click('.sendbtn')
            pg.wait_for_timeout(7000)
        else:
            pg.wait_for_timeout(1200)
        if name in ('03-bill', '05-nudge', '07-settled'):
            pg.evaluate('window.scrollTo(0, document.body.scrollHeight)')
            pg.wait_for_timeout(600)
        pg.screenshot(path=f'{OUT}/{name}.png')
        print('shot', name)
    b.close()
print('done')
