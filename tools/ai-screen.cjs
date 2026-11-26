/**
 * 격리 메모리 DB의 가상 DISK 장애를 실제 Ollama로 분석한 화면을 캡처합니다.
 * 평문 계정은 이 검사 프로세스 안에서만 사용하고 로그에 출력하지 않습니다.
 * try/finally로 브라우저와 앱을 닫습니다. 결과는 07_ai_analysis.png와 ai-ui-check.json입니다.
 */
const { chromium } = require('playwright');
(async () => {
  const { openDB } = await import('../src/db.js');
  const { createApp } = await import('../src/server.js');
  const { saveSample } = await import('../src/incidents.js');
  const { demoSample } = await import('../src/telemetry.js');
  const app = await createApp({
    db: await openDB({ path: ':memory:', driver: 'sqlite' }),
    background: false,
    aiOptions: { enabled: true, timeout: 90000 },
  });
  let browser;
  try {
    const demo = await app.db.get("SELECT * FROM servers WHERE source='demo'");
    await saveSample(app.db, demo, demoSample(0));
    const address = await app.start(0);
    browser = await chromium.launch({
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      headless: true,
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.locator('#loginForm [name=username]').fill('admin');
    await page.locator('#loginForm [name=password]').fill(app.credentials.admin);
    await page.locator('#loginForm button').click();
    await page.locator('#console').waitFor({ state: 'visible' });
    await page.locator('nav [data-tab=incidents]').click();
    await page.locator('#incidentTable button').first().click();
    await page.getByRole('button', { name: 'AI 및 매뉴얼 분석' }).click();
    await page
      .getByRole('heading', { name: 'AI 분석 · 담당자 검토 필요' })
      .waitFor({ timeout: 120000 });
    await page.screenshot({ path: 'evidence/07_ai_analysis.png', fullPage: true });
    const result = await app.db.get('SELECT mode,answer FROM analyses ORDER BY id DESC LIMIT 1');
    console.log('실제 모델 화면 검증', result.mode);
    require('node:fs').writeFileSync(
      'evidence/ai-ui-check.json',
      JSON.stringify(
        {
          checked_at: new Date().toISOString(),
          mode: result.mode,
          source: 'demo',
          review_required: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser?.close();
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
