// Console and network capture for read_console / read_network, fed by chrome.debugger events.
// Entries exist only from the moment the debugger attached to a tab.
const MAX_ENTRIES = 300;
const MAX_ENTRY_CHARS = 500;
const SECRET_PARAM = /token|key|secret|pass|auth|sig|session|sid|code|cred|jwt|bearer|otp|nonce/i;

export function redactUrl(raw) {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const name of [...url.searchParams.keys()]) {
      if (SECRET_PARAM.test(name)) url.searchParams.set(name, 'REDACTED');
    }
    if (url.hash.length > 1 && /[=&]/.test(url.hash) && SECRET_PARAM.test(url.hash)) url.hash = '#REDACTED';
    return url.href;
  } catch {
    return String(raw);
  }
}

export function redactText(text) {
  return String(text)
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 REDACTED')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, 'REDACTED_JWT')
    .replace(/\b(sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}/g, 'REDACTED_KEY')
    .replace(/\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|session[_-]?id|auth)[\w-]*["']?\s*[:=]\s*["']?)[^"'\s,;&]+/gi, '$1REDACTED')
    .replace(/https?:\/\/[^\s"'<>)]+/g, (url) => redactUrl(url));
}

const oneLine = (text) => redactText(String(text ?? ''))
  .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
  .slice(0, MAX_ENTRY_CHARS);

function previewText(preview) {
  const items = preview.properties.map((p) => {
    const value = p.type === 'string' ? JSON.stringify(p.value) : p.value ?? p.subtype ?? p.type;
    return preview.subtype === 'array' ? value : `${p.name}: ${value}`;
  });
  if (preview.overflow) items.push('…');
  return preview.subtype === 'array' ? `[${items.join(', ')}]` : `{${items.join(', ')}}`;
}

function remoteObjectText(arg) {
  if (!arg) return '';
  if (arg.preview?.properties && ['object'].includes(arg.type) && !['node', 'error', 'regexp', 'date'].includes(arg.subtype)) return previewText(arg.preview);
  if (arg.type === 'string') return arg.value;
  if ('unserializableValue' in arg) return arg.unserializableValue;
  if ('value' in arg) return JSON.stringify(arg.value);
  return arg.description || `[${arg.subtype || arg.type}]`;
}

export class ActivityLog {
  constructor() {
    this.console = new Map(); // tabId -> { entries, dropped }
    this.network = new Map(); // tabId -> { order: [], byId: Map, dropped }
  }

  forget(tabId) {
    this.console.delete(tabId);
    this.network.delete(tabId);
  }

  consoleOf(tabId) {
    if (!this.console.has(tabId)) this.console.set(tabId, { entries: [], dropped: 0 });
    return this.console.get(tabId);
  }

  networkOf(tabId) {
    if (!this.network.has(tabId)) this.network.set(tabId, { order: [], byId: new Map(), dropped: 0 });
    return this.network.get(tabId);
  }

  pushConsole(tabId, level, text, location) {
    const log = this.consoleOf(tabId);
    const where = location?.url ? ` (${redactUrl(location.url)}:${(location.lineNumber ?? 0) + 1})` : '';
    log.entries.push(`[${level}] ${oneLine(text)}${oneLine(where)}`);
    if (log.entries.length > MAX_ENTRIES) {
      log.entries.shift();
      log.dropped += 1;
    }
  }

  newRequest(tabId, key, params) {
    const net = this.networkOf(tabId);
    const entry = { method: params.request.method, url: params.request.url, start: params.timestamp };
    net.byId.set(key, entry);
    net.order.push(entry);
    if (net.order.length > MAX_ENTRIES) {
      const old = net.order.shift();
      for (const [id, value] of net.byId) if (value === old) net.byId.delete(id);
      net.dropped += 1;
    }
  }

  /** Handles one chrome.debugger event; returns true when it was a capture event. */
  handle(tabId, method, params) {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const level = { warning: 'warning', error: 'error', assert: 'error' }[params.type] || params.type;
        const frame = params.stackTrace?.callFrames?.[0];
        this.pushConsole(tabId, level, params.args.map(remoteObjectText).join(' '), frame);
        return true;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails;
        this.pushConsole(tabId, 'error', `Uncaught ${d.exception?.description || d.text}`, d);
        return true;
      }
      case 'Log.entryAdded': {
        const e = params.entry;
        this.pushConsole(tabId, e.level, `${e.source}: ${e.text}`, e);
        return true;
      }
      case 'Network.requestWillBeSent': {
        if (/^(data|blob):/i.test(params.request.url)) return true;
        const net = this.networkOf(tabId);
        const previous = net.byId.get(params.requestId);
        if (previous && params.redirectResponse) {
          previous.status = params.redirectResponse.status;
          previous.mime = params.redirectResponse.mimeType;
          previous.end = params.timestamp;
          net.byId.delete(params.requestId);
        }
        this.newRequest(tabId, params.requestId, params);
        return true;
      }
      case 'Network.responseReceived': {
        const entry = this.network.get(tabId)?.byId.get(params.requestId);
        if (entry) {
          entry.status = params.response.status;
          entry.mime = params.response.mimeType;
        }
        return true;
      }
      case 'Network.loadingFinished':
      case 'Network.loadingFailed': {
        const entry = this.network.get(tabId)?.byId.get(params.requestId);
        if (entry) {
          entry.end = params.timestamp;
          if (method === 'Network.loadingFailed') entry.failed = params.canceled ? 'canceled' : params.errorText || 'failed';
        }
        return true;
      }
      default:
        return false;
    }
  }

  readConsole(tabId) {
    const log = this.consoleOf(tabId);
    const lines = [...log.entries];
    if (log.dropped) lines.unshift(`[${log.dropped} earlier entries were dropped.]`);
    log.entries = [];
    log.dropped = 0;
    return lines.length ? lines.join('\n') : 'No console entries since the last read.';
  }

  readNetwork(tabId) {
    const net = this.networkOf(tabId);
    const lines = net.order.map((e) => {
      const done = e.end !== undefined;
      const status = e.failed ? `failed (${e.failed})` : e.status ?? 'pending';
      const timing = done ? `${Math.round((e.end - e.start) * 1000)}ms` : '-';
      return oneLine(`${e.method} ${status} ${e.mime || '-'} ${timing} ${redactUrl(e.url)}`);
    });
    if (net.dropped) lines.unshift(`[${net.dropped} earlier requests were dropped.]`);
    // Finished requests are reported once; pending ones are reported again when they finish.
    net.order = net.order.filter((e) => e.end === undefined);
    for (const [id, e] of net.byId) if (e.end !== undefined) net.byId.delete(id);
    net.dropped = 0;
    return lines.length ? lines.join('\n') : 'No network requests since the last read.';
  }
}
