import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

let context: BrowserContext;
let fixturePage: Page;
let panelPage: Page;
let temporaryRoot = '';
let productionManifest: Record<string, unknown>;
let browserVersion = '';
let extensionId = '';

async function clickWithoutFocusing(page: Page, text: string): Promise<void> {
  await page.evaluate((label) => {
    const button = Array.from(document.querySelectorAll('button')).find((candidate) => {
      return candidate.textContent?.includes(label) || candidate.getAttribute('aria-label') === label;
    });
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
    button.click();
  }, text);
}

async function triggerExtensionAction(page: Page): Promise<void> {
  const browser = context.browser();
  if (!browser) throw new Error('Persistent Chromium browser is unavailable');
  const browserSession = await browser.newBrowserCDPSession();
  const { targetInfos } = await browserSession.send('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }],
  });
  const tabTarget = targetInfos.find((target) => target.type === 'tab' && target.url === page.url());
  if (!tabTarget) throw new Error(`Tab target not found for ${page.url()}`);
  await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: tabTarget.targetId });
  await browserSession.detach();
}

async function openExtensionPage(url: string): Promise<Page> {
  const existingPages = new Set(context.pages());
  const worker = context.serviceWorkers().find((candidate) => new URL(candidate.url()).host === extensionId)
    ?? await context.waitForEvent('serviceworker', {
      timeout: 10_000,
      predicate: (candidate) => new URL(candidate.url()).host === extensionId,
    });
  await worker.evaluate(async (targetUrl) => {
    await (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome.tabs.create({ url: targetUrl, active: false });
  }, url);
  await expect.poll(() => context.pages().some((candidate) => !existingPages.has(candidate) && candidate.url() === url), {
    timeout: 10_000,
    message: `Extension page target did not open: ${url}`,
  }).toBe(true);
  const page = context.pages().find((candidate) => !existingPages.has(candidate) && candidate.url() === url);
  if (!page) throw new Error(`Extension page target is unavailable: ${url}`);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

test.beforeAll(async () => {
  test.setTimeout(90_000);
  temporaryRoot = mkdtempSync(join(tmpdir(), 'seo-opt-e2e-'));
  const extensionPath = join(temporaryRoot, 'extension');
  await cp(resolve('.output/chrome-mv3'), extensionPath, { recursive: true });
  const manifestPath = join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  productionManifest = structuredClone(manifest);
  // Browser permission prompts live outside Playwright pages, so local page and AI
  // fixtures are pre-granted only in this temporary test manifest.
  manifest.host_permissions = ['http://127.0.0.1/*'];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const executablePath = process.env.SEO_OPT_CHROME_PATH || chromium.executablePath();
  context = await chromium.launchPersistentContext(join(temporaryRoot, 'profile'), {
    headless: false,
    executablePath,
    // Playwright disables extensions by default. Chrome 150 still returns an
    // ID from Extensions.loadUnpacked in that state, but never registers the
    // extension or its service worker.
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  });
  const browser = context.browser();
  if (!browser) throw new Error('Persistent Chromium browser is unavailable');
  const browserSession = await browser.newBrowserCDPSession();
  try {
    const loaded = await browserSession.send('Extensions.loadUnpacked', { path: extensionPath });
    extensionId = loaded.id;
  } finally {
    await browserSession.detach();
  }

  fixturePage = context.pages()[0] ?? await context.newPage();
  await fixturePage.goto('http://127.0.0.1:4173/media-links.html');
  browserVersion = await fixturePage.evaluate(() => navigator.userAgent);
  await triggerExtensionAction(fixturePage);
  panelPage = await openExtensionPage(`chrome-extension://${extensionId}/sidepanel.html`);
});

test('production manifest keeps page access on demand', () => {
  const chromeMajor = Number(browserVersion.match(/Chrome\/(\d+)\./)?.[1] ?? 0);
  expect(chromeMajor).toBeGreaterThanOrEqual(116);
  expect(productionManifest.permissions).toEqual(['activeTab', 'tabs', 'scripting', 'storage', 'sidePanel']);
  expect(productionManifest.host_permissions).toBeUndefined();
  expect(productionManifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
  expect(productionManifest.side_panel).toEqual({ default_path: 'sidepanel.html' });
});

test('explains activeTab permission instead of misreporting a normal website as unsupported', async () => {
  const ungrantedPage = await context.newPage();
  await ungrantedPage.goto('http://localhost:4173/healthy.html');
  await ungrantedPage.bringToFront();
  const visibleActiveUrl = await panelPage.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.url ?? null;
  });
  expect(visibleActiveUrl).toBe(ungrantedPage.url());
  await panelPage.getByRole('button', { name: '重新扫描当前页面' }).click();
  await expect(panelPage.getByRole('heading', { name: '需要授权当前页面' })).toBeVisible({ timeout: 8_000 });
  await expect(panelPage.getByText('可以只授权当前网站')).toBeVisible();
  await expect(panelPage.getByText('扫描设置')).toHaveCount(0);
  await expect(panelPage.getByText('目标查询')).toHaveCount(0);
  if (process.env.SEO_OPT_SCREENSHOTS === '1') {
    await panelPage.setViewportSize({ width: 375, height: 800 });
    await panelPage.screenshot({ path: '/tmp/seo-opt-permission-375.png', fullPage: true });
  }
  await ungrantedPage.close();
});

test('automatically scans the current website before opening advanced workspaces', async () => {
  await fixturePage.goto('http://127.0.0.1:4173/healthy.html');
  await fixturePage.bringToFront();
  await triggerExtensionAction(fixturePage);
  await expect(panelPage.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true');
  await expect(panelPage.getByTestId('overall-score')).not.toHaveText('—', { timeout: 20_000 });
  await expect(panelPage.getByText('今天先做', { exact: false })).toHaveCount(0);
  await expect(panelPage.getByText('执行队列', { exact: false })).toHaveCount(0);
  await panelPage.getByRole('tab', { name: '海外站优化' }).click();
  await expect(panelPage.getByRole('heading', { name: '海外站优化' })).toBeVisible();
  await expect(panelPage.getByLabel('当前检查网站 127.0.0.1')).toBeVisible({ timeout: 20_000 });
  await expect(panelPage.getByLabel('海外站项目')).toHaveCount(0);
  await expect(panelPage.getByRole('button', { name: '新建项目' })).toHaveCount(0);
  await expect(panelPage.getByLabel('网站地址')).toHaveCount(0);
  await expect(panelPage.getByText('自动检查完成')).toBeVisible();
  await expect(panelPage.getByText('当前为单语言页面，不要求 hreflang')).toBeVisible();
  await panelPage.setViewportSize({ width: 320, height: 800 });
  const overseasLayout = await panelPage.locator('.overseas-workspace').evaluate((workspace) => ({
    overflow: workspace.scrollWidth - workspace.clientWidth,
    controls: Array.from(workspace.querySelectorAll<HTMLElement>('button, input:not([type="checkbox"]), summary')).map((control) => {
      const rect = control.getBoundingClientRect();
      return { width: rect.width, height: rect.height, visible: rect.width > 0 && rect.height > 0 };
    }),
  }));
  expect(overseasLayout.overflow).toBeLessThanOrEqual(1);
  expect(overseasLayout.controls.filter((control) => control.visible && (control.width < 44 || control.height < 44))).toEqual([]);
  await panelPage.setViewportSize({ width: 375, height: 800 });

  await panelPage.getByRole('tab', { name: 'SEM' }).click();
  await expect(panelPage.getByRole('heading', { name: 'SEM 诊断' })).toBeVisible();
  const initialSemTabs = panelPage.getByRole('tablist', { name: 'SEM 工作区' });
  await expect(initialSemTabs.getByRole('tab').allTextContents()).resolves.toEqual(['概况', '落地页', '数据', '诊断']);
  await initialSemTabs.getByRole('tab', { name: '概况' }).focus();
  await panelPage.keyboard.press('End');
  await expect(initialSemTabs.getByRole('tab', { name: '诊断' })).toHaveAttribute('aria-selected', 'true');
  await expect(initialSemTabs.getByRole('tab', { name: '诊断' })).toHaveAttribute('aria-controls', 'sem-panel-diagnosis');
  await panelPage.keyboard.press('Home');
  await expect(initialSemTabs.getByRole('tab', { name: '概况' })).toHaveAttribute('aria-selected', 'true');

  await panelPage.locator('details.sem-advanced-settings summary').click();
  await expect(panelPage.getByLabel('项目名称')).toHaveValue('127.0.0.1');
  await expect(panelPage.locator('.sem-onboarding')).toHaveCount(0);
  await panelPage.getByLabel('项目名称').fill('SEM E2E 项目');
  await panelPage.getByLabel('核心转化').fill('有效线索');
  await panelPage.getByLabel('品牌词').fill('SEM E2E');
  await panelPage.getByLabel('目标 CPA').fill('100');

  const semTabs = panelPage.getByRole('tablist', { name: 'SEM 工作区' });
  await semTabs.getByRole('tab', { name: '落地页' }).click();
  await expect(panelPage.getByText('没有当前页面报告')).toHaveCount(0);
  await panelPage.getByLabel('SEM 目标查询').fill('企业 SEO 审计');
  await panelPage.getByLabel('广告承诺').fill('24 小时给出诊断报告');

  await semTabs.getByRole('tab', { name: '数据' }).click();
  const adsImporter = panelPage.locator('section[aria-label="导入广告表现 CSV"]');
  await adsImporter.locator('input[type="file"]').setInputFiles({
    name: 'google-ads.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from([
      '日期,广告系列,点击次数,费用,转化次数,搜索词,最终网址,展示次数',
      '2026-08-01,Search,10,100,2,seo audit,https://sem-e2e.example,100',
      '2026-08-02,Search,12,120,1,seo optimization,https://sem-e2e.example,120',
    ].join('\n')),
  });
  await expect(adsImporter.getByText('2 行 · google')).toBeVisible();
  await expect(adsImporter.getByRole('button', { name: '确认导入' })).toBeEnabled();
  await adsImporter.getByRole('button', { name: '确认导入' }).click();
  await expect(panelPage.getByText('google-ads.csv').last()).toBeVisible();

  await semTabs.getByRole('tab', { name: '概况' }).click();
  const changeLog = panelPage.locator('details.sem-change-log');
  await changeLog.locator('summary').click();
  await panelPage.getByLabel('具体改动').fill('品牌搜索系列日预算从 100 调到 120');
  await panelPage.getByLabel('观察天数').fill('14');
  await panelPage.getByRole('button', { name: '添加记录' }).click();
  await expect(panelPage.getByText('品牌搜索系列日预算从 100 调到 120')).toBeVisible();

  await panelPage.getByRole('button', { name: /本次变更.*预算/ }).click();
  await panelPage.getByRole('option', { name: '落地页' }).click();
  await panelPage.getByLabel('具体改动').fill('非品牌系列改用新版咨询落地页');
  await panelPage.getByRole('button', { name: '添加记录' }).click();
  await expect(panelPage.getByText('非品牌系列改用新版咨询落地页')).toBeVisible();

  for (const width of [320, 375, 414, 768]) {
    await panelPage.setViewportSize({ width, height: 800 });
    const semLayout = await panelPage.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      undersized: Array.from(document.querySelectorAll<HTMLElement>('.sem-workspace button, .sem-workspace input'))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.opacity !== '0';
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { label: element.getAttribute('aria-label') || element.textContent || '', width: rect.width, height: rect.height };
        })
        .filter((control) => control.width < 44 || control.height < 44),
    }));
    expect(semLayout.overflow, `${width}px SEM horizontal overflow`).toBeLessThanOrEqual(1);
    expect(semLayout.undersized, `${width}px SEM controls smaller than 44px`).toEqual([]);
  }

  await panelPage.setViewportSize({ width: 375, height: 800 });
  await semTabs.getByRole('tab', { name: '数据' }).click();
  await panelPage.getByRole('button', { name: '运行 SEM 诊断' }).click();
  await expect(semTabs.getByRole('tab', { name: '诊断' })).toHaveAttribute('aria-selected', 'true');
  await expect(panelPage.getByText('多项广告变更仍处于重叠观察期')).toBeVisible();
  await expect(panelPage.getByText(/结果无法可靠归因到其中一项/)).toBeVisible();
  await expect(panelPage.getByText('平台转化尚未与真实业务结果核对')).toBeVisible();
  await expect(panelPage.getByText('退款后 ROAS', { exact: true })).toBeVisible();
  await expect(panelPage.getByText('缺少收入与退款业务结果')).toBeVisible();

  await panelPage.reload();
  await panelPage.getByRole('tab', { name: 'SEM' }).click();
  await panelPage.locator('details.sem-advanced-settings summary').click();
  await expect(panelPage.getByLabel('项目名称')).toHaveValue('SEM E2E 项目');
  await expect(panelPage.getByLabel('目标 CPA')).toHaveValue('100');
  await expect(panelPage.locator('.sem-onboarding')).toHaveCount(0);
  const persistedChangeLog = panelPage.locator('details.sem-change-log');
  await persistedChangeLog.locator('summary').click();
  await expect(panelPage.getByText('品牌搜索系列日预算从 100 调到 120')).toBeVisible();
  await expect(panelPage.getByText('非品牌系列改用新版咨询落地页')).toBeVisible();
  await panelPage.getByRole('tablist', { name: 'SEM 工作区' }).getByRole('tab', { name: '数据' }).click();
  await expect(panelPage.getByText('google-ads.csv').last()).toBeVisible();
  await panelPage.getByRole('button', { name: '删除 google-ads.csv' }).click();
  await expect(panelPage.getByText('google-ads.csv')).toHaveCount(0);

  await panelPage.getByRole('tablist', { name: 'SEM 工作区' }).getByRole('tab', { name: '概况' }).click();
  await panelPage.locator('details.sem-advanced-settings summary').click();
  panelPage.once('dialog', (dialog) => void dialog.accept());
  await panelPage.getByRole('button', { name: '删除当前项目' }).click();
  await expect(panelPage.getByRole('heading', { name: '先告诉插件要分析哪个网站' })).toHaveCount(0);
  await expect(panelPage.getByRole('heading', { name: 'SEM 诊断' })).toBeVisible();
  await panelPage.getByRole('tab', { name: '概览' }).click();
});

