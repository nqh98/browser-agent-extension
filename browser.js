// Executor for the Claude API browser toolset (browser_toolset_20260801).
import { modifierMask, parseKeySequence } from './keys.js';
import { ActivityLog, redactUrl } from './capture.js';
import { t } from './i18n.js';

const MAX_IMAGE_EDGE = 1456;
const MAX_TEXT = 50000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const OPTIONAL_MEMBERS = ['javascript_exec', 'file_upload', 'read_console', 'read_network'];
const FRAME_LINE = /^\u0001frame:(\d+):(\d+)$/;
const TAB_MEMBERS = new Set(['new_tab', 'list_tabs', 'switch_tab', 'close_tab']);
const WRITE_MEMBERS = new Set([
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag',
  'left_mouse_down', 'left_mouse_up', 'type', 'key', 'hold_key', 'form_input', 'close_tab',
  'javascript_exec', 'file_upload',
]);
const CLICK_COUNTS = {
  left_click: ['left', 1], right_click: ['right', 1], middle_click: ['middle', 1],
  double_click: ['left', 2], triple_click: ['left', 3],
};
const BUTTON_MASK = { left: 1, right: 2, middle: 4 };
const FORBIDDEN_SCHEME = /^(javascript|data|file|chrome|chrome-extension|about|blob|view-source|vbscript|mailto|ftp|devtools):/i;
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

// Best-effort only: catches common consequential actions in English and Vietnamese.
const SENSITIVE = /\b(buy|purchase|pay|payment|checkout|place order|order now|delete|remove|send|submit|publish|post|transfer|confirm|sign up|subscribe|unsubscribe|accept|agree|install|authorize|grant)\b|mua|thanh toán|đặt hàng|xoá|xóa|gửi|đăng bài|đăng ký|chuyển khoản|chuyển tiền|xác nhận|đồng ý|hủy|huỷ|cấp quyền/i;

// Best-effort only: code that can send data off the page, change the page's state, or read storage.
const RISKY_JS = /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|postMessage|cookie|localStorage|sessionStorage|indexedDB|caches|submit|click|dispatchEvent|location|open|eval|Function|import|navigator\.credentials|innerHTML|outerHTML|insertAdjacentHTML|document\.write|setAttribute|remove)\b|\.value\s*=(?!=)/;

const sanitize = (value, max) => String(value || '').replace(UNSAFE_CHARS, ' ').slice(0, max);
const pad = (n) => '  '.repeat(n);

