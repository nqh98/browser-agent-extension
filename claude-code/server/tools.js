// MCP tool definitions. Each tool maps 1:1 to a browser member that the
// extension's BrowserExecutor already runs, with the same input shape.

const tabId = { type: 'string', description: 'Tab to act on, e.g. "tab-123". Defaults to the active tab.' };
const target = {
  description: 'Element to act on: {"type":"ref","ref":"ref_12"} from read_page/find, or {"type":"coordinate","x":100,"y":200} in the pixels of the latest screenshot.',
  oneOf: [
    {
      type: 'object',
      properties: { type: { const: 'ref' }, ref: { type: 'string' } },
      required: ['type', 'ref'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { type: { const: 'coordinate' }, x: { type: 'number' }, y: { type: 'number' } },
      required: ['type', 'x', 'y'],
      additionalProperties: false,
    },
  ],
};
const refTarget = {
  type: 'object',
  description: 'Element reference from read_page or find: {"type":"ref","ref":"ref_12"}.',
  properties: { type: { const: 'ref' }, ref: { type: 'string' } },
  required: ['type', 'ref'],
  additionalProperties: false,
};
const modifiers = { type: 'string', description: 'Modifier keys held during the click, joined with "+", e.g. "ctrl+shift".' };

const schema = (properties = {}, required = []) => ({
  type: 'object',
  properties: { ...properties, tab_id: tabId },
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const tabOnly = (required) => ({
  type: 'object',
  properties: { tab_id: tabId },
  ...(required ? { required: ['tab_id'] } : {}),
  additionalProperties: false,
});
const click = (what) => ({
  description: `${what} an element or a point. Asks the user first in "ask" mode or when the target looks sensitive.`,
  inputSchema: schema({ target, modifiers }, ['target']),
});

const DEFS = {
  navigate: {
    description: 'Open a URL in the tab, or pass "back", "forward" or "reload". The user must allow each new site in the side panel.',
    inputSchema: schema({ url: { type: 'string' } }, ['url']),
  },
  read_page: {
    description: 'Read the accessibility tree of the page, including iframes. Each element gets a ref (ref_N) for other tools. Prefer this or find over screenshots for acting on elements.',
    inputSchema: schema({
      filter: { type: 'string', enum: ['interactive', 'all'], description: 'interactive: only controls; all: include off-screen elements. Default: visible elements.' },
      depth: { type: 'integer', minimum: 1, description: 'Maximum tree depth (default 15).' },
      ref: { type: 'string', description: 'Read only the subtree under this ref.' },
    }),
  },
  find: {
    description: 'Find elements by keywords (not semantic). Returns matching elements with refs.',
    inputSchema: schema({ query: { type: 'string' } }, ['query']),
  },
  get_page_text: { description: 'Get the visible text of the page, including iframes the user allowed.', inputSchema: schema() },
  screenshot: { description: 'Capture the visible part of the tab. Coordinates in later actions refer to this image.', inputSchema: schema() },
  zoom: {
    description: 'Capture a region of the latest screenshot at higher resolution.',
    inputSchema: schema({
      region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[x0, y0, x1, y1] in screenshot pixels.' },
    }, ['region']),
  },
  left_click: click('Left-click'),
  right_click: click('Right-click'),
  middle_click: click('Middle-click'),
  double_click: click('Double-click'),
  triple_click: click('Triple-click'),
  left_click_drag: {
    description: 'Drag with the left button from one element or point to another.',
    inputSchema: schema({ from: target, target }, ['from', 'target']),
  },
  left_mouse_down: { description: 'Press the left mouse button at a target.', inputSchema: schema({ target }, ['target']) },
  left_mouse_up: { description: 'Release the left mouse button at a target.', inputSchema: schema({ target }, ['target']) },
  hover: { description: 'Move the pointer over an element or point.', inputSchema: schema({ target }, ['target']) },
  mouse_move: { description: 'Move the pointer to an element or point.', inputSchema: schema({ target }, ['target']) },
  scroll: {
    description: 'Scroll with the mouse wheel at a target.',
    inputSchema: schema({
      target,
      scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      scroll_amount: { type: 'integer', minimum: 1, maximum: 10, description: 'Wheel notches (default 3).' },
    }, ['target', 'scroll_direction']),
  },
  scroll_to: { description: 'Scroll an element into view.', inputSchema: schema({ target: refTarget }, ['target']) },
  type: {
    description: 'Type text into the focused element. Click or form_input the field first.',
    inputSchema: schema({ text: { type: 'string' } }, ['text']),
  },
  key: {
    description: 'Press keys, e.g. "Enter", "ctrl+a", "Tab Tab" (space-separated sequence).',
    inputSchema: schema({ text: { type: 'string' }, repeat: { type: 'integer', minimum: 1, maximum: 100 } }, ['text']),
  },
  hold_key: {
    description: 'Hold a key or chord down for some seconds.',
    inputSchema: schema({ text: { type: 'string' }, duration: { type: 'number', minimum: 0, maximum: 30 } }, ['text', 'duration']),
  },
  form_input: {
    description: 'Set the value of an input, textarea, select (by value or label), checkbox or radio (true/false).',
    inputSchema: schema({ target: refTarget, value: { type: ['string', 'number', 'boolean'] } }, ['target', 'value']),
  },
  wait: {
    description: 'Wait some seconds, e.g. for a page to update.',
    inputSchema: schema({ duration: { type: 'number', minimum: 0, maximum: 30 } }, ['duration']),
  },
  new_tab: { description: 'Open a new blank tab and make it active.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  list_tabs: { description: 'List the tabs this session controls.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  switch_tab: { description: 'Make a controlled tab active.', inputSchema: tabOnly(true) },
  close_tab: { description: 'Close a controlled tab. Always asks the user.', inputSchema: tabOnly(true) },
  read_console: {
    description: 'Read console messages since the previous read. Optional: the user must enable it in the side panel settings.',
    inputSchema: schema(),
  },
  read_network: {
    description: 'Read network requests since the previous read. Optional: the user must enable it in the side panel settings.',
    inputSchema: schema(),
  },
  file_upload: {
    description: 'Upload files the user attached in the side panel (document ids like "doc-1"; bridge_status lists them) to a file input. Optional; always asks the user.',
    inputSchema: schema({ target: refTarget, document_ids: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['target', 'document_ids']),
  },
  javascript_exec: {
    description: 'Run JavaScript in the page with top-level await; returns the value. Optional: the user must enable it in the side panel settings.',
    inputSchema: schema({ text: { type: 'string', description: 'JavaScript source.' } }, ['text']),
  },
};

export const STATUS_TOOL = 'bridge_status';

export const TOOLS = [
  ...Object.entries(DEFS).map(([name, def]) => ({ name, ...def })),
  {
    name: STATUS_TOOL,
    description: 'Check whether the Chrome extension is connected, and how to connect it if not.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export const MEMBERS = new Set(Object.keys(DEFS));

/** Converts an extension tool_result into MCP tool call content. */
export function toMcpResult(result) {
  const blocks = typeof result?.content === 'string'
    ? [{ type: 'text', text: result.content }]
    : Array.isArray(result?.content) ? result.content : [];
  const content = [];
  for (const block of blocks) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text });
    else if (block.type === 'image' && block.source?.type === 'base64') {
      content.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type });
    } else if (block.type === 'browser_state') {
      const { type, ...state } = block;
      content.push({ type: 'text', text: `Browser state: ${JSON.stringify(state)}` });
    }
  }
  if (!content.length) content.push({ type: 'text', text: result?.is_error ? 'Error.' : 'Done.' });
  return { content, ...(result?.is_error ? { isError: true } : {}) };
}
