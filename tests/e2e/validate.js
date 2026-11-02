// Checks every request body against the browser_toolset_20260801 client rules.
const TAB_MEMBERS = new Set(['new_tab', 'list_tabs', 'switch_tab', 'close_tab']);
const BAD = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function jpegSize(b64) {
  const buf = Buffer.from(b64, 'base64');
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

function checkState(s, where, errs) {
  if (!Array.isArray(s.tabs) || !s.tabs.length) errs.push(`${where}: browser_state with empty/missing tabs`);
  else {
    const active = s.tabs.filter((t) => t.active === true);
    if (active.length !== 1) errs.push(`${where}: ${active.length} active tabs`);
    const ids = new Set(s.tabs.map((t) => t.tab_id));
    if (ids.size !== s.tabs.length) errs.push(`${where}: duplicate tab_id`);
    for (const t of s.tabs) for (const k of ['tab_id', 'title', 'url']) {
      if (typeof t[k] !== 'string') errs.push(`${where}: tab.${k} not string`);
      else if (t[k].length > 4096 || BAD.test(t[k])) errs.push(`${where}: tab.${k} invalid`);
    }
    if (s.tabs.length > 100) errs.push(`${where}: >100 tabs`);
  }
  if ('state_changes' in s) {
    if (!Array.isArray(s.state_changes) || !s.state_changes.length) errs.push(`${where}: empty state_changes`);
    for (const c of s.state_changes || []) {
      if (c.type === 'tab_opened' && !s.tabs?.some((t) => t.tab_id === c.tab_id)) errs.push(`${where}: tab_opened not in tabs`);
    }
  }
}

function validate(body, imageSizes) {
  const errs = [];
  if (JSON.stringify(body.tools) !== JSON.stringify([{ type: 'browser_toolset_20260801' }])) errs.push('tools entry changed');
  const msgs = body.messages;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const uses = m.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) continue;
    const next = msgs[i + 1];
    if (!next) continue;
    const results = (Array.isArray(next.content) ? next.content : []).filter((b) => b.type === 'tool_result');
    if (results.length !== uses.length) errs.push(`msg ${i}: ${uses.length} tool_use vs ${results.length} tool_result`);
    uses.forEach((u, k) => {
      const r = results[k];
      const where = `msg ${i + 1} ${u.name}`;
      if (!r || r.tool_use_id !== u.id) return errs.push(`${where}: result order/id mismatch`);
      if (u.toolset_name === 'browser' && r.toolset_name !== 'browser') errs.push(`${where}: toolset_name not echoed`);
      if (u.toolset_name !== 'browser' && 'toolset_name' in r) errs.push(`${where}: toolset_name on non-member`);
      const content = typeof r.content === 'string' ? [{ type: 'text', text: r.content }] : r.content;
      if (!Array.isArray(content)) return errs.push(`${where}: content not string/array`);
      for (const b of content) if (!['text', 'image', 'browser_state'].includes(b.type)) errs.push(`${where}: bad block ${b.type}`);
      const states = content.filter((b) => b.type === 'browser_state');
      if (states.length > 1) errs.push(`${where}: >1 browser_state`);
      if (r.is_error) {
        if (states.length) errs.push(`${where}: browser_state on error`);
        return;
      }
      states.forEach((s) => checkState(s, where, errs));
      if (TAB_MEMBERS.has(u.name)) {
        if (content.length !== 1 || states.length !== 1) errs.push(`${where}: tab member must return exactly one browser_state (got ${content.map((b) => b.type)})`);
        if (u.name === 'new_tab') {
          const opened = (states[0]?.state_changes || []).filter((c) => c.type === 'tab_opened');
          const active = states[0]?.tabs?.find((t) => t.active);
          if (opened.length !== 1 || opened[0].tab_id !== active?.tab_id) errs.push(`${where}: new_tab tab_opened mismatch`);
        }
      }
      const imgs = content.filter((b) => b.type === 'image');
      if ((u.name === 'screenshot' || u.name === 'zoom') && !imgs.length) {
        // older images may have been replaced by placeholders, which is allowed
        if (!content.some((b) => /Older screenshot removed/.test(b.text || ''))) errs.push(`${where}: no image`);
      }
      for (const img of imgs) {
        const size = jpegSize(img.source.data);
        if (!size) { errs.push(`${where}: undecodable image`); continue; }
        if (Math.max(size.w, size.h) > 1568) errs.push(`${where}: image too large ${size.w}x${size.h}`);
        if (u.name === 'screenshot') imageSizes.add(`${size.w}x${size.h}`);
      }
    });
  }
  return errs;
}
module.exports = { validate, jpegSize };
