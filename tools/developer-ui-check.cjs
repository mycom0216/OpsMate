/** 코드 탭, 실제 JSON 표시, 복사, 읽기 전용 요청, 수신 스트림을 브라우저에서 검증합니다. */
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const root = process.argv[2];
  const credentials = JSON.parse(await fs.readFile(path.join(root, 'data/bootstrap.json'), 'utf8'));
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1060 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:3100');
    assert((await page.locator('#loginCode').innerText()).includes('createCollector'));
    await page.locator('#loginForm [name=username]').fill('admin');
    await page.locator('#loginForm [name=password]').fill(credentials.admin);
    await page.locator('#loginForm button').click();
    await page.locator('#console').waitFor({ state: 'visible' });
    await page.locator('#developerCode .syntax-number').first().waitFor();
    const response = await page.request.get('http://127.0.0.1:3100/api/snapshot');
    const snapshot = await response.json();
    assert((await page.locator('#developerCode').innerText()).includes(snapshot.servers[0].name));
    await page.getByRole('tab', { name: 'JS request.js' }).click();
    assert((await page.locator('#developerCode').innerText()).includes("fetch('/api/snapshot'"));
    const received = page.waitForResponse(r => r.url().endsWith('/api/snapshot') && r.request().method() === 'GET');
    await page.locator('#runSnapshotRequest').click();
    assert.equal((await received).status(), 200);
    await page.getByRole('tab', { name: 'JS agent.mjs' }).click();
    assert((await page.locator('#developerCode').innerText()).includes('process.env.AGENT_TOKEN'));
    await page.locator('#copyDeveloperCode').click();
    await page.getByRole('button', { name: '표시 코드 복사' }).filter({ hasText: '복사됨' }).waitFor();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    assert(clipboard.includes('createCollector') && clipboard.includes('/api/ingest'));
    await page.getByRole('tab', { name: '{ } snapshot.json' }).click();
    await page.waitForFunction(() => document.querySelector('#developerTrace').textContent.includes('WS'), { timeout: 15000 });
    assert((await page.locator('#developerTrace').innerText()).includes('/ws → snapshot'));
    await page.screenshot({ path: path.join(root, 'evidence/developer-workbench.png'), fullPage: true });
    await page.screenshot({ path: path.join(root, 'evidence/dashboard-preview.png'), fullPage: false });
    await page.locator('#clearDeveloperTrace').click();
    assert.equal(await page.locator('#developerTrace .trace-line').count(), 0);
    const overflows = [];
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) overflows.push(width);
    }
    assert.equal(overflows.length, 0);
    assert.equal(errors.length, 0);
    await fs.writeFile(path.join(root, 'evidence/developer-ui-check.json'), JSON.stringify({ checked_at: new Date().toISOString(), real_snapshot: true, tabs: 3, read_only_request: true, copy_verified: true, websocket_trace: true, clear_trace: true, tested_widths: [390, 768, 1024, 1440], horizontal_overflows: overflows, page_errors: errors }, null, 2));
    console.log('개발자 코드 작업 공간의 실제 JSON·복사·GET·WS·반응형 검사 통과');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
