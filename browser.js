// Executor for the Claude API browser toolset (browser_toolset_20260801).
import { modifierMask, parseKeySequence } from './keys.js';

const MAX_IMAGE_EDGE = 1456;
const TAB_MEMBERS = new Set(['new_tab', 'list_tabs', 'switch_tab', 'close_tab']);
const WRITE_MEMBERS = new Set([
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag',
  'left_mouse_down', 'left_mouse_up', 'type', 'key', 'hold_key', 'form_input', 'close_tab',
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

const sanitize = (value, max) => String(value || '').replace(UNSAFE_CHARS, ' ').slice(0, max);

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
   */
  constructor({ confirm, settings, persistHost, onDetachedByUser }) {
    this.confirm = confirm;
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
      this.attached.delete(tabId);
      this.views.delete(tabId);
      this.pendingOpened.delete(tabId);
      if (this.activeTab === tabId) this.activeTab = [...this.managed].at(-1) ?? null;
    };
    this.handleDetach = (source, reason) => {
      this.attached.delete(source.tabId);
      if (reason === 'canceled_by_user') this.onDetachedByUser?.();
    };
    chrome.tabs.onCreated.addListener(this.handleCreated);
    chrome.tabs.onRemoved.addListener(this.handleRemoved);
    chrome.debugger.onDetach.addListener(this.handleDetach);
  }

  async beginTask(signal) {
    this.signal = signal;
    this.autoRest = false;
    this.approved = new Set([...this.approved, ...(this.settings.approvedHosts || [])]);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      this.managed.add(tab.id);
      this.activeTab = tab.id;
    }
  }

  async endTask() {
    await Promise.all([...this.attached].map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {})));
    this.attached.clear();
  }

  dispose() {
    chrome.tabs.onCreated.removeListener(this.handleCreated);
    chrome.tabs.onRemoved.removeListener(this.handleRemoved);
    chrome.debugger.onDetach.removeListener(this.handleDetach);
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

  /** Text results carry the tab inventory plus any tabs opened during the call. */
  async withState(content) {
    const state = await this.browserState();
    const open = new Set(state.tabs.map((tab) => tab.tab_id));
    const changes = [...this.pendingOpened].map((id) => `tab-${id}`).filter((id) => open.has(id));
    this.pendingOpened.clear();
    if (changes.length) state.state_changes = changes.map((tab_id) => ({ type: 'tab_opened', tab_id }));
    if (state.tabs.length) content.push(state);
    return content;
  }

  // ---- Dispatch ----

  async dispatch(name, input) {
    if (this.signal?.aborted) throw new Error('Stopped by the user.');
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
    await this.gate(name, input, tabId);

    switch (name) {
      case 'screenshot': {
        const image = await this.capture(tabId);
        return this.withState([{ type: 'text', text: 'Screenshot captured.' }, image]);
      }
      case 'zoom': return [await this.capture(tabId, input.region)];
      case 'read_page':
        return this.textResult(await this.page(tabId, 'readPage', [{ filter: input.filter, depth: input.depth, ref: input.ref }]));
      case 'find': return this.textResult(await this.page(tabId, 'find', [{ query: input.query }]));
      case 'get_page_text': return this.textResult(await this.page(tabId, 'getPageText', []));
      case 'form_input':
        this.requireRef(input.target);
        return this.textResult(await this.page(tabId, 'formInput', [input.target.ref, input.value]));
      case 'scroll_to':
        this.requireRef(input.target);
        return this.textResult(await this.page(tabId, 'scrollTo', [input.target.ref]));
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
      const created = await chrome.tabs.create({ active: true, url: 'about:blank' });
      this.managed.add(created.id);
      this.activeTab = created.id;
      this.pendingOpened.delete(created.id);
      const state = await this.browserState();
      state.state_changes = [{ type: 'tab_opened', tab_id: `tab-${created.id}` }];
      return [state];
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
    return [await this.browserState()];
  }

  // ---- Approvals ----

  async approveHost(host) {
    if (this.approved.has(host)) return;
    const answer = await this.confirm({
      kind: 'site',
      title: `Cho phép tác tử dùng ${host}?`,
      detail: 'Nội dung trang này sẽ được gửi tới Claude API và tác tử có thể thao tác trên đó.',
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
    const info = await this.describeAction(name, input, tabId).catch(() => ({ label: 'phần tử không xác định' }));
    const haystack = `${info.label} ${info.submitLabel || ''}`;
    const isEnter = name === 'key' && /\benter\b|\breturn\b/i.test(String(input.text));
    const sensitive = Boolean(
      info.secret
      || name === 'close_tab'
      || (name !== 'type' && name !== 'key' && SENSITIVE.test(info.label))
      || (isEnter && info.inForm && SENSITIVE.test(haystack)),
    );
    if (!sensitive && (this.settings.mode === 'auto' || this.autoRest)) return;
    const answer = await this.confirm({
      kind: 'action',
      sensitive,
      title: sensitive ? 'Thao tác nhạy cảm, cần bạn xác nhận' : 'Cho phép thao tác này?',
      detail: this.describeForUser(name, input, info),
    });
    if (answer === 'deny') throw new Error('The user declined this action. Ask the user how to proceed rather than retrying.');
    if (answer === 'allow_all' && !sensitive) this.autoRest = true;
  }

  async describeAction(name, input, tabId) {
    if (name === 'close_tab') return { label: `tab ${input.tab_id}` };
    if (name === 'type' || name === 'key' || name === 'hold_key') return this.page(tabId, 'describeFocus', []);
    const target = input.target;
    if (target?.type === 'ref') return this.page(tabId, 'describeRef', [target.ref]);
    const point = await this.point(tabId, target);
    return this.page(tabId, 'describePoint', [point.x, point.y]);
  }

  describeForUser(name, input, info) {
    if (name === 'type') {
      return `Nhập vào ${info.label}: ${info.secret ? '[ẩn]' : `"${String(input.text).slice(0, 200)}"`}`;
    }
    if (name === 'key' || name === 'hold_key') return `Nhấn phím ${input.text} tại ${info.label}`;
    if (name === 'form_input') return `Đặt ${info.label} = ${info.secret ? '[ẩn]' : `"${String(input.value).slice(0, 200)}"`}`;
    if (name === 'close_tab') return `Đóng ${info.label}`;
    return `${name} trên ${info.label}`;
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

  async page(tabId, method, args) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['page-agent.js'] });
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [method, args],
      func: (m, a) => {
        try {
          return { value: globalThis.__browserAgent[m](...a) };
        } catch (error) {
          return { error: error.message };
        }
      },
    });
    if (!frame?.result) throw new Error('The page did not respond.');
    if (frame.result.error) throw new Error(frame.result.error);
    return frame.result.value;
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
    if (target?.type === 'ref') return this.page(tabId, 'locate', [target.ref]);
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