test.afterAll(async () => {
  await context?.close();
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
});

test('runs the complete scan, annotation, stale, tab state, and restricted-page workflow', async () => {
  // This end-to-end path includes a 20-page site audit, responsive checks,
  // recommendation navigation, streamed AI, tab isolation, and stale recovery.
  test.setTimeout(180_000);
  await fixturePage.goto('http://127.0.0.1:4173/media-links.html');
  await fixturePage.bringToFront();
  await triggerExtensionAction(fixturePage);
  await clickWithoutFocusing(panelPage, '概览');
  await expect(panelPage.getByText('六类信号')).toBeVisible({ timeout: 20_000 });
  await expect(panelPage.getByRole('heading', { name: 'SEO优化' })).toBeVisible();
  const overviewSections = panelPage.getByRole('tablist', { name: '概览内容' });
  await expect(overviewSections.getByRole('tab').allTextContents()).resolves.toEqual(['摘要', '页面信息', '页面数据', '站点审计']);
  await expect(panelPage.getByRole('heading', { name: '得分与扣分明细' })).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: /已通过与获得分数/ })).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: /扣分项目/ })).toBeVisible();
  await expect(panelPage.getByText('规则获得')).toBeVisible();
  await expect(panelPage.getByText('实际扣分')).toBeVisible();
  await overviewSections.getByRole('tab', { name: '页面信息' }).click();
  await expect(panelPage.getByRole('heading', { name: '页面信息' })).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: '元信息' })).toBeVisible();
  await overviewSections.getByRole('tab', { name: '页面数据' }).click();
  await expect(panelPage.getByRole('heading', { name: '搜索引擎能否访问' })).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: 'HTTPS 与网站正式地址' })).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: '压缩与缓存' })).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: '抓取规则（robots.txt）' })).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: '结构化数据建议' })).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: 'CSS 与 JavaScript 加载' })).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: '链接关系（nofollow）' })).toBeVisible();
  await expect(panelPage.getByText('浏览器扩展不可读取到期时间、证书链和 TLS 等级')).toBeVisible();
  for (const width of [320, 375, 414, 768]) {
    await panelPage.setViewportSize({ width, height: 800 });
    const technicalLayout = await panelPage.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      undersized: Array.from(document.querySelectorAll<HTMLElement>('.technical-section button, .technical-section summary'))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.opacity !== '0';
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { label: element.textContent || element.getAttribute('aria-label') || '', width: rect.width, height: rect.height };
        })
        .filter((item) => item.width < 44 || item.height < 44)
        .map((item) => item.label),
    }));
    expect(technicalLayout.overflow, `${width}px technical page horizontal overflow`).toBeLessThanOrEqual(1);
    expect(technicalLayout.undersized, `${width}px technical controls smaller than 44px`).toEqual([]);
  }
  await panelPage.setViewportSize({ width: 375, height: 800 });
  await overviewSections.getByRole('tab', { name: '摘要' }).click();
  await expect(panelPage.getByRole('button', { name: '重新扫描当前页面' })).toBeVisible();
  await expect(panelPage.getByText('本次结果不代表实际收录或排名')).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: '本次访问性能' })).toBeVisible();
  await expect(panelPage.getByText('最大内容出现速度')).toBeVisible();
  await expect(panelPage.getByText('首个内容出现速度')).toBeVisible();
  await expect(panelPage.getByText('INP', { exact: true })).toBeVisible();
  await expect(panelPage.getByText(/INP 只有本次扫描观察到真实交互时才显示样本/)).toBeVisible();
  await expect(panelPage.getByText('搜索引擎能否访问页面、理解索引指令，并把页面加入索引。')).toBeVisible();
  await expect(panelPage.getByTestId('overall-score')).not.toHaveText('—');
  await expect(panelPage.getByRole('tablist', { name: '搜索增长工作台' }).getByRole('tab').allTextContents()).resolves.toEqual(['概览概览', '问题问题', '优化建议建议', '海外站优化海外', 'AI 深度解读AI', 'SEMSEM']);
  await expect(panelPage.getByText('页面 SEO 基础分', { exact: true })).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: '页面目标' })).toHaveCount(0);
  await expect(panelPage.getByRole('heading', { name: '站点审计' })).toHaveCount(0);
  await overviewSections.getByRole('tab', { name: '站点审计' }).click();
  await expect(panelPage.getByText(/判断问题是单页写错，还是模板或配置写错/)).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: '站点审计' })).toBeVisible();
  await expect(panelPage.getByText('它能帮你做什么？')).toBeVisible();
  await expect(panelPage.getByText(/默认快速检查 20 页/)).toBeVisible();
  await expect(panelPage.getByText(/再扩大到 50 或 100 页确认影响范围/)).toBeVisible();
  await expect(panelPage.getByRole('tablist', { name: '搜索增长工作台' }).getByRole('tab', { name: '页面数据' })).toHaveCount(0);
  await expect(panelPage.getByText('站点信息', { exact: true })).toHaveCount(0);
  await expect(panelPage.getByText('外部数据', { exact: true })).toHaveCount(0);
  await expect(panelPage.getByText('元信息', { exact: true })).toHaveCount(0);
  await expect(panelPage.getByText('robots.txt', { exact: true })).toHaveCount(0);

  await panelPage.getByRole('button', { name: '调整检查范围' }).click();
  await panelPage.getByRole('button', { name: /检查范围/ }).click();
  if (process.env.SEO_OPT_SCREENSHOTS === '1') {
    await panelPage.screenshot({ path: '/tmp/seo-opt-custom-select-375-light.png' });
  }
  await panelPage.getByRole('option', { name: /快速检查/ }).click();
  await panelPage.getByRole('button', { name: '快速检查 20 页' }).click();
  await expect(panelPage.locator('.site-run-summary')).toContainText('已完成', { timeout: 20_000 });
  await expect(panelPage.locator('.site-run-summary')).toContainText('/20');
  const firstSiteIssue = panelPage.locator('.site-issue-card').first();
  await expect(firstSiteIssue.getByText('为什么要处理')).toBeVisible();
  await expect(firstSiteIssue.getByText('建议怎么做')).toBeVisible();
  await expect(firstSiteIssue.getByText('怎么验证已经修好')).toBeVisible();
  const affectedUrls = firstSiteIssue.locator('details');
  await affectedUrls.locator('summary').focus();
  await panelPage.keyboard.press('Enter');
  await expect(affectedUrls).toHaveAttribute('open', '');
  await expect(affectedUrls.locator('code').first()).toBeVisible();
  const sitePermission = await panelPage.evaluate(() => chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] }));
  expect(sitePermission).toBe(true);

  for (const width of [320, 375, 414, 768]) {
    await panelPage.setViewportSize({ width, height: 800 });
    const layout = await panelPage.evaluate(() => {
      const visibleControls = Array.from(document.querySelectorAll<HTMLElement>('button,input,textarea'))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.opacity !== '0';
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { tag: element.tagName, width: rect.width, height: rect.height, label: element.getAttribute('aria-label') || element.textContent || '' };
        });
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        undersized: visibleControls.filter((control) => control.width < 44 || control.height < 44),
        offenders: Array.from(document.querySelectorAll<HTMLElement>('body *'))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName,
              className: element.className,
              text: (element.textContent || '').trim().slice(0, 60),
              left: Math.round(rect.left),
              right: Math.round(rect.right),
              width: Math.round(rect.width),
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
            };
          })
          .filter((element) => element.right > document.documentElement.clientWidth + 1 || element.left < -1 || element.scrollWidth > element.clientWidth + 1)
          .slice(0, 12),
      };
    });
    expect(layout.overflow, `${width}px horizontal overflow: ${JSON.stringify(layout.offenders)}`).toBeLessThanOrEqual(1);
    expect(layout.undersized, `${width}px controls smaller than 44px`).toEqual([]);
    if (process.env.SEO_OPT_SCREENSHOTS === '1') {
      await panelPage.screenshot({ path: `/tmp/seo-opt-panel-${width}-light.png` });
    }
  }

  await panelPage.setViewportSize({ width: 375, height: 800 });
  await clickWithoutFocusing(panelPage, '设置');
  await expect(panelPage.getByText('深色', { exact: true })).toHaveCount(0);
  await expect(panelPage.getByText('跟随系统', { exact: true })).toHaveCount(0);
  await expect(panelPage.getByRole('switch')).toHaveCount(0);
  await expect(panelPage.getByLabel('请求地址')).toBeVisible();
  await expect(panelPage.getByLabel('模型')).toBeVisible();
  await expect(panelPage.locator('#ai-key')).toBeVisible();
  await expect(panelPage.getByRole('link', { name: '获取 API Key' })).toHaveAttribute('href', 'https://codecc.cc');
  await panelPage.getByLabel('请求地址').fill('https://codecc.cc/');
  await expect(panelPage.locator('.endpoint-recognition')).toContainText('https://codecc.cc/v1/chat/completions');
  await panelPage.getByLabel('请求地址').fill('');
  await panelPage.getByRole('button', { name: '关闭设置' }).click();
  await expect(panelPage.locator('html')).not.toHaveAttribute('data-theme');
  if (process.env.SEO_OPT_SCREENSHOTS === '1') {
    await panelPage.screenshot({ path: '/tmp/seo-opt-panel-375-light.png' });
  }
  await overviewSections.getByRole('tab', { name: '摘要' }).click();
  await panelPage.emulateMedia({ reducedMotion: 'reduce' });
  const reducedMotionDuration = await panelPage.locator('.score-value').evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(reducedMotionDuration)).toBeLessThanOrEqual(0.00001);

  await panelPage.keyboard.press('Tab');
  const focusVisible = await panelPage.evaluate(() => document.activeElement instanceof HTMLElement
    && document.activeElement.matches('button,input,textarea,select,a[href],summary,[tabindex]:not([tabindex="-1"])'));
  expect(focusVisible).toBe(true);

  const overviewTab = panelPage.getByRole('tab', { name: '概览' });
  await overviewTab.focus();
  await overviewTab.press('ArrowRight');
  await expect(panelPage.getByRole('tab', { name: '问题' })).toHaveAttribute('aria-selected', 'true');
  await panelPage.getByRole('tab', { name: '问题' }).press('ArrowRight');
  await expect(panelPage.getByRole('tab', { name: '优化建议' })).toHaveAttribute('aria-selected', 'true');
  await expect(panelPage.getByRole('heading', { name: '网站优化方案' })).toBeVisible();
  await expect(panelPage.getByText('执行队列', { exact: false })).toHaveCount(0);
  await expect(panelPage.locator('select')).toHaveCount(0);
  await expect(panelPage.locator('strong')).toHaveCount(0);
  await expect(panelPage.getByText('推荐策略', { exact: false }).first()).toBeVisible();
  await expect(panelPage.getByText('通常修改位置', { exact: true }).first()).toBeVisible();
  await expect(panelPage.getByRole('button', { name: /查看代码解释/ }).first()).toBeVisible();
  await panelPage.getByRole('button', { name: /建议分类/ }).click();
  await expect(panelPage.getByRole('listbox', { name: '建议分类' })).toBeVisible();
  await panelPage.keyboard.press('End');
  await panelPage.keyboard.press('Escape');
  await expect(panelPage.getByRole('button', { name: /建议分类/ })).toBeFocused();
  if (process.env.SEO_OPT_SCREENSHOTS === '1') {
    await panelPage.screenshot({ path: '/tmp/seo-opt-recommendations-375-light.png' });
  }
  await panelPage.getByRole('tab', { name: '问题' }).click();
  await expect(panelPage.getByRole('tab', { name: '问题' })).toHaveAttribute('aria-selected', 'true');
  await expect(panelPage.getByRole('button', { name: '状态：未通过（失败/警告）' })).toBeVisible();
  await expect(panelPage.locator('.issue-card.status-pass')).toHaveCount(0);
  await expect(panelPage.locator('.issue-card.status-informational')).toHaveCount(0);
  await expect(panelPage.locator('.issue-card.status-not_measurable')).toHaveCount(0);
  await expect(panelPage.locator('.issue-card.status-not_applicable')).toHaveCount(0);

  await expect(panelPage.getByRole('group', { name: '优先级筛选' })).toBeVisible();
  await panelPage.getByRole('button', { name: '分类：全部分类' }).click();
  await expect(panelPage.getByRole('menu', { name: '分类筛选' })).toBeVisible();
  await expect(panelPage.getByRole('menuitemradio', { name: /性能指标/ })).toBeVisible();
  if (process.env.SEO_OPT_SCREENSHOTS === '1') {
    await panelPage.screenshot({ path: '/tmp/seo-opt-filters-375-light.png' });
  }
  await panelPage.getByRole('menuitemradio', { name: '媒体与结构化数据' }).click();
  await expect(panelPage.getByRole('button', { name: '分类：媒体与结构化数据' })).toBeVisible();
  await panelPage.getByRole('button', { name: '重置筛选' }).click();
  await expect(panelPage.getByText('图片替代文本', { exact: true })).toBeVisible();
  await panelPage.getByText('图片替代文本', { exact: true }).click();
  const issueScrollBeforeRecommendation = await panelPage.locator('.app-main').evaluate((element) => element.scrollTop);
  await panelPage.getByRole('button', { name: '查看完整优化建议' }).click();
  await expect(panelPage.getByRole('tab', { name: '优化建议' })).toHaveAttribute('aria-selected', 'true');
  await expect(panelPage.locator('.recommendation-expanded')).toBeVisible();
  await panelPage.getByRole('button', { name: '查看完整问题' }).first().click();
  await expect(panelPage.getByRole('tab', { name: '问题' })).toHaveAttribute('aria-selected', 'true');
  await expect(panelPage.getByRole('button', { name: '状态：未通过（失败/警告）' })).toBeVisible();
  await expect.poll(() => panelPage.locator('.app-main').evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(Math.max(0, issueScrollBeforeRecommendation - 8));
  await fixturePage.bringToFront();
  await clickWithoutFocusing(panelPage, '网页定位');
  await expect.poll(() => fixturePage.locator('#seo-opt-overlay-root').count()).toBe(1);

  await clickWithoutFocusing(panelPage, '设置');
  await panelPage.getByLabel('请求地址').fill('http://127.0.0.1:4174/v1');
  await expect(panelPage.locator('.endpoint-recognition')).toContainText('http://127.0.0.1:4174/v1/chat/completions');
  await panelPage.getByLabel('模型').fill('fixture-model');
  await panelPage.locator('#ai-key').fill('e2e-session-key');
  await expect(panelPage.getByRole('button', { name: '保存设置' })).toBeVisible();
  if (process.env.SEO_OPT_SCREENSHOTS === '1') {
    await panelPage.screenshot({ path: '/tmp/seo-opt-settings-ai-375.png' });
  }
  await panelPage.getByRole('button', { name: '保存设置' }).click();
  const keyStorage = await panelPage.evaluate(async () => ({
    local: await chrome.storage.local.get('seo-opt:ai-key'),
    session: await chrome.storage.session.get('seo-opt:ai-key'),
  }));
  expect(keyStorage.local['seo-opt:ai-key']).toBe('e2e-session-key');
  expect(keyStorage.session['seo-opt:ai-key']).toBeUndefined();
  await expect(panelPage.locator('dialog.settings-dialog')).not.toBeVisible();
  await clickWithoutFocusing(panelPage, '设置');
  await expect(panelPage.locator('dialog.settings-dialog')).toBeVisible();
  await expect(panelPage.getByText('API Key 已保存在本机')).toBeVisible();
  await expect(panelPage.getByRole('button', { name: '清除 Key' })).toBeVisible();
  await expect(panelPage.getByRole('button', { name: '保存设置' })).toBeInViewport();
  await panelPage.getByRole('button', { name: '关闭设置' }).click();
  await clickWithoutFocusing(panelPage, 'AI 深度解读');
  await expect(panelPage.getByText('每轮都会携带最新评分')).toBeVisible();
  await panelPage.getByRole('button', { name: '用普通话解释当前网站的问题和优化策略。' }).click();
  await expect(panelPage.locator('.ai-message-streaming')).toBeVisible({ timeout: 3_000 });
  await expect(panelPage.locator('.ai-message-streaming')).toContainText('第 1 轮');
  await expect(panelPage.getByRole('heading', { name: '第 1 轮回答' })).toBeVisible({ timeout: 10_000 });

  const chatLayout = await panelPage.evaluate(() => {
    const main = document.querySelector('.app-main')?.getBoundingClientRect();
    const timeline = document.querySelector('.ai-timeline');
    const composer = document.querySelector('.ai-composer')?.getBoundingClientRect();
    const actionBar = document.querySelector('.action-bar')?.getBoundingClientRect();
    return {
      composerInsideMain: Boolean(main && composer && composer.bottom <= main.bottom + 1),
      composerAboveActions: Boolean(composer && actionBar && composer.bottom <= actionBar.top + 1),
      timelineScrollable: timeline ? getComputedStyle(timeline).overflowY === 'auto' : false,
    };
  });
  expect(chatLayout).toEqual({
    composerInsideMain: true,
    composerAboveActions: true,
    timelineScrollable: true,
  });

  const composer = panelPage.getByLabel('继续追问');
  await composer.fill('延迟回答用于交互测试');
  await panelPage.getByRole('button', { name: '发送' }).click();
  await expect(composer).toHaveValue('');
  await expect(panelPage.getByText('延迟回答用于交互测试', { exact: true })).toBeVisible();
  await expect(panelPage.locator('.ai-message-loading')).toBeVisible();
  if (process.env.SEO_OPT_SCREENSHOTS === '1') {
    await panelPage.screenshot({ path: '/tmp/seo-opt-ai-loading-375.png' });
  }
  const loadingAlignment = await panelPage.locator('.ai-message-loading').evaluate((element) => {
    const row = element.getBoundingClientRect();
    const indicator = element.querySelector('.ai-loading-indicator')?.getBoundingClientRect();
    return indicator ? Math.abs((row.top + row.height / 2) - (indicator.top + indicator.height / 2)) : 999;
  });
  expect(loadingAlignment).toBeLessThanOrEqual(1);
  await expect(composer).toBeEnabled();
  await composer.fill('等待时先写下一条');
  await panelPage.getByRole('button', { name: '停止' }).click();
  await expect(panelPage.locator('.ai-message-loading')).toHaveCount(0);
  await expect(composer).toHaveValue('等待时先写下一条');
  await expect(panelPage.getByText('AI 请求超时', { exact: false })).toHaveCount(0);

  await panelPage.getByLabel('继续追问').fill('第二轮：给出验证方法');
  await panelPage.getByRole('button', { name: '发送' }).click();
  await expect(panelPage.getByRole('heading', { name: '第 2 轮回答' })).toBeVisible({ timeout: 10_000 });

  await composer.fill('模拟失败并恢复草稿');
  await panelPage.getByRole('button', { name: '发送' }).click();
  await expect(panelPage.locator('.ai-chat-error')).toContainText('429');
  await expect(composer).toHaveValue('模拟失败并恢复草稿');
  await expect(panelPage.locator('.global-notice.error-notice')).toHaveCount(0);
  await expect(panelPage.getByRole('button', { name: '重试上条' })).toBeVisible();
  await panelPage.getByRole('button', { name: '关闭 AI 错误' }).click();

  await expect(panelPage.getByRole('button', { name: '保存当前网站对话' })).toBeVisible();
  await panelPage.getByRole('button', { name: '保存当前网站对话' }).click();
  await expect(panelPage.getByText('当前网站 AI 对话已保存到本机')).toBeVisible();
  for (const width of [320, 375, 414, 768]) {
    await panelPage.setViewportSize({ width, height: 800 });
    const aiLayout = await panelPage.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      undersized: Array.from(document.querySelectorAll<HTMLElement>('button,textarea'))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height, label: element.getAttribute('aria-label') || element.textContent || '' };
        })
        .filter((control) => control.width < 44 || control.height < 44),
    }));
    expect(aiLayout.overflow, `${width}px AI horizontal overflow`).toBeLessThanOrEqual(1);
    expect(aiLayout.undersized, `${width}px AI controls smaller than 44px`).toEqual([]);
  }
  await panelPage.setViewportSize({ width: 375, height: 800 });

  await fixturePage.bringToFront();
  await fixturePage.evaluate(() => history.pushState({}, '', '/media-links.html?view=changed'));
  await expect(panelPage.getByText(/media-links\.html\?view=changed/).first()).toBeVisible({ timeout: 20_000 });
  await expect(panelPage.getByText('证据已更新', { exact: true }).first()).toBeVisible();
  await expect(panelPage.getByLabel('继续追问')).toBeEnabled();

  const secondTab = await context.newPage();
  await secondTab.goto('http://127.0.0.1:4173/noindex.html');
  await secondTab.bringToFront();
  await triggerExtensionAction(secondTab);
  await clickWithoutFocusing(panelPage, '海外站优化');
  await expect(panelPage.getByLabel('当前检查网站 127.0.0.1')).toBeVisible({ timeout: 20_000 });
  await clickWithoutFocusing(panelPage, '概览');
  await expect(panelPage.getByText(/noindex\.html/).first()).toBeVisible({ timeout: 20_000 });
  await clickWithoutFocusing(panelPage, '问题');
  await expect(panelPage.getByRole('button', { name: /P0 索引指令/ })).toHaveCount(0);
  await clickWithoutFocusing(panelPage, '概览');
  await panelPage.getByRole('tablist', { name: '概览内容' }).getByRole('tab', { name: '页面信息' }).click();
  await expect(panelPage.getByText('不应出现在索引中的测试页').first()).toBeVisible();
  await expect(panelPage.getByText('noindex,follow', { exact: true })).toBeVisible();
  await clickWithoutFocusing(panelPage, 'AI 深度解读');
  await expect(panelPage.getByRole('heading', { name: '第 1 轮回答' })).toBeVisible();
  await expect(panelPage.getByText('证据已更新', { exact: true }).first()).toBeVisible();

  const isolatedOrigin = await context.newPage();
  await isolatedOrigin.goto('http://localhost:4173/healthy.html');
  await isolatedOrigin.bringToFront();
  await triggerExtensionAction(isolatedOrigin);
  await clickWithoutFocusing(panelPage, 'AI 深度解读');
  await expect(panelPage.getByText('从当前审计继续追问')).toBeVisible({ timeout: 20_000 });
  await expect(panelPage.getByRole('heading', { name: '第 1 轮回答' })).toHaveCount(0);
  await isolatedOrigin.close();

  await fixturePage.bringToFront();
  await expect(panelPage.getByText(/media-links\.html\?view=changed/).first()).toBeVisible({ timeout: 20_000 });
  await expect(panelPage.getByText('当前结果可能过期')).toHaveCount(0);
  await secondTab.close();

  const restricted = await context.newPage();
  await restricted.goto('chrome://settings/');
  await restricted.bringToFront();
  await triggerExtensionAction(restricted);
  await expect(panelPage.getByRole('heading', { name: '当前页面不可测' })).toBeVisible({ timeout: 8_000 });
  await restricted.goto('http://127.0.0.1:4173/healthy.html');
  await panelPage.getByRole('tab', { name: '概览' }).click();
  await expect(panelPage.getByTestId('overall-score')).not.toHaveText('—', { timeout: 20_000 });
  await expect(panelPage.getByRole('heading', { name: '当前页面不可测' })).toHaveCount(0);
  await restricted.close();
});

