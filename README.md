# Browser Agent

**English** | [Tiếng Việt](README.vi.md)

An unofficial Chrome extension. An agent in the side panel reads and operates web pages, using your own Claude API key or Claude Code in your terminal.

## Install

1. Unzip this folder.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the folder. The extension ID is always `eboigejnblbcifgbpgaadonkpgbdbnkc`; if you loaded an older copy before (with a different ID), remove it and enter your settings again.
4. Click the extension icon to open the side panel.
5. Choose how to use it:
   - **Chat in the panel**: give tasks right in the panel. Enter an API key, click **Check** to verify it and pick a model, then **Save**.
   - **Control from Claude Code**: Claude Code in your terminal operates the browser; no API key needed (see below).

The two modes are exclusive. Switch with the mode button at the top left; switching stops everything the old mode was doing. A green dot next to the mode name means it is ready: there is an API key, or at least one Claude Code session is connected.

## Display language

The panel is available in English and Vietnamese. By default it follows the browser (Vietnamese if the browser prefers Vietnamese, English otherwise).

- Switch right on the first screen (**English** / **Tiếng Việt** buttons), or under **Settings → Language** (choose **Automatic** to follow the browser).
- The confirmation questions Claude Code shows in the terminal use the same language.
- Lines already in the log keep the language they were written in.
- The extension's name and description in `chrome://extensions` follow Chrome's own UI language.

## Using a company gateway

In chat mode, open **Settings** and tick **Use a company gateway**:

- **API base URL**: the gateway address, for example `https://llm-gateway.example.com/anthropic`. A trailing `/v1` is fine either way. Leave it empty to use `https://api.anthropic.com`.
- **Authentication**: `x-api-key` for Anthropic, or `Authorization: Bearer` if the gateway needs it.
- **Model**: click **Check** to load the models the key or gateway allows, from `GET /v1/models` (Anthropic format with pagination, or `{ data: [{ id }] }`). The list also reloads after you save a new base URL, authentication or key, and is remembered for next time. Choose **Type another name…** for a model that is not listed. If the gateway has no `/v1/models`, type the model name yourself.
- The gateway must support the Messages API (`/v1/messages`) and pass the `browser_toolset_20260801` tool through unchanged, including the `toolset_name` and `browser_state` fields.

Chrome shows a "started debugging this browser" bar while the agent controls a tab. Closing that bar stops the task.

## Control from Claude Code (terminal)

Claude Code in your terminal can drive Chrome through this extension, similar to Claude in Chrome. In this mode Claude Code calls the model, so the extension needs no API key; a company gateway, if any, is configured on the Claude Code side.

```
Claude Code (terminal 1) ──stdio──▶ MCP server :18765 ──┐
Claude Code (terminal 2) ──stdio──▶ MCP server :18766 ──┼─WebSocket 127.0.0.1──▶ side panel ──▶ Chrome tab
                                                   …     ┘
```

1. Install the plugin (needs Node.js 18 or later):

   ```
   /plugin marketplace add nqh98/browser-agent-extension
   /plugin install browser-agent@browser-agent-extension
   ```

   For a local copy, replace `nqh98/browser-agent-extension` with the folder path. Or skip the plugin: `claude mcp add browser-agent -- node /path/to/browser-agent-extension/claude-code/server/index.js`.
2. Restart Claude Code.
3. In the side panel, choose **Control from Claude Code**. The panel connects by itself; each session shows as a row with its own color, state, tab count and a **Stop** button. The header shows **Claude Code ×2** when two sessions are connected.
4. Keep the side panel open and give Claude Code a browser task, for example "open example.com and summarize the page". Claude Code can call the `bridge_status` tool to check the connection.

How it works:

- The `mcp__browser-agent__*` tools (`navigate`, `read_page`, `find`, `left_click`, `form_input`, `screenshot`…) map to the extension's member tools with the same inputs.
- Site approvals, the automation level, sensitive-action checks and optional tools apply just as in the panel. Claude Code waits until you answer (up to 10 minutes).
- Confirm right in the terminal: Claude Code shows "MCP server "browser-agent" requests your input". **Accept** allows, **Decline** or Esc denies. The preset **Scope** field can widen an approval to "for the rest of the task", or "always allow" for a site; sensitive actions only offer Accept/Decline. The panel shows a confirmation card at the same time; whichever you answer first closes the other. To ask only in the panel: **Settings → Claude Code connection → Ask for confirmation in → Panel only**. When Claude Code runs non-interactively (`claude -p`), a terminal question counts as denied, so answer in the panel or use the "sensitive actions only" level.
- Every action is logged in the panel with the session's name. **Stop** on a session's row interrupts that session's running action, and the next call tells Claude Code you stopped it.
- To let Claude Code upload files to a page, turn on **Upload files** under Optional tools and click **📎 Attach files**. The `bridge_status` tool lists those files as `doc-N`.
- After 3 minutes without tool calls, the extension releases its tabs and Chrome's debugging bar disappears.
- Security: the server listens only on `127.0.0.1` and accepts only connections whose origin is this extension's ID (`chrome-extension://eboigejnblbcifgbpgaadonkpgbdbnkc`, fixed by the `key` in `manifest.json`). Browsers set the origin themselves, so web pages and other extensions cannot fake it. On a computer shared with other OS users, also set `BROWSER_AGENT_TOKEN` for Claude Code and enter the same value in the panel's Token field. If you repackage the extension with another key, set `BROWSER_AGENT_EXTENSION_ID` for the server.

