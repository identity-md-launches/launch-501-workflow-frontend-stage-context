import assert from 'node:assert/strict';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { decodeAbiParameters, parseAbiParameters, parseEther, zeroAddress } from 'viem';
import { startFixtureServer, makeFixture, buyer, operator } from './fixture.mjs';

const evidence = resolve(import.meta.dirname, '../../docs/evidence');
await mkdir(evidence, { recursive: true });
let executablePath;
for (const candidate of [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/home/imd-worker/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome']) {
  if (candidate) try { await access(candidate); executablePath = candidate; break; } catch { /* Use Playwright's configured browser if absent. */ }
}
const server = await startFixtureServer();
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const results = [];
const checks = [];
async function waitFor(condition, label, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await condition()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Timed out: ${label}`);
}
async function scenario(name, options, run) {
  if (process.env.TEST_FILTER && !name.toLowerCase().includes(process.env.TEST_FILTER.toLowerCase())) return;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on('pageerror', e => runtimeErrors.push(e.message));
  page.on('console', message => { if (message.type() === 'error') runtimeErrors.push(message.text()); });
  page.on('response', r => { if (r.url().startsWith(server.url) && r.status() >= 400) runtimeErrors.push(`${r.status()} ${r.url()}`); });
  const fixture = await makeFixture(page, options);
  try {
    await page.goto(server.url);
    await page.getByRole('heading', { name: /A small plot.*A shared future/i }).waitFor();
    await waitFor(() => page.locator('.plot').count().then(n => n === 256), '256 city controls render');
    await run(page, fixture);
    assert.deepEqual(runtimeErrors, [], 'No browser JavaScript or local asset failures');
    assert.deepEqual(fixture.state.errors, [], 'No unexpected external requests');
    results.push({ name, status: 'passed', transactions: fixture.state.transactions.map(t => t.name), rpcRequests: fixture.state.requests.length });
    console.log(`PASS ${name}`);
  } catch (e) {
    results.push({ name, status: 'failed', error: e.message, runtimeErrors, fixtureErrors: fixture.state.errors });
    console.error(`FAIL ${name}: ${e.message}`);
    await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true });
    console.error((await page.locator('body').innerText()).slice(0, 1200));
    console.error(JSON.stringify(await page.evaluate(() => window.__wallet?.requests),null,2));
    throw e;
  } finally { await context.close(); }
}
async function connect(page) {
  await page.getByRole('button', { name: /^Connect wallet$/i }).click();
  await waitFor(() => page.getByRole('button', { name: /^Connect wallet$/i }).count().then(n => n === 0), 'connected address appears');
}
async function quote(page, amount = '0.01') {
  await page.getByLabel(/^You pay/).fill(amount);
  await page.getByRole('button', { name: /^(Get|Refresh) quote$/ }).click();
  await page.getByText('Expected output', { exact: true }).waitFor();
}
async function receipt(page, fixture, count) {
  await waitFor(() => fixture.state.transactions.length === count, 'mock wallet request');
  await waitFor(() => page.locator('body').innerText().then(text => /confirmed\./i.test(text)), 'confirmed transaction and state refresh');
}
function inspectSwap(transaction, fixture, native) {
  assert.equal(transaction.to.toLowerCase(), fixture.manifest.network.uniswapV4.universalRouter.toLowerCase());
  assert.equal(transaction.args[0], '0x10');
  const [actions, params] = decodeAbiParameters(parseAbiParameters('bytes,bytes[]'), transaction.args[1][0]);
  assert.equal(actions, '0x060c0f');
  const [swap] = decodeAbiParameters(parseAbiParameters('((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)'), params[0]);
  assert.equal(swap.poolKey.currency0, zeroAddress);
  assert.equal(swap.poolKey.currency1.toLowerCase(), fixture.byName.LaunchToken.address.toLowerCase());
  assert.equal(swap.poolKey.hooks, zeroAddress);
  assert.equal(swap.poolKey.fee, 3000);
  assert.equal(swap.poolKey.tickSpacing, 60);
  assert.equal(swap.zeroForOne, native);
  assert.equal(swap.amountIn, parseEther(native ? '0.01' : '1000'));
  assert.equal(swap.amountOutMinimum, parseEther(native ? '1492.5' : '0.002985'));
  const [settle, settleAmount] = decodeAbiParameters(parseAbiParameters('address,uint256'), params[1]);
  const [take, takeAmount] = decodeAbiParameters(parseAbiParameters('address,uint256'), params[2]);
  assert.equal(settle.toLowerCase(), native ? zeroAddress : fixture.byName.LaunchToken.address.toLowerCase());
  assert.equal(take.toLowerCase(), native ? fixture.byName.LaunchToken.address.toLowerCase() : zeroAddress);
  assert.equal(settleAmount, swap.amountIn);
  assert.equal(takeAmount, swap.amountOutMinimum);
  assert.equal(BigInt(transaction.value || '0x0'), native ? swap.amountIn : 0n);
}

try {
  await scenario('Missing browser wallet gives a recovery instruction', { wallet: false }, async page => {
    await page.getByRole('button', { name: /^Connect wallet$/i }).click();
    await page.getByText(/No browser wallet detected/).waitFor();
    assert.equal(await page.getByRole('button', { name: /^Get quote$/ }).isDisabled(), true);
  });
  await scenario('Connection rejection and unknown chain add/switch recover', { rejectConnect: true, wrongChain: true }, async (page, fixture) => {
    await page.getByRole('button', { name: /^Connect wallet$/i }).click();
    await page.getByText(/Request rejected in your wallet/).waitFor();
    await connect(page);
    await page.getByRole('button', { name: /Switch to Sepolia/i }).click();
    await waitFor(() => page.getByRole('button', { name: /Switch to Sepolia/i }).count().then(n => n === 0), 'wrong network resolves');
    const wallet = await page.evaluate(() => ({ added: window.__wallet.added, switches: window.__wallet.switchRequests, requests: window.__wallet.requests }));
    assert.equal(wallet.added, true);
    assert.equal(wallet.switches, 2);
    assert.deepEqual(wallet.requests.find(r => r.method === 'wallet_addEthereumChain').params[0], fixture.manifest.walletAddChain);
    await quote(page);
    assert.equal(await page.getByRole('button', { name: 'Swap ETH for GRID', exact: true }).isEnabled(), true);
  });
  await scenario('Purchase approval rejection, pending lock and soulbound purchase review', {}, async (page, fixture) => {
    await connect(page);
    await page.evaluate(() => { window.__wallet.rejectNext = 'eth_sendTransaction'; });
    await page.getByRole('button', { name: /Approve GRID for purchase/ }).click();
    await page.getByText(/Request rejected in your wallet/).waitFor();
    assert.equal(fixture.state.transactions.length, 0);
    fixture.state.receiptDelay = 800;
    await page.getByRole('button', { name: /Approve GRID for purchase/ }).click();
    await page.getByRole('button', { name: /Approving purchase/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Approving purchase/ }).isDisabled(), true);
    await receipt(page, fixture, 1);
    const purchase = page.getByRole('button', { name: /Review purchase/ });
    await purchase.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText(/permanently bound/).waitFor();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await purchase.evaluate(e => document.activeElement === e), true, 'Review returns focus to its trigger');
    await purchase.click();
    await dialog.getByRole('button', { name: 'Confirm buy city #000', exact: true }).click();
    await receipt(page, fixture, 2);
    assert.deepEqual(fixture.state.transactions.map(t => t.name), ['approve', 'buyCity']);
    assert.equal(fixture.state.transactions[0].args[0].toLowerCase(), fixture.byName.CityRegistry.address.toLowerCase());
    assert.equal(fixture.state.transactions[1].args[0], 0n);
    await page.getByRole('button', { name: 'Find my city ↗', exact: true }).waitFor();
  });
  await scenario('Owner level and reward claims, non-owner restrictions, keyboard map', { ownsCity: true }, async (page, fixture) => {
    await connect(page);
    await page.getByRole('button', { name: 'Find my city ↗', exact: true }).click();
    await page.getByRole('button', { name: 'Level up city', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm level up city', exact: true }).click();
    await receipt(page, fixture, 1);
    assert.equal(fixture.state.cities.get(17)[1], 3n);
    await page.getByRole('button', { name: 'Claim GRID rewards', exact: true }).click();
    await receipt(page, fixture, 2);
    await waitFor(() => page.getByRole('button', { name: 'Claim GRID rewards', exact: true }).isDisabled(), 'zero claimable disables claim');
    await page.locator('#plot-3').click();
    assert.equal(await page.getByRole('button', { name: 'Claim GRID rewards', exact: true }).isDisabled(), true);
    await page.locator('#plot-3').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'plot-4');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'plot-20');
    await page.getByText('Operator console', { exact: false }).first().click();
    assert.equal(await page.getByRole('button', { name: 'Review resource grant', exact: true }).isDisabled(), true);
  });
  await scenario('Operator grant, heartbeat validation, pause and resume', { account: operator }, async (page, fixture) => {
    await connect(page);
    await page.locator('.operator > summary').click();
    await page.getByLabel('City ID', { exact: true }).fill('17');
    await page.getByLabel('Resources', { exact: true }).fill('100');
    await page.getByRole('button', { name: 'Review resource grant', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm grant resources', exact: true }).click();
    await receipt(page, fixture, 1);
    for (let i = 1; i <= 3; i++) await page.getByLabel(`Winner ${i} city ID`, { exact: true }).fill('17');
    await page.getByRole('button', { name: 'Review heartbeat', exact: true }).click();
    await page.getByText('Choose three distinct cities.', { exact: true }).first().waitFor();
    await page.getByLabel('Winner 2 city ID', { exact: true }).fill('3');
    await page.getByLabel('Winner 3 city ID', { exact: true }).fill('81');
    await page.getByRole('button', { name: 'Review heartbeat', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm record heartbeat', exact: true }).click();
    await receipt(page, fixture, 2);
    await page.getByRole('button', { name: 'Pause grants', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm pause grants', exact: true }).click();
    await receipt(page, fixture, 3);
    await waitFor(() => page.getByRole('button', { name: 'Review resource grant', exact: true }).isDisabled(), 'paused grants disable resource control');
    await page.getByRole('button', { name: 'Resume grants', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm resume grants', exact: true }).click();
    await receipt(page, fixture, 4);
    assert.deepEqual(fixture.state.transactions.map(t => t.name), ['grantResources', 'recordHeartbeat', 'pauseGrants', 'unpauseGrants']);
    assert.equal(fixture.state.paused, false);
  });
  await scenario('GRID transfer validates recipient and simulates before the wallet request', {}, async (page, fixture) => {
    await connect(page);
    await page.locator('summary').filter({ hasText: /^Transfer GRID/ }).click();
    await page.getByLabel('Recipient address', { exact: true }).fill('not an address');
    await page.getByLabel('Amount in GRID', { exact: true }).fill('25');
    await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
    await page.getByText('Enter a valid nonzero Ethereum address.', { exact: true }).last().waitFor();
    assert.equal(fixture.state.transactions.length, 0);
    await page.getByLabel('Recipient address', { exact: true }).fill('0x2222222222222222222222222222222222222222');
    await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
    fixture.state.simulateFails = true;
    await page.getByRole('dialog').getByRole('button', { name: /Confirm transfer grid/i }).click();
    await page.getByText(/not completed. Check the transaction/).waitFor();
    assert.equal(fixture.state.transactions.length, 0, 'Simulation failure prevents signing');
    fixture.state.simulateFails = false;
    await page.getByRole('button', { name: 'Review transfer', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Confirm transfer grid/i }).click();
    await receipt(page, fixture, 1);
    assert.equal(fixture.state.transactions[0].name, 'transfer');
    assert.equal(fixture.state.transactions[0].args[1], parseEther('25'));
  });
  await scenario('Actual deployment authorization mismatch locks writes visibly', { roleMismatch: true }, async (page, fixture) => {
    await connect(page);
    await page.getByText(/Authorization conflict: executor operator/).waitFor();
    assert.equal(await page.getByRole('button', { name: /Approve GRID for purchase/ }).isDisabled(), true);
    await page.getByLabel(/^You pay/).fill('0.01');
    assert.equal(await page.getByRole('button', { name: 'Get quote', exact: true }).isDisabled(), true);
    assert.equal(fixture.state.transactions.length, 0);
  });
  await scenario('Missing contract code blocks all transaction paths', { missingCode: true }, async (page, fixture) => {
    await connect(page);
    await page.getByText(/LaunchToken has no deployed code/).waitFor();
    assert.equal(await page.getByRole('button', { name: /Approve GRID for purchase/ }).isDisabled(), true);
    await page.getByLabel(/^You pay/).fill('0.01');
    assert.equal(await page.getByRole('button', { name: 'Get quote', exact: true }).isDisabled(), true);
    assert.equal(fixture.state.transactions.length, 0);
  });
  await scenario('Native swap simulation, slippage, router encoding and no approval', {}, async (page, fixture) => {
    await connect(page);
    await quote(page);
    await page.getByRole('button', { name: 'Swap ETH for GRID', exact: true }).click();
    await receipt(page, fixture, 1);
    assert.deepEqual(fixture.state.transactions.map(t => t.name), ['execute']);
    inspectSwap(fixture.state.transactions[0], fixture, true);
  });
  await scenario('Token swap requires exact token and Permit2 approval steps', {}, async (page, fixture) => {
    await connect(page);
    await page.getByRole('button', { name: 'GRID → ETH', exact: true }).click();
    await quote(page, '1000');
    await page.getByRole('button', { name: '1. Approve GRID for Permit2', exact: true }).click();
    await receipt(page, fixture, 1);
    await page.getByRole('button', { name: '2. Authorize swap router', exact: true }).waitFor();
    await page.getByRole('button', { name: '2. Authorize swap router', exact: true }).click();
    await receipt(page, fixture, 2);
    await page.getByRole('button', { name: 'Swap GRID for ETH', exact: true }).click();
    await receipt(page, fixture, 3);
    const [tokenApproval, routerApproval, swap] = fixture.state.transactions;
    assert.equal(tokenApproval.to.toLowerCase(), fixture.byName.LaunchToken.address.toLowerCase());
    assert.equal(tokenApproval.args[0].toLowerCase(), fixture.manifest.network.uniswapV4.permit2.toLowerCase());
    assert.equal(tokenApproval.args[1], parseEther('1000'));
    assert.equal(routerApproval.to.toLowerCase(), fixture.manifest.network.uniswapV4.permit2.toLowerCase());
    assert.equal(routerApproval.args[0].toLowerCase(), fixture.byName.LaunchToken.address.toLowerCase());
    assert.equal(routerApproval.args[1].toLowerCase(), fixture.manifest.network.uniswapV4.universalRouter.toLowerCase());
    assert.equal(routerApproval.args[2], parseEther('1000'));
    inspectSwap(swap, fixture, false);
  });
  await scenario('Input invalidation, invalid slippage and quote failure block swaps', {}, async (page, fixture) => {
    await connect(page);
    await quote(page);
    await page.getByLabel(/^You pay/).fill('0.02');
    assert.equal(await page.getByRole('button', { name: 'Swap ETH for GRID', exact: true }).count(), 0);
    await page.getByLabel('Maximum slippage (%)').fill('51');
    await page.getByRole('button', { name: 'Get quote', exact: true }).click();
    await page.locator('.swap-panel [role=alert]').waitFor();
    assert.equal(fixture.state.transactions.length, 0);
    await page.getByLabel('Maximum slippage (%)').fill('0.5');
    fixture.state.quoteFails = true;
    await page.getByRole('button', { name: 'Get quote', exact: true }).click();
    await page.locator('.swap-panel [role=alert]').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Swap ETH for GRID', exact: true }).count(), 0);
  });
  await scenario('Expired quote and empty liquidity prevent router signing', {}, async (page, fixture) => {
    await connect(page);
    await quote(page);
    await page.evaluate(() => { const original=Date.now; Date.now=()=>original()+61000; });
    await page.getByText('Quote expired or inputs changed. Refresh the quote to continue.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Swap ETH for GRID', exact: true }).isDisabled(), true);
    fixture.state.emptyLiquidity = true;
    await page.getByRole('button', { name: 'Refresh quote', exact: true }).click();
    await page.getByText(/no active liquidity/).waitFor();
    assert.equal(fixture.state.transactions.length, 0);
  });
  await scenario('Modified implementation ABI fails integrity before enabling controls', {}, async (page, fixture) => {
    await page.route('**/abi/LaunchToken.json', route => route.fulfill({contentType:'application/json',body:'[]'}));
    await page.reload();
    await page.getByText('LaunchToken ABI integrity check failed.', { exact: true }).waitFor();
    assert.equal(await page.locator('.swap-panel').count(), 0);
    assert.equal(fixture.state.transactions.length, 0);
  });
  await scenario('RPC failure locks transactions and explicit refresh recovers', {}, async (page, fixture) => {
    await connect(page);
    await quote(page);
    fixture.state.readFails = true;
    await page.getByRole('button', { name: /Refresh$/ }).click();
    await page.getByText('Live state unavailable. Transaction controls are locked.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /Approve GRID for purchase/ }).isDisabled(), true);
    fixture.state.readFails = false;
    await page.getByRole('button', { name: /Refresh$/ }).click();
    await waitFor(() => page.getByRole('button', { name: /Approve GRID for purchase/ }).isEnabled(), 'RPC recovery restores prerequisites');
    assert.equal(fixture.state.transactions.length, 0);
  });
  await scenario('Production subpath, responsive layout, accessible controls and rendered styles', {}, async (page, fixture) => {
    await waitFor(() => page.locator('.sync-bar').innerText().then(t => t.includes('deployment verified')), 'verified read state');
    for (const width of [1440, 900, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const metrics = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, gridScroll: document.querySelector('.map-scroll').scrollWidth > document.querySelector('.map-scroll').clientWidth }));
      assert.ok(metrics.documentWidth <= width + 1, `No page overflow at ${width}px (${metrics.documentWidth})`);
      assert.ok(metrics.bodyWidth <= width + 1, `No body overflow at ${width}px`);
      checks.push({ kind: 'viewport', ...metrics });
      if (width === 1440 || width === 390 || width === 320) await page.screenshot({ path: resolve(evidence, `desktop-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#plot-0').focus();
    await page.keyboard.press('ArrowRight');
    const semantic = await page.evaluate(() => {
      const unnamed = [...document.querySelectorAll('button')].filter(e => !e.textContent.trim() && !e.getAttribute('aria-label')).length;
      const unlabelled = [...document.querySelectorAll('input')].filter(e => !e.labels.length && !e.getAttribute('aria-label')).length;
      const focus = getComputedStyle(document.activeElement);
      return { unnamedButtons: unnamed, unlabelledInputs: unlabelled, activeElement: document.activeElement.id, outline: focus.outline, font: getComputedStyle(document.body).fontFamily, headings: [...document.querySelectorAll('h1,h2,h3')].slice(0, 8).map(e => ({ tag: e.tagName, text: e.textContent, size: getComputedStyle(e).fontSize, weight: getComputedStyle(e).fontWeight })) };
    });
    assert.equal(semantic.unnamedButtons, 0);
    assert.equal(semantic.unlabelledInputs, 0);
    assert.equal(semantic.activeElement, 'plot-1');
    assert.ok(!semantic.outline.includes('none') && !semantic.outline.includes('0px'));
    checks.push({ kind: 'semantics', ...semantic });
    await page.screenshot({ path: resolve(evidence, 'keyboard-focus.png'), fullPage: false });
    const contrast = await page.evaluate(() => {
      const luminance = rgb => rgb.slice(0,3).map(n => { const c=n/255; return c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4; }).reduce((v,c,i)=>v+c*[0.2126,0.7152,0.0722][i],0);
      const rgba = value => (value.match(/[\d.]+/g)||[]).map(Number);
      return ['.hero h1','.hero p','.helper','.muted','.eyebrow','.city-panel .primary','.plot.selected','.plot.owned'].map(selector=>{
        const el=document.querySelector(selector), style=getComputedStyle(el); let bg, cursor=el;
        while(cursor){const c=rgba(getComputedStyle(cursor).backgroundColor);if(c.length===3||c[3]===1){bg=c;break;}cursor=cursor.parentElement;}
        if(!bg)return {selector,verified:false};const fg=rgba(style.color), a=luminance(fg),b=luminance(bg);return {selector,foreground:style.color,background:`rgb(${bg.slice(0,3).join(', ')})`,ratio:Number(((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)).toFixed(2)),verified:true};
      });
    });
    checks.push({ kind: 'renderedContrast', pairs: contrast });
    assert.ok(contrast.filter(c=>c.verified).every(c=>c.ratio>=4.5), 'Selected text token pairs meet 4.5:1');
    await page.setViewportSize({width: 320,height: 1000});
    await page.locator('#city-panel').screenshot({path:resolve(evidence,'mobile-city-panel.png')});
    checks.push({kind:'mobileInputs',sizes:await page.locator('input').evaluateAll(elements=>elements.map(e=>getComputedStyle(e).fontSize))});
    assert.ok((await page.locator('input').evaluateAll(elements=>elements.map(e=>parseFloat(getComputedStyle(e).fontSize)))).every(size=>size>=16));
    assert.ok(fixture.state.requests.length < 1200, 'No unbounded render-triggered RPC loop');
  });
} finally {
  await writeFile(resolve(evidence, 'interaction-results.json'), JSON.stringify({ recordedAt: new Date().toISOString(), browserVersion: browser.version(), exportPath: 'dist/', exportManifestSha256: createHash('sha256').update(await readFile(resolve(import.meta.dirname,'../../dist/imd-deployment.json'))).digest('hex'), servingPath: '/preview/', results, checks }, null, 2) + '\n');
  await browser.close();
  await server.close();
}
