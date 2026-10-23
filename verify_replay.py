"""Browser checks for the separate alphaBell-authored Replay Lab."""
import argparse
import functools
import http.server
import json
from pathlib import Path
import threading

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url')
    parser.add_argument('--artifacts', type=Path)
    args = parser.parse_args()
    server = None
    if args.base_url:
        base_url = args.base_url.rstrip('/') + '/'
    else:
        class QuietHandler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *unused):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base_url = f'http://127.0.0.1:{server.server_port}/'
    checks, errors, requests = [], [], []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
            try:
                context = browser.new_context(viewport={'width': 1440, 'height': 1100}, reduced_motion='reduce', accept_downloads=True)
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('request', lambda request: requests.append(request.url))
                page.goto(base_url + 'replay.html', wait_until='networkidle')
                expect(page.locator('#verdict-title')).to_have_text('The second timer gives itself away.')
                assert page.locator('#divergence-time').inner_text() == '1.00s'
                assert page.locator('#fresh-spawns').inner_text() == '1'
                assert page.locator('#restart-spawns').inner_text() == '2'
                assert page.locator('#fresh-world [data-spawn-marker]').count() == 1
                assert page.locator('#restart-world [data-spawn-marker]').count() == 2
                assert page.locator('[data-check=resetBasics]').get_attribute('data-pass') == 'true'
                assert page.locator('[data-check=restartReplay]').get_attribute('data-pass') == 'false'
                assert 'alphaBell' in page.locator('.credit').inner_text()
                assert page.locator('.credit a').get_attribute('href') == 'https://discuss.huggingface.co/t/190935/4'
                checks.append('default leaked timer splits at 1000 ms with visible spawn markers and separate provenance')

                timeline = page.locator('#timeline')
                timeline.focus()
                timeline.press('Home')
                assert timeline.input_value() == '0'
                assert page.locator('#fresh-spawns').inner_text() == page.locator('#restart-spawns').inner_text() == '0'
                assert page.locator('#fresh-timers').inner_text() == '1 virtual timer'
                assert page.locator('#restart-timers').inner_text() == '2 virtual timers'
                timeline.press('ArrowRight')
                assert timeline.input_value() == '50'
                timeline.press('End')
                assert page.locator('#fresh-spawns').inner_text() == '10'
                assert page.locator('#restart-spawns').inner_text() == '20'
                assert page.locator('#spawn-rows tr').count() == 11
                for row in page.locator('#spawn-rows tr').all():
                    cells = row.locator('td').all_text_contents()
                    assert cells[1] == cells[2]
                    assert int(cells[3]) == 2 * int(cells[1])
                page.locator('#jump').click()
                assert timeline.input_value() == '1000'
                checks.append('keyboard timeline, fresh control and cumulative per-second spawn table')

                page.locator('#mode-fixed').click()
                assert page.locator('#verdict-title').inner_text() == 'One timer. The same replay.'
                assert page.locator('#restart-spawns').inner_text() == page.locator('#fresh-spawns').inner_text() == '1'
                assert page.locator('#restart-timers').inner_text() == '1 virtual timer'
                assert page.locator('#jump').is_disabled()
                assert page.locator('[data-check=restartReplay]').get_attribute('data-pass') == 'true'
                assert all(row.get_attribute('data-pass') == 'true' for row in page.locator('.check-row').all())
                for row in page.locator('#spawn-rows tr').all():
                    cells = row.locator('td').all_text_contents()
                    assert cells[1] == cells[2] == cells[3]
                checks.append('fixed timer reset restores all gameplay-state and spawn checks')

                page.locator('#seed').fill('42')
                page.locator('#run-experiment').click()
                with page.expect_download() as event:
                    page.locator('#download').click()
                download = event.value
                assert download.suggested_filename == 'alphabell-illustrative-replay-42-fixed.json'
                first = json.loads(Path(download.path()).read_text())
                assert first['provenance']['flintGenerated'] is False
                assert first['provenance']['author'] == 'alphaBell'
                assert first['provenance']['inspiration'] == 'https://discuss.huggingface.co/t/190935/4'
                assert first['comparisons']['restart']['equal'] is True
                assert len(first['runs']['restarted']['samples']) == 201
                page.locator('#run-experiment').click()
                with page.expect_download() as event:
                    page.locator('#download').click()
                assert json.loads(Path(event.value.path()).read_text()) == first
                page.locator('#seed').fill('-1')
                page.locator('#run-experiment').click()
                assert 'unsigned 32-bit' in page.locator('#status').inner_text()
                assert page.locator('#verdict-title').inner_text() == 'One timer. The same replay.'
                page.locator('#seed').fill('1337')
                page.locator('#mode-leaked').click()
                checks.append('seeded recomputation is identical, invalid seeds rejected and downloads retain complete evidence')

                page.locator('#play').click()
                page.wait_for_function('() => Number(document.getElementById("timeline").value)>1000')
                page.locator('#play').click()
                paused = timeline.input_value()
                page.wait_for_timeout(120)
                assert timeline.input_value() == paused
                page.locator('#jump').click()
                assert timeline.input_value() == '1000'
                page.locator('#play').click()
                page.evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:true}); document.dispatchEvent(new Event("visibilitychange"))')
                assert page.locator('#play').inner_text() == '▶ Play replay'
                checks.append('playback advances saved states, pauses reliably and stops when hidden')

                if args.artifacts:
                    args.artifacts.mkdir(parents=True, exist_ok=True)
                    page.evaluate('document.activeElement?.blur(); window.scrollTo(0,0)')
                    page.screenshot(path=str(args.artifacts / 'replay-desktop.png'), full_page=True)

                phone_context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, reduced_motion='reduce')
                phone = phone_context.new_page()
                phone.on('pageerror', lambda error: errors.append(str(error)))
                phone.on('request', lambda request: requests.append(request.url))
                phone.goto(base_url + 'replay.html', wait_until='networkidle')
                expect(phone.locator('#verdict-title')).to_have_text('The second timer gives itself away.')
                assert phone.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
                phone.locator('#mode-fixed').tap()
                assert phone.locator('#restart-timers').inner_text() == '1 virtual timer'
                phone.locator('#mode-leaked').tap()
                phone.locator('#timeline').scroll_into_view_if_needed()
                rect = phone.locator('#timeline').bounding_box()
                cdp = phone_context.new_cdp_session(phone)
                x, y = rect['x'] + rect['width'] * .55, rect['y'] + rect['height'] / 2
                cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
                cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
                assert int(phone.locator('#timeline').input_value()) > 3000
                phone.locator('#jump').tap()
                assert phone.locator('#timeline').input_value() == '1000'
                if args.artifacts:
                    phone.evaluate('document.activeElement?.blur(); window.scrollTo(0,0)')
                    phone.screenshot(path=str(args.artifacts / 'replay-phone.png'), full_page=True)
                phone.set_viewport_size({'width': 320, 'height': 740})
                assert phone.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
                phone_context.close()
                checks.append('390 and 320 px layouts with real touch mode and timeline controls')

                # The Clinic intentionally starts with a real broken Canvas
                # case. Keep its expected failure separate from Replay Lab
                # runtime errors rather than hiding errors from either page.
                page.close()
                clinic_errors = []
                clinic = context.new_page()
                clinic.on('pageerror', lambda error: clinic_errors.append(str(error)))
                clinic.on('request', lambda request: requests.append(request.url))
                clinic.goto(base_url + 'index.html', wait_until='networkidle')
                expect(clinic.locator('#case-list .case-button')).to_have_count(3)
                assert clinic.locator('footer a[href="replay.html"]').count() == 1
                assert clinic_errors == ["Failed to execute 'arc' on 'CanvasRenderingContext2D': 5 arguments required, but only 4 present."], clinic_errors
                checks.append('original Clinic still loads three cases and links to the separate lab')
                origin = '/'.join(base_url.split('/')[:3])
                foreign = [url for url in requests if not url.startswith(origin + '/') and not url.startswith(('blob:', 'data:', 'about:'))]
                assert not foreign, foreign
                assert not errors, errors
                checks.append('no external network requests or browser runtime errors')
                context.close()
            finally:
                browser.close()
    finally:
        if server:
            server.shutdown()
            server.server_close()
    print(json.dumps({'passed': len(checks), 'checks': checks, 'runtime_errors': errors, 'expected_original_case_errors': clinic_errors, 'base_url': args.base_url or 'local'}, indent=2))


if __name__ == '__main__':
    main()
