const { chromium } = require('playwright');
const { start } = require('./site');
const { validate } = require('./validate');

const EXT = process.env.EXT || require('path').resolve(__dirname, '../..');
const PORT = 8123;
const H = `127.0.0.1:${PORT}`;
const BASE = `http://${H}`;
const results = [];
let idc = 0;
const tu = (name, input = {}) => ({ type: 'tool_use', id: `toolu_${++idc}`, name, toolset_name: 'browser', input });
const say = (text) => ({ type: 'text', text });

// ---- mock API ----
let script = [];
let requests = [];
let apiErrorPlan = []; // [{status, body}] consumed before script
const imageSizes = new Set();
const formatErrors = [];

function lastResults() {
  const body = requests.at(-1);
  const last = body?.messages.at(-1);
  return Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'tool_result') : [];
}
const textOf = (r) => (typeof r.content === 'string' ? r.content : r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
function refIn(text, re) {
  const line = text.split('\n').find((l) => re.test(l));
  if (!line) throw new Error(`no line matching ${re} in:\n${text.slice(0, 1500)}`);
  return /\[(ref_\d+)\]/.exec(line)[1];
}

async function handleApi(route) {
  const body = JSON.parse(route.request().postData());
  requests.push(body);
  formatErrors.push(...validate(body, imageSizes).map((e) => `[${current}] ${e}`));
  if (apiErrorPlan.length) {
    const e = apiErrorPlan.shift();
    return route.fulfill({ status: e.status, contentType: 'application/json', headers: e.headers || {}, body: JSON.stringify(e.body) });
  }
  let content;
  try {
    const step = script.shift();
    content = step ? (typeof step === 'function' ? step(lastResults()) : step) : [say('done')];
  } catch (error) {
    content = [say(`SCRIPT ERROR ${error.message}`)];
    scriptErrors.push(`[${current}] ${error.message}`);
  }
  const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', content, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } }),
  });
}
const scriptErrors = [];
let current = '';

