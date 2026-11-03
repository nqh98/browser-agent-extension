import { runTask, listModels, apiBase } from './agent.js';
import { BrowserExecutor } from './browser.js';
import { BridgeClient } from './bridge-client.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = { baseUrl: '', authType: 'x-api-key', apiKey: '', model: 'claude-sonnet-5-5', mode: 'ask', approvedHosts: [], tools: {}, bridge: { enabled: false, port: 18765, token: '' } };
const REMOTE_IDLE_MS = 3 * 60 * 1000;
const MAX_ATTACH_BYTES = 25 * 1024 * 1024;

let settings = { ...DEFAULTS };
let messages = [];
let controller = null;
let executor = null;
const totals = { input: 0, output: 0 };
const pendingConfirms = new Set();
const attachments = new Map(); // document_id -> File
let nextDocument = 0;
const CUSTOM_MODEL = '__custom__';
let modelLoad = null;

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

function formConnection() {
  return { baseUrl: $('baseUrl').value.trim(), authType: $('authType').value, apiKey: $('apiKey').value.trim() };
}

/** Fetches the models the key or gateway allows and caches them per base URL. */
async function refreshModels() {
  const connection = formConnection();
  if (!connection.apiKey) {
    $('modelStatus').textContent = 'Nhập API key để tải danh sách model.';
    return;
  }
  modelLoad?.abort();
  const load = new AbortController();
  modelLoad = load;
  const current = chosenModel();
  $('refreshModels').disabled = true;
  $('modelStatus').textContent = 'Đang tải danh sách model…';
  try {
    const models = await listModels(connection, load.signal);
    if (load.signal.aborted) return;
    renderModels(models, current);
    $('modelStatus').textContent = models.length
      ? `${models.length} model được phép tại ${apiBase(connection.baseUrl)}.`
      : 'Gateway không trả về model nào. Hãy nhập tên model thủ công.';
    if (models.length && current && !models.some((model) => model.id === current)) {
      $('modelStatus').textContent += ` "${current}" không có trong danh sách.`;
    }
    await chrome.storage.local.set({ modelCache: { base: apiBase(connection.baseUrl), models } });
  } catch (error) {
    if (load.signal.aborted) return;
    $('modelStatus').textContent = `Không tải được danh sách model: ${error.message || error}`;
  } finally {
    if (modelLoad === load) {
      modelLoad = null;
      $('refreshModels').disabled = false;
    }
  }
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

function askUser({ title, detail, kind, sensitive }) {
  return new Promise((resolve) => {
    const card = document.createElement('div');
    card.className = `card${sensitive ? ' sensitive' : ''}`;
    const heading = document.createElement('strong');
    heading.textContent = title;
    const body = document.createElement('div');
    body.className = 'detail';
    body.textContent = detail;
    const buttons = document.createElement('div');
    buttons.className = 'buttons';

    const entry = {};
    const finish = (answer) => {
      pendingConfirms.delete(entry);
      card.remove();
      resolve(answer);
    };
    entry.cancel = () => finish('deny');
    pendingConfirms.add(entry);

    const options = kind === 'site'
      ? [['allow', 'Cho phép đến khi tạo chat mới'], ['always', 'Luôn cho phép'], ['deny', 'Từ chối']]
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
    $('log').append(card);
    card.scrollIntoView({ block: 'end' });
  });
}

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

function setRunning(running) {
  $('send').hidden = running;
  $('stop').hidden = !running;
  $('prompt').disabled = running;
  if (!running) $('prompt').focus();
}

function stopTask({ byUser = true } = {}) {
  controller?.abort();
  for (const session of sessions.values()) {
    if (!session.controller) continue;
    session.controller.abort();
    session.stopped = byUser;
    endSession(session);
  }
  for (const entry of [...pendingConfirms]) entry.cancel();
}

function ensureExecutor() {
  executor ??= new BrowserExecutor({
    confirm: askUser,
    settings,
    persistHost,
    onDetachedByUser: () => {
      append('error', 'Bạn đã tắt quyền điều khiển tab, tác vụ đã dừng.');
      stopTask();
    },
  });
  executor.settings = settings;
  executor.documents = attachments;
  return executor;
}

// ---- Claude Code bridge: each terminal session drives its own executor through ----
// ---- its own local MCP server, one port per session in a small range.           ----

const BRIDGE_PORTS = 10;
const sessions = new Map(); // port -> { port, client, state, detail, label, executor, controller, idle, stopped }
const remoteError = (text) => ({ type: 'tool_result', toolset_name: 'browser', is_error: true, content: `Error: ${text}` });
const remoteBusy = () => [...sessions.values()].some((session) => session.controller);

async function endSession(session) {
  clearTimeout(session.idle);
  if (!session.controller) return;
  session.controller = null;
  if (!controller && !remoteBusy()) setRunning(false);
  await session.executor?.endTask();
}

async function dropSessionExecutor(session) {
  await endSession(session);
  session.executor?.dispose();
  session.executor = null;
}

function sessionExecutor(session) {
  session.executor ??= new BrowserExecutor({
    confirm: (request) => askUser({ ...request, title: `[${session.label}] ${request.title}` }),
    settings,
    persistHost,
    ownWindow: true,
    onDetachedByUser: () => {
      append('error', `Bạn đã tắt quyền điều khiển tab, phiên ${session.label} đã dừng.`);
      session.stopped = true;
      session.controller?.abort();
      endSession(session);
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
  if (controller) return remoteError('The user is running a task from the side panel. Wait for it to finish, then try again.');
  if (session.stopped) {
    session.stopped = false;
    return remoteError('The user pressed Stop in the side panel. Ask the user before continuing.');
  }
  const exec = sessionExecutor(session);
  if (!session.controller) {
    session.controller = new AbortController();
    setRunning(true);
    await exec.beginTask(session.controller.signal);
    // Two sessions must not share a tab: leave the user's tab to the session already on it.
    if (exec.activeTab !== null && ownedElsewhere(session, exec.activeTab)) {
      exec.managed.delete(exec.activeTab);
      exec.activeTab = [...exec.managed].at(-1) ?? null;
    }
  }
  clearTimeout(session.idle);
  logAction(name, input, 'action remote', `Claude Code (${session.label})`);
  let result = await exec.run({ id: 'bridge', name, input });
  if (result.is_error && /No tab is open/.test(String(result.content))) {
    result = remoteError('This session has no tab yet, and the active tab belongs to another Claude Code session. Call new_tab to open a tab of your own.');
  }
  if (result.is_error) append('error', `[${session.label}] ${String(result.content)}`);
  // Detach (and drop Chrome's debugging bar) once this session goes quiet.
  if (session.controller) session.idle = setTimeout(() => endSession(session), REMOTE_IDLE_MS);
  return result;
}

function showBridge() {
  const list = [...sessions.values()];
  const connected = list.filter((session) => session.state === 'connected');
  const errors = [...new Set(list.filter((session) => session.state === 'error').map((session) => session.detail))];
  const base = settings.bridge.port;
  const lines = [];
  if (connected.length) lines.push(`Đã kết nối: ${connected.map((session) => `${session.label} (cổng ${session.port})`).join(', ')}.`);
  else if (list.length) lines.push(`Đang chờ Claude Code ở cổng ${base}–${base + BRIDGE_PORTS - 1}…`);
  lines.push(...errors);
  $('bridgeStatus').textContent = lines.join(' ');
  const badge = $('bridgeBadge');
  badge.hidden = !list.length;
  badge.textContent = connected.length > 1 ? `Claude Code ×${connected.length}` : connected.length ? 'Claude Code' : 'Claude Code ✕';
  badge.title = $('bridgeStatus').textContent;
  badge.classList.toggle('on', connected.length > 0);
}

/** Keeps one client per port in the range while the bridge is enabled. */
function configureBridges() {
  const { enabled, port, token } = settings.bridge;
  const wanted = new Set(enabled ? Array.from({ length: BRIDGE_PORTS }, (_, i) => port + i) : []);
  for (const [sessionPort, session] of sessions) {
    if (wanted.has(sessionPort)) continue;
    session.client.configure({ enabled: false });
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
            dropSessionExecutor(session);
          }
          showBridge();
        },
        hello: () => ({ mode: settings.mode, tools: settings.tools }),
      });
      sessions.set(sessionPort, session);
    }
    session.client.configure({ enabled: true, port: sessionPort, token });
    session.client.sendStatus();
  }
  showBridge();
}

