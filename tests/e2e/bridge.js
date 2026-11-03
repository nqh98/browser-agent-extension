// e2e: Claude Code -> MCP server (stdio) -> WebSocket -> side panel -> BrowserExecutor.
// Spawns the real server from claude-code/server and drives it with JSON-RPC like Claude Code does.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const { pathToFileURL } = require('url');
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
  // Plays Claude Code's side of server-to-client traffic: elicitation requests and notifications.
  const mcp = { fromServer: [], onElicit: null };
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method) {
      mcp.fromServer.push(message);
      if (message.method === 'elicitation/create') {
        mcp.onElicit?.(message.params, (result) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`));
      }
      return;
    }
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
  return Object.assign(mcp, { child, rpc, call, listening });
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

/** Opens a bridge connection by hand and sends one hello; resolves with the server's close code. */
function rawHello(port, payload) {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const sock = net.connect(port, '127.0.0.1', () => sock.write([
      'GET /bridge HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', `Origin: ${EXT_ORIGIN}`, '', '',
    ].join('\r\n')));
    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        upgraded = true;
        buffer = buffer.subarray(end + 4);
        const body = Buffer.from(JSON.stringify(payload));
        const mask = Buffer.from([1, 2, 3, 4]);
        sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, Buffer.from(body.map((b, i) => b ^ mask[i & 3]))]));
      }
      if (buffer.length >= 4 && (buffer[0] & 0x0f) === 8) {
        resolve(buffer.readUInt16BE(2));
        sock.destroy();
      }
    });
    sock.on('error', () => resolve('error'));
    setTimeout(() => resolve('timeout'), 3000);
  });
}

/** A stand-in for a Claude Code session still running an old plugin. */
async function fakeOldServer(port, onHello) {
  const { upgrade } = await import(pathToFileURL(path.join(EXT, 'claude-code/server/ws.js')).href);
  const server = http.createServer();
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const ws = upgrade(req, socket, () => true);
    ws?.on('message', () => onHello(ws));
  });
  await new Promise((res) => server.listen(port, '127.0.0.1', res));
  // Upgraded sockets keep server.close() waiting; cut them like a process exit would.
  return { close: () => new Promise((res) => { server.close(res); for (const socket of sockets) socket.destroy(); }) };
}

(async () => {
  const server = await start(SITE_PORT);
  const mcp = startMcp(BRIDGE_PORT, '', 'first-project');
  const tokenMcp = startMcp(TOKEN_PORT, TOKEN);
  await Promise.all([mcp.listening, tokenMcp.listening]);

  // ---- MCP handshake ----
  // Like Claude Code: this client can ask the user in the terminal (elicitation).
  const init = await mcp.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'e2e', version: '0' } });
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

  const status = () => panel.$eval('#sessions', (n) => n.innerText.replace(/\s+/g, ' '));
  async function setUsage(usage) {
    if (await panel.$eval('#welcome', (n) => n.hidden)) await panel.click('#modeSwitch');
    await panel.click(`#welcome [data-usage=${usage}]`);
  }
  async function configure({ token = '', mode = 'ask', port = BRIDGE_PORT, confirmIn = 'terminal' } = {}) {
    if (await panel.$eval('#settings', (n) => n.hidden)) await panel.click('#toggleSettings');
    await panel.click(`.segmented input[value=${mode}] + span`);
    await panel.click(`.segmented input[value=${confirmIn}] + span`);
    await panel.$eval('#bridgeAdvanced', (d) => { d.open = true; });
    await panel.fill('#bridgePort', String(port));
    await panel.fill('#bridgeToken', token);
    await panel.click('#settings button[type=submit]');
  }

  // First run: pick Claude Code. No API key or settings are needed.
  check('first run asks how to use the extension', await panel.isVisible('#welcome') && !(await panel.isVisible('#apiKey')));
  // ---- Display language ----
  const { STRINGS_FOR_TEST: dict } = await import(pathToFileURL(path.join(EXT, 'i18n.js')).href);
  const missing = Object.keys(dict.en).filter((k) => !(k in dict.vi)).concat(Object.keys(dict.vi).filter((k) => !(k in dict.en)));
  check('English and Vietnamese have the same strings', missing.length === 0, missing.join(', '));
  check('English browser: panel starts in English', await panel.$eval('#welcome h1', (n) => n.textContent) === 'How do you want to use Browser Agent?' && await panel.evaluate(() => document.documentElement.lang) === 'en');
  check('no untranslated placeholders on screen', !(await panel.evaluate(() => /[a-z]+\.[a-z.]+\b/.test([...document.querySelectorAll('[data-i18n]')].map((n) => n.textContent).join(' ')) && [...document.querySelectorAll('[data-i18n]')].some((n) => n.textContent === n.dataset.i18n))));
  await panel.click('#welcome [data-lang=vi]');
  check('language buttons switch the welcome screen at once', await panel.$eval('#welcome h1', (n) => n.textContent) === 'Bạn muốn dùng Browser Agent thế nào?' && await panel.$eval('[data-lang=vi]', (n) => n.classList.contains('current')));
  await panel.click('#modeSwitch');
  check('mode button cannot dismiss the first-run choice', await panel.isVisible('#welcome'));
  await setUsage('code');
  const codeView = await panel.evaluate(() => ({
    settings: document.getElementById('settings').hidden,
    composer: getComputedStyle(document.getElementById('composer')).display,
    guide: getComputedStyle(document.getElementById('setupGuide')).display,
    rows: document.querySelectorAll('#sessionList .session').length,
    label: document.getElementById('modeLabel').textContent,
  }));
  check('Claude Code mode: no composer, setup guide shown, settings closed', codeView.settings && codeView.composer === 'none' && (codeView.guide !== 'none') === (codeView.rows === 0) && codeView.label === 'Claude Code', JSON.stringify(codeView));

  const waitStatus = (re) => panel.waitForFunction((source) => new RegExp(source).test(document.getElementById('sessions').innerText.replace(/\s+/g, ' ')), re.source, { timeout: 10000 }).catch(() => {});

  // Optional token, for machines shared with other OS users.
  await configure({ port: TOKEN_PORT, token: 'wrong-token-wrong-token' });
  await waitStatus(/Cổng 18810: token không khớp/);
  check('server with BROWSER_AGENT_TOKEN rejects a wrong token', /Cổng 18810: token không khớp/.test(await status()), await status());
  await configure({ port: TOKEN_PORT });
  await waitStatus(/Cổng 18810: token không khớp/);
  check('server with BROWSER_AGENT_TOKEN rejects a missing token', /Cổng 18810: token không khớp/.test(await status()), await status());
  await configure({ port: TOKEN_PORT, token: TOKEN });
  await waitStatus(/đang chờ · 0 tab/);
  check('server with BROWSER_AGENT_TOKEN accepts the right token', /browser-agent-extension đang chờ/.test(await status()) && !/token không khớp/.test(await status()), await status());
  r = await tokenMcp.call('bridge_status');
  check('token server reports connected', /Extension: connected/.test(textOf(r)), textOf(r));

  // Default: no token, just tick the box.
  await configure();
  await waitStatus(/first-project đang chờ/);
  check('panel connects without a token by default', /first-project đang chờ/.test(await status()) && await panel.$eval('#bridgeStatus', (n) => n.textContent) === '', await status());
  check('header dot shows connection and the guide hides', await panel.$eval('#modeDot', (n) => n.classList.contains('on')) && !(await panel.isVisible('#setupGuide')));
  check('session row lists the session, port in its tooltip', await panel.$eval('#sessionList [data-port="18790"]', (n) => /first-project/.test(n.textContent) && /cổng 18790/.test(n.title)));
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
        const tag = await card.$eval('.tag', (n) => n.textContent).catch(() => '');
        prompts.push({ title, detail, tag });
        const choice = policy(title, detail);
        if (choice === 'WAIT') { await new Promise((res) => setTimeout(res, 100)); continue; } // leave it to the terminal
        const button = await card.$(`button:text-is("${choice}")`) || await card.$('button:text-is("Từ chối")') || await card.$('button:text-is("Deny")');
        await button?.click().catch(() => {});
      }
      await new Promise((res) => setTimeout(res, 100));
    }
  })();

  // ---- Tool calls through the bridge ----
  policy = (title) => (title.includes('Cho phép tác tử dùng') ? 'Cho phép đến khi phiên này kết thúc' : 'Cho phép');
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
  check('prompts are tagged with the session', prompts.length && prompts.every((p) => p.tag === 'first-project'), JSON.stringify(prompts));

  // ---- Confirmations in the terminal (MCP elicitation) ----
  const elicitations = () => mcp.fromServer.filter((m) => m.method === 'elicitation/create');
  const cancels = () => mcp.fromServer.filter((m) => m.method === 'notifications/cancelled');
  const clicks = () => site.evaluate(() => window.helloClicks || 0);
  check('panel cards say the terminal is asking too', prompts.length > 0 && elicitations().length > 0);
  policy = () => 'WAIT'; // the user looks at the terminal, not the panel
  mcp.onElicit = (params, respond) => respond({ action: 'accept', content: {} });
  let before = elicitations().length;
  let clicked = await clicks();
  r = await mcp.call('left_click', { target: { type: 'ref', ref: hello } });
  let asked = elicitations().slice(before);
  const scope = asked[0]?.params.requestedSchema.properties.scope;
  const choices = scope?.oneOf?.map((o) => o.const);
  check('confirmation asked in the terminal and answered there', !r.isError && await clicks() === clicked + 1 && asked.length === 1
    && asked[0].params.mode === 'form' && /first-project/.test(asked[0].params.message) && /left_click/.test(asked[0].params.message)
    && JSON.stringify(choices) === JSON.stringify(['allow', 'allow_all']) && scope.default === 'allow'
    && !asked[0].params.requestedSchema.required, JSON.stringify({ r, asked }));
  check('panel card closes when the terminal answers', (await panel.$$('.card')).length === 0);
  mcp.onElicit = (params, respond) => respond({ action: 'decline' });
  clicked = await clicks();
  r = await mcp.call('left_click', { target: { type: 'ref', ref: hello } });
  check('declining in the terminal denies the action', r.isError && /declined/.test(textOf(r)) && await clicks() === clicked, textOf(r));
  r = await mcp.call('find', { query: 'delete account' });
  const del = refIn(textOf(r), /Delete account/);
  before = elicitations().length;
  mcp.onElicit = (params, respond) => respond({ action: 'cancel' }); // Esc
  r = await mcp.call('left_click', { target: { type: 'ref', ref: del } });
  asked = elicitations().slice(before);
  check('sensitive action: warning sign, plain Accept/Decline, Esc denies', r.isError && /^⚠/.test(asked[0]?.params.message)
    && Object.keys(asked[0].params.requestedSchema.properties).length === 0 && !(await site.evaluate(() => window.deleted)), JSON.stringify(asked));
  mcp.onElicit = null; // nobody answers in the terminal
  policy = () => 'Cho phép';
  before = cancels().length;
  clicked = await clicks();
  r = await mcp.call('left_click', { target: { type: 'ref', ref: hello } });
  const lastAsk = elicitations().at(-1);
  check('answering in the panel first withdraws the terminal question', !r.isError && await clicks() === clicked + 1
    && cancels().length === before + 1 && cancels().at(-1).params.requestId === lastAsk.id, JSON.stringify(cancels().slice(-1)));
  await configure({ confirmIn: 'panel' });
  before = elicitations().length;
  policy = (title) => (title.includes('Cho phép tác tử dùng') ? 'Cho phép đến khi phiên này kết thúc' : 'Cho phép');
  r = await mcp.call('left_click', { target: { type: 'ref', ref: hello } });
  check('"panel only" setting never asks in the terminal', !r.isError && elicitations().length === before, JSON.stringify(elicitations().slice(before)));
  r = await mcp.call('bridge_status');
  check('bridge_status says where confirmations go', /Confirmations: side panel only/.test(textOf(r)), textOf(r));
  await configure();
  r = await mcp.call('bridge_status');
  check('bridge_status reports terminal confirmations', /Confirmations: asked in this terminal and in the side panel/.test(textOf(r)), textOf(r));
  // Picking a wider scope in the terminal: "allow for the rest of the task" stops further questions.
  policy = () => 'WAIT';
  mcp.onElicit = (params, respond) => respond({ action: 'accept', content: /left_click/.test(params.message) ? { scope: 'allow_all' } : {} });
  const clickAsks = () => elicitations().filter((m) => /left_click/.test(m.params.message)).length;
  before = clickAsks();
  clicked = await clicks();
  await mcp.call('left_click', { target: { type: 'ref', ref: hello } });
  r = await mcp.call('left_click', { target: { type: 'ref', ref: hello } });
  check('scope "allow for the task" chosen in the terminal applies to later actions', !r.isError && clickAsks() === before + 1 && await clicks() === clicked + 2, textOf(r));
  mcp.onElicit = null;
  policy = () => 'Cho phép';

  // ---- Stop button ----
  const waiting = mcp.call('wait', { duration: 20 });
  await new Promise((res) => setTimeout(res, 700));
  check('busy session row offers Stop', await panel.$eval('#sessionList [data-port="18790"]', (n) => n.classList.contains('busy') && !n.querySelector('button').disabled));
  await panel.click('#sessionList [data-port="18790"] button');
  r = await waiting;
  check('Stop in the panel interrupts a running call', r.isError && /Stopped by the user/.test(textOf(r)), textOf(r));
  check('session row idle after Stop', await panel.$eval('#sessionList [data-port="18790"]', (n) => !n.classList.contains('busy') && n.querySelector('button').disabled));
  r = await mcp.call('list_tabs');
  check('next call after Stop tells Claude to ask the user', r.isError && /pressed Stop/.test(textOf(r)), textOf(r));
  r = await mcp.call('list_tabs');
  check('calls work again after that', !r.isError && /tab-\d+/.test(textOf(r)), textOf(r));

  // ---- Auto mode and status updates ----
  await configure({ mode: 'auto' });
  prompts.length = 0;
  clicked = await clicks();
  before = elicitations().length;
  r = await mcp.call('left_click', { target: { type: 'ref', ref: hello } });
  check('auto mode clicks without asking', !r.isError && prompts.length === 0 && elicitations().length === before && await clicks() === clicked + 1, JSON.stringify(prompts));
  r = await mcp.call('bridge_status');
  check('bridge_status follows settings changes', /auto/.test(textOf(r)), textOf(r));

  // ---- Two Claude Code sessions, one port each ----
  const mcp2 = startMcp(BRIDGE_PORT, '', 'second-project');
  await mcp2.listening;
  r = await mcp2.call('bridge_status');
  check('second session takes the next free port', new RegExp(`127.0.0.1:${BRIDGE_PORT + 1}/bridge as session "second-project"`).test(textOf(r)), textOf(r));
  await waitStatus(/second-project/);
  // The panel connected before this Claude Code initialized; terminal questions must still work.
  await mcp2.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'e2e-2', version: '0' } });
  check('panel lists both sessions with their ports', await panel.$$eval('#sessionList .session', (ns) => ns.map((n) => `${n.querySelector('.name').textContent}@${n.dataset.port}`).join(',')) === 'first-project@18790,second-project@18791', await status());
  check('header counts sessions', await panel.$eval('#modeLabel', (n) => n.textContent) === 'Claude Code ×2' && (await panel.$$('#sessionList .session')).length === 2);
  r = await mcp2.call('list_tabs');
  r = await mcp2.call('get_page_text');
  check('second session cannot take the first session\'s tab', r.isError && /belongs to another Claude Code session/.test(textOf(r)) && /new_tab/.test(textOf(r)), textOf(r));
  r = await mcp2.call('new_tab');
  const tab2 = Number(/tab-(\d+)/.exec(textOf(r))?.[1]);
  const windows = await panel.evaluate(async ([a, b]) => [(await chrome.tabs.get(a)).windowId, (await chrome.tabs.get(b)).windowId], [targetId, tab2]);
  check('second session opens its tab in its own window', tab2 && windows[0] !== windows[1], JSON.stringify({ text: textOf(r), windows }));
  prompts.length = 0;
  policy = (title) => (title.includes('Cho phép tác tử dùng') ? 'Cho phép đến khi phiên này kết thúc' : 'Cho phép');
  r = await mcp2.call('navigate', { url: `${BASE}/page2` });
  check('a session that initialized after the panel connected still asks in its terminal', mcp2.fromServer.some((m) => m.method === 'elicitation/create' && /second-project/.test(m.params.message) && new RegExp(`127.0.0.1:${SITE_PORT}`).test(m.params.message)), JSON.stringify(mcp2.fromServer.slice(-2)));
  check('each session asks for sites on its own, labeled', !r.isError && prompts.some((p) => p.tag === 'second-project' && p.title.includes(`127.0.0.1:${SITE_PORT}`)), textOf(r) + JSON.stringify(prompts));
  const [t1, t2] = await Promise.all([mcp.call('get_page_text'), mcp2.call('get_page_text')]);
  check('sessions work in parallel on their own tabs', /Welcome to the test shop/.test(textOf(t1)) && /Page Two/.test(textOf(t2)) && !/Welcome to the test shop/.test(textOf(t2)), textOf(t1).slice(0, 100) + ' | ' + textOf(t2).slice(0, 100));
  const labels = await panel.$$eval('#log > .action.remote', (ns) => [...new Set(ns.map((n) => n.dataset.session))]);
  check('panel log labels each session', labels.includes('first-project') && labels.includes('second-project'), JSON.stringify(labels));
  mcp2.child.kill();
  await panel.waitForFunction(() => !/second-project/.test(document.getElementById('sessions').textContent), null, { timeout: 10000 }).catch(() => {});
  check('closing a terminal removes its session', !/second-project/.test(await status()) && await panel.$eval('#modeLabel', (n) => n.textContent) === 'Claude Code', await status());
  r = await mcp.call('list_tabs');
  check('first session unaffected', !r.isError && new RegExp(`tab-${targetId}`).test(textOf(r)), textOf(r));

  // ---- Version mismatches tell the user exactly what to do ----
  const oldReject = await fakeOldServer(BRIDGE_PORT + 5, (ws) => ws.close(4003, 'Bad token'));
  await waitStatus(/Cổng 18795: một phiên Claude Code đang chạy bản plugin cũ/);
  check('old plugin that rejects the panel: status says to Reconnect via /mcp', /Cổng 18795: một phiên Claude Code đang chạy bản plugin cũ.*\/mcp.*Reconnect/.test(await status()), await status());
  await oldReject.close();
  await panel.waitForFunction(() => !/18795/.test(document.getElementById('sessions').innerText), null, { timeout: 25000 }).catch(() => {});
  check('message clears once that session is gone', !/18795/.test(await status()), await status());
  const oldAccept = await fakeOldServer(BRIDGE_PORT + 6, (ws) => ws.send(JSON.stringify({ type: 'welcome', server: '0.1.0', label: 'legacy-project', port: BRIDGE_PORT + 6 })));
  await waitStatus(/legacy-project/);
  check('old plugin that still connects is flagged on its row', await panel.$eval('#sessionList [data-port="18796"]', (n) => /plugin cũ/.test(n.textContent)).catch(() => false) && /legacy-project đang chạy bản plugin cũ/.test(await status()), await status());
  check('up-to-date session is not flagged', await panel.$eval('#sessionList [data-port="18790"]', (n) => !/plugin cũ/.test(n.textContent)));
  await oldAccept.close();

  check('server refuses an extension without the protocol', await rawHello(TOKEN_PORT, { type: 'hello', token: TOKEN }) === 4010);
  r = await tokenMcp.call('bridge_status');
  check('bridge_status tells Claude to have the extension reloaded', /older than this plugin.*chrome:\/\/extensions/.test(textOf(r)), textOf(r));
  check('server refuses a newer extension protocol', await rawHello(TOKEN_PORT, { type: 'hello', protocol: 99, token: TOKEN }) === 4011);
  check('server refuses a wrong token with its own code', await rawHello(TOKEN_PORT, { type: 'hello', protocol: 2, token: 'nope' }) === 4005);

  const toolsFile = path.join(EXT, 'claude-code/server/tools.js');
  const { atime, mtime } = fs.statSync(toolsFile);
  fs.utimesSync(toolsFile, atime, new Date(mtime.getTime() + 60000));
  try {
    r = await mcp.call('bridge_status');
    check('bridge_status notices the plugin changed on disk', /files changed on disk.*\/mcp.*Reconnect/.test(textOf(r)), textOf(r));
    r = await mcp.call('list_tabs');
    check('next tool result carries a one-time reload note', !r.isError && /updated on disk.*\/mcp/.test(textOf(r)), textOf(r));
    r = await mcp.call('list_tabs');
    check('the note is not repeated', !/updated on disk/.test(textOf(r)), textOf(r));
  } finally {
    fs.utimesSync(toolsFile, atime, mtime);
  }

  // ---- Switching to chat disconnects Claude Code (the modes are exclusive) ----
  await setUsage('chat');
  await new Promise((res) => setTimeout(res, 300));
  r = await mcp.call('list_tabs');
  check('switching to chat disconnects Claude Code', r.isError && /not connected/.test(textOf(r)), textOf(r));
  const chatView = await panel.evaluate(() => ({
    sessions: getComputedStyle(document.getElementById('sessions')).display,
    composer: getComputedStyle(document.getElementById('composer')).display,
    label: document.getElementById('modeLabel').textContent,
    apiKeyShown: !document.getElementById('settings').hidden,
  }));
  check('chat view: composer shown, sessions hidden, asks for API key', chatView.sessions === 'none' && chatView.composer !== 'none' && chatView.label === 'Chat' && chatView.apiKeyShown, JSON.stringify(chatView));
  await setUsage('code');
  await waitStatus(/first-project/);
  check('switching back reconnects', /first-project/.test(await status()), await status());

  // ---- English everywhere: panel, prompts, and questions in the terminal ----
  await panel.click('#toggleSettings');
  await panel.selectOption('#language', 'en');
  await panel.click('#settings button[type=submit]');
  await waitStatus(/first-project waiting/);
  check('English: session rows and settings headings', /first-project waiting · \d+ tab/.test(await status())
    && await panel.$eval('[data-i18n="set.code.h"]', (n) => n.textContent) === 'Claude Code connection'
    && await panel.evaluate(() => document.documentElement.lang) === 'en', await status());
  policy = (title) => (title.startsWith('Allow the agent to') ? 'Allow until this session ends' : 'Allow');
  mcp.onElicit = null;
  prompts.length = 0;
  before = elicitations().length;
  r = await mcp.call('read_page');
  const ask = elicitations().slice(before)[0];
  check('English: prompt card and its buttons', !r.isError && prompts.some((p) => /^Allow the agent to use 127\.0\.0\.1:8124\?$/.test(p.title)), JSON.stringify(prompts));
  check('English: the terminal question too', /Accept = allow, Decline = deny/.test(ask?.params.message || '') && ask.params.requestedSchema.properties.scope?.title === 'Scope'
    && ask.params.requestedSchema.properties.scope.oneOf.some((o) => o.title === 'Always allow'), JSON.stringify(ask));
  const logLine = await panel.$$eval('#log > .action.remote', (ns) => ns.at(-1).textContent);
  check('English: action log', logLine === 'Read the page structure', logLine);
  await panel.click('#toggleSettings');
  await panel.selectOption('#language', '');
  await panel.click('#settings button[type=submit]');
  check('"Automatic" follows the browser (English here)', await panel.evaluate(() => document.documentElement.lang) === 'en' && await panel.$eval('#language', (n) => n.value) === '');

  answering = false;
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await ctx.close();
  mcp.child.kill();
  tokenMcp.child.kill();
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
