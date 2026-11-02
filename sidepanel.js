import { runTask } from './agent.js';
import { BrowserExecutor } from './browser.js';

const $ = (id) => document.getElementById(id);
const DEFAULTS = { apiKey: '', model: 'claude-sonnet-5-5', mode: 'ask', approvedHosts: [], tools: {} };
const MAX_ATTACH_BYTES = 25 * 1024 * 1024;

let settings = { ...DEFAULTS };
let messages = [];
let controller = null;
let executor = null;
const totals = { input: 0, output: 0 };
const pendingConfirms = new Set();
const attachments = new Map(); // document_id -> File
let nextDocument = 0;

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

function stopTask() {
  controller?.abort();
  for (const entry of [...pendingConfirms]) entry.cancel();
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
        onAction: (name, input) => {
          const node = append('action', describeAction(name, input));
          if (name === 'javascript_exec') {
            const code = document.createElement('span');
            code.className = 'code';
            code.textContent = String(input.text ?? '').slice(0, 4000);
            node.append(code);
          }
        },
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
  if (text && !controller) submitTask(text);
});
$('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});
$('stop').addEventListener('click', stopTask);
$('toggleSettings').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });
$('newChat').addEventListener('click', () => {
  stopTask();
  messages = [];
  totals.input = 0;
  totals.output = 0;
  $('usage').textContent = '';
  $('log').replaceChildren();
  executor?.dispose();
  executor = null;
  attachments.clear();
  renderAttachments();
});
$('settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  settings.apiKey = $('apiKey').value.trim();
  settings.model = $('model').value.trim() || DEFAULTS.model;
  settings.mode = $('mode').value;
  settings.approvedHosts = $('hosts').value.split('\n').map((line) => line.trim()).filter(Boolean);
  settings.tools = Object.fromEntries([...document.querySelectorAll('[data-tool]')].map((box) => [box.dataset.tool, box.checked]));
  renderAttachments();
  await saveSettings();
  // Drop session approvals so a site removed from the list really loses access.
  if (!controller) {
    executor?.dispose();
    executor = null;
  }
  $('settings').hidden = true;
});

(async () => {
  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULTS, ...stored.settings };
  $('apiKey').value = settings.apiKey;
  $('model').value = settings.model;
  $('mode').value = settings.mode;
  $('hosts').value = settings.approvedHosts.join('\n');
  settings.tools = { ...settings.tools };
  for (const box of document.querySelectorAll('[data-tool]')) box.checked = Boolean(settings.tools[box.dataset.tool]);
  renderAttachments();
  if (!settings.apiKey) $('settings').hidden = false;
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
