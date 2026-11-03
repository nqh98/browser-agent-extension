import { runTask, listModels, apiBase } from './agent.js';
import { BrowserExecutor } from './browser.js';
import { BridgeClient } from './bridge-client.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  usage: '', // 'chat' (the panel calls the Claude API) or 'code' (Claude Code drives the panel)
  baseUrl: '',
  authType: 'x-api-key',
  apiKey: '',
  model: 'claude-sonnet-5-5',
  mode: 'ask',
  approvedHosts: [],
  tools: {},
  bridge: { port: 18765, token: '' },
};
const USAGE_LABEL = { chat: 'Chat', code: 'Claude Code' };
const HINT = {
  chat: 'Giao việc cho tác tử trên tab đang mở, ví dụ: "Tóm tắt trang này" hoặc "Tìm chuyến bay rẻ nhất tới Đà Nẵng".',
  code: 'Các thao tác của Claude Code sẽ hiện ở đây. Khi cần bạn đồng ý, panel sẽ hỏi tại đây.',
};
const REMOTE_IDLE_MS = 3 * 60 * 1000;
const MAX_ATTACH_BYTES = 25 * 1024 * 1024;
const BRIDGE_PORTS = 10;
const CUSTOM_MODEL = '__custom__';

let settings = structuredClone(DEFAULTS);
let messages = [];
let controller = null;
let executor = null;
const totals = { input: 0, output: 0 };
const pendingConfirms = new Set();
const attachments = new Map(); // document_id -> File
let nextDocument = 0;
let modelLoad = null;

// ---- Log ----

function showHint() {
  if ($('log').children.length || !settings.usage) return;
  const hint = document.createElement('p');
  hint.className = 'muted hint';
  hint.textContent = HINT[settings.usage];
  $('log').append(hint);
}

function append(className, text) {
  $('log').querySelector('.hint')?.remove();
  const node = document.createElement('div');
  node.className = className;
  node.textContent = text;
  $('log').append(node);
  node.scrollIntoView({ block: 'end' });
  return node;
}

function clearLog() {
  $('log').replaceChildren();
  showHint();
}

/** Stable hue per session label, so a session keeps its color everywhere. */
function hueOf(label) {
  let hash = 0;
  for (const char of label) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % 360;
}

function describeAction(name, input = {}) {
  const target = input.target?.ref || (input.target ? `(${input.target.x}, ${input.target.y})` : '');
  const parts = {
    navigate: `Mở ${input.url}`,
    read_page: 'Đọc cấu trúc trang',
    get_page_text: 'Đọc nội dung trang',
    find: `Tìm "${input.query}"`,
    screenshot: 'Chụp màn hình',
    zoom: 'Phóng to một vùng',
    type: 'Nhập văn bản',
    key: `Nhấn ${input.text}`,
    wait: `Chờ ${input.duration} giây`,
    form_input: `Điền ${target}`,
    new_tab: 'Mở tab mới',
    switch_tab: `Chuyển sang ${input.tab_id}`,
    close_tab: `Đóng ${input.tab_id}`,
    list_tabs: 'Xem danh sách tab',
    read_console: 'Đọc console',
    read_network: 'Đọc request mạng',
    file_upload: `Tải lên ${(input.document_ids || []).map((id) => attachments.get(String(id))?.name || id).join(', ')}`,
    javascript_exec: 'Chạy JavaScript',
  };
  return parts[name] || `${name} ${target}`.trim();
}

function logAction(name, input, session = null) {
  const node = append(session ? 'action remote' : 'action', describeAction(name, input));
  if (session) {
    node.dataset.session = session.label;
    node.style.setProperty('--hue', hueOf(session.label));
  }
  if (name === 'javascript_exec') {
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = String(input.text ?? '').slice(0, 4000);
    node.append(code);
  }
}