function logAction(name, input, className = 'action', session = '') {
  const node = append(className, describeAction(name, input));
  if (session) node.dataset.session = session;
  if (name === 'javascript_exec') {
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = String(input.text ?? '').slice(0, 4000);
    node.append(code);
  }
}

async function submitTask(text) {
  if (!settings.apiKey) {
    $('settings').hidden = false;
    $('apiKey').focus();
    append('error', 'Hãy nhập API key trong Cài đặt trước.');
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

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('prompt').value.trim();
  if (text && !controller && !remoteBusy()) submitTask(text);
});
$('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});
$('stop').addEventListener('click', () => stopTask());
$('toggleSettings').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });
$('newChat').addEventListener('click', () => {
  stopTask({ byUser: false });
  messages = [];
  totals.input = 0;
  totals.output = 0;
  $('usage').textContent = '';
  $('log').replaceChildren();
  executor?.dispose();
  executor = null;
  for (const session of sessions.values()) dropSessionExecutor(session);
  attachments.clear();
  renderAttachments();
});
$('settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const before = `${apiBase(settings.baseUrl)}|${settings.authType}|${settings.apiKey}`;
  Object.assign(settings, formConnection());
  settings.model = chosenModel() || DEFAULTS.model;
  settings.mode = $('mode').value;
  settings.approvedHosts = $('hosts').value.split('\n').map((line) => line.trim()).filter(Boolean);
  settings.tools = Object.fromEntries([...document.querySelectorAll('[data-tool]')].map((box) => [box.dataset.tool, box.checked]));
  settings.bridge = {
    enabled: $('bridgeEnabled').checked,
    port: Number($('bridgePort').value) || DEFAULTS.bridge.port,
    token: $('bridgeToken').value.trim(),
  };
  renderAttachments();
  await saveSettings();
  configureBridges();
  // Drop session approvals so a site removed from the list really loses access.
  if (!controller && !remoteBusy()) {
    executor?.dispose();
    executor = null;
    for (const session of sessions.values()) dropSessionExecutor(session);
  }
  $('settings').hidden = true;
  if (settings.apiKey && before !== `${apiBase(settings.baseUrl)}|${settings.authType}|${settings.apiKey}`) refreshModels();
});
$('refreshModels').addEventListener('click', refreshModels);
$('modelSelect').addEventListener('change', () => {
  const custom = $('modelSelect').value === CUSTOM_MODEL;
  $('model').hidden = !custom;
  if (custom) $('model').focus();
});

(async () => {
  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULTS, ...stored.settings };
  $('baseUrl').value = settings.baseUrl;
  $('authType').value = settings.authType;
  $('apiKey').value = settings.apiKey;
  const { modelCache } = await chrome.storage.local.get('modelCache');
  renderModels(modelCache?.base === apiBase(settings.baseUrl) ? modelCache.models : [], settings.model);
  $('mode').value = settings.mode;
  $('hosts').value = settings.approvedHosts.join('\n');
  settings.tools = { ...settings.tools };
  for (const box of document.querySelectorAll('[data-tool]')) box.checked = Boolean(settings.tools[box.dataset.tool]);
  settings.bridge = { ...DEFAULTS.bridge, ...settings.bridge };
  $('bridgeEnabled').checked = settings.bridge.enabled;
  $('bridgePort').value = settings.bridge.port;
  $('bridgeToken').value = settings.bridge.token;
  renderAttachments();
  configureBridges();
  if (!settings.apiKey && !settings.bridge.enabled) $('settings').hidden = false;
})();

function renderAttachments() {
  const enabled = Boolean(settings.tools?.file_upload);
  $('attach').hidden = !enabled;
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
}

$('attach').addEventListener('click', () => $('files').click());
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