Several terminals at once:

- Each Claude Code session takes the first free port in `18765`–`18774`, and the panel connects to all 10. Up to 10 sessions can run side by side. Change the range with `BROWSER_AGENT_PORT` (the first port) and the panel's **First port** field.
- Each session is labeled with the folder Claude Code runs in (override with `BROWSER_AGENT_LABEL`). The label has its own color and shows on the session's row, in the action log, on confirmation cards and in terminal questions.
- Each session has its own tabs, site approvals and state. An open tab belongs to the first session that uses it; another session's `new_tab` opens in a window of its own, so sessions do not fight over the visible tab when taking screenshots.
- Closing a terminal only disconnects its own session. Port and token live under **Settings → Advanced**, needed only if you change `BROWSER_AGENT_PORT` or set `BROWSER_AGENT_TOKEN`.

### After an update

Claude Code keeps an MCP server running once started, so after the plugin is updated, open sessions still run the old code. The panel and the server detect this and say what to do:

- The panel marks the session's row **old plugin**, or reports "Port …: a Claude Code session is running an old plugin". In that session's terminal, type `/mcp` → choose **browser-agent** → **Reconnect**. The panel picks the session up again within seconds, with nothing else to do.
- Claude Code reports that the extension is older than the plugin: go to `chrome://extensions`, reload **Browser Agent**, then reopen the side panel.
- You never need to set ports by hand: each session takes a free one.

## Permissions and safety

- You must allow each site before the agent reads or acts on it.
- The default level asks before every action that changes the page.
- The "sensitive actions only" level still asks for actions that look consequential, such as buying, deleting, sending, or typing into a password field. Detection is keyword-based (English and Vietnamese) and can miss some.
- Page content and screenshots are sent to Claude. Use a separate Chrome profile without important accounts signed in.
- The API key is stored unencrypted in `chrome.storage.local`. Do not ship this extension with a team key.

## Frames (iframes)

- `read_page`, `find`, `get_page_text` and `ref`-based actions work inside iframes, including nested and cross-site ones.
- Same-site iframes, and `about:blank`/`srcdoc` frames, count as part of the page.
- Cross-site iframes need their own approval, as when the agent opens a new site. If you deny, the frame's content is not sent to Claude and that site is not asked again until a new chat. `find` and `get_page_text` do not ask; they skip frames that are not allowed.
- A coordinate click into a frame that is not allowed always asks.

## Optional tools

Turn them on under **Settings → Optional tools**. All four are off by default.

- **Read the page console** (`read_console`) and **Read network requests** (`read_network`): recorded only from when the agent starts acting on a tab in a task. Each read returns new entries since the previous one. Tokens, API keys and sensitive URL parameters are masked, and each entry is cut at 500 characters. Console output of out-of-process iframes is not recorded.
- **Upload files you attach** (`file_upload`): click 📎 to attach files (25 MB in total). The agent can upload only these files, by their `doc-N` id; paths on your computer are always refused. Every upload asks you.
- **Run JavaScript on the page** (`javascript_exec`): runs in the page with its full access. The code is shown in the log. At the "ask for every action" level, every run asks. At "sensitive actions only", code that looks like it sends data, reads cookies or storage, or changes the page still asks; detection is keyword-based and can miss some.

Downloads that start during a task are reported to Claude (`download_started`, `download_completed`, `download_failed`), without file paths or URL query strings.

## Current limits

- `find` matches keywords; it does not understand meaning.
- It does not work on `chrome://` pages or the Chrome Web Store.
- The conversation is lost when the side panel closes.

## Layout

- `sidepanel.*`: the interface and settings.
- `i18n.js`: English and Vietnamese display strings; `_locales/` for the extension's name and description.
- `agent.js`: the Messages API loop.
- `browser.js`: runs the `browser_toolset_20260801` member tools, joins the page tree across frames, and turns local references into tab-wide `ref_N`.
- `page-agent.js`: reads the page and keeps local references in each frame's isolated world.
- `capture.js`: records console output and network requests, masking sensitive data.
- `keys.js`: converts keys for the Chrome DevTools Protocol.
- `bridge-client.js`: connects the side panel to Claude Code's MCP server.
- `claude-code/`: the Claude Code plugin, with a dependency-free MCP server (`server/`) and a skill on using the tools.

## Tests

`tests/e2e/run.js` loads the extension into Chromium with Playwright, mocks the Claude API with scripted responses, and runs every member tool on a local test page. Every request is checked against the `browser_toolset_20260801` format rules (`toolset_name`, `browser_state`, batch halt messages, image sizes). `tests/e2e/bridge.js` runs the real MCP server and drives it like Claude Code, including terminal confirmations, several sessions at once, and both languages. No API key needed.

```sh
npm i -D playwright   # if not installed
node tests/e2e/run.js
node tests/e2e/bridge.js   # Claude Code → MCP server → extension
```