function askUser({ title, detail, kind, sensitive, session = null }) {
  return new Promise((resolve) => {
    const card = document.createElement('div');
    card.className = `card${sensitive ? ' sensitive' : ''}`;
    if (session) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = session.label;
      card.style.setProperty('--hue', hueOf(session.label));
      card.append(tag);
    }
    const heading = document.createElement('strong');
    heading.textContent = title;
    const body = document.createElement('div');
    body.className = 'detail';
    body.textContent = detail;
    const buttons = document.createElement('div');
    buttons.className = 'buttons';

    const entry = { session };
    const finish = (answer) => {
      pendingConfirms.delete(entry);
      card.remove();
      showHint();
      resolve(answer);
    };
    entry.cancel = () => finish('deny');
    pendingConfirms.add(entry);

    const until = session ? 'đến khi phiên này kết thúc' : 'đến khi tạo chat mới';
    const options = kind === 'site'
      ? [['allow', `Cho phép ${until}`], ['always', 'Luôn cho phép'], ['deny', 'Từ chối']]
      : sensitive
        ? [['allow', 'Cho phép'], ['deny', 'Từ chối']]
        : [['allow', 'Cho phép'], ['allow_all', 'Cho phép đến hết tác vụ'], ['deny', 'Từ chối']];
    for (const [value, label] of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      if (value !== 'allow') button.className = 'ghost';
      button.addEventListener('click', () => finish(value));
      buttons.append(button);
    }
    card.append(heading, body, buttons);
    $('log').querySelector('.hint')?.remove();
    $('log').append(card);
    card.scrollIntoView({ block: 'end' });
  });
}

/** Denies open prompts: all of them, or only those of one session (null = the chat). */
function cancelConfirms(session = undefined) {
  for (const entry of [...pendingConfirms]) {
    if (session === undefined || entry.session === session) entry.cancel();
  }
}

// ---- Settings storage ----

async function saveSettings() {
  await chrome.storage.local.set({ settings });
}

async function persistHost(host) {
  if (!settings.approvedHosts.includes(host)) {
    settings.approvedHosts.push(host);
    $('hosts').value = settings.approvedHosts.join('\n');
    await saveSettings();
  }
}

/** Older versions had no usage choice; pick the one their settings point to. */
function migrate(stored = {}) {
  const next = { ...structuredClone(DEFAULTS), ...stored };
  next.bridge = { ...DEFAULTS.bridge, ...stored.bridge };
  next.tools = { ...stored.tools };
  if (!next.usage) next.usage = stored.bridge?.enabled ? 'code' : stored.apiKey ? 'chat' : '';
  delete next.bridge.enabled;
  return next;
}

// ---- Models (chat) ----

/** The model chosen in the form: the gateway list when shown, otherwise the text box. */
function chosenModel() {
  const select = $('modelSelect');
  if (!select.hidden && select.value !== CUSTOM_MODEL) return select.value;
  return $('model').value.trim();
}

/** Shows the allowed models as a dropdown, keeping a way to type any other name. */
function renderModels(models, current) {
  const select = $('modelSelect');
  select.replaceChildren();
  if (!models?.length) {
    select.hidden = true;
    $('model').hidden = false;
    $('model').value = current;
    return;
  }
  const add = (value, label) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  };
  for (const model of models) add(model.id, model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id);
  const known = models.some((model) => model.id === current);
  add(CUSTOM_MODEL, 'Nhập tên khác…');
  select.value = known ? current : current ? CUSTOM_MODEL : models[0].id;
  select.hidden = false;
  $('model').value = known ? '' : current;
  $('model').hidden = select.value !== CUSTOM_MODEL;
}

let modelList = []; // what the dropdown currently offers

function formConnection() {
  const gateway = $('useGateway').checked;
  return {
    baseUrl: gateway ? $('baseUrl').value.trim() : '',
    authType: gateway ? $('authType').value : 'x-api-key',
    apiKey: $('apiKey').value.trim(),
  };
}

/** Checks the key and fetches the models it may use; cached per base URL. */
async function refreshModels() {
  const connection = formConnection();
  if (!connection.apiKey) {
    $('modelStatus').textContent = 'Nhập API key để kiểm tra.';
    return;
  }
  modelLoad?.abort();
  const load = new AbortController();
  modelLoad = load;
  const current = chosenModel();
  $('refreshModels').disabled = true;
  $('modelStatus').textContent = 'Đang kiểm tra…';
  try {
    const models = await listModels(connection, load.signal);
    if (load.signal.aborted) return;
    modelList = models;
    renderModels(models, current);
    $('modelStatus').textContent = models.length
      ? `✓ Key dùng được. ${models.length} model được phép tại ${apiBase(connection.baseUrl)}.`
      : 'Gateway không trả về model nào. Hãy nhập tên model thủ công.';
    if (models.length && current && !models.some((model) => model.id === current)) {
      $('modelStatus').textContent += ` "${current}" không có trong danh sách.`;
    }
    await chrome.storage.local.set({ modelCache: { base: apiBase(connection.baseUrl), models } });
  } catch (error) {
    if (load.signal.aborted) return;
    $('modelStatus').textContent = `Không kiểm tra được: ${error.message || error}`;
  } finally {
    if (modelLoad === load) {
      modelLoad = null;
      $('refreshModels').disabled = false;
    }
  }
}

