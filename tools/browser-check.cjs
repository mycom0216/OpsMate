/**
 * 실행 중인 로컬 앱에 로그인해 주요 화면과 모바일 폭을 확인하는 수동 브라우저 검사입니다.
 * 로컬 bootstrap.json을 사용하지만 비밀번호를 출력하거나 캡처하지 않습니다.
 * 기본 AI 비활성 환경의 원문 안내를 확인하므로 실제 AI 화면 검사는 ai-screen.cjs로 분리합니다.
 * 증빙은 evidence의 화면 PNG와 ui-check.json이며 일반 앱 시작에 필요한 파일은 아닙니다.
 */
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const root = path.resolve(__dirname, '..'),
    evidence = path.join(root, 'evidence');
  const credentials = JSON.parse(await fs.readFile(path.join(root, 'data/bootstrap.json'), 'utf8'));
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1040 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:3100/');
  await page.screenshot({ path: path.join(evidence, '01_login.png'), fullPage: true });
  await page.locator('#loginForm [name=username]').fill('admin');
  await page.locator('#loginForm [name=password]').fill(credentials.admin);
  await page.getByRole('button', { name: '관제 콘솔 로그인' }).click();
  await page.locator('#console').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#serverCards').children.length >= 2);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(evidence, '02_dashboard.png'), fullPage: true });
  await page.locator('nav [data-tab=incidents]').click();
  await page.locator('#incidentTable button').first().click();
  await page.getByRole('button', { name: 'AI 및 매뉴얼 분석' }).click();
  await page.getByText('매뉴얼 원문 안내', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, '03_incident.png'), fullPage: true });
  await page.locator('nav [data-tab=logs]').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(evidence, '04_logs.png'), fullPage: true });
  await page.locator('nav [data-tab=admin]').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(evidence, '05_admin.png'), fullPage: true });
  await page.locator('nav [data-tab=dashboard]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(evidence, '06_mobile.png'), fullPage: true });
  const mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  await fs.writeFile(
    path.join(evidence, 'ui-check.json'),
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        browser: 'Chrome headless',
        screenshots: 6,
        page_errors: errors,
        mobile_horizontal_overflow: mobileOverflow,
        login: true,
        dashboard: true,
        incident_source_only: true,
        logs: true,
        admin: true,
      },
      null,
      2,
    ),
  );
  await browser.close();
  if (errors.length || mobileOverflow) process.exitCode = 1;
  console.log('UI 검증 완료', JSON.stringify({ errors: errors.length, mobileOverflow }));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