test('runs the complete overseas optimization workflow', async () => {
  test.setTimeout(120_000);
  await fixturePage.goto('http://127.0.0.1:4173/overseas-demo.html');
  await fixturePage.bringToFront();
  await triggerExtensionAction(fixturePage);
  await panelPage.getByRole('tab', { name: '海外站优化' }).click();
  await expect(panelPage.getByRole('heading', { name: '海外站优化' })).toBeVisible();
  await expect(panelPage.getByLabel('当前检查网站 127.0.0.1')).toBeVisible({ timeout: 20_000 });
  await expect(panelPage.getByLabel('网站地址')).toHaveCount(0);

  const overseasTabs = panelPage.getByRole('tablist', { name: '海外站优化工作区' });
  await expect(overseasTabs.getByRole('tab').allTextContents()).resolves.toEqual(['概况', '问题', '优化建议', '追踪']);
  await overseasTabs.getByRole('tab', { name: '概况' }).focus();
  await panelPage.keyboard.press('End');
  await expect(overseasTabs.getByRole('tab', { name: '追踪' })).toHaveAttribute('aria-selected', 'true');
  await panelPage.keyboard.press('Home');
  await expect(overseasTabs.getByRole('tab', { name: '概况' })).toHaveAttribute('aria-selected', 'true');

  await expect(panelPage.getByText('自动检查完成')).toBeVisible();
  await expect(panelPage.locator('.overseas-result-group')).toHaveCount(4);
  await expect(panelPage.getByRole('heading', { name: '搜索访问' })).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: '语言与地区' })).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: '数据统计' })).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: '广告与业务' })).toBeVisible();
  const overseasCounts = (await panelPage.locator('.overseas-counts .count-value').allTextContents()).map(Number);
  expect(overseasCounts).toHaveLength(3);
  await expect(panelPage.locator('details.overseas-normal-details > summary')).toContainText('查看已确认正常项目');
  await expect(panelPage.locator('details.overseas-evidence-boundaries > summary')).toContainText('查看检测边界');
  await expect(panelPage.getByText('接下来怎么做', { exact: true })).toHaveCount(0);
  await expect(panelPage.getByText('下一步检查', { exact: true })).toHaveCount(0);
  await expect(panelPage.getByRole('button', { name: '刷新页面证据' })).toHaveCount(0);

  const assertOverseasLayout = async (label: string) => {
    for (const width of [320, 375, 414, 768]) {
      await panelPage.setViewportSize({ width, height: 800 });
      const layout = await panelPage.locator('.overseas-workspace').evaluate((workspace) => ({
        overflow: workspace.scrollWidth - workspace.clientWidth,
        undersized: Array.from(workspace.querySelectorAll<HTMLElement>('button, summary'))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
          })
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return { width: rect.width, height: rect.height, label: element.getAttribute('aria-label') || element.textContent || '' };
          })
          .filter((control) => control.width < 44 || control.height < 44),
      }));
      expect(layout.overflow, `${width}px ${label} horizontal overflow`).toBeLessThanOrEqual(1);
      expect(layout.undersized, `${width}px ${label} controls smaller than 44px`).toEqual([]);
      if (process.env.SEO_OPT_SCREENSHOTS === '1') {
        const screenshotLabel = label.replaceAll(' ', '-');
        await panelPage.screenshot({ path: `/tmp/seo-opt-${screenshotLabel}-${width}.png` });
      }
    }
    await panelPage.setViewportSize({ width: 375, height: 800 });
  };
  await assertOverseasLayout('overseas summary');

  await panelPage.locator('details.optional-settings summary').click();
  await panelPage.getByLabel('目标国家或地区').fill('美国');
  await panelPage.getByLabel('目标语言').fill('en-US');
  const engineSelect = panelPage.getByRole('button', { name: /主要搜索引擎/ });
  await engineSelect.focus();
  await engineSelect.press('ArrowDown');
  await expect(panelPage.getByRole('listbox', { name: '主要搜索引擎' })).toBeVisible();
  await panelPage.getByRole('option', { name: 'Google', exact: true }).press('Enter');
  await expect(engineSelect).toContainText('Google');

  const languageGroup = panelPage.locator('.overseas-result-group').filter({ has: panelPage.getByRole('heading', { name: '语言与地区' }) });
  await languageGroup.locator('summary').click();
  await expect(languageGroup.getByText(/已自动检查 \d+ 个/)).toBeVisible({ timeout: 20_000 });
  await overseasTabs.getByRole('tab', { name: '问题' }).click();
  if (overseasCounts[1]! > 0) {
    await expect(panelPage.locator('.overseas-problem-card')).toHaveCount(overseasCounts[1]!);
    const problem = panelPage.locator('.overseas-problem-card').first();
    const findingId = await problem.getAttribute('data-overseas-problem-id');
    expect(findingId).toBeTruthy();
    await problem.getByRole('button', { name: '查看优化建议' }).click();
    await expect(overseasTabs.getByRole('tab', { name: '优化建议' })).toHaveAttribute('aria-selected', 'true');
    const linkedRecommendation = panelPage.locator(`[data-recommendation-id="${findingId}"]`);
    await expect(linkedRecommendation).toBeVisible();
    await expect(linkedRecommendation.locator('.recommendation-summary')).toHaveAttribute('aria-expanded', 'true');
  } else {
    await expect(panelPage.getByText('本次未取得直接异常证据')).toBeVisible();
    await panelPage.getByRole('button', { name: '查看优化建议' }).click();
  }
  await expect(overseasTabs.getByRole('tab', { name: '优化建议' })).toHaveAttribute('aria-selected', 'true');
  expect(await panelPage.locator('.overseas-recommendations-panel .recommendation-item').count()).toBeGreaterThan(0);

  await overseasTabs.getByRole('tab', { name: '追踪' }).click();
  await expect(panelPage.getByRole('heading', { name: '追踪', exact: true })).toBeVisible();
  await expect.poll(() => panelPage.locator('.app-main').evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
  const trackingTool = panelPage
    .locator('details.tracking-tool-section')
    .filter({ hasText: '现场追踪测试' });
  if (!(await trackingTool.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await trackingTool.locator(':scope > summary').click();
  }
  await assertOverseasLayout('tracking test');
  await panelPage.getByRole('button', { name: '开始测试' }).click();
  await expect(panelPage.getByText('REC', { exact: true })).toBeVisible({ timeout: 8_000 });
  await fixturePage.bringToFront();
  await fixturePage.getByRole('button', { name: 'Book a successful demo' }).click();
  await panelPage.getByRole('button', { name: '成功操作已完成' }).click();
  await fixturePage.bringToFront();
  await fixturePage.getByRole('button', { name: 'Submit an invalid form' }).click();
  await fixturePage.getByRole('button', { name: 'Open pricing route' }).click();
  await fixturePage.evaluate(() => {
    const queue = (window as typeof window & { uetq: unknown[] }).uetq;
    for (let index = 0; index < 25; index += 1) queue.push('event', `flush_tail_${index}`, {});
  });
  const wrappedState = await fixturePage.evaluate(() => {
    const root = window as typeof window & { dataLayer?: { push: unknown }; uetq?: { push: unknown }; __seoOptOriginalDataLayerPush?: unknown; __seoOptOriginalUetPush?: unknown };
    return {
      dataLayerRestored: root.dataLayer?.push === root.__seoOptOriginalDataLayerPush,
      uetRestored: root.uetq?.push === root.__seoOptOriginalUetPush,
    };
  });
  expect(wrappedState).toEqual({ dataLayerRestored: false, uetRestored: false });
  await panelPage.getByRole('button', { name: '失败操作已完成' }).click();
  await expect(panelPage.getByText('REC', { exact: true })).toHaveCount(0);
  await panelPage.locator('.tracking-timeline-details > summary').click();
  await expect(panelPage.getByText('generate_lead', { exact: true }).first()).toBeVisible({ timeout: 8_000 });
  await expect(panelPage.locator('.tracking-event').filter({ hasText: 'generate_lead' }).filter({ hasText: 'bing_uet · event' })).toBeVisible();
  await expect(panelPage.getByText('form_error', { exact: true })).toBeVisible();
  await expect(panelPage.getByText('pushState', { exact: true })).toBeVisible();
  await expect(panelPage.getByText('成功操作被观察到记录一次。')).toBeVisible();
  await expect(panelPage.getByText('失败操作没有被观察为转化。')).toBeVisible();
  const restoredAfterStop = await fixturePage.evaluate(() => {
    const root = window as typeof window & { dataLayer?: { push: unknown }; uetq?: { push: unknown }; __seoOptOriginalDataLayerPush?: unknown; __seoOptOriginalUetPush?: unknown };
    return {
      dataLayerRestored: root.dataLayer?.push === root.__seoOptOriginalDataLayerPush,
      uetRestored: root.uetq?.push === root.__seoOptOriginalUetPush,
    };
  });
  expect(restoredAfterStop).toEqual({ dataLayerRestored: true, uetRestored: true });
  const storedTrackingRuns = await panelPage.evaluate(async () => {
    const request = indexedDB.open('seo-opt-workbench');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction('trackingRuns', 'readonly');
    const runs = await new Promise<Array<{ status: string; observations: Array<{ name: string }> }>>((resolve, reject) => {
      const getAll = transaction.objectStore('trackingRuns').getAll();
      getAll.onsuccess = () => resolve(getAll.result);
      getAll.onerror = () => reject(getAll.error);
    });
    database.close();
    return runs;
  });
  expect(storedTrackingRuns.some((run) => run.status === 'stopped' && run.observations.some((item) => item.name === 'flush_tail_24'))).toBe(true);
  await panelPage.reload();
  await clickWithoutFocusing(panelPage, '海外站优化');
  await panelPage.getByRole('tablist', { name: '海外站优化工作区' }).getByRole('tab', { name: '追踪' }).click();
  const restoredTrackingTool = panelPage
    .locator('details.tracking-tool-section')
    .filter({ hasText: '现场追踪测试' });
  if (!(await restoredTrackingTool.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await restoredTrackingTool.locator(':scope > summary').click();
  }
  await expect(panelPage.getByRole('heading', { name: '最近追踪测试' })).toBeVisible({ timeout: 10_000 });
  await panelPage.locator('.tracking-timeline-details > summary').click();
  await expect(panelPage.getByText('flush_tail_24', { exact: true })).toBeVisible();
  await expect(panelPage.getByText(/stopped|completed/)).toBeVisible();

  const reconciliationTool = panelPage.locator('details.tracking-tool-section').filter({ hasText: '报表数据核对' });
  if (!(await reconciliationTool.evaluate((element) => (element as HTMLDetailsElement).open))) await reconciliationTool.locator(':scope > summary').click();
  await assertOverseasLayout('data reconciliation');
  await panelPage.getByLabel('数据比较币种').fill('USD');
  const ga4 = panelPage.locator('section[aria-label="导入GA4 分析数据 CSV"]');
  await ga4.locator('input[type="file"]').setInputFiles({ name: 'ga4-overseas.csv', mimeType: 'text/csv', buffer: Buffer.from('日期,页面,来源,媒介,会话系列,会话数,互动会话数,用户数,事件名称,关键事件数,总收入,货币\n2026-08-01,/overseas-demo.html,google,cpc,Global Search,80,60,70,generate_lead,8,1000,USD') });
  await ga4.getByRole('button', { name: '确认导入' }).click();
  const ads = panelPage.locator('section[aria-label="导入广告表现 CSV"]');
  await ads.locator('input[type="file"]').setInputFiles({ name: 'ads-overseas.csv', mimeType: 'text/csv', buffer: Buffer.from('日期,广告系列,点击次数,费用,转化次数,最终网址,展示次数,UTM系列\n2026-08-01,Global Search,100,300,12,http://127.0.0.1:4173/overseas-demo.html,1000,Global Search') });
  await ads.getByRole('button', { name: '确认导入' }).click();
  const business = panelPage.locator('section[aria-label="导入业务结果 CSV"]');
  await business.locator('input[type="file"]').setInputFiles({ name: 'business-overseas.csv', mimeType: 'text/csv', buffer: Buffer.from('日期,有效转化,收入,退款,毛利,UTM系列\n2026-08-01,5,800,50,400,Global Search') });
  await business.getByRole('button', { name: '确认导入' }).click();
  await expect(panelPage.getByText('ga4-overseas.csv')).toBeVisible();
  await panelPage.getByRole('button', { name: '运行三方数据核对' }).click();
  await expect(panelPage.locator('[aria-label="追踪数据漏斗"]')).toBeVisible({ timeout: 20_000 });
  await expect(panelPage.getByText('网站时区 / 成熟期')).toBeVisible();
  await expect(panelPage.getByText('点击 ID')).toBeVisible();
  await expect(panelPage.getByRole('heading', { name: '仍缺少的数据与口径说明' })).toHaveCount(0);
  await overseasTabs.getByRole('tab', { name: '问题' }).click();
  await expect(panelPage.locator('.overseas-problem-card')).not.toHaveCount(0);
  await overseasTabs.getByRole('tab', { name: '优化建议' }).click();
  await expect(panelPage.locator('.overseas-recommendations-panel .recommendation-item')).not.toHaveCount(0);
  await overseasTabs.getByRole('tab', { name: '追踪' }).click();
  await expect(panelPage.getByRole('button', { name: '删除这次追踪测试' })).toBeVisible();
  await panelPage.getByRole('button', { name: '删除这次追踪测试' }).click();
  await expect(panelPage.getByRole('button', { name: '删除这次追踪测试' })).toHaveCount(0);
});

test('generates Chrome Web Store screenshots from the real extension UI', async () => {
  test.setTimeout(150_000);
  test.skip(process.env.SEO_OPT_STORE_ASSETS !== '1', 'Store assets are generated only on demand.');

  await fixturePage.goto('http://127.0.0.1:4173/store-demo.html');
  await fixturePage.bringToFront();
  await triggerExtensionAction(fixturePage);
  await expect(panelPage.getByRole('tab', { name: '概览' })).toBeVisible({ timeout: 20_000 });
  await clickWithoutFocusing(panelPage, '概览');
  await expect(panelPage.getByRole('region', { name: /store-demo\.html/ })).toBeVisible({ timeout: 20_000 });
  await expect(panelPage.getByTestId('overall-score')).not.toHaveText('—');
  await expect(panelPage.getByText('六类信号')).toBeVisible();

  await panelPage.setViewportSize({ width: 415, height: 800 });
  await fixturePage.setViewportSize({ width: 865, height: 800 });

  const assetsDir = resolve('store/assets');
  mkdirSync(assetsDir, { recursive: true });

  const capture = async (filename: string) => {
    const pageImage = await fixturePage.screenshot({ type: 'png' });
    const panelImage = await panelPage.screenshot({ type: 'png' });
    await sharp({ create: { width: 1280, height: 800, channels: 4, background: '#f4f7fb' } })
      .composite([
        { input: pageImage, left: 0, top: 0 },
        { input: panelImage, left: 865, top: 0 },
        { input: { create: { width: 1, height: 800, channels: 4, background: '#c7d2e2' } }, left: 864, top: 0 },
      ])
      .png()
      .toFile(join(assetsDir, filename));
  };

  await clickWithoutFocusing(panelPage, '优化建议');
  await expect(panelPage.getByRole('heading', { name: '网站优化方案' })).toBeVisible();
  const codeRecommendation = panelPage.locator('.recommendation-item').filter({ has: panelPage.locator('.code-advice pre code') }).first();
  await codeRecommendation.locator('.recommendation-summary').click();
  await codeRecommendation.getByRole('button', { name: '查看代码解释、变量、验证和回滚' }).click();
  await expect(codeRecommendation.getByRole('heading', { name: '代码逐段解释' })).toBeVisible();
  await codeRecommendation.locator('.code-advice').first().scrollIntoViewIfNeeded();
  await capture('01-optimization-code-1280x800.png');

  await clickWithoutFocusing(panelPage, '概览');
  await panelPage.getByRole('tablist', { name: '概览内容' }).getByRole('tab', { name: '摘要' }).click();
  await panelPage.locator('#view-panel').evaluate((element) => { element.scrollTop = 0; });
  await capture('02-core-seo-1280x800.png');

  await panelPage.getByRole('tablist', { name: '概览内容' }).getByRole('tab', { name: '站点审计' }).click();
  const runSiteAudit = panelPage.getByRole('button', { name: '快速检查 20 页' });
  await expect(runSiteAudit).toBeVisible();
  await runSiteAudit.click();
  await expect(panelPage.locator('.site-run-summary')).toContainText('已完成', { timeout: 20_000 });
  const siteIssue = panelPage.locator('.site-issue-card').first();
  await expect(siteIssue).toBeVisible();
  await siteIssue.scrollIntoViewIfNeeded();
  await capture('03-site-audit-1280x800.png');

  await fixturePage.goto('http://127.0.0.1:4173/overseas-demo.html');
  await fixturePage.bringToFront();
  await triggerExtensionAction(fixturePage);
  await clickWithoutFocusing(panelPage, '海外站优化');
  await expect(panelPage.getByRole('heading', { name: '海外站优化' })).toBeVisible();
  await panelPage.locator('details.optional-settings summary').click();
  await panelPage.getByLabel('目标国家或地区').fill('美国');
  await panelPage.getByLabel('目标语言').fill('en-US');
  const overseasTabs = panelPage.getByRole('tablist', { name: '海外站优化工作区' });
  await overseasTabs.getByRole('tab', { name: '优化建议' }).click();
  const overseasFinding = panelPage.locator('.overseas-recommendations-panel .recommendation-item').first();
  await expect(overseasFinding).toBeVisible({ timeout: 20_000 });
  await overseasFinding.scrollIntoViewIfNeeded();
  await capture('04-overseas-advice-1280x800.png');

  await clickWithoutFocusing(panelPage, 'SEM');
  await expect(panelPage.getByRole('heading', { name: 'SEM 诊断' })).toBeVisible();
  const semTabs = panelPage.getByRole('tablist', { name: 'SEM 工作区' });
  await semTabs.getByRole('tab', { name: '概况' }).click();
  await panelPage.getByLabel('货币').fill('USD');
  await panelPage.getByLabel('核心转化').fill('有效咨询');
  await semTabs.getByRole('tab', { name: '数据' }).click();
  const semAds = panelPage.locator('section[aria-label="导入广告表现 CSV"]');
  await semAds.locator('input[type="file"]').setInputFiles({
    name: 'sem-diagnosis-ads.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from([
      '日期,广告系列,搜索词,展示次数,点击次数,费用,转化次数,最终网址',
      '2026-08-01,Global Search,seo audit platform,1200,96,960,8,http://127.0.0.1:4173/overseas-demo.html',
      '2026-08-02,Global Search,free seo checker,900,80,800,0,http://127.0.0.1:4173/overseas-demo.html',
    ].join('\n')),
  });
  await semAds.getByRole('button', { name: '确认导入' }).click();
  const semBusiness = panelPage.locator('section[aria-label="导入业务结果 CSV"]');
  await semBusiness.locator('input[type="file"]').setInputFiles({
    name: 'sem-diagnosis-business.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('日期,有效转化,收入,退款,毛利,UTM系列\n2026-08-01,3,1200,100,500,Global Search'),
  });
  await semBusiness.getByRole('button', { name: '确认导入' }).click();
  await panelPage.getByRole('button', { name: '运行 SEM 诊断' }).click();
  await expect(semTabs.getByRole('tab', { name: '诊断' })).toHaveAttribute('aria-selected', 'true');
  const semFinding = panelPage.locator('.sem-finding').first();
  await expect(semFinding).toBeVisible();
  await semFinding.scrollIntoViewIfNeeded();
  await capture('05-sem-diagnosis-1280x800.png');
});
