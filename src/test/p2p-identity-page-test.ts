/**
 * P2P Identity Page Test with Playwright
 * 测试 P2P 身份页面，显示 DID、CID 等信息
 */

import { chromium } from 'playwright';

async function testP2PIdentityPage() {
  console.log('=== P2P Identity Page Test ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1. 打开 Bolloon 网页
    console.log('1. 打开 Bolloon 网页...');
    await page.goto('http://localhost:54188', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // 2. 初始化 iroh
    console.log('2. 初始化 iroh...');
    const irohInit = await page.evaluate(async () => {
      const res = await fetch('/api/iroh/init', { method: 'POST' });
      return res.json();
    });
    console.log('   iroh 初始化结果:');
    console.log('   - DID:', irohInit.did?.substring(0, 30) + '...');
    console.log('   - CID:', irohInit.cid);
    console.log('   - Initialized:', irohInit.initialized);

    // 3. 打开 P2P Modal
    console.log('\n3. 打开 P2P Modal...');

    // 初始化 iroh（这会触发 CID 生成）
    await page.evaluate(async () => {
      await fetch('/api/iroh/init', { method: 'POST' });
    });
    await page.waitForTimeout(1000);

    // 打开 P2P Modal 通过点击按钮
    await page.evaluate(() => {
      const btn = document.querySelector('#p2p-network-btn') as HTMLButtonElement;
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);

    // 4. 获取身份信息显示
    console.log('\n4. 获取身份信息...');

    // 获取 modal HTML 结构用于调试
    const modalHtml = await page.evaluate(() => {
      const modal = document.querySelector('.p2p-modal');
      return modal ? modal.outerHTML : 'Modal not found';
    });
    console.log('\n   Modal HTML:');
    console.log('   ', modalHtml.substring(0, 1000));

    // 检查 p2p-info-row 中的 label 内容
    const labels = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.p2p-info-row .label')).map(el => el.textContent);
    });
    console.log('\n   Labels found:', labels);

    // 检查是否有 CID
    const hasCidRow = await page.evaluate(() => {
      const rows = document.querySelectorAll('.p2p-info-row');
      for (const row of rows) {
        const label = row.querySelector('.label')?.textContent;
        if (label?.includes('CID')) return true;
      }
      return false;
    });
    console.log('   CID row exists:', hasCidRow);

    console.log('\n=== 测试完成 ===');

  } catch (error) {
    console.error('测试失败:', error);
  } finally {
    await browser.close();
  }
}

// 运行测试
testP2PIdentityPage().catch(console.error);