// Connects the side panel to the local Claude Code MCP server (claude-code/server).
// The server sends {type:'call', id, name, input}; we answer {type:'result', id, result}.

const RETRY_MS = [1000, 2000, 5000, 10000];
// Must match BRIDGE_PROTOCOL in claude-code/server/index.js.
export const BRIDGE_PROTOCOL = 2;

export class BridgeClient {
  /**
   * @param onCall async (name, input) => tool_result block
   * @param onState (state, detail) => void; state is 'off' | 'connecting' | 'connected' | 'error'
   * @param hello () => extra fields for the hello message (mode, enabled tools)
   */
  constructor({ onCall, onState, hello }) {
    this.onCall = onCall;
    this.state = 'off';
    this.onState = (state, ...rest) => {
      this.state = state;
      onState(state, ...rest);
    };
    this.hello = hello;
    this.ws = null;
    this.config = null;
    this.retry = 0;
    this.timer = null;
    this.queue = Promise.resolve();
    this.terminalConfirm = false; // whether this session's Claude Code can ask in the terminal
    this.confirms = new Map(); // id -> resolve(answer | null)
    this.nextConfirm = 0;
  }

  /** Applies settings: connects when enabled with a token, disconnects otherwise. */
  configure({ enabled, port, token }) {
    const next = enabled ? { port: Number(port) || 18765, token: token || '' } : null;
    if (JSON.stringify(next) === JSON.stringify(this.config)) return;
    this.config = next;
    this.disconnect();
    if (next) this.connect();
    else this.onState('off');
  }

  disconnect() {
    clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }

  connect() {
    const config = this.config;
    if (!config) return;
    // Keep showing an error while quietly re-checking it.
    if (this.state !== 'error') this.onState('connecting');
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${config.port}/bridge`);
    } catch (error) {
      this.scheduleRetry(String(error.message || error));
      return;
    }
    this.ws = ws;
    let welcomed = false;
    ws.onopen = () => ws.send(JSON.stringify({
      type: 'hello', protocol: BRIDGE_PROTOCOL, token: config.token, extension: chrome.runtime.getManifest().version, ...this.hello(),
    }));
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'welcome') {
        welcomed = true;
        this.retry = 0;
        // Servers before protocol 2 still work, but the user should know to reload them.
        const outdated = !(message.protocol >= BRIDGE_PROTOCOL) || Boolean(message.stale);
        this.terminalConfirm = Boolean(message.terminalConfirm);
        this.onState('connected', '', { label: String(message.label || '').slice(0, 60), outdated });
      } else if (message.type === 'server_info') {
        this.terminalConfirm = Boolean(message.terminalConfirm);
      } else if (message.type === 'confirm_result') {
        this.confirms.get(message.id)?.(message.answer ?? null);
        this.confirms.delete(message.id);
      } else if (message.type === 'call') {
        // One call at a time, in arrival order: the executor is not reentrant.
        this.queue = this.queue.then(() => this.run(ws, message));
      }
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.terminalConfirm = false;
      for (const resolve of this.confirms.values()) resolve(null);
      this.confirms.clear();
      // These will not fix themselves by retrying; say what the user has to do.
      // Details are i18n keys; the panel shows them in the current language.
      // 4003 comes from servers before protocol 2, which demanded a token.
      const stuck = [4003, 4005, 4010, 4011, 4000].includes(event.code) ? `bridge.err.${event.code}` : null;
      if (stuck) {
        this.onState('error', stuck);
        // Check again now and then, so a reconnected session is picked up without touching the panel.
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.connect(), 15000);
        return;
      }
      this.scheduleRetry(welcomed ? 'bridge.lost' : 'bridge.notRunning');
    };
  }

  scheduleRetry(detail) {
    this.onState('connecting', detail);
    const delay = RETRY_MS[Math.min(this.retry++, RETRY_MS.length - 1)];
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  async run(ws, message) {
    let result;
    try {
      result = await this.onCall(message.name, message.input || {});
    } catch (error) {
      result = { type: 'tool_result', is_error: true, content: `Error: ${error.message || error}` };
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: message.id, result }));
  }

  /**
   * Asks the user in the Claude Code terminal. Returns { id, answer } where answer
   * resolves to an option value, 'deny', or null when the terminal cannot ask.
   */
  confirm({ title, detail, sensitive, session, options }) {
    const id = ++this.nextConfirm;
    if (!this.terminalConfirm || this.ws?.readyState !== WebSocket.OPEN) return { id, answer: Promise.resolve(null) };
    const answer = new Promise((resolve) => this.confirms.set(id, resolve));
    this.ws.send(JSON.stringify({ type: 'confirm', id, title, detail, sensitive, session, options }));
    return { id, answer };
  }

  /** The user answered in the panel: withdraw the terminal question. */
  cancelConfirm(id) {
    if (!this.confirms.has(id)) return;
    this.confirms.get(id)(null);
    this.confirms.delete(id);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'confirm_cancel', id }));
  }

  /** Tells the server about setting changes that affect what Claude can do. */
  sendStatus() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'status', ...this.hello() }));
  }
}