// ---- Chat tasks ----

function setRunning(running) {
  $('send').hidden = running;
  $('stop').hidden = !running;
  $('prompt').disabled = running;
  if (!running && settings.usage === 'chat') $('prompt').focus();
}

function ensureExecutor() {
  executor ??= new BrowserExecutor({
    confirm: askUser,
    settings,
    persistHost,
    onDetachedByUser: () => {
      append('error', 'Bạn đã tắt quyền điều khiển tab, tác vụ đã dừng.');
      stopChat();
    },
  });
  executor.settings = settings;
  executor.documents = attachments;
  return executor;
}

function stopChat() {
  controller?.abort();
  cancelConfirms(null);
}

function resetChat() {
  stopChat();
  messages = [];
  totals.input = 0;
  totals.output = 0;
  $('usage').textContent = '';
  executor?.dispose();
  executor = null;
}

async function submitTask(text) {
  if (!settings.apiKey) {
    openSettings();
    $('apiKey').focus();
    append('error', 'Hãy nhập API key trước.');
    return;
  }
  append('msg user', text);
  $('prompt').value = '';
  controller = new AbortController();
  setRunning(true);
  ensureExecutor();
  let request = text;
  if (settings.tools.file_upload && attachments.size) {
    const list = [...attachments].map(([id, file]) => `${id}: ${file.name} (${file.type || 'unknown type'}, ${file.size} bytes)`).join('; ');
    request += `\n\n[Files the user attached for file_upload, by document_id: ${list}]`;
  }

  try {
    await runTask({
      text: request,
      messages,
      settings,
      executor,
      signal: controller.signal,
      ui: {
        onText: (said) => append('msg', said),
        onAction: (name, input) => logAction(name, input),
        onActionError: (_name, error) => append('error', String(error)),
        onNotice: (notice) => append('muted', notice),
        onUsage: (usage) => {
          totals.input += (usage?.input_tokens || 0)
            + (usage?.cache_read_input_tokens || 0)
            + (usage?.cache_creation_input_tokens || 0);
          totals.output += usage?.output_tokens || 0;
          $('usage').textContent = `${totals.input.toLocaleString()} vào · ${totals.output.toLocaleString()} ra`;
        },
      },
    });
    if (controller.signal.aborted) append('muted', 'Đã dừng.');
  } catch (error) {
    if (error.name === 'AbortError') append('muted', 'Đã dừng.');
    else append('error', error.message || String(error));
  } finally {
    controller = null;
    setRunning(false);
  }
}

// ---- Claude Code: each terminal session drives its own executor through its own ----
// ---- local MCP server, one port per session in a small range.                   ----

const sessions = new Map(); // port -> { port, client, state, detail, label, executor, controller, idle, stopped }
const remoteError = (text) => ({ type: 'tool_result', toolset_name: 'browser', is_error: true, content: `Error: ${text}` });

async function endSession(session) {
  clearTimeout(session.idle);
  if (!session.controller) return;
  session.controller = null;
  renderSessions();
  await session.executor?.endTask();
}

async function dropSessionExecutor(session) {
  await endSession(session);
  session.executor?.dispose();
  session.executor = null;
}

function stopSession(session, byUser = true) {
  if (!session.controller) return;
  session.controller.abort();
  session.stopped = byUser;
  cancelConfirms(session);
  endSession(session);
}

function sessionExecutor(session) {
  session.executor ??= new BrowserExecutor({
    confirm: (request) => askUser({ ...request, session }),
    settings,
    persistHost,
    ownWindow: true,
    onDetachedByUser: () => {
      append('error', `Bạn đã tắt quyền điều khiển tab, phiên ${session.label} đã dừng.`);
      stopSession(session);
    },
  });
  session.executor.settings = settings;
  session.executor.documents = attachments;
  return session.executor;
}