(async () => {
  const server = await start(PORT);
  const ctx = await chromium.launchPersistentContext('', {
    headless: true, channel: 'chromium', viewport: { width: 1280, height: 720 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await ctx.route('https://api.anthropic.com/**', handleApi);
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;

  const panel = await ctx.newPage();
  panel.on('pageerror', (e) => console.log('PANEL ERROR', e.message));
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  // Open the website in its own window so the panel stays visible, like a real side panel.
  const pagePromise = ctx.waitForEvent('page');
  const targetId = await panel.evaluate(async (url) => (await chrome.windows.create({ url, focused: true })).tabs[0].id, `${BASE}/`);
  const site = await pagePromise;
  await site.waitForLoadState();
  // In a real side panel, {active, currentWindow} is the page the user looks at.
  await panel.evaluate((id) => {
    const orig = chrome.tabs.query.bind(chrome.tabs);
    window.__target = id;
    chrome.tabs.query = async (q) => (q.active && q.currentWindow ? [await chrome.tabs.get(window.__target)] : orig(q));
  }, targetId);

  // Configure through the real settings form.
  await panel.fill('#apiKey', 'sk-ant-test');
  await panel.fill('#model', 'claude-sonnet-5-5');
  await panel.selectOption('#mode', 'ask');
  await panel.click('#settings button[type=submit]');

  const prompts = [];
  let policy = () => 'Cho phép';
  async function runTask(name, text, steps, opts = {}) {
    current = name;
    script = [...steps];
    const before = requests.length;
    prompts.length = 0;
    policy = opts.policy || (() => 'Cho phép');
    const errsBefore = formatErrors.length + scriptErrors.length;
    await panel.fill('#prompt', text);
    await panel.click('#send');
    const deadline = Date.now() + (opts.timeout || 60000);
    while (Date.now() < deadline) {
      const card = await panel.$('.card');
      if (card) {
        const title = await card.$eval('strong', (n) => n.textContent);
        const detail = await card.$eval('.detail', (n) => n.textContent);
        const sensitive = await card.evaluate((n) => n.classList.contains('sensitive'));
        prompts.push({ title, detail, sensitive });
        const choice = policy(title, detail, sensitive);
        if (choice === 'STOP') await panel.click('#stop');
        else {
          const button = await card.$(`button:text-is("${choice}")`) || await card.$('button:text-is("Từ chối")');
          await button.click();
        }
      }
      if (opts.duringRun) { const fn = opts.duringRun; opts.duringRun = null; await fn(); }
      const done = await panel.evaluate(() => !document.getElementById('send').hidden);
      if (done) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const log = await panel.$$eval('#log > *', (ns) => ns.map((n) => `${n.className}: ${n.textContent}`));
    return { requests: requests.slice(before), prompts: [...prompts], log, newErrors: formatErrors.length + scriptErrors.length - errsBefore };
  }
  async function newChat() { await panel.click('#newChat'); }
  function check(name, cond, info = '') {
    results.push({ name, ok: !!cond, info });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && info ? `\n      ${String(info).slice(0, 800)}` : ''}`);
  }
  const resultsOf = (r) => r.requests.flatMap((b) => { const l = b.messages.at(-1); return Array.isArray(l.content) ? l.content.filter((x) => x.type === 'tool_result') : []; });
  const G = (expr) => site.evaluate(expr);
  const center = async (sel) => site.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });

  // ---------- 1. Site permission + reading ----------
  let r = await runTask('read', 'Tóm tắt trang này', [
    [say('Đọc trang.'), tu('read_page'), tu('read_page', { filter: 'interactive' }), tu('get_page_text'), tu('find', { query: 'search box' }), tu('screenshot'), tu('zoom', { region: [0, 0, 400, 200] }), tu('list_tabs')],
    [say('Trang là Test Shop.')],
  ], { policy: (t) => (t.startsWith('Cho phép tác tử dùng') ? 'Cho phép đến khi tạo chat mới' : 'Từ chối') });
  let rs = resultsOf(r);
  check('site approval prompt shown once for host', r.prompts.filter((p) => p.title.includes(H)).length === 1, JSON.stringify(r.prompts));
  check('cross-site frame asks separately', r.prompts.some((p) => /khung nhúng từ localhost:8123/.test(p.title)), JSON.stringify(r.prompts));
  check('read-only actions need no per-action approval', r.prompts.length === 2, JSON.stringify(r.prompts));
  check('denied frame shown as placeholder, its text not leaked', /content from localhost:8123 not shown/.test(textOf(rs[0])) && !/Partner secret/.test(textOf(rs[0])) && !/Partner secret/.test(textOf(rs[2])), textOf(rs[0]));
  check('same-origin srcdoc frame nested in read_page', /iframe "Same frame" \[ref_\d+\]\n\s+button "Frame button" \[ref_\d+\]/.test(textOf(rs[0])), textOf(rs[0]));
  check('all 7 read calls succeeded', rs.length === 7 && rs.every((x) => !x.is_error), rs.map((x) => x.is_error && textOf(x)).join(' | '));
  check('read_page lists heading/button/textbox with refs', /heading "Test Shop Home" \[ref_\d+\] level=1/.test(textOf(rs[0])) && /button "Delete account" \[ref_/.test(textOf(rs[0])) && /textbox "Full name"/.test(textOf(rs[0])), textOf(rs[0]));
  check('read_page reports password as hidden-capable field', /textbox "Password" \[ref_\d+\].*type=password/.test(textOf(rs[0])), textOf(rs[0]));
  check('read_page interactive omits plain text', !/text "Welcome/.test(textOf(rs[1])) && /button "Search"/.test(textOf(rs[1])), textOf(rs[1]));
  check('read_page sees shadow DOM button', /Shadow button/.test(textOf(rs[0])), '');
  check('get_page_text contains body text', /Price of Widget is 42 dollars/.test(textOf(rs[2])), textOf(rs[2]).slice(0, 300));
  check('find returns search box first', /Search query/.test(textOf(rs[3]).split('\n')[0]), textOf(rs[3]));
  check('screenshot returns image + browser_state', rs[4].content.some((b) => b.type === 'image') && rs[4].content.some((b) => b.type === 'browser_state'));
  check('zoom returns only an image', rs[5].content.length === 1 && rs[5].content[0].type === 'image');
  check('final text shown in panel', r.log.some((l) => l.includes('Trang là Test Shop.')), r.log.join('\n'));
  check('no format errors (read)', r.newErrors === 0, formatErrors.concat(scriptErrors).join('\n'));

  // ---------- 2. Forms & typing (ask mode) ----------
  r = await runTask('forms', 'Điền form', [
    [tu('read_page', { filter: 'interactive' })],
    (prev) => {
      const t = textOf(prev[0]);
      return [
        tu('form_input', { target: { type: 'ref', ref: refIn(t, /textbox "Full name"/) }, value: 'Nguyen Van A' }),
        tu('form_input', { target: { type: 'ref', ref: refIn(t, /combobox "Country"/) }, value: 'Japan' }),
        tu('form_input', { target: { type: 'ref', ref: refIn(t, /checkbox "Remember me"/) }, value: true }),
        tu('form_input', { target: { type: 'ref', ref: refIn(t, /checkbox "Remember me"/) }, value: 'false' }),
        tu('form_input', { target: { type: 'ref', ref: refIn(t, /checkbox "Remember me"/) }, value: 'true' }),
        tu('form_input', { target: { type: 'ref', ref: refIn(t, /textbox "Notes editor"/) }, value: 'new notes' }),
        tu('left_click', { target: { type: 'ref', ref: refIn(t, /textbox "Keys"/) } }),
        tu('key', { text: 'a b shift+c' }),
        tu('key', { text: 'ctrl+a Backspace' }),
        tu('type', { text: 'xin chào 你好' }),
        tu('left_click', { target: { type: 'ref', ref: refIn(t, /Search query/) } }),
        tu('type', { text: 'widget' }),
        tu('key', { text: 'Enter' }),
      ];
    },
    [say('Đã điền.')],
  ], { policy: (t) => (t === 'Cho phép thao tác này?' ? 'Cho phép' : 'Cho phép') });
  rs = resultsOf(r);
  check('select named by its label only', /combobox "Country" \[ref_/.test(textOf(rs[0])), textOf(rs[0]));
  check('ask mode: every write action asked', r.prompts.length === 13, `${r.prompts.length} prompts: ${r.prompts.map((p) => p.detail).join(' | ')}`);
  check('form calls all succeeded', rs.every((x) => !x.is_error), rs.filter((x) => x.is_error).map(textOf).join(' | '));
  const form = await G(() => ({ name: document.getElementById('name').value, country: document.getElementById('country').value, remember: document.getElementById('remember').checked, notes: document.getElementById('editor').textContent, keys: document.getElementById('keys').value, searched: window.searched, changes: window.changes }));
  check('form_input text/select/checkbox/contenteditable applied', form.name === 'Nguyen Van A' && form.country === 'jp' && form.remember && form.notes === 'new notes', JSON.stringify(form));
  check('form_input fires change event', form.changes.includes('name'), JSON.stringify(form));
  check('key sequence + ctrl+a + type unicode', form.keys === 'xin chào 你好', JSON.stringify(form.keys));
  check('Enter submits form', form.searched === 'widget', JSON.stringify(form));

  // ---------- 3. Pointer actions (auto mode via "allow all") ----------
  await site.evaluate(() => { window.log = []; window.wheel = 0; window.scrollTo(0, 0); });
  const pad = await center('#pad');
  const drag = await center('#drag');
  r = await runTask('pointer', 'Thử chuột', [
    [tu('screenshot')],
    [tu('left_click', { target: { type: 'coordinate', ...pad } })],
    [tu('double_click', { target: { type: 'coordinate', ...pad } }), tu('triple_click', { target: { type: 'coordinate', ...pad } }), tu('right_click', { target: { type: 'coordinate', ...pad } }), tu('middle_click', { target: { type: 'coordinate', ...pad } }), tu('left_click', { target: { type: 'coordinate', ...pad }, modifiers: 'ctrl+shift' }), tu('hover', { target: { type: 'coordinate', x: pad.x + 5, y: pad.y } }), tu('mouse_move', { target: { type: 'coordinate', x: pad.x + 10, y: pad.y } }),
      tu('left_mouse_down', { target: { type: 'coordinate', ...pad } }), tu('left_mouse_up', { target: { type: 'coordinate', ...pad } }),
      tu('left_click_drag', { from: { type: 'coordinate', x: drag.x - 50, y: drag.y }, target: { type: 'coordinate', x: drag.x + 300, y: drag.y + 40 } })],
    [tu('scroll', { target: { type: 'coordinate', x: 640, y: 360 }, scroll_direction: 'down', scroll_amount: 5 })],
    [tu('find', { query: 'Footer anchor' })],
    (prev) => [tu('scroll_to', { target: { type: 'ref', ref: refIn(textOf(prev[0]), /Footer anchor/) } }), tu('left_click', { target: { type: 'ref', ref: refIn(textOf(prev[0]), /Footer anchor/) } })],
    [tu('find', { query: 'shadow button' })],
    (prev) => [tu('left_click', { target: { type: 'ref', ref: refIn(textOf(prev[0]), /Shadow button/) } })],
    [say('ok')],
  ], { policy: (t, d, s) => (s ? 'Cho phép' : 'Cho phép đến hết tác vụ') });
  rs = resultsOf(r);
  check('"allow for rest of task" stops further prompts', r.prompts.length === 1, JSON.stringify(r.prompts));
  check('pointer calls all succeeded', rs.every((x) => !x.is_error), rs.filter((x) => x.is_error).map(textOf).join(' | '));
  const plog = await G(() => window.log);
  const has = (s) => plog.includes(s);
  check('left_click → click detail 1', has('click:0:1'), plog.join(','));
  check('double_click → dblclick', has('dblclick:0:2'), plog.join(','));
  check('triple_click → click detail 3', has('click:0:3'), plog.join(','));
  check('right_click → contextmenu', plog.some((x) => x.startsWith('contextmenu:2')), plog.join(','));
  check('middle_click → auxclick button 1', plog.some((x) => x.startsWith('auxclick:1')), plog.join(','));
  check('click modifiers ctrl+shift', plog.some((x) => x.startsWith('click:0:1:ctrl:shift')), plog.join(','));
  check('hover → mouseover', has('mouseover:0:0'), plog.join(','));
  const dg = await G(() => window.drag);
  check('left_click_drag down/up at right points', dg.down && dg.up && Math.abs(dg.down[0] - (drag.x - 50)) <= 2 && Math.abs(dg.up[0] - (drag.x + 300)) <= 2, JSON.stringify({ dg, drag }));
  check('scroll wheel delta 500', (await G(() => window.wheel)) === 500, String(await G(() => window.wheel)));
  check('scroll_to + click far element', await G(() => window.bottomClicked === true));
  check('click inside shadow DOM via ref', await G(() => window.shadowClicked === true));

  // ---------- 4. Sensitive actions in auto mode ----------
  await panel.click('#toggleSettings');
  await panel.selectOption('#mode', 'auto');
  await panel.click('#settings button[type=submit]');
  await site.evaluate(() => window.scrollTo(0, 0));
  r = await runTask('sensitive', 'Xóa tài khoản', [
    [tu('find', { query: 'delete account' })],
    (prev) => [tu('left_click', { target: { type: 'ref', ref: refIn(textOf(prev[0]), /Delete account/) } }), tu('screenshot')],
    [say('Người dùng từ chối.')],
  ], { policy: (t) => (t.startsWith('Cho phép tác tử dùng') ? 'Luôn cho phép' : 'Từ chối') });
  rs = resultsOf(r);
  check('auto mode re-asks site after settings save (session approvals dropped)', r.prompts.some((p) => p.title.includes(H)), JSON.stringify(r.prompts));
  check('"always allow" persisted to settings', (await panel.inputValue('#hosts')).includes(H));
  check('sensitive click prompts even in auto mode', r.prompts.some((p) => p.sensitive && /Delete account/.test(p.detail)), JSON.stringify(r.prompts));
  check('denied click not executed', (await G(() => window.deleted)) !== true);
  check('deny → error result + halt of next call', rs[1]?.is_error && /declined/.test(textOf(rs[1])) && rs[2]?.content === 'Not executed: an earlier action in this turn failed.', rs.map(textOf).join(' | '));

  // password typing prompts and masks
  r = await runTask('password', 'Nhập mật khẩu', [
    [tu('find', { query: 'password' })],
    (prev) => [tu('left_click', { target: { type: 'ref', ref: refIn(textOf(prev[0]), /Password/) } }), tu('type', { text: 'hunter2' })],
    [say('ok')],
  ], { policy: () => 'Cho phép' });
  check('typing into password field prompts and hides value', r.prompts.some((p) => p.sensitive && /\[ẩn\]/.test(p.detail) && !p.detail.includes('hunter2')), JSON.stringify(r.prompts));
  check('password typed after approval', (await G(() => document.getElementById('pw').value)) === 'hunter2');

  // ---------- 5. Navigation ----------
  r = await runTask('navigate', 'Điều hướng', [
    [tu('navigate', { url: `${BASE}/page2` })],
    [tu('navigate', { url: 'back' })],
    [tu('navigate', { url: 'forward' })],
    [tu('navigate', { url: 'reload' })],
    [tu('navigate', { url: 'javascript:alert(1)' })],
    [tu('navigate', { url: 'file:///etc/passwd' })],
    [tu('navigate', { url: `${H}/page3` })],
    [tu('navigate', { url: `${BASE}/redirect` })],
    [say('ok')],
  ], { policy: (t) => (t.includes('localhost') ? 'Từ chối' : 'Cho phép') });
  rs = resultsOf(r);
  check('navigate http ok', !rs[0].is_error && /page2/.test(textOf(rs[0])), textOf(rs[0]));
  check('navigate back', !rs[1].is_error && /8123\/$/.test(textOf(rs[1])), textOf(rs[1]));
  check('navigate forward', !rs[2].is_error && /page2/.test(textOf(rs[2])), textOf(rs[2]));
  check('navigate reload', !rs[3].is_error, textOf(rs[3]));
  check('javascript: refused', rs[4].is_error && /Only http and https/.test(textOf(rs[4])), textOf(rs[4]));
  check('file: refused', rs[5].is_error && /Only http and https/.test(textOf(rs[5])), textOf(rs[5]));
  check('scheme-less URL treated as https (fails on http-only server = error, not crash)', rs[6].is_error || /https:/.test(textOf(rs[6])), textOf(rs[6]));
  check('redirect to unapproved host asks and is blocked on deny', rs[7].is_error && /did not allow access to localhost/.test(textOf(rs[7])) && r.prompts.some((p) => p.title.includes('localhost')), textOf(rs[7]));
  check('page blanked after denied redirect', (await site.url()) === 'about:blank', site.url());
  await site.goto(`${BASE}/`);

  // ---------- 6. Tabs ----------
  r = await runTask('tabs', 'Tab', [
    [tu('find', { query: 'page three new tab' })],
    (prev) => [tu('left_click', { target: { type: 'ref', ref: refIn(textOf(prev[0]), /page three/i) } })],
    [tu('list_tabs')],
    [tu('new_tab')],
    [tu('navigate', { url: `${BASE}/page2` })],
    (prev) => {
      const st = prev[0].content.find((b) => b.type === 'browser_state');
      const first = st.tabs[0].tab_id;
      return [tu('switch_tab', { tab_id: first }), tu('get_page_text', { tab_id: first })];
    },
    (prev) => {
      const st = prev[0].content.find((b) => b.type === 'browser_state');
      const other = st.tabs.find((t) => !t.active && /page2/.test(t.url)).tab_id;
      return [tu('close_tab', { tab_id: other })];
    },
    [tu('switch_tab', { tab_id: 'tab-999999' })],
    [say('ok')],
  ], { policy: () => 'Cho phép' });
  rs = resultsOf(r);
  const click = rs[1].content.find((b) => b.type === 'browser_state');
  check('target=_blank click reports tab_opened', click?.state_changes?.some((c) => c.type === 'tab_opened'), JSON.stringify(click));
  check('list_tabs shows 2 tabs', rs[2].content[0].tabs.length === 2, JSON.stringify(rs[2].content));
  check('new_tab ok', !rs[3].is_error && rs[3].content[0].tabs.length === 3, JSON.stringify(rs[3].content));
  check('navigate in new tab', !rs[4].is_error, textOf(rs[4]));
  check('switch_tab + get_page_text by tab_id', !rs[5].is_error && /Price of Widget/.test(textOf(rs[6])), textOf(rs[6]));
  check('close_tab is confirmed as sensitive', r.prompts.some((p) => p.sensitive && /Đóng/.test(p.detail)), JSON.stringify(r.prompts));
  check('close_tab ok', !rs[7].is_error && rs[7].content[0].tabs.length === 2, JSON.stringify(rs[7].content));
  check('unknown tab id → error', rs[8].is_error && /Unknown tab_id/.test(textOf(rs[8])), textOf(rs[8]));

  // ---------- 7. Errors and edge cases ----------
  r = await runTask('errors', 'Lỗi', [
    [tu('left_click', { target: { type: 'ref', ref: 'ref_99999' } }), tu('screenshot')],
    [tu('javascript_exec', { text: '1+1' })],
    [tu('file_upload', { target: { type: 'ref', ref: 'ref_1' }, paths: ['/etc/passwd'] })],
    [tu('left_click', { target: { type: 'coordinate', x: 99999, y: 5 } })],
    [tu('zoom', { region: [10, 10, 5, 5] })],
    [tu('key', { text: 'ctrl+nosuchkey' })],
    [{ type: 'tool_use', id: `toolu_${++idc}`, name: 'bash', input: { command: 'ls' } }],
    [say('ok')],
  ]);
  rs = resultsOf(r);
  check('stale ref error text', rs[0].is_error && /ref_99999 is stale or not found/.test(textOf(rs[0])), textOf(rs[0]));
  check('halted batch text exact', rs[1].content === 'Not executed: an earlier action in this turn failed.');
  check('javascript_exec disabled message', rs[2].is_error && /javascript_exec is not enabled in this environment/.test(textOf(rs[2])), textOf(rs[2]));
  check('file_upload disabled message', rs[3].is_error && /file_upload is not enabled/.test(textOf(rs[3])), textOf(rs[3]));
  check('out-of-viewport coordinate rejected', rs[4].is_error && /outside/.test(textOf(rs[4])), textOf(rs[4]));
  check('invalid zoom region rejected', rs[5].is_error && /Invalid zoom region/.test(textOf(rs[5])), textOf(rs[5]));
  check('unknown key rejected', rs[6].is_error, textOf(rs[6]));
  check('non-browser tool answered with error, no toolset_name', rs[7].is_error && !('toolset_name' in rs[7]), JSON.stringify(rs[7]));
  check('no format errors (errors)', r.newErrors === 0, formatErrors.concat(scriptErrors).join('\n'));

  // ---------- 8. Timing: wait, hold_key, key repeat ----------
  await site.evaluate(() => { window.keylog = []; document.getElementById('keys').value = ''; });
  r = await runTask('timing', 'Thời gian', [
    [tu('find', { query: 'keys' })],
    (prev) => [tu('left_click', { target: { type: 'ref', ref: refIn(textOf(prev[0]), /textbox "Keys"/) } }), tu('key', { text: 'x', repeat: 3 }), tu('hold_key', { text: 'shift', duration: 1 }), tu('wait', { duration: 1 })],
    [say('ok')],
  ]);
  rs = resultsOf(r);
  check('timing calls succeeded', rs.every((x) => !x.is_error), rs.map(textOf).join(' | '));
  check('key repeat 3', (await G(() => document.getElementById('keys').value)) === 'xxx', await G(() => document.getElementById('keys').value));
  const kl = await G(() => window.keylog.filter((k) => k.includes('Shift')));
  const held = kl.length >= 2 ? Number(kl.at(-1).split(':')[2]) - Number(kl[0].split(':')[2]) : 0;
  check('hold_key held ~1s', held >= 900 && held < 2500, JSON.stringify(kl));

  // ---------- 9. Stop button during long wait ----------
  const t0 = Date.now();
  r = await runTask('stop', 'Chờ lâu', [[tu('wait', { duration: 30 })], [say('should not reach')]], {
    duringRun: async () => { await new Promise((res) => setTimeout(res, 1000)); await panel.click('#stop'); },
  });
  check('stop aborts a 30s wait quickly', Date.now() - t0 < 6000, `${Date.now() - t0}ms`);
  check('stop shows "Đã dừng."', r.log.some((l) => l.includes('Đã dừng.')), r.log.slice(-3).join('\n'));
  check('composer usable after stop', await panel.evaluate(() => !document.getElementById('prompt').disabled));

  // ---------- 10. API errors and retries ----------
  apiErrorPlan = [{ status: 529, body: { error: { message: 'Overloaded' } }, headers: { 'retry-after': '1' } }];
  r = await runTask('retry', 'Thử lại', [[say('Sau khi thử lại.')]]);
  check('529 retried then succeeded', r.log.some((l) => l.includes('Sau khi thử lại.')), r.log.slice(-3).join('\n'));
  apiErrorPlan = [{ status: 401, body: { error: { message: 'invalid x-api-key' } } }];
  r = await runTask('401', 'Lỗi key', [[say('x')]]);
  check('401 shows Vietnamese key error', r.log.some((l) => l.includes('API key không hợp lệ')), r.log.slice(-3).join('\n'));
  script = [];

  // ---------- 11. Long task: old screenshots pruned, cache_control ----------
  await newChat();
  r = await runTask('prune', 'Chụp nhiều', [...Array(8)].map(() => [tu('screenshot')]).concat([[say('ok')]]));
  const lastBody = r.requests.at(-1);
  const imgs = lastBody.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).flatMap((b) => (b.type === 'tool_result' && Array.isArray(b.content) ? b.content : []));
  check('only 6 newest images kept', imgs.filter((b) => b.type === 'image').length === 6 && imgs.filter((b) => /Older screenshot removed/.test(b.text || '')).length === 2);
  check('cache_control on last block and system', lastBody.messages.at(-1).content.at(-1).cache_control && lastBody.system[0].cache_control);
  check('new chat cleared history', r.requests[0].messages.length === 1);
  check('screenshot sizes consistent', imageSizes.size === 1, [...imageSizes].join(','));

  // ---------- 12. iframe limitation ----------
  r = await runTask('iframe', 'iframe', [[tu('find', { query: 'Frame button' })], [say('ok')]]);
  check('find reaches into same-origin frame', /button "Frame button" \[ref_\d+\] \(in frame from this page\)/.test(textOf(resultsOf(r)[0])), textOf(resultsOf(r)[0]));

  // ---------- 13. iframes ----------
  await newChat();
  const frameOf = (re) => site.frames().find((f) => re.test(f.url()));
  r = await runTask('frames', 'Khung', [
    [tu('read_page', { filter: 'interactive' })],
    (prev) => {
      const t = textOf(prev[0]);
      return [
        tu('left_click', { target: { type: 'ref', ref: refIn(t, /button "Frame button"/) } }),
        tu('form_input', { target: { type: 'ref', ref: refIn(t, /textbox "Frame input"/) }, value: 'hello frame' }),
        tu('left_click', { target: { type: 'ref', ref: refIn(t, /button "Cross button"/) } }),
        tu('left_click', { target: { type: 'ref', ref: refIn(t, /button "Nested button"/) } }),
        tu('scroll_to', { target: { type: 'ref', ref: refIn(t, /button "Nested button"/) } }),
        tu('get_page_text'),
        tu('find', { query: 'nested button' }),
      ];
    },
    [say('ok')],
  ], { policy: (t) => (/khung nhúng/.test(t) ? 'Cho phép đến khi tạo chat mới' : 'Cho phép') });
  rs = resultsOf(r);
  const ft = textOf(rs[0]);
  check('approved cross-site frame and its nested frame appear in read_page', /iframe "Partner widget" \[ref_\d+\]\n\s+button "Cross button"[^\n]*\n\s+iframe "Nested" \[ref_\d+\]\n\s+button "Nested button"/.test(ft), ft);
  check('refs are unique across frames', (() => { const all = [...ft.matchAll(/\[(ref_\d+)\]/g)].map((m) => m[1]); return new Set(all).size === all.length; })(), ft);
  check('frame actions succeeded', rs.slice(1, 8).every((x) => !x.is_error), rs.slice(1, 8).map(textOf).join(' | '));
  check('click by ref in same-origin frame', (await G(() => window.frameClicked)) === 1, String(await G(() => window.frameClicked)));
  check('form_input in frame', (await G(() => window.frameInput)) === 'hello frame', String(await G(() => window.frameInput)));
  const cross = frameOf(/framepage/);
  check('click by ref in cross-site frame (border/padding offsets)', (await cross.evaluate(() => window.crossClicked)) === 1);
  check('click by ref in nested frame', (await cross.evaluate(() => window.nestedClicked)) === 1);
  check('get_page_text includes approved frame text', /--- Frame: http:\/\/localhost:8123\/framepage ---\n[\s\S]*Partner secret text/.test(textOf(rs[6])), textOf(rs[6]).slice(-400));
  check('find in nested frame labels the frame', /Nested button" \[ref_\d+\] \(in frame from (this page|localhost:8123)\)/.test(textOf(rs[7])), textOf(rs[7]));
  const r2 = await runTask('frames-reload', 'Tải lại', [
    [tu('navigate', { url: 'reload' })],
    [tu('left_click', { target: { type: 'ref', ref: refIn(ft, /button "Cross button"/) } })],
    [say('ok')],
  ]);
  check('frame ref stale after reload', resultsOf(r2)[1].is_error && /is stale or not found/.test(textOf(resultsOf(r2)[1])), textOf(resultsOf(r2)[1]));

  // coordinate click into a frame from a site the user denied is treated as sensitive
  await newChat();
  await site.evaluate(() => document.getElementById('cross').scrollIntoView());
  const crossPoint = await site.$eval('#cross', (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.left + 60), y: Math.round(b.top + 80) }; });
  r = await runTask('frames-deny', 'Khung từ chối', [
    [tu('read_page')],
    [tu('find', { query: 'cross button' })],
    [tu('left_click', { target: { type: 'coordinate', ...crossPoint } })],
    [say('ok')],
  ], { policy: (t, d, sens) => (/khung nhúng/.test(t) ? 'Từ chối' : sens ? 'Từ chối' : 'Cho phép') });
  rs = resultsOf(r);
  check('find skips denied frames and says so', /were not searched/.test(textOf(rs[1])) && !/Cross button/.test(textOf(rs[1])), textOf(rs[1]));
  check('coordinate click into denied frame asks as sensitive', r.prompts.some((p) => p.sensitive && /khung nhúng từ localhost/.test(p.detail)), JSON.stringify(r.prompts));

  // ---------- 14. Optional tools ----------
  await panel.click('#toggleSettings');
  for (const tool of ['read_console', 'read_network', 'file_upload', 'javascript_exec']) await panel.check(`[data-tool=${tool}]`);
  await panel.selectOption('#mode', 'auto');
  await panel.click('#settings button[type=submit]');
  check('attach button appears when file_upload enabled', await panel.isVisible('#attach'));
  await panel.setInputFiles('#files', [{ name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') }, { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.alloc(2048, 1) }]);
  check('attached files listed as chips', (await panel.textContent('#attachments')).includes('doc-1: cv.pdf'), await panel.textContent('#attachments'));

  await site.evaluate(() => window.scrollTo(0, 0));
  r = await runTask('optional', 'Tool tùy chọn', [
    [tu('screenshot')],
    [tu('javascript_exec', { text: 'document.title' }), tu('javascript_exec', { text: '[1, 2, 3].map((x) => x * 2)' }), tu('javascript_exec', { text: 'await new Promise((r) => setTimeout(() => r(5), 100))' }), tu('javascript_exec', { text: "console.log('hello from page', {a: 1}); console.error('failed with token=abc123 Bearer abcdefghijklmnop'); 'logged'" })],
    [tu('javascript_exec', { text: "fetch('/api/data?token=supersecret&page=2').then((r) => r.status)" })],
    [tu('wait', { duration: 1 })],
    [tu('read_console'), tu('read_console'), tu('read_network')],
    [tu('javascript_exec', { text: 'nosuchvar.foo' })],
    [tu('javascript_exec', { text: "document.getElementById('hello').click()" })],
    [tu('find', { query: 'upload document' })],
    (prev) => [tu('file_upload', { target: { type: 'ref', ref: refIn(textOf(prev[0]), /Upload document/) }, document_ids: ['doc-1', 'doc-2'] })],
    (prev) => [tu('file_upload', { target: { type: 'ref', ref: 'ref_1' }, paths: ['/etc/passwd'] })],
    [tu('file_upload', { target: { type: 'ref', ref: 'ref_1' }, document_ids: ['doc-99'] })],
    [say('ok')],
  ], { policy: (t, d, sens) => (sens && /click\(\)/.test(d) ? 'Từ chối' : 'Cho phép') });
  rs = resultsOf(r);
  const firstReq = r.requests[0];
  check('request lists enabled optional members in configs', JSON.stringify(firstReq.tools[0].configs) === JSON.stringify({ javascript_exec: { enabled: true }, file_upload: { enabled: true }, read_console: { enabled: true }, read_network: { enabled: true } }), JSON.stringify(firstReq.tools));
  check('attached files described in user message', /doc-1: cv\.pdf \(application\/pdf, 13 bytes\); doc-2: photo\.png/.test(JSON.stringify(firstReq.messages.at(-1))), JSON.stringify(firstReq.messages.at(-1)).slice(0, 400));
  check('javascript_exec string result', textOf(rs[1]) === 'Test Shop', textOf(rs[1]));
  check('javascript_exec JSON result', textOf(rs[2]).replace(/\s/g, '') === '[2,4,6]', textOf(rs[2]));
  check('javascript_exec awaits promises', textOf(rs[3]) === '5', textOf(rs[3]));
  check('javascript_exec fetch ran', textOf(rs[5]) === '200', textOf(rs[5]));
  const con = textOf(rs[7]);
  check('read_console shows log and error lines', /\[log\] hello from page \{a: 1\}/.test(con) && /\[error\] failed with token=/.test(con), con);
  check('read_console redacts secrets', !/abc123|abcdefghijklmnop/.test(con) && /REDACTED/.test(con), con);
  check('read_console returns only new entries', /No console entries since the last read/.test(textOf(rs[8])), textOf(rs[8]));
  const net = textOf(rs[9]);
  check('read_network lists request with status/mime/timing', /GET 200 application\/json \d+ms http:\/\/127\.0\.0\.1:8123\/api\/data\?token=REDACTED&page=2/.test(net), net);
  check('read_network redacts token', !/supersecret/.test(net), net);
  check('javascript_exec error reported', rs[10].is_error && /JavaScript error: ReferenceError: nosuchvar is not defined/.test(textOf(rs[10])), textOf(rs[10]));
  check('risky JavaScript asks even in auto mode, code shown', r.prompts.some((p) => p.sensitive && /getElementById\('hello'\)\.click\(\)/.test(p.detail)), JSON.stringify(r.prompts));
  check('declined JavaScript not run', rs[11].is_error && !(await G(() => window.helloClicks > 1)), textOf(rs[11]));
  check('plain JavaScript runs without asking in auto mode', !r.prompts.some((p) => /document\.title/.test(p.detail)), JSON.stringify(r.prompts));
  check('file_upload asks with file names', r.prompts.some((p) => p.sensitive && /cv\.pdf, photo\.png/.test(p.detail)), JSON.stringify(r.prompts));
  check('file_upload set files on input', JSON.stringify(await G(() => window.uploaded)) === JSON.stringify(['cv.pdf:13', 'photo.png:2048']), JSON.stringify(await G(() => window.uploaded)) + textOf(rs[13]));
  check('file_upload paths refused', rs[14].is_error && /Uploading by path is not supported/.test(textOf(rs[14])), textOf(rs[14]));
  check('file_upload unknown id refused', rs[15].is_error && /Unknown document_id doc-99/.test(textOf(rs[15])), textOf(rs[15]));
  check('JavaScript code shown in panel log', r.log.some((l) => l.includes('Chạy JavaScript') && l.includes('document.title')), r.log.filter((l) => l.includes('JavaScript')).join('\n'));
  check('no format errors (optional tools)', r.newErrors === 0, formatErrors.concat(scriptErrors).join('\n'));

  // ---------- 15. Downloads ----------
  r = await runTask('downloads', 'Tải xuống', [
    [tu('find', { query: 'download report' })],
    (prev) => [tu('left_click', { target: { type: 'ref', ref: refIn(textOf(prev[0]), /Download report/) } })],
    [tu('wait', { duration: 1 })],
    [tu('zoom', { region: [0, 0, 100, 100] })],
    [say('ok')],
  ]);
  rs = resultsOf(r);
  const changes = rs.flatMap((x) => (Array.isArray(x.content) ? x.content : []).filter((b) => b.type === 'browser_state').flatMap((b) => b.state_changes || []));
  const started = changes.find((c) => c.type === 'download_started');
  const done = changes.find((c) => c.type === 'download_completed');
  check('download reported (started or completed)', started || done, JSON.stringify(changes));
  check('download completed with size and no path', done && done.size_bytes === 8 && !('path' in done) && /\/download$/.test(done.url), JSON.stringify(changes));
  check('each download event reported once', changes.filter((c) => c.type === 'download_completed').length === 1, JSON.stringify(changes));
  check('no format errors (downloads)', r.newErrors === 0, formatErrors.concat(scriptErrors).join('\n'));

  console.log('\nFORMAT ERRORS:', formatErrors.length ? `\n${formatErrors.join('\n')}` : 'none');
  console.log('SCRIPT ERRORS:', scriptErrors.length ? `\n${scriptErrors.join('\n')}` : 'none');
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await ctx.close();
  server.close();
  process.exit(failed.length || formatErrors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