function capText(text, note = '') {
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}\n[Output truncated at ${MAX_TEXT} characters.${note}]`;
}

class FrameGoneError extends Error {}

export function hostOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : null;
  } catch {
    return null;
  }
}

export function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Navigation refused. The URL is empty.');
  if (FORBIDDEN_SCHEME.test(raw)) throw new Error('Navigation refused. Only http and https URLs are allowed.');
  let parsed;
  try {
    parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Navigation refused. "${raw.slice(0, 200)}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Navigation refused. Only http and https URLs are allowed.');
  }
  return parsed.href;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class BrowserExecutor {
  /**
   * @param confirm async ({kind, title, detail, sensitive}) => 'allow' | 'always' | 'allow_all' | 'deny'
   * @param settings object with mode ('ask' | 'auto') and approvedHosts (array)
   * @param persistHost async (host) => void, saves an "always allow" site
   * @param ownWindow new_tab opens this executor's tabs in a window of its own, so
   *   several executors running at once do not take turns on one window's active tab
   */
  constructor({ confirm, settings, persistHost, onDetachedByUser, ownWindow = false }) {
    this.confirm = confirm;
    this.ownWindow = ownWindow;
    this.settings = settings;
    this.persistHost = persistHost;
    this.onDetachedByUser = onDetachedByUser;
    this.managed = new Set();
    this.activeTab = null;
    this.attached = new Set();
    this.views = new Map();
    this.pendingOpened = new Set();
    this.approved = new Set(settings.approvedHosts || []);
    this.autoRest = false;
    this.signal = null;
    this.running = false;
    this.documents = new Map(); // document_id -> File, attached by the user for file_upload
    this.refMaps = new Map(); // tabId -> { next, byGlobal, byLocal }
    this.deniedFrameHosts = new Set();
    this.activity = new ActivityLog();
    this.capturing = new Set();
    this.downloads = new Set();
    this.pendingChanges = [];

    this.handleCreated = (tab) => {
      if (tab.openerTabId === undefined || !this.managed.has(tab.openerTabId)) return;
      const url = tab.pendingUrl || tab.url || '';
      if (url.startsWith('chrome://')) return;
      this.managed.add(tab.id);
      this.pendingOpened.add(tab.id);
      if (tab.active) this.activeTab = tab.id;
    };
    this.handleRemoved = (tabId) => {
      this.managed.delete(tabId);
      this.refMaps.delete(tabId);
      this.capturing.delete(tabId);
      this.activity.forget(tabId);
      this.attached.delete(tabId);
      this.views.delete(tabId);
      this.pendingOpened.delete(tabId);
      if (this.activeTab === tabId) this.activeTab = [...this.managed].at(-1) ?? null;
    };
    this.handleDetach = (source, reason) => {
      // Other executors attach to other tabs; only react to our own.
      if (!this.attached.delete(source.tabId)) return;
      this.capturing.delete(source.tabId);
      if (reason === 'canceled_by_user') this.onDetachedByUser?.();
    };
    this.handleEvent = (source, method, params) => {
      if (this.capturing.has(source.tabId)) this.activity.handle(source.tabId, method, params);
    };
    // Downloads carry no tab id, so every download that starts while a task runs is reported.
    this.handleDownloadCreated = (item) => {
      if (!this.running) return;
      this.downloads.add(item.id);
      this.pendingChanges.push({ type: 'download_started', download_id: `dl-${item.id}`, url: this.safeDownloadUrl(item.finalUrl || item.url) });
    };
    this.handleDownloadChanged = async (delta) => {
      if (!this.downloads.has(delta.id)) return;
      const state = delta.state?.current;
      if (state !== 'complete' && state !== 'interrupted') return;
      this.downloads.delete(delta.id);
      const [item] = await chrome.downloads.search({ id: delta.id }).catch(() => []);
      const url = this.safeDownloadUrl(item?.finalUrl || item?.url || '');
      if (state === 'complete') {
        const size = item?.fileSize >= 0 ? item.fileSize : item?.totalBytes;
        this.pendingChanges.push({
          type: 'download_completed', download_id: `dl-${delta.id}`, url,
          ...(Number.isInteger(size) && size >= 0 ? { size_bytes: size } : {}),
        });
      } else {
        const error = delta.error?.current || item?.error;
        this.pendingChanges.push({ type: 'download_failed', download_id: `dl-${delta.id}`, url, ...(error ? { error: sanitize(error, 200) } : {}) });
      }
    };
    chrome.tabs.onCreated.addListener(this.handleCreated);
    chrome.tabs.onRemoved.addListener(this.handleRemoved);
    chrome.debugger.onDetach.addListener(this.handleDetach);
    chrome.debugger.onEvent.addListener(this.handleEvent);
    chrome.downloads?.onCreated.addListener(this.handleDownloadCreated);
    chrome.downloads?.onChanged.addListener(this.handleDownloadChanged);
  }

  enabled(member) {
    return Boolean(this.settings.tools?.[member]);
  }

  safeDownloadUrl(url) {
    // Download URLs often carry signed credentials in the query string.
    try {
      const parsed = new URL(url);
      parsed.search = '';
      parsed.hash = '';
      parsed.username = '';
      parsed.password = '';
      return sanitize(parsed.href, 4096) || 'unknown';
    } catch {
      return sanitize(url, 4096) || 'unknown';
    }
  }

  async beginTask(signal) {
    this.signal = signal;
    this.running = true;
    this.autoRest = false;
    this.approved = new Set([...this.approved, ...(this.settings.approvedHosts || [])]);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      this.managed.add(tab.id);
      this.activeTab = tab.id;
    }
  }

  async endTask() {
    this.running = false;
    this.capturing.clear();
    await Promise.all([...this.attached].map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {})));
    this.attached.clear();
  }

  dispose() {
    chrome.tabs.onCreated.removeListener(this.handleCreated);
    chrome.tabs.onRemoved.removeListener(this.handleRemoved);
    chrome.debugger.onDetach.removeListener(this.handleDetach);
    chrome.debugger.onEvent.removeListener(this.handleEvent);
    chrome.downloads?.onCreated.removeListener(this.handleDownloadCreated);
    chrome.downloads?.onChanged.removeListener(this.handleDownloadChanged);
  }

  // ---- Result protocol ----

  /** Runs one member call and returns a complete tool_result block. */
  async run(block) {
    const result = { type: 'tool_result', tool_use_id: block.id, toolset_name: 'browser' };
    try {
      result.content = await this.dispatch(block.name, block.input || {});
    } catch (error) {
      result.content = `Error: ${error.message || error}`;
      result.is_error = true;
    }
    return result;
  }

  async browserState() {
    const tabs = [];
    for (const id of [...this.managed]) {
      try {
        const tab = await chrome.tabs.get(id);
        tabs.push({
          tab_id: `tab-${id}`,
          title: sanitize(tab.title, 300),
          url: this.safeTabUrl(tab.pendingUrl || tab.url),
          ...(id === this.activeTab ? { active: true } : {}),
        });
      } catch {
        this.managed.delete(id);
      }
    }
    if (tabs.length && !tabs.some((tab) => tab.active)) {
      tabs[tabs.length - 1].active = true;
      this.activeTab = Number(tabs[tabs.length - 1].tab_id.slice(4));
    }
    return { type: 'browser_state', tabs };
  }

  safeTabUrl(url) {
    try {
      const parsed = new URL(url);
      parsed.username = '';
      parsed.password = '';
      return sanitize(parsed.href, 2000);
    } catch {
      return sanitize(url, 2000) || 'about:blank';
    }
  }

  /** Adds tabs opened and download events since the last successful result. */
  addChanges(state, opened = [...this.pendingOpened]) {
    if (!state.tabs.length) return state; // keep events for a result that can carry them
    const open = new Set(state.tabs.map((tab) => tab.tab_id));
    const changes = opened.map((id) => `tab-${id}`).filter((id) => open.has(id))
      .map((tab_id) => ({ type: 'tab_opened', tab_id }));
    this.pendingOpened.clear();
    // At most one entry per download: the latest event wins.
    const latest = new Map();
    for (const change of this.pendingChanges) latest.set(change.download_id, change);
    this.pendingChanges = [];
    changes.push(...latest.values());
    if (changes.length) state.state_changes = changes.slice(0, 200);
    return state;
  }

  /** Text results carry the tab inventory plus any tabs opened during the call. */
  async withState(content) {
    const state = this.addChanges(await this.browserState());
    if (state.tabs.length) content.push(state);
    return content;
  }

  // ---- Dispatch ----

  async dispatch(name, input) {
    if (this.signal?.aborted) throw new Error('Stopped by the user.');
    if (OPTIONAL_MEMBERS.includes(name) && !this.enabled(name)) throw new Error(`${name} is not enabled in this environment.`);
    if (TAB_MEMBERS.has(name)) return this.tabMember(name, input);

    const tabId = this.resolveTab(input.tab_id);
    switch (name) {
      case 'navigate': return this.navigate(tabId, input.url);
      case 'wait':
        await this.sleep(Math.min(Math.max(Number(input.duration) || 0, 0), 30) * 1000);
        return this.withState([{ type: 'text', text: `Waited ${input.duration} seconds.` }]);
      default:
    }

    await this.requireHost(tabId);
    if (this.enabled('read_console') || this.enabled('read_network')) await this.startCapture(tabId);
    await this.gate(name, input, tabId);

    switch (name) {
      case 'screenshot': {
        const image = await this.capture(tabId);
        return this.withState([{ type: 'text', text: 'Screenshot captured.' }, image]);
      }
      case 'zoom': {
        const image = await this.capture(tabId, input.region);
        return this.pendingChanges.length ? this.withState([image]) : [image];
      }
      case 'read_page': return this.textResult(await this.readPage(tabId, input));
      case 'find': return this.textResult(await this.find(tabId, String(input.query ?? '')));
      case 'get_page_text': return this.textResult(await this.pageText(tabId));
      case 'form_input':
        this.requireRef(input.target);
        return this.textResult(await this.refCall(tabId, input.target.ref, 'formInput', [input.value]));
      case 'scroll_to':
        this.requireRef(input.target);
        await this.locateRef(tabId, input.target.ref);
        return this.textResult(`Scrolled ${input.target.ref} into view.`);
      case 'file_upload': return this.textResult(await this.uploadFiles(tabId, input));
      case 'javascript_exec': return this.textResult(await this.runJavaScript(tabId, input.text));
      case 'read_console': return this.textResult(this.activity.readConsole(tabId));
      case 'read_network': return this.textResult(this.activity.readNetwork(tabId));
      case 'type':
        await this.cdp(tabId, 'Input.insertText', { text: String(input.text ?? '') });
        return this.textResult(`Typed ${String(input.text ?? '').length} characters.`);
      case 'key': return this.pressKeys(tabId, input);
      case 'hold_key': return this.holdKey(tabId, input);
      case 'hover':
      case 'mouse_move': {
        const point = await this.point(tabId, input.target);
        await this.mouse(tabId, 'mouseMoved', point);
        return this.textResult(`Moved pointer to ${this.targetLabel(input.target)}.`);
      }
      case 'left_mouse_down':
      case 'left_mouse_up': {
        const point = await this.point(tabId, input.target);
        const down = name === 'left_mouse_down';
        await this.mouse(tabId, down ? 'mousePressed' : 'mouseReleased', point, { button: 'left', clickCount: 1, buttons: down ? 1 : 0 });
        return this.textResult(`Left button ${down ? 'pressed' : 'released'}.`);
      }
      case 'left_click_drag': {
        const from = await this.point(tabId, input.from);
        const to = await this.point(tabId, input.target);
        await this.mouse(tabId, 'mouseMoved', from);
        await this.mouse(tabId, 'mousePressed', from, { button: 'left', clickCount: 1, buttons: 1 });
        await this.mouse(tabId, 'mouseMoved', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, { button: 'left', buttons: 1 });
        await this.mouse(tabId, 'mouseMoved', to, { button: 'left', buttons: 1 });
        await this.mouse(tabId, 'mouseReleased', to, { button: 'left', clickCount: 1 });
        return this.textResult('Drag completed.');
      }
      case 'scroll': return this.scroll(tabId, input);
      default:
    }
    if (CLICK_COUNTS[name]) return this.click(tabId, name, input);
    throw new Error(`${name} is not enabled in this environment.`);
  }

  textResult(text) {
    return this.withState([{ type: 'text', text: String(text) }]);
  }

  resolveTab(tabRef) {
    if (tabRef === undefined || tabRef === null) {
      if (this.activeTab === null) throw new Error('No tab is open. Call new_tab first.');
      return this.activeTab;
    }
    const match = /^tab-(\d+)$/.exec(String(tabRef));
    const id = match ? Number(match[1]) : NaN;
    if (!this.managed.has(id)) throw new Error('Unknown tab_id. Call list_tabs to see available tabs.');
    return id;
  }

  async tabMember(name, input) {
    if (name === 'new_tab') {
      const created = this.ownWindow ? await this.createInOwnWindow() : await chrome.tabs.create({ active: true, url: 'about:blank' });
      this.managed.add(created.id);
      this.activeTab = created.id;
      this.pendingOpened.delete(created.id);
      return [this.addChanges(await this.browserState(), [created.id])];
    }
    if (name === 'switch_tab') {
      const id = this.resolveTab(input.tab_id);
      await chrome.tabs.update(id, { active: true });
      this.activeTab = id;
    } else if (name === 'close_tab') {
      const id = this.resolveTab(input.tab_id);
      await this.gate(name, input, id);
      await chrome.tabs.remove(id);
      this.handleRemoved(id);
    }
    return [this.addChanges(await this.browserState())];
  }

  async createInOwnWindow() {
    for (const id of this.managed) {
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (tab && this.ownWindowId === tab.windowId) return chrome.tabs.create({ windowId: tab.windowId, active: true, url: 'about:blank' });
    }
    const window = await chrome.windows.create({ url: 'about:blank', focused: true });
    this.ownWindowId = window.id;
    return window.tabs[0];
  }

  // ---- Approvals ----

  async approveHost(host) {
    if (this.approved.has(host)) return;
    const answer = await this.confirm({
      kind: 'site',
      title: t('prompt.site.title', { host }),
      detail: t('prompt.site.detail'),
    });
    if (answer === 'deny') throw new Error(`The user did not allow access to ${host}. Do not retry this site unless the user asks.`);
    this.approved.add(host);
    if (answer === 'always') await this.persistHost?.(host);
  }

  async requireHost(tabId) {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.pendingUrl || tab.url;
    const host = hostOf(url);
    if (!host) throw new Error(`This action is unavailable on ${sanitize(url, 100) || 'this page'}. Navigate to an http or https page first.`);
    await this.approveHost(host);
  }

  async gate(name, input, tabId) {
    if (!WRITE_MEMBERS.has(name)) return;
    const info = await this.describeAction(name, input, tabId).catch(() => ({ label: t('target.unknown') }));
    const haystack = `${info.label} ${info.submitLabel || ''}`;
    const isEnter = name === 'key' && /\benter\b|\breturn\b/i.test(String(input.text));
    const sensitive = Boolean(
      info.secret
      || info.foreignFrame
      || name === 'close_tab'
      || name === 'file_upload'
      || (name === 'javascript_exec' && RISKY_JS.test(String(input.text)))
      || (!['type', 'key', 'javascript_exec'].includes(name) && SENSITIVE.test(info.label))
      || (isEnter && info.inForm && SENSITIVE.test(haystack)),
    );
    if (!sensitive && (this.settings.mode === 'auto' || this.autoRest)) return;
    const answer = await this.confirm({
      kind: 'action',
      sensitive,
      title: t(sensitive ? 'prompt.sensitive' : 'prompt.action'),
      detail: this.describeForUser(name, input, info),
    });
    if (answer === 'deny') throw new Error('The user declined this action. Ask the user how to proceed rather than retrying.');
    if (answer === 'allow_all' && !sensitive) this.autoRest = true;
  }

  async describeAction(name, input, tabId) {
    if (name === 'close_tab') return { label: `tab ${input.tab_id}` };
    if (name === 'javascript_exec') return { label: 'JavaScript' };
    if (name === 'type' || name === 'key' || name === 'hold_key') return this.describeIn(tabId, 'describeFocus', () => []);
    const target = input.target;
    if (target?.type === 'ref') return this.refCall(tabId, target.ref, 'describeRef');
    const point = await this.point(tabId, target);
    return this.describeIn(tabId, 'describePoint', (info) => (info ? [info.x, info.y] : [point.x, point.y]));
  }

  /** Follows a describePoint/describeFocus answer down into child frames. */
  async describeIn(tabId, method, argsFor) {
    let info = await this.page(tabId, method, argsFor(null));
    if (!(info.frame >= 0)) return info;
    const tree = await this.frameTree(tabId);
    let frame = tree.top;
    while (info.frame >= 0) {
      const child = tree.childOf(frame, info.frame);
      if (!child) return info;
      if (!(await this.frameAllowed(child, tree, false))) {
        return { label: t('target.frame', { host: hostOf(child.url) || t('target.otherSite') }), secret: false, foreignFrame: true };
      }
      frame = child;
      info = await this.page(tabId, method, argsFor(info), frame);
    }
    return info;
  }

  describeForUser(name, input, info) {
    if (name === 'type') {
      return t('confirm.type', { label: info.label, text: info.secret ? t('hidden') : `"${String(input.text).slice(0, 200)}"` });
    }
    if (name === 'key' || name === 'hold_key') return t('confirm.key', { keys: input.text, label: info.label });
    if (name === 'form_input') return t('confirm.form', { label: info.label, value: info.secret ? t('hidden') : `"${String(input.value).slice(0, 200)}"` });
    if (name === 'close_tab') return t('confirm.close', { label: info.label });
    if (name === 'javascript_exec') return t('confirm.js', { code: String(input.text).slice(0, 1500) });
    if (name === 'file_upload') {
      const names = (input.document_ids || []).map((id) => this.documents.get(String(id))?.name || id);
      return t('confirm.upload', { files: names.join(', ') || t('confirm.noFiles'), label: info.label });
    }
    return t('confirm.other', { name, label: info.label });
  }

  // ---- Chrome plumbing ----

  sleep(ms) {
    return new Promise((resolve, reject) => {
      if (this.signal?.aborted) return reject(new Error('Stopped by the user.'));
      const onAbort = () => { clearTimeout(timer); reject(new Error('Stopped by the user.')); };
      const timer = setTimeout(() => { this.signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      this.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async attach(tabId) {
    if (this.attached.has(tabId)) return;
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (error) {
      if (!/already attached/i.test(error.message)) throw new Error(`Could not control this tab: ${error.message}`);
      throw new Error('Another debugger is attached to this tab. Ask the user to close DevTools for it.');
    }
    this.attached.add(tabId);
    // Let Chrome's debugging infobar appear and the viewport settle before measuring.
    await this.sleep(300);
  }

  async cdp(tabId, method, params = {}) {
    await this.attach(tabId);
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }

  /** Calls a page-agent method in one frame (the top frame by default). */
  async page(tabId, method, args, frame) {
    const target = frame?.documentId ? { tabId, documentIds: [frame.documentId] } : { tabId, frameIds: [frame?.frameId ?? 0] };
    let result;
    try {
      await chrome.scripting.executeScript({ target, files: ['page-agent.js'] });
      [result] = await chrome.scripting.executeScript({
        target,
        args: [method, args],
        func: (m, a) => {
          try {
            return { value: globalThis.__browserAgent[m](...a) };
          } catch (error) {
            return { error: error.message };
          }
        },
      });
    } catch (error) {
      if (frame?.documentId) throw new FrameGoneError('The frame has navigated or closed.');
      throw error;
    }
    if (!result?.result) throw new Error('The page did not respond.');
    if (result.result.error) throw new Error(result.result.error);
    return result.result.value;
  }

  // ---- Frames and references ----

  /**
   * Lists the tab's frames with their parent and their index among the parent's <iframe>
   * elements. Chrome cannot map an element to a frameId directly, so each frame posts a
   * random token to its child windows and each child reports the token it received.
   */
  async frameTree(tabId) {
    const all = { tabId, allFrames: true };
    await chrome.scripting.executeScript({ target: all, files: ['page-agent.js'] });
    const probes = await chrome.scripting.executeScript({ target: all, func: () => globalThis.__browserAgent?.probeFrames() });
    const owners = new Map();
    for (const p of probes) if (p.result?.token) owners.set(p.result.token, p.frameId);

    let who = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      await this.sleep(40);
      who = await chrome.scripting.executeScript({ target: all, func: () => globalThis.__browserAgent?.whoAmI() });
      const matched = who.every((w) => w.frameId === 0 || owners.has(String(w.result?.probe).split(':')[0]));
      if (matched) break;
    }
    const frames = new Map();
    for (const w of who) {
      if (!w.result) continue;
      frames.set(w.frameId, {
        frameId: w.frameId, documentId: w.documentId, url: w.result.url,
        visible: w.result.width >= 2 && w.result.height >= 2, parent: null, index: null,
      });
    }
    for (const w of who) {
      const frame = frames.get(w.frameId);
      if (!frame || w.frameId === 0) continue;
      const [token, index] = String(w.result.probe).split(':');
      const parent = frames.get(owners.get(token));
      if (parent) {
        frame.parent = parent;
        frame.index = Number(index);
      } else {
        frames.delete(w.frameId); // unmatched frames cannot be placed or located safely
      }
    }
    const top = frames.get(0);
    if (!top) throw new Error('The page did not respond.');
    const ordered = [];
    const visit = (frame) => {
      ordered.push(frame);
      [...frames.values()].filter((f) => f.parent === frame).sort((a, b) => a.index - b.index).forEach(visit);
    };
    visit(top);
    return {
      top,
      topHost: hostOf(top.url),
      ordered: ordered.filter((f) => f === top || ordered.includes(f.parent)),
      childOf: (parent, index) => [...frames.values()].find((f) => f.parent === parent && f.index === index),
    };
  }

  /**
   * Frames from the page's own host and about:blank/srcdoc frames are part of the page.
   * Frames from other sites need the user's approval, like a site the agent navigates to.
   */
  async frameAllowed(frame, tree, ask) {
    for (let f = frame; f?.parent; f = f.parent) {
      if (/^about:/i.test(f.url)) continue;
      const host = hostOf(f.url);
      if (!host) return false;
      if (host === tree.topHost || this.approved.has(host)) continue;
      if (!ask || this.deniedFrameHosts.has(host)) return false;
      const answer = await this.confirm({
        kind: 'site',
        title: t('prompt.frame.title', { host }),
        detail: t('prompt.frame.detail'),
      });
      if (answer === 'deny') {
        this.deniedFrameHosts.add(host);
        return false;
      }
      this.approved.add(host);
      if (answer === 'always') await this.persistHost?.(host);
    }
    return true;
  }

  refState(tabId) {
    if (!this.refMaps.has(tabId)) this.refMaps.set(tabId, { next: 0, byGlobal: new Map(), byLocal: new Map() });
    return this.refMaps.get(tabId);
  }

  /** Rewrites a frame's local "[ref_N]" tags to tab-wide references that never get reused. */
  globalize(tabId, frame, text) {
    const refs = this.refState(tabId);
    return String(text).replace(/\[(ref_\d+)\]/g, (_, local) => {
      const key = `${frame.documentId}|${local}`;
      let ref = refs.byLocal.get(key);
      if (!ref) {
        ref = `ref_${++refs.next}`;
        refs.byLocal.set(key, ref);
        refs.byGlobal.set(ref, { frame, local });
      }
      return `[${ref}]`;
    });
  }

  staleRef(ref) {
    return new Error(`${ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
  }

  resolveRef(tabId, ref) {
    const entry = this.refMaps.get(tabId)?.byGlobal.get(String(ref));
    if (!entry) throw this.staleRef(ref);
    return entry;
  }

  /** Calls a page-agent method whose first argument is a reference, in the reference's frame. */
  async refCall(tabId, ref, method, args = []) {
    const { frame, local } = this.resolveRef(tabId, ref);
    const localName = new RegExp(`\\b${local}\\b`, 'g');
    try {
      const value = await this.page(tabId, method, [local, ...args], frame);
      return typeof value === 'string' ? value.replace(localName, ref) : value;
    } catch (error) {
      if (error instanceof FrameGoneError) throw this.staleRef(ref);
      throw new Error(String(error.message).replace(localName, ref));
    }
  }

  /** Viewport point of a reference, scrolling it (and every enclosing frame) into view. */
  async locateRef(tabId, ref) {
    const { frame } = this.resolveRef(tabId, ref);
    let point = await this.refCall(tabId, ref, 'locate');
    try {
      for (let f = frame; f.parent; f = f.parent) {
        point = await this.page(tabId, 'framePoint', [f.index, point.x, point.y], f.parent);
      }
    } catch (error) {
      if (error instanceof FrameGoneError) throw this.staleRef(ref);
      throw error;
    }
    return point;
  }

  async readPage(tabId, input) {
    const tree = await this.frameTree(tabId);
    let start = tree.top;
    let localRef;
    if (input.ref) ({ frame: start, local: localRef } = this.resolveRef(tabId, input.ref));
    const lines = [];
    const render = async (frame, ref, depth, indent) => {
      let text;
      try {
        text = await this.page(tabId, 'readPage', [{ filter: input.filter, depth, ref }], frame);
      } catch (error) {
        if (ref) throw (error instanceof FrameGoneError ? this.staleRef(input.ref) : new Error(String(error.message).replace(new RegExp(`\\b${ref}\\b`, 'g'), input.ref)));
        lines.push(`${pad(indent)}(frame content unavailable)`);
        return;
      }
      for (const line of this.globalize(tabId, frame, text).split('\n')) {
        const marker = FRAME_LINE.exec(line);
        if (!marker) {
          if (frame !== start && line === 'No matching visible elements.') continue;
          lines.push(pad(indent) + line);
          continue;
        }
        const level = Number(marker[2]);
        const child = tree.childOf(frame, Number(marker[1]));
        if (!child) {
          lines.push(`${pad(indent + level)}(frame content unavailable)`);
        } else if (!(await this.frameAllowed(child, tree, true))) {
          lines.push(`${pad(indent + level)}(content from ${hostOf(child.url)} not shown: the user did not allow this site)`);
        } else {
          await render(child, undefined, depth - level, indent + level);
        }
      }
    };
    await render(start, localRef, Math.max(1, Number(input.depth) || 15), 0);
    return capText(lines.join('\n'), ' Use a smaller depth or a ref to narrow the read.');
  }

  async find(tabId, query) {
    const tree = await this.frameTree(tabId);
    const matches = [];
    const skipped = new Set();
    for (const frame of tree.ordered) {
      if (frame !== tree.top && !frame.visible) continue;
      if (!(await this.frameAllowed(frame, tree, false))) {
        skipped.add(hostOf(frame.url));
        continue;
      }
      const found = await this.page(tabId, 'find', [{ query, raw: true }], frame).catch(() => []);
      const where = frame === tree.top ? '' : ` (in frame from ${hostOf(frame.url) || 'this page'})`;
      for (const m of found) matches.push({ score: m.score, line: this.globalize(tabId, frame, m.line) + where });
    }
    matches.sort((a, b) => b.score - a.score); // stable: top frame first on ties
    let text = matches.slice(0, 20).map((m) => m.line).join('\n') || `No elements matched "${query}". Try read_page or a screenshot.`;
    skipped.delete(null);
    if (skipped.size) text += `\n[Frames from ${[...skipped].join(', ')} were not searched because the user has not allowed those sites. read_page asks for access.]`;
    return text;
  }

  async pageText(tabId) {
    const tree = await this.frameTree(tabId);
    const parts = [];
    for (const frame of tree.ordered) {
      if (frame !== tree.top && (!frame.visible || !(await this.frameAllowed(frame, tree, false)))) continue;
      const text = await this.page(tabId, 'getPageText', [], frame).catch(() => '');
      if (frame === tree.top) parts.push(text);
      else if (text && text !== 'The page has no visible text.') parts.push(`--- Frame: ${redactUrl(frame.url)} ---\n${text}`);
    }
    return capText(parts.join('\n\n'));
  }

  // ---- Optional members ----

  async uploadFiles(tabId, input) {
    this.requireRef(input.target);
    const ids = (input.document_ids || []).map(String);
    const available = [...this.documents].map(([id, file]) => `${id} (${file.name})`).join(', ') || 'none';
    if (input.paths?.length) {
      throw new Error(`Uploading by path is not supported here. Use document_ids of files the user attached. Attached: ${available}.`);
    }
    if (!ids.length) throw new Error(`file_upload needs document_ids. Attached: ${available}.`);
    const files = ids.map((id) => {
      const file = this.documents.get(id);
      if (!file) throw new Error(`Unknown document_id ${id}. Attached: ${available}.`);
      return file;
    });
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_BYTES) throw new Error('The files are larger than 25 MB in total.');
    const payload = await Promise.all(files.map(async (file) => ({
      name: file.name, type: file.type, lastModified: file.lastModified, data: toBase64(await file.arrayBuffer()),
    })));
    const text = await this.refCall(tabId, input.target.ref, 'setFiles', [payload]);
    await this.settle(tabId);
    return text;
  }

  async runJavaScript(tabId, code) {
    const group = 'browser-agent';
    const fail = (details) => new Error(`JavaScript error: ${String(details.exception?.description || details.text).slice(0, 2000)}`);
    try {
      // replMode allows top-level await; a returned promise is awaited separately below.
      let response = await this.cdp(tabId, 'Runtime.evaluate', {
        expression: String(code ?? ''), objectGroup: group, awaitPromise: true, userGesture: true, replMode: true, timeout: 10000,
      });
      if (response.exceptionDetails) throw fail(response.exceptionDetails);
      let r = response.result;
      if (r.subtype === 'promise') {
        response = await this.cdp(tabId, 'Runtime.awaitPromise', { promiseObjectId: r.objectId, returnByValue: true });
        if (response.exceptionDetails) throw fail(response.exceptionDetails);
        r = response.result;
      } else if (r.objectId && !['node', 'function', 'error', 'window'].includes(r.subtype) && r.type !== 'function') {
        response = await this.cdp(tabId, 'Runtime.callFunctionOn', {
          objectId: r.objectId, functionDeclaration: 'function () { return this; }', returnByValue: true,
        }).catch(() => ({ result: r }));
        r = response.result;
      }
      let text;
      if (r.type === 'undefined') text = 'undefined';
      else if ('unserializableValue' in r) text = r.unserializableValue;
      else if (r.type === 'string') text = r.value;
      else if ('value' in r) text = JSON.stringify(r.value, null, 2) ?? String(r.value);
      else text = r.description || `[${r.subtype || r.type}]`;
      await this.settle(tabId);
      return capText(text);
    } finally {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
    }
  }

  async startCapture(tabId) {
    if (this.capturing.has(tabId)) return;
    await this.attach(tabId);
    if (this.enabled('read_console')) {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
      await chrome.debugger.sendCommand({ tabId }, 'Log.enable');
    }
    if (this.enabled('read_network')) await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    this.capturing.add(tabId);
  }

  async viewport(tabId) {
    const metrics = await this.cdp(tabId, 'Page.getLayoutMetrics');
    const { clientWidth: width, clientHeight: height } = metrics.cssLayoutViewport;
    const factor = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
    return { width, height, factor, imageWidth: Math.round(width * factor), imageHeight: Math.round(height * factor) };
  }

  requireRef(target) {
    if (target?.type !== 'ref' || !target.ref) throw new Error('This action needs an element reference target.');
  }

  /** Converts a target to CSS viewport pixels. Claude's coordinates are screenshot pixels. */
  async point(tabId, target) {
    if (target?.type === 'ref') return this.locateRef(tabId, target.ref);
    if (target?.type !== 'coordinate') throw new Error('Invalid target.');
    const view = this.views.get(tabId) || await this.viewport(tabId);
    const { x, y } = target;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > view.imageWidth || y > view.imageHeight) {
      throw new Error(`Coordinate (${x}, ${y}) is outside the ${view.imageWidth}x${view.imageHeight} viewport.`);
    }
    return { x: x / view.factor, y: y / view.factor };
  }

  targetLabel(target) {
    return target?.type === 'ref' ? target.ref : `(${target?.x}, ${target?.y})`;
  }

  mouse(tabId, type, point, extra = {}) {
    return this.cdp(tabId, 'Input.dispatchMouseEvent', { type, x: point.x, y: point.y, ...extra });
  }

  async click(tabId, name, input) {
    const [button, count] = CLICK_COUNTS[name];
    const modifiers = modifierMask(input.modifiers);
    const point = await this.point(tabId, input.target);
    await this.mouse(tabId, 'mouseMoved', point, { modifiers });
    for (let clickCount = 1; clickCount <= count; clickCount++) {
      await this.mouse(tabId, 'mousePressed', point, { button, clickCount, buttons: BUTTON_MASK[button], modifiers });
      await this.mouse(tabId, 'mouseReleased', point, { button, clickCount, modifiers });
    }
    await this.settle(tabId);
    return this.textResult(`Clicked ${this.targetLabel(input.target)}.`);
  }

  async scroll(tabId, input) {
    const point = await this.point(tabId, input.target);
    const notches = Math.min(Math.max(Number(input.scroll_amount) || 3, 1), 10);
    const direction = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[input.scroll_direction];
    if (!direction) throw new Error('scroll_direction must be up, down, left, or right.');
    await this.mouse(tabId, 'mouseWheel', point, { deltaX: direction[0] * notches * 100, deltaY: direction[1] * notches * 100 });
    await this.sleep(250);
    return this.textResult(`Scrolled ${input.scroll_direction} ${notches} notches.`);
  }

  async sendChordDown({ modifiers, mask, def, command }, tabId) {
    let held = 0;
    for (const mod of modifiers) {
      held |= mod.bit;
      await this.cdp(tabId, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: mod.key, code: mod.code, windowsVirtualKeyCode: mod.vk, modifiers: held,
      });
    }
    await this.cdp(tabId, 'Input.dispatchKeyEvent', {
      type: def.text ? 'keyDown' : 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
      modifiers: mask,
      ...(def.text ? { text: def.text, unmodifiedText: def.text } : {}),
      ...(command ? { commands: [command] } : {}),
    });
  }

  async sendChordUp({ modifiers, mask, def }, tabId) {
    await this.cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.vk, modifiers: mask,
    });
    let held = mask;
    for (const mod of [...modifiers].reverse()) {
      held &= ~mod.bit;
      await this.cdp(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: mod.key, code: mod.code, windowsVirtualKeyCode: mod.vk, modifiers: held,
      });
    }
  }

  async pressKeys(tabId, input) {
    const chords = parseKeySequence(input.text);
    const repeat = Math.min(Math.max(Number(input.repeat) || 1, 1), 100);
    for (let i = 0; i < repeat; i++) {
      for (const chord of chords) {
        await this.sendChordDown(chord, tabId);
        await this.sendChordUp(chord, tabId);
      }
    }
    await this.settle(tabId);
    return this.textResult(`Pressed ${input.text}.`);
  }

  async holdKey(tabId, input) {
    const [chord] = parseKeySequence(input.text);
    await this.sendChordDown(chord, tabId);
    try {
      await this.sleep(Math.min(Math.max(Number(input.duration) || 0, 0), 30) * 1000);
    } finally {
      await this.sendChordUp(chord, tabId);
    }
    return this.textResult(`Held ${input.text} for ${input.duration} seconds.`);
  }

  async navigate(tabId, url) {
    const keyword = String(url).toLowerCase();
    if (keyword === 'back') await chrome.tabs.goBack(tabId);
    else if (keyword === 'forward') await chrome.tabs.goForward(tabId);
    else if (keyword === 'reload') await chrome.tabs.reload(tabId);
    else {
      const href = normalizeUrl(url);
      await this.approveHost(new URL(href).host);
      await chrome.tabs.update(tabId, { url: href });
    }
    await this.sleep(150);
    await this.waitForLoad(tabId, 30000);

    // Redirects can land on a different site, so check the final host as well.
    const tab = await chrome.tabs.get(tabId);
    const finalHost = hostOf(tab.url);
    if (finalHost) {
      try {
        await this.approveHost(finalHost);
      } catch (error) {
        await chrome.tabs.update(tabId, { url: 'about:blank' });
        throw error;
      }
    }
    return this.textResult(`Navigated to ${this.safeTabUrl(tab.url)}`);
  }

  async waitForLoad(tabId, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
      await this.sleep(200);
    }
    throw new Error(`Page load timed out after ${Math.round(timeout / 1000)} seconds. The page may be unavailable.`);
  }

  async settle(tabId) {
    await this.sleep(350);
    await this.waitForLoad(tabId, 8000).catch((error) => {
      if (this.signal?.aborted) throw error;
    });
  }

  /** Returns one consistently sized image block; region crops in screenshot pixels. */
  async capture(tabId, region) {
    // Chrome can stall when capturing a tab that is not visible.
    const current = await chrome.tabs.get(tabId);
    if (!current.active) await chrome.tabs.update(tabId, { active: true });
    this.activeTab = tabId;
    const shot = await this.cdp(tabId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const source = new Blob([fromBase64(shot.data)], { type: 'image/png' });
    const full = await createImageBitmap(source);

    // Take geometry from the pixels actually captured: reported metrics can lag
    // behind Chrome's debugging infobar, which would stretch the image and skew clicks.
    const metrics = await this.cdp(tabId, 'Page.getLayoutMetrics');
    const cssWidth = metrics.cssLayoutViewport.clientWidth;
    const cssHeight = full.height * (cssWidth / full.width);
    const factor = Math.min(1, MAX_IMAGE_EDGE / Math.max(cssWidth, cssHeight));
    const view = {
      factor,
      imageWidth: Math.round(cssWidth * factor),
      imageHeight: Math.round(cssHeight * factor),
    };
    // Claude's coordinates refer to the most recent image it was shown.
    if (!region) this.views.set(tabId, view);
    const scale = full.width / view.imageWidth;

    let sx = 0;
    let sy = 0;
    let sw = full.width;
    let sh = full.height;
    let outW = view.imageWidth;
    let outH = view.imageHeight;
    if (region) {
      const [x0, y0, x1, y1] = region.map(Number);
      if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0
        || x0 < 0 || y0 < 0 || x1 > view.imageWidth || y1 > view.imageHeight) {
        full.close();
        throw new Error(`Invalid zoom region. It must fit inside ${view.imageWidth}x${view.imageHeight}.`);
      }
      sx = x0 * scale;
      sy = y0 * scale;
      sw = (x1 - x0) * scale;
      sh = (y1 - y0) * scale;
      const fit = MAX_IMAGE_EDGE / Math.max(x1 - x0, y1 - y0);
      outW = Math.max(1, Math.round((x1 - x0) * fit));
      outH = Math.max(1, Math.round((y1 - y0) * fit));
    }

    const canvas = new OffscreenCanvas(outW, outH);
    canvas.getContext('2d').drawImage(full, sx, sy, sw, sh, 0, 0, outW, outH);
    full.close();
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    return {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: toBase64(await blob.arrayBuffer()) },
    };
  }
}