/** A tab some other connected session is already driving. */
function ownedElsewhere(session, tabId) {
  return [...sessions.values()].some((other) => other !== session && other.state === 'connected' && other.executor?.managed.has(tabId));
}

async function remoteCall(session, name, input) {
  if (settings.usage !== 'code') return remoteError('The side panel is in chat mode. Ask the user to switch it to Claude Code.');
  if (session.stopped) {
    session.stopped = false;
    return remoteError('The user pressed Stop in the side panel. Ask the user before continuing.');
  }
  const exec = sessionExecutor(session);
  if (!session.controller) {
    session.controller = new AbortController();
    renderSessions();
    await exec.beginTask(session.controller.signal);
    // Two sessions must not share a tab: leave the user's tab to the session already on it.
    if (exec.activeTab !== null && ownedElsewhere(session, exec.activeTab)) {
      exec.managed.delete(exec.activeTab);
      exec.activeTab = [...exec.managed].at(-1) ?? null;
    }
  }
  clearTimeout(session.idle);
  logAction(name, input, session);
  let result = await exec.run({ id: 'bridge', name, input });
  if (result.is_error && /No tab is open/.test(String(result.content))) {
    result = remoteError('This session has no tab yet, and the active tab belongs to another Claude Code session. Call new_tab to open a tab of your own.');
  }
  if (result.is_error) append('error', `${session.label}: ${String(result.content).replace(/^Error: /, '')}`);
  // Detach (and drop Chrome's debugging bar) once this session goes quiet.
  if (session.controller) session.idle = setTimeout(() => endSession(session), REMOTE_IDLE_MS);
  renderSessions();
  return result;
}

