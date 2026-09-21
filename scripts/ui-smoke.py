"""اختبار واجهة حقيقي عبر Chromium (iPhone 393x852): python3 scripts/ui-smoke.py"""
import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

PORT = 3123
srv = subprocess.Popen(['node', 'server/index.js'], env={**os.environ, 'PORT': str(PORT)}, stdout=subprocess.DEVNULL)
time.sleep(0.8)
URL = f'http://127.0.0.1:{PORT}'
OUT = '/tmp/shots'; os.makedirs(OUT, exist_ok=True)
SENT = 'العلم نور والعمل أساس النجاح'
ok = True
def check(cond, msg):
    global ok
    print(('PASS ' if cond else 'FAIL ') + msg)
    ok = ok and cond

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        def page(name):
            ctx = b.new_context(viewport={'width': 393, 'height': 852}, device_scale_factor=2, has_touch=True, is_mobile=True, locale='ar-SA')
            pg = ctx.new_page(); pg.goto(URL); pg.on('pageerror', lambda e: check(False, f'{name} JS error: {e}')); return pg
        host, lead, mem, spec = page('host'), page('lead'), page('mem'), page('spec')

        host.locator('input[placeholder="اسمك"]').last.fill('المستضيف'); host.get_by_text('إنشاء غرفة').click()
        host.wait_for_selector('.roomcode'); code = host.locator('.roomcode').inner_text(); check(len(code) == 5, f'room code {code}')
        for pg, n in ((lead, 'ليلى'), (mem, 'منى'), (spec, 'سعد')):
            pg.locator('input[placeholder="رمز الغرفة"]').fill(code); pg.locator('input[placeholder="اسمك"]').first.fill(n); pg.get_by_text('دخول الغرفة').click(); pg.wait_for_selector('.roomcode')
        host.locator('input[placeholder="اسم فريق جديد"]').fill('الصقور'); host.get_by_text('➕ فريق').click()
        host.wait_for_selector('.team')
        lead.get_by_text('انضمام إلى الفريق').click(); mem.get_by_text('انضمام إلى الفريق').click()
        lead.wait_for_selector('text=👑 ليلى'); host.screenshot(path=f'{OUT}/1_host_teams.png')
        host.locator('textarea').fill(SENT); host.get_by_text('حفظ وتوليد اللغز').click()
        host.wait_for_selector('.tok'); check(host.locator('.tok').count() == 6, '6 tokens shown to host')
        host.get_by_role('button', name='اختيار', exact=True).click()
        host.wait_for_selector('text=بانتظار بدء الجولة'); lead.get_by_text('🎮 اللعبة').click()
        lead.wait_for_selector('text=بانتظار بدء الجولة'); host.screenshot(path=f'{OUT}/2_host_waiting.png')
        check(lead.locator('.card:visible').count() == 0, 'no board before start')
        host.get_by_text('بدء اللعب', exact=True).click()
        for pg in (lead, mem, spec): pg.wait_for_selector('.board:visible')
        time.sleep(0.3)
        check(lead.locator('.card').count() == 30 and lead.locator('.chip').count() == 6, '30 cards + 6 code chips')
        # لا تمرير أفقي ولا عناصر خارج الشاشة
        for name, pg in (('lead', lead), ('mem', mem)):
            m = pg.evaluate('({sw: document.documentElement.scrollWidth, cw: innerWidth, b: document.querySelector(".board").getBoundingClientRect().bottom, f: document.querySelector(".foot").getBoundingClientRect().bottom, h: innerHeight})')
            check(m['sw'] <= m['cw'] and m['f'] <= m['h'] + 1, f'{name} fits screen {m}')
        lead.screenshot(path=f'{OUT}/3_leader_active.png')
        # كشف بطاقة
        lead.locator('.card').nth(7).click(); time.sleep(0.35)
        check(mem.locator('.card.flip').count() == 1 and spec.locator('.card.flip').count() == 1, 'reveal visible to member + spectator')
        mem.locator('.card').nth(3).click(); time.sleep(0.1)
        lead.locator('.card').nth(9).click(); time.sleep(0.1)
        check(lead.locator('.card.flip').count() == 1, 'second card blocked during reveal')
        lead.screenshot(path=f'{OUT}/4_leader_reveal.png')
        time.sleep(1.1)
        check(lead.locator('.card.flip').count() == 0, 'card hides after 1s')
        lead.locator('.card').nth(7).click(); time.sleep(1.2); lead.locator('.card').nth(7).click(); time.sleep(0.3)
        check(lead.locator('.card').nth(7).evaluate('e=>e.classList.contains("locked")') and lead.locator('.card.flip').count() == 0, 'third reveal blocked, card locked')
        # سحب وإفلات
        before = lead.locator('.chip').all_inner_texts()
        a = lead.locator('.chip').nth(0).bounding_box(); z = lead.locator('.chip').nth(5).bounding_box()
        lead.mouse.move(a['x'] + a['width']/2, a['y'] + a['height']/2); lead.mouse.down()
        lead.mouse.move(a['x'] + a['width']/2 + 10, a['y'] + a['height']/2, steps=3)
        lead.mouse.move(z['x'] + z['width']/2, z['y'] + z['height']/2, steps=8); lead.mouse.up(); time.sleep(0.4)
        after = lead.locator('.chip').all_inner_texts(); mem_after = mem.locator('.chip').all_inner_texts()
        check(after != before and after == mem_after, f'drag reorders and syncs to members')
        # إنهاء مبكر + إجابة
        lead.get_by_text('إنهاء ومحاولة الحل').click(); lead.get_by_text('اضغط مرة أخرى للتأكيد').click()
        lead.wait_for_selector('#ans'); mem.wait_for_selector('text=القائد يقوم بكتابة الإجابة'); spec.wait_for_selector('text=القائد يقوم بكتابة الإجابة')
        check(lead.locator('.board:visible').count() == 0, 'board hidden in answer phase')
        lead.locator('#ans').fill('العلم، نور والعمل أساس النجاح'); time.sleep(0.5)
        lead.screenshot(path=f'{OUT}/5_answer.png')
        check('العلم' in mem.locator('.draft').inner_text(), 'team member sees draft')
        lead.get_by_text('إرسال الإجابة').click()
        for pg in (lead, mem, spec, host): pg.wait_for_selector('text=تم الحل بنجاح')
        check('ثانية' in lead.locator('.time').inner_text(), 'solve time shown: ' + lead.locator('.time').inner_text())
        lead.screenshot(path=f'{OUT}/6_result.png'); host.screenshot(path=f'{OUT}/7_host_result.png')
        b.close()
finally:
    srv.terminate()
sys.exit(0 if ok else 1)
