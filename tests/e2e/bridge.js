// e2e: Claude Code -> MCP server (stdio) -> WebSocket -> side panel -> BrowserExecutor.
// Spawns the real server from claude-code/server and drives it with JSON-RPC like Claude Code does.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const readline = require('readline');
const { start } = require('./site');

const EXT = process.env.EXT || path.resolve(__dirname, '../..');
const SITE_PORT = 8124;
const BRIDGE_PORT = 18790;
const TOKEN_PORT = 18810; // outside the panel's default range; this server requires BROWSER_AGENT_TOKEN
const TOKEN = 'e2e-token-0123456789abcdef';
const EXT_ORIGIN = 'chrome-extension://eboigejnblbcifgbpgaadonkpgbdbnkc';
const BASE = `http://127.0.0.1:${SITE_PORT}`;
const results = [];
const check = (name, cond, info = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? `\n      ${String(info).slice(0, 800)}` : ''}`);
};

function startMcp(port, token, label) {
  const env = { ...process.env, BROWSER_AGENT_PORT: String(port) };
  if (label) env.BROWSER_AGENT_LABEL = label;
  delete env.BROWSER_AGENT_TOKEN;
  if (token) env.BROWSER_AGENT_TOKEN = token;
  const child = spawn(process.execPath, [path.join(EXT, 'claude-code/server/index.js')], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  let id = 0;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const listening = new Promise((resolve) => {
    child.stderr.on('data', (chunk) => { if (/listening on/.test(String(chunk))) resolve(); });
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const n = ++id;
    waiting.set(n, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  return { child, rpc, call, listening };
}

const textOf = (result) => (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const refIn = (text, re) => {
  const line = text.split('\n').find((l) => re.test(l));
  return line && /\[(ref_\d+)\]/.exec(line)?.[1];
};

function upgradeStatus(headers) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: BRIDGE_PORT, path: '/bridge',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', (res) => resolve(res.statusCode));
    req.on('error', (e) => resolve(e.message));
    req.end();
  });
}

(async () => {
  const server = await start(SITE_PORT);
  const mcp = startMcp(BRIDGE_PORT, '', 'first-project');
  const tokenMcp = startMcp(TOKEN_PORT, TOKEN);
  await Promise.all([mcp.listening, tokenMcp.listening]);

  // ---- MCP handshake ----
  const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  check('initialize returns tools capability', init.result?.capabilities?.tools && init.result.serverInfo?.name === 'browser-agent', JSON.stringify(init));
  const list = await mcp.rpc('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  check('tools/list exposes browser members and bridge_status', ['navigate', 'read_page', 'find', 'left_click', 'screenshot', 'form_input', 'list_tabs', 'bridge_status'].every((n) => names.includes(n)), names.join(','));
  check('every tool has an object input schema', list.result.tools.every((t) => t.inputSchema?.type === 'object'));
  let r = await mcp.call('navigate', { url: BASE });
  check('call before the extension connects explains setup', r.isError && /not connected/.test(textOf(r)) && /Claude Code/.test(textOf(r)), textOf(r));
  const unknown = await mcp.rpc('tools/call', { name: 'rm_rf', arguments: {} });
  check('unknown tool is a JSON-RPC error', unknown.error?.code === -32602, JSON.stringify(unknown));

  // ---- WebSocket origin check ----
  check('web page origin rejected', (await upgradeStatus({ Origin: BASE })) === 403);
  check('missing origin rejected', (await upgradeStatus({})) === 403);
  check('another extension rejected', (await upgradeStatus({ Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })) === 403);
  check('this extension\'s fixed origin accepted', (await upgradeStatus({ Origin: EXT_ORIGIN })) === 101);

  // ---- Extension ----
  const ctx = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium', viewport: { width: 1280, height: 720 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  check('manifest key pins the extension id', `chrome-extension://${extId}` === EXT_ORIGIN, extId);
  const panel = await ctx.newPage();
  panel.on('pageerror', (e) => console.log('PANEL ERROR', e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  const pagePromise = ctx.waitForEvent('page');
  const targetId = await panel.evaluate(async (url) => (await chrome.windows.create({ url, focused: true })).tabs[0].id, `${BASE}/`);
  const site = await pagePromise;
  await site.waitForLoadState();
  await panel.evaluate((tabId) => {
    const orig = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => (q.active && q.currentWindow ? [await chrome.tabs.get(tabId)] : orig(q));
  }, targetId);

  const status = () => panel.$eval('#bridgeStatus', (n) => n.textContent);
  async function configure({ enabled = true, token = '', mode = 'ask', port = BRIDGE_PORT } = {}) {
    if (await panel.$eval('#settings', (n) => n.hidden)) await panel.click('#toggleSettings');
    await panel.selectOption('#mode', mode);
    await panel.setChecked('#bridgeEnabled', enabled);
    await panel.fill('#bridgePort', String(port));
    await panel.fill('#bridgeToken', token);
    await panel.click('#settings button[type=submit]');
  }

  const waitStatus = (re) => panel.waitForFunction((source) => new RegExp(source).test(document.getElementById('bridgeStatus').textContent), re.source, { timeout: 10000 }).catch(() => {});

  // Optional token, for machines shared with other OS users.
  await configure({ port: TOKEN_PORT, token: 'wrong-token-wrong-token' });
  await waitStatus(/Token không khớp/);
  check('server with BROWSER_AGENT_TOKEN rejects a wrong token', /Token không khớp/.test(await status()), await status());
  await configure({ port: TOKEN_PORT });
  await waitStatus(/Token không khớp/);
  check('server with BROWSER_AGENT_TOKEN rejects a missing token', /Token không khớp/.test(await status()), await status());
  await configure({ port: TOKEN_PORT, token: TOKEN });
  await waitStatus(/Đã kết nối/);
  check('server with BROWSER_AGENT_TOKEN accepts the right token', /Đã kết nối/.test(await status()), await status());
  r = await tokenMcp.call('bridge_status');
  check('token server reports connected', /Extension: connected/.test(textOf(r)), textOf(r));

  // Default: no token, just tick the box.
  await configure();
  await waitStatus(/Đã kết nối/);
  await panel.waitForFunction(() => /Đã kết nối/.test(document.getElementById('bridgeStatus').textContent), null, { timeout: 10000 }).catch(() => {});
  check('panel connects without a token by default', /Đã kết nối/.test(await status()), await status());
  check('header badge shows connection', await panel.$eval('#bridgeBadge', (n) => !n.hidden && n.classList.contains('on')));
  r = await mcp.call('bridge_status');
  check('bridge_status reports connected and mode', /Extension: connected/.test(textOf(r)) && /ask before each/.test(textOf(r)), textOf(r));

  // Answer panel prompts in the background, like a user watching the panel.
  const prompts = [];
  let policy = () => 'Cho phép';
  let answering = true;
  (async () => {
    while (answering) {
      const card = await panel.$('.card').catch(() => null);
      if (card) {
        const title = await card.$eval('strong', (n) => n.textContent).catch(() => '');
        const detail = await card.$eval('.detail', (n) => n.textContent).catch(() => '');
        prompts.push({ title, detail });
        const choice = policy(title, detail);
        const button = await card.$(`button:text-is("${choice}")`) || await card.$('button:text-is("Từ chối")');
        await button?.click().catch(() => {});
      }
      await new Promise((res) => setTimeout(res, 100));
    }
  })();

  // ---- Tool calls through the bridge ----
  policy = (title) => (title.includes('Cho phép tác tử dùng') ? 'Cho phép đến khi tạo chat mới' : 'Cho phép');
  r = await mcp.call('read_page', { filter: 'interactive' });
  check('read_page works and asks for the site once', !r.isError && /Say hello/.test(textOf(r)) && prompts.filter((p) => p.title.includes(`127.0.0.1:${SITE_PORT}`)).length === 1, textOf(r).slice(0, 400) + JSON.stringify(prompts));
  check('results carry browser state as text', /Browser state: .*"tab_id":"tab-\d+"/.test(textOf(r)), textOf(r).slice(-300));
  r = await mcp.call('find', { query: 'say hello' });
  const hello = refIn(textOf(r), /Say hello/);
  check('find returns a ref', hello, textOf(r));
  prompts.length = 0;
  r = await mcp.call('left_click', { target: { type: 'ref', ref: hello } });
  check('click runs after approval in the panel', !r.isError && await site.evaluate(() => window.helloClicks) === 1 && prompts.length === 1, textOf(r) + JSON.stringify(prompts));
  r = await mcp.call('screenshot');
  const image = r.content.find((c) => c.type === 'image');
  check('screenshot returns MCP image content', image && image.mimeType === 'image/jpeg' && image.data.length > 1000, JSON.stringify(r.content.map((c) => c.type)));
  r = await mcp.call('find', { query: 'full name' });
  const nameRef = refIn(textOf(r), /Full name/);
  r = await mcp.call('form_input', { target: { type: 'ref', ref: nameRef }, value: 'Nguyen Van A' });
  check('form_input sets a field', !r.isError && await site.$eval('#name', (n) => n.value) === 'Nguyen Van A', textOf(r));

  policy = () => 'Từ chối';
  r = await mcp.call('left_click', { target: { type: 'ref', ref: hello } });
  check('declined action returns an error to Claude Code', r.isError && /declined/.test(textOf(r)) && await site.evaluate(() => window.helloClicks) === 1, textOf(r));
  policy = () => 'Cho phép';

  r = await mcp.call('javascript_exec', { text: '1+1' });
  check('optional tool off by default', r.isError && /not enabled/.test(textOf(r)), textOf(r));

  // Parallel calls from Claude Code run one at a time, in order.
  const [a, b] = await Promise.all([mcp.call('list_tabs'), mcp.call('get_page_text')]);
  check('concurrent calls both answered', !a.isError && !b.isError && /Welcome to the test shop/.test(textOf(b)), textOf(a) + textOf(b).slice(0, 200));

  const log = await panel.$$eval('#log > .action.remote', (ns) => ns.map((n) => n.textContent));
  check('panel logs Claude Code actions', log.some((l) => /Tìm "say hello"/.test(l)) && log.length >= 6, log.join(' | '));
  check('panel composer locked while Claude Code drives', await panel.$eval('#send', (n) => n.hidden) && !(await panel.$eval('#stop', (n) => n.hidden)));

  // ---- Stop button ----
  const waiting = mcp.call('wait', { duration: 20 });
  await new Promise((res) => setTimeout(res, 700));
  await panel.click('#stop');
  r = await waiting;
  check('Stop in the panel interrupts a running call', r.isError && /Stopped by the user/.test(textOf(r)), textOf(r));
  check('composer unlocked after Stop', !(await panel.$eval('#send', (n) => n.hidden)));
  r = await mcp.call('list_tabs');
  check('next call after Stop tells Claude to ask the user', r.isError && /pressed Stop/.test(textOf(r)), textOf(r));
  r = await mcp.call('list_tabs');
  check('calls work again after that', !r.isError && /tab-\d+/.test(textOf(r)), textOf(r));

  // ---- Auto mode and status updates ----
  await configure({ mode: 'auto' });
  prompts.length = 0;
  r = await mcp.call('left_click', { target: { type: 'ref', ref: hello } });
  check('auto mode clicks without asking', !r.isError && prompts.length === 0 && await site.evaluate(() => window.helloClicks) === 2, JSON.stringify(prompts));
  r = await mcp.call('bridge_status');
  check('bridge_status follows settings changes', /auto/.test(textOf(r)), textOf(r));

  // ---- Two Claude Code sessions, one port each ----
  const mcp2 = startMcp(BRIDGE_PORT, '', 'second-project');
  await mcp2.listening;
  r = await mcp2.call('bridge_status');
  check('second session takes the next free port', new RegExp(`127.0.0.1:${BRIDGE_PORT + 1}/bridge as session "second-project"`).test(textOf(r)), textOf(r));
  await waitStatus(/second-project/);
  check('panel lists both sessions with their ports', /first-project \(cổng 18790\).*second-project \(cổng 18791\)/.test(await status()), await status());
  check('badge counts sessions', await panel.$eval('#bridgeBadge', (n) => n.textContent) === 'Claude Code ×2');
  r = await mcp2.call('list_tabs');
  r = await mcp2.call('get_page_text');
  check('second session cannot take the first session\'s tab', r.isError && /belongs to another Claude Code session/.test(textOf(r)) && /new_tab/.test(textOf(r)), textOf(r));
  r = await mcp2.call('new_tab');
  const tab2 = Number(/tab-(\d+)/.exec(textOf(r))?.[1]);
  const windows = await panel.evaluate(async ([a, b]) => [(await chrome.tabs.get(a)).windowId, (await chrome.tabs.get(b)).windowId], [targetId, tab2]);
  check('second session opens its tab in its own window', tab2 && windows[0] !== windows[1], JSON.stringify({ text: textOf(r), windows }));
  prompts.length = 0;
  policy = (title) => (title.includes('Cho phép tác tử dùng') ? 'Cho phép đến khi tạo chat mới' : 'Cho phép');
  r = await mcp2.call('navigate', { url: `${BASE}/page2` });
  check('each session asks for sites on its own, labeled', !r.isError && prompts.some((p) => p.title.startsWith('[second-project]') && p.title.includes(`127.0.0.1:${SITE_PORT}`)), textOf(r) + JSON.stringify(prompts));
  const [t1, t2] = await Promise.all([mcp.call('get_page_text'), mcp2.call('get_page_text')]);
  check('sessions work in parallel on their own tabs', /Welcome to the test shop/.test(textOf(t1)) && /Page Two/.test(textOf(t2)) && !/Welcome to the test shop/.test(textOf(t2)), textOf(t1).slice(0, 100) + ' | ' + textOf(t2).slice(0, 100));
  const labels = await panel.$$eval('#log > .action.remote', (ns) => [...new Set(ns.map((n) => n.dataset.session))]);
  check('panel log labels each session', labels.includes('Claude Code (first-project)') && labels.includes('Claude Code (second-project)'), JSON.stringify(labels));
  mcp2.child.kill();
  await panel.waitForFunction(() => !/second-project/.test(document.getElementById('bridgeStatus').textContent), null, { timeout: 10000 }).catch(() => {});
  check('closing a terminal removes its session', !/second-project/.test(await status()) && await panel.$eval('#bridgeBadge', (n) => n.textContent) === 'Claude Code', await status());
  r = await mcp.call('list_tabs');
  check('first session unaffected', !r.isError && new RegExp(`tab-${targetId}`).test(textOf(r)), textOf(r));

  // ---- Disconnect ----
  await configure({ enabled: false });
  await new Promise((res) => setTimeout(res, 300));
  r = await mcp.call('list_tabs');
  check('disabling the bridge disconnects', r.isError && /not connected/.test(textOf(r)), textOf(r));
  check('badge hidden when disabled', await panel.$eval('#bridgeBadge', (n) => n.hidden));

  answering = false;
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await ctx.close();
  mcp.child.kill();
  tokenMcp.child.kill();
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