function renderSessions() {
  const list = [...sessions.values()];
  const connected = list.filter((session) => session.state === 'connected');
  const rows = connected.map((session) => {
    const row = document.createElement('div');
    row.className = `session${session.controller ? ' busy' : ''}`;
    row.dataset.port = session.port;
    row.style.setProperty('--hue', hueOf(session.label));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = session.label;
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const tabs = session.executor?.managed.size || 0;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${session.controller ? 'đang điều khiển' : 'đang chờ'} · ${tabs} tab`;
    row.title = `${session.label} · cổng ${session.port}`;
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'danger small';
    stop.textContent = 'Dừng';
    stop.title = `Dừng phiên ${session.label}`;
    stop.disabled = !session.controller;
    stop.addEventListener('click', () => stopSession(session));
    row.append(name, spacer, meta, stop);
    return row;
  });
  $('sessionList').replaceChildren(...rows);
  $('setupGuide').hidden = connected.length > 0;

  // The rows already show connected sessions; the status line only adds what they don't.
  const base = settings.bridge.port;
  const lines = list.filter((session) => session.state === 'error').map((session) => `Cổng ${session.port}: ${session.detail}`);
  if (!connected.length && list.length) lines.unshift(`Đang chờ Claude Code ở cổng ${base}–${base + BRIDGE_PORTS - 1}…`);
  $('bridgeStatus').textContent = lines.join(' ');
  renderHeader();
}

const helloInfo = () => ({
  mode: settings.mode,
  tools: settings.tools,
  documents: settings.tools.file_upload ? [...attachments].map(([id, file]) => ({ id, name: file.name, size: file.size, type: file.type })) : [],
});

/** Keeps one client per port in the range while in Claude Code mode. */
function configureBridges() {
  const { port, token } = settings.bridge;
  const wanted = new Set(settings.usage === 'code' ? Array.from({ length: BRIDGE_PORTS }, (_, i) => port + i) : []);
  for (const [sessionPort, session] of sessions) {
    if (wanted.has(sessionPort)) continue;
    session.client.configure({ enabled: false });
    cancelConfirms(session);
    dropSessionExecutor(session);
    sessions.delete(sessionPort);
  }
  for (const sessionPort of wanted) {
    let session = sessions.get(sessionPort);
    if (!session) {
      session = { port: sessionPort, state: 'off', detail: '', label: `Claude Code :${sessionPort}`, executor: null, controller: null, idle: null, stopped: false };
      session.client = new BridgeClient({
        onCall: (name, input) => remoteCall(session, name, input),
        onState: (state, detail = '', info = {}) => {
          const was = session.state;
          session.state = state;
          session.detail = detail;
          if (state === 'connected') session.label = info.label || `Claude Code :${sessionPort}`;
          // A new connection is a new Claude Code session: start it with fresh tabs and approvals.
          if (was === 'connected' && state !== 'connected') {
            session.stopped = false;
            cancelConfirms(session);
            dropSessionExecutor(session);
          }
          renderSessions();
        },
        hello: helloInfo,
      });
      sessions.set(sessionPort, session);
    }
    session.client.configure({ enabled: true, port: sessionPort, token });
    session.client.sendStatus();
  }
  renderSessions();
}

// ---- Usage (chat / Claude Code) ----

function renderHeader() {
  const usage = settings.usage;
  const connected = [...sessions.values()].filter((session) => session.state === 'connected').length;
  const ready = usage === 'chat' ? Boolean(settings.apiKey) : connected > 0;
  $('modeLabel').textContent = usage === 'code' && connected > 1 ? `Claude Code ×${connected}` : USAGE_LABEL[usage] || 'Browser Agent';
  $('modeDot').classList.toggle('on', ready);
  $('modeDot').title = usage === 'chat'
    ? (ready ? 'Đã có API key' : 'Chưa có API key')
    : (connected ? `${connected} phiên Claude Code đã kết nối` : 'Chưa có phiên Claude Code nào');
}

function showWelcome(show) {
  document.body.classList.toggle('choosing', show && Boolean(settings.usage));
  $('welcome').hidden = !show;
  $('cancelWelcome').hidden = !settings.usage;
  for (const choice of document.querySelectorAll('.choice')) choice.classList.toggle('current', choice.dataset.usage === settings.usage);
  if (show) $('settings').hidden = true;
}

async function chooseUsage(usage) {
  const changed = usage !== settings.usage;
  showWelcome(false);
  if (!changed) return;
  // The two modes are exclusive: leaving one stops everything it was doing.
  resetChat();
  settings.usage = usage;
  await saveSettings();
  applyUsage();
  clearLog();
  if (usage === 'chat' && !settings.apiKey) {
    openSettings();
    $('apiKey').focus();
  }
}

function applyUsage() {
  document.body.dataset.usage = settings.usage;
  configureBridges();
  renderAttachments();
  renderHeader();
}

// ---- Settings form ----

function fillSettings() {
  $('apiKey').value = settings.apiKey;
  $('useGateway').checked = Boolean(settings.baseUrl) || settings.authType === 'bearer';
  $('gatewayFields').hidden = !$('useGateway').checked;
  $('baseUrl').value = settings.baseUrl;
  $('authType').value = settings.authType;
  renderModels(modelList, settings.model);
  for (const radio of document.querySelectorAll('input[name=mode]')) radio.checked = radio.value === settings.mode;
  $('hosts').value = settings.approvedHosts.join('\n');
  for (const box of document.querySelectorAll('[data-tool]')) box.checked = Boolean(settings.tools[box.dataset.tool]);
  renderToolsCount();
  $('bridgePort').value = settings.bridge.port;
  $('bridgeToken').value = settings.bridge.token;
  $('bridgeAdvanced').open = settings.bridge.port !== DEFAULTS.bridge.port || Boolean(settings.bridge.token);
}

function renderToolsCount() {
  const on = [...document.querySelectorAll('[data-tool]')].filter((box) => box.checked).length;
  $('toolsCount').textContent = on ? `(${on} đang bật)` : '(tắt cả)';
}

function openSettings() {
  showWelcome(false);
  $('settings').hidden = false;
}

function closeSettings() {
  fillSettings(); // discard unsaved edits
  $('settings').hidden = true;
}

$('settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const before = `${apiBase(settings.baseUrl)}|${settings.authType}|${settings.apiKey}`;
  Object.assign(settings, formConnection());
  settings.model = chosenModel() || DEFAULTS.model;
  settings.mode = document.querySelector('input[name=mode]:checked')?.value || 'ask';
  settings.approvedHosts = $('hosts').value.split('\n').map((line) => line.trim()).filter(Boolean);
  settings.tools = Object.fromEntries([...document.querySelectorAll('[data-tool]')].map((box) => [box.dataset.tool, box.checked]));
  settings.bridge = {
    port: Number($('bridgePort').value) || DEFAULTS.bridge.port,
    token: $('bridgeToken').value.trim(),
  };
  await saveSettings();
  applyUsage();
  // Drop approvals so a site removed from the list really loses access.
  if (!controller) {
    executor?.dispose();
    executor = null;
  }
  for (const session of sessions.values()) {
    if (!session.controller) dropSessionExecutor(session);
  }
  $('settings').hidden = true;
  if (settings.usage === 'chat' && settings.apiKey && before !== `${apiBase(settings.baseUrl)}|${settings.authType}|${settings.apiKey}`) refreshModels();
});

$('toggleSettings').addEventListener('click', () => {
  if ($('settings').hidden) openSettings();
  else closeSettings();
});
$('closeSettings').addEventListener('click', closeSettings);
$('useGateway').addEventListener('change', () => {
  $('gatewayFields').hidden = !$('useGateway').checked;
  if ($('useGateway').checked) $('baseUrl').focus();
});
$('refreshModels').addEventListener('click', refreshModels);
$('modelSelect').addEventListener('change', () => {
  const custom = $('modelSelect').value === CUSTOM_MODEL;
  $('model').hidden = !custom;
  if (custom) $('model').focus();
});
for (const box of document.querySelectorAll('[data-tool]')) box.addEventListener('change', renderToolsCount);

// ---- Header, welcome, composer ----

$('modeSwitch').addEventListener('click', () => {
  if (settings.usage) showWelcome($('welcome').hidden); // before the first choice there is nothing to go back to
});
$('cancelWelcome').addEventListener('click', () => showWelcome(false));
for (const choice of document.querySelectorAll('.choice')) {
  choice.addEventListener('click', () => chooseUsage(choice.dataset.usage));
}
$('newChat').addEventListener('click', () => {
  resetChat();
  clearLog();
  attachments.clear();
  renderAttachments();
});
$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('prompt').value.trim();
  if (text && !controller) submitTask(text);
});
$('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});
$('stop').addEventListener('click', stopChat);
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = button.previousElementSibling.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Đã chép';
    } catch {
      button.textContent = 'Không chép được';
    }
    setTimeout(() => { button.textContent = 'Sao chép'; }, 1500);
  });
}

// ---- Attachments (file_upload) ----

function renderAttachments() {
  const enabled = Boolean(settings.tools?.file_upload);
  $('attach').hidden = !enabled;
  $('attachCode').hidden = !enabled;
  const box = $('attachments');
  box.replaceChildren();
  box.hidden = !enabled || !attachments.size;
  for (const [id, file] of attachments) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `${id}: ${file.name}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost';
    remove.title = 'Bỏ tệp này';
    remove.textContent = '×';
    remove.addEventListener('click', () => { attachments.delete(id); renderAttachments(); });
    chip.append(remove);
    box.append(chip);
  }
  for (const session of sessions.values()) session.client.sendStatus();
}

$('attach').addEventListener('click', () => $('files').click());
$('attachCode').addEventListener('click', () => $('files').click());
$('files').addEventListener('change', () => {
  let total = [...attachments.values()].reduce((sum, file) => sum + file.size, 0);
  for (const file of $('files').files) {
    if (total + file.size > MAX_ATTACH_BYTES) {
      append('error', `Bỏ qua ${file.name}: tổng dung lượng tệp đính kèm vượt 25 MB.`);
      continue;
    }
    total += file.size;
    attachments.set(`doc-${++nextDocument}`, file);
  }
  $('files').value = '';
  renderAttachments();
});

// ---- Start ----

(async () => {
  const stored = await chrome.storage.local.get(['settings', 'modelCache']);
  settings = migrate(stored.settings);
  if (stored.modelCache?.base === apiBase(settings.baseUrl)) modelList = stored.modelCache.models || [];
  fillSettings();
  applyUsage();
  showHint();
  if (!settings.usage) showWelcome(true);
  else if (settings.usage === 'chat' && !settings.apiKey) openSettings();
})();
