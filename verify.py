"""Browser regression checks: python verify.py [base_url]. Requires playwright and Chromium."""
import hashlib
import http.server
import json
import os
import pathlib
import shutil
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
DATA = json.loads((ROOT / 'cases.json').read_text())


def verify(base_url):
    checks = []
    for case in DATA['cases']:
        for field in ('before', 'after'):
            assert hashlib.sha256(case[field].encode()).hexdigest() == case[field + '_sha256']
    checks.append('All six source hashes match their public records')
    with sync_playwright() as p:
        executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium')
        options = dict(headless=True, args=['--no-sandbox'])
        if executable:
            options['executable_path'] = executable
        browser = p.chromium.launch(**options)
        try:
            page = browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
            for case in DATA['cases']:
                page.goto(base_url + '?case=' + case['id'])
                page.wait_for_function("() => document.getElementById('status').textContent === 'Broken'")
                assert page.locator('#editor').input_value() == case['before']
                assert page.locator('#result').inner_text()
                page.locator('#repair').click()
                page.wait_for_function("() => document.getElementById('status').textContent === 'Running'")
                assert page.locator('#editor').input_value() == case['after']
                page.locator('#check').click()
                page.wait_for_function("() => document.getElementById('status').textContent === 'Quick checks passed'")
                assert page.locator('#result').inner_text().count('PASS') == 4
                with page.expect_download() as download:
                    page.locator('#download').click()
                payload = json.loads(pathlib.Path(download.value.path()).read_text())
                assert len(payload['cases']) == 1 and payload['cases'][0] == case
                page.locator('#reset').click()
                page.wait_for_function("() => document.getElementById('status').textContent === 'Broken'")
                checks.append(case['id'] + ': failure, recorded repair, four quick checks, exact download, reset')

            # A game can render correctly and still have the wrong control behavior.
            cloud = DATA['cases'][2]
            page.goto(base_url + '?case=cloud-courier')
            page.wait_for_selector('.case-button')
            broken_controls = cloud['after'].replace('keyboard.down||', '').replace('keyboard.up||', '')
            assert broken_controls != cloud['after']
            page.locator('#editor').fill(broken_controls)
            page.locator('#run').click()
            page.wait_for_function("() => document.getElementById('status').textContent === 'Running'")
            page.locator('#check').click()
            page.wait_for_function("() => document.getElementById('status').textContent === 'Check failed'")
            assert 'FAIL keyboard vertical' in page.locator('#result').inner_text()
            checks.append('Control defect injection: a renderable game with missing vertical keys fails')

            # Missing and non-finite snapshots must never produce a live pass.
            for override in ("window.arcade={};", "window.arcade.snapshot=()=>({phase:'ready',player:{x:NaN,y:0}});"):
                source = cloud['after'] + '<script>' + override + '</script>'
                page.locator('#editor').fill(source)
                page.locator('#run').click()
                page.wait_for_function("() => document.getElementById('status').textContent === 'Check failed'")
            checks.append('Missing interface and non-finite coordinates both fail')

            # The iframe must stay opaque even when its program tries to reach the parent.
            assert 'allow-same-origin' not in page.locator('#game').get_attribute('sandbox')
            source = cloud['after'] + "<script>try{parent.document.body.dataset.escaped='yes'}catch(e){window.escapeBlocked=true}fetch('https://example.com/clinic-test').catch(()=>window.networkBlocked=true)</script>"
            page.locator('#editor').fill(source)
            page.locator('#run').click()
            page.wait_for_function("() => document.getElementById('status').textContent === 'Running'")
            game = page.locator('#game').element_handle().content_frame()
            game.wait_for_function('() => window.escapeBlocked && window.networkBlocked')
            assert page.locator('body').get_attribute('data-escaped') is None
            checks.append('Sandbox denies parent DOM access and network fetch')

            # Untrusted markup must never precede the child policy or error listeners.
            for prefix in ('<!-- <head> fake head </head> -->', '<!doctype html><HTML><HEAD></HEAD>', '<div>No head element</div>'):
                page.locator('#editor').fill(prefix + source)
                page.locator('#run').click()
                page.wait_for_function("() => document.getElementById('status').textContent === 'Running'")
                game = page.locator('#game').element_handle().content_frame()
                game.wait_for_function('() => window.escapeBlocked && window.networkBlocked')
                assert page.locator('body').get_attribute('data-escaped') is None
            checks.append('Commented, uppercase and missing heads cannot hide the child policy')

            page.goto(base_url + '?case=moon-garden')
            page.wait_for_selector('[data-case="bee-bop"]')
            page.locator('[data-case="bee-bop"]').click()
            page.reload()
            page.wait_for_function("() => document.getElementById('case-title').textContent === 'Bee Bop'")
            checks.append('Shared-case navigation preserves the latest selection on reload')

            for case in DATA['cases']:
                phone = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=1, is_mobile=True, has_touch=True, reduced_motion='reduce')
                try:
                    mobile = phone.new_page()
                    mobile.goto(base_url + '?case=' + case['id'])
                    mobile.wait_for_selector('.case-button')
                    assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    mobile.locator('#repair').click()
                    mobile.wait_for_function("() => document.getElementById('status').textContent === 'Running'")
                    game = mobile.locator('#game').element_handle().content_frame()
                    start = game.locator('#startBtn, #start')
                    start.tap()
                    before = game.evaluate('window.arcade.snapshot()')
                    direction = game.locator('#rightBtn, [data-dir="right"]')
                    direction.scroll_into_view_if_needed()
                    box = direction.bounding_box()
                    assert box and box['width'] > 0
                    client = phone.new_cdp_session(mobile)
                    touch = {'x': box['x'] + box['width']/2, 'y': box['y'] + box['height']/2}
                    client.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [touch]})
                    mobile.wait_for_timeout(350)
                    client.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
                    after = game.evaluate('window.arcade.snapshot()')
                    assert abs(after['player']['x'] - before['player']['x']) > .5
                    checks.append(case['id'] + ': phone fits and native touch moves the player')
                finally:
                    phone.close()
        finally:
            browser.close()
    print(json.dumps({'passed': len(checks), 'checks': checks}, indent=2))


if __name__ == '__main__':
    if len(sys.argv) > 1:
        verify(sys.argv[1].rstrip('/') + '/')
    else:
        class QuietHandler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(ROOT), **kwargs)

            def log_message(self, *_args):
                pass
        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler) as server:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                verify('http://127.0.0.1:' + str(server.server_port) + '/')
            finally:
                server.shutdown()
