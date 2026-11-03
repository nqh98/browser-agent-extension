// Connects the side panel to the local Claude Code MCP server (claude-code/server).
// The server sends {type:'call', id, name, input}; we answer {type:'result', id, result}.

const RETRY_MS = [1000, 2000, 5000, 10000];

export class BridgeClient {
  /**
   * @param onCall async (name, input) => tool_result block
   * @param onState (state, detail) => void; state is 'off' | 'connecting' | 'connected' | 'error'
   * @param hello () => extra fields for the hello message (mode, enabled tools)
   */
  constructor({ onCall, onState, hello }) {
    this.onCall = onCall;
    this.onState = onState;
    this.hello = hello;
    this.ws = null;
    this.config = null;
    this.retry = 0;
    this.timer = null;
    this.queue = Promise.resolve();
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
    this.onState('connecting');
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${config.port}/bridge`);
    } catch (error) {
      this.scheduleRetry(String(error.message || error));
      return;
    }
    this.ws = ws;
    let welcomed = false;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: config.token, extension: chrome.runtime.getManifest().version, ...this.hello() }));
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
        this.onState('connected', '', { label: String(message.label || '').slice(0, 60) });
      } else if (message.type === 'call') {
        // One call at a time, in arrival order: the executor is not reentrant.
        this.queue = this.queue.then(() => this.run(ws, message));
      }
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (event.code === 4003) {
        this.onState('error', 'Token không khớp với BROWSER_AGENT_TOKEN của Claude Code.');
        return; // a wrong token will not fix itself
      }
      if (event.code === 4000) {
        this.onState('error', 'Một side panel khác đã kết nối tới Claude Code.');
        return;
      }
      this.scheduleRetry(welcomed ? 'Mất kết nối tới Claude Code.' : 'Chưa thấy Claude Code đang chạy.');
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

  /** Tells the server about setting changes that affect what Claude can do. */
  sendStatus() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'status', ...this.hello() }));
  }
}
