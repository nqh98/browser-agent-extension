// Injected into the extension's ISOLATED world, so page scripts cannot read or
// tamper with the reference map. Only rendered content is reported to Claude.
(() => {
  if (globalThis.__browserAgent) return;

  const MAX_CHARS = 50000;
  const refs = new Map();
  const elRefs = new WeakMap();
  let counter = 0;

  const TAG_ROLES = {
    A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'image',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', FORM: 'form',
    TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader', UL: 'list', OL: 'list',
    LI: 'listitem', SUMMARY: 'button', DIALOG: 'dialog', ASIDE: 'complementary', LABEL: 'label',
    VIDEO: 'video', AUDIO: 'audio', CANVAS: 'canvas', ARTICLE: 'article', SECTION: 'region',
    IFRAME: 'iframe', FRAME: 'iframe',
  };
  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox',
    radio: 'radio', range: 'slider', file: 'button', search: 'searchbox', number: 'spinbutton',
  };
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'combobox',
    'textbox', 'searchbox', 'slider', 'spinbutton', 'listbox',
  ]);
  const NAME_FROM_CONTENT = new Set([
    'button', 'link', 'heading', 'tab', 'menuitem', 'option', 'label', 'cell', 'columnheader',
    'listitem', 'checkbox', 'radio', 'switch',
  ]);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD']);

  // Page text must not be able to forge "[ref_N]" tags or frame placeholders in our output.
  const clean = (s, max = 120) => String(s || '').replace(/[\u0000-\u0008\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ').trim().replace(/\[(?=ref_)/gi, '(').slice(0, max);
  const FRAME_MARK = '\u0001frame:';
  const isFrame = (el) => el?.tagName === 'IFRAME' || el?.tagName === 'FRAME';

  // ---- Frames ----
  // Chrome gives content scripts no way to map an <iframe> element to its frameId, so the
  // executor matches them with a handshake: each frame posts a random token to every child
  // frame window, and each child reports the token it received from its parent.
  let probeFromParent = null;
  addEventListener('message', (event) => {
    const token = event.data?.__browserAgentProbe;
    if (typeof token === 'string' && event.source === window.parent && window.parent !== window) {
      probeFromParent = token;
    }
  });

  function frameList() {
    const out = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot);
        if (isFrame(el)) out.push(el);
      }
    };
    visit(document);
    return out;
  }

  function probeFrames() {
    const token = crypto.randomUUID();
    frameList().forEach((frame, index) => {
      try { frame.contentWindow?.postMessage({ __browserAgentProbe: `${token}:${index}` }, '*'); } catch {}
    });
    return { token };
  }

  function whoAmI() {
    return { probe: probeFromParent, url: location.href, width: innerWidth, height: innerHeight };
  }

  /** Top-left of a child frame's content box in this frame's viewport. */
  function frameBox(index) {
    const frame = frameList()[index];
    if (!frame) throw new Error('The frame is no longer on the page. Re-read the page.');
    const r = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    return {
      x: r.left + frame.clientLeft + parseFloat(style.paddingLeft || 0),
      y: r.top + frame.clientTop + parseFloat(style.paddingTop || 0),
    };
  }

  /** Converts a point inside child frame `index` to this frame's viewport, scrolling it into view. */
  function framePoint(index, x, y) {
    let box = frameBox(index);
    let px = box.x + x;
    let py = box.y + y;
    if (px < 0 || py < 0 || px > innerWidth || py > innerHeight) {
      scrollBy({ left: px - innerWidth / 2, top: py - innerHeight / 2, behavior: 'instant' });
      box = frameBox(index);
      px = box.x + x;
      py = box.y + y;
    }
    return { x: px, y: py };
  }
  const quote = (s) => JSON.stringify(s);

  function refFor(el) {
    let ref = elRefs.get(el);
    if (!ref) {
      ref = `ref_${++counter}`;
      elRefs.set(el, ref);
      refs.set(ref, new WeakRef(el));
    }
    return ref;
  }

  function getEl(ref) {
    const el = refs.get(ref)?.deref();
    if (!el || !el.isConnected) {
      throw new Error(`${ref} is stale or not found on the current page. Re-read the page to get fresh references.`);
    }
    return el;
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    if (el.tagName === 'INPUT') return INPUT_ROLES[(el.type || 'text').toLowerCase()] || 'textbox';
    if (el.tagName === 'A' && !el.hasAttribute('href')) return '';
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    return TAG_ROLES[el.tagName] || '';
  }

  /** Label text without the labelled control's own text (e.g. a wrapped select's options). */
  function labelText(label, control) {
    let text = '';
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (control.contains(node) || parent?.closest('select, textarea, script, style')) continue;
      text += ` ${node.textContent}`;
    }
    return text;
  }

  function nameOf(el, role) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id)?.innerText || '').join(' ');
      if (clean(text)) return clean(text);
    }
    if (el.labels?.length) {
      const text = [...el.labels].map((l) => labelText(l, el)).join(' ');
      if (clean(text)) return clean(text);
    }
    const attr = el.getAttribute('alt') || el.getAttribute('placeholder') || el.getAttribute('title');
    if (attr) return clean(attr);
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value);
    if (NAME_FROM_CONTENT.has(role)) return clean(el.innerText);
    return '';
  }

  function isSecretField(el) {
    const autocomplete = (el.getAttribute?.('autocomplete') || '').toLowerCase();
    return el.type === 'password' || autocomplete.startsWith('cc-')
      || autocomplete.includes('password') || autocomplete === 'one-time-code';
  }

  function stateOf(el, role) {
    const parts = [];
    if (el.tagName === 'A' && el.href && el.protocol.startsWith('http')) parts.push(`href=${quote(el.href.slice(0, 300))}`);
    if (/^H[1-6]$/.test(el.tagName)) parts.push(`level=${el.tagName[1]}`);
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
      if (el.type === 'checkbox' || el.type === 'radio') parts.push(el.checked ? 'checked' : 'unchecked');
      else if (isSecretField(el)) parts.push(el.value ? 'value=[hidden]' : 'empty');
      else if (el.tagName === 'SELECT') {
        parts.push(`selected=${quote(clean(el.selectedOptions[0]?.text))}`);
        parts.push(`options=${quote([...el.options].slice(0, 30).map((o) => clean(o.text, 40)).join(' | '))}`);
      } else if (el.value && role !== 'button') parts.push(`value=${quote(clean(el.value, 200))}`);
      if (el.tagName === 'INPUT' && el.type && !['text', 'submit', 'button'].includes(el.type)) parts.push(`type=${el.type}`);
    }
    if (el.disabled) parts.push('disabled');
    for (const attr of ['aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed']) {
      const value = el.getAttribute(attr);
      if (value !== null) parts.push(`${attr.slice(5)}=${value}`);
    }
    return parts.join(' ');
  }

  function isRendered(el) {
    if (el.getAttribute('aria-hidden') === 'true' || el.hidden) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width >= 2 && rect.height >= 2) return true;
    return style.display === 'contents' || el.childElementCount > 0;
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.tagName === 'INPUT' && el.type !== 'hidden') return true;
    if (el.hasAttribute('onclick')) return true;
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) >= 0) return true;
    return getComputedStyle(el).cursor === 'pointer'
      && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer');
  }

  function ownText(el) {
    let text = '';
    for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    return clean(text, 200);
  }

  function describeLine(el, indent) {
    const role = roleOf(el) || (isInteractive(el, '') ? 'clickable' : '') || (ownText(el) ? 'text' : '');
    if (!role) return null;
    const name = role === 'text' ? ownText(el) : (nameOf(el, role) || ownText(el));
    const state = stateOf(el, role);
    return `${'  '.repeat(indent)}${role}${name ? ` ${quote(name)}` : ''} [${refFor(el)}]${state ? ` ${state}` : ''}`;
  }

  function readPage({ filter, depth = 15, ref } = {}) {
    const root = ref ? getEl(ref) : document.body;
    const frameIndex = new Map(frameList().map((frame, index) => [frame, index]));
    const maxDepth = Math.max(1, Number(depth) || 15);
    const lines = [];
    let chars = 0;
    let truncated = false;

    const add = (line) => {
      if (chars + line.length + 1 > MAX_CHARS) { truncated = true; return; }
      lines.push(line);
      chars += line.length + 1;
    };

    const walk = (el, level) => {
      if (truncated || SKIP_TAGS.has(el.tagName) || !isRendered(el)) return;
      const role = roleOf(el);
      const visibleEnough = filter === 'all' || inViewport(el);
      let include = false;
      if (visibleEnough) {
        include = filter === 'interactive'
          ? isInteractive(el, role)
          : Boolean(role || ownText(el) || isInteractive(el, role));
        // Unnamed structure adds noise without giving Claude anything to act on.
        if (include && filter !== 'interactive' && ['list', 'row', 'region'].includes(role) && !nameOf(el, role)) include = false;
        // Frames are always listed so their content can be nested under them.
        if (isFrame(el)) include = true;
      }
      let next = level;
      if (include) {
        const line = describeLine(el, level);
        if (line) { add(line); next = level + 1; }
        // The executor replaces this marker with the child frame's own tree.
        if (line && isFrame(el) && frameIndex.has(el) && next < maxDepth) add(`${FRAME_MARK}${frameIndex.get(el)}:${next}`);
      }
      if (next >= maxDepth) return;
      if (el.shadowRoot) for (const child of el.shadowRoot.children) walk(child, next);
      for (const child of el.children) walk(child, next);
    };

    walk(root, 0);
    let text = lines.join('\n') || 'No matching visible elements.';
    if (truncated) text += `\n[Output truncated at ${MAX_CHARS} characters. Use a smaller depth or a ref to narrow the read.]`;
    return text;
  }

  const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();

  function find({ query, raw }) {
    const tokens = fold(query).split(/\s+/).filter(Boolean);
    const matches = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot);
        if (SKIP_TAGS.has(el.tagName) || !isRendered(el)) continue;
        const role = roleOf(el) || (isInteractive(el, '') ? 'clickable' : '');
        if (!role) continue;
        const haystack = fold(`${role} ${nameOf(el, role)} ${el.getAttribute('name') || ''} ${el.id || ''} ${ownText(el)}`);
        const score = tokens.filter((t) => haystack.includes(t)).length;
        if (score) matches.push({ el, score: score + (isInteractive(el, role) ? 0.5 : 0) });
      }
    };
    visit(document);
    matches.sort((a, b) => b.score - a.score);
    if (raw) return matches.slice(0, 20).map((m) => ({ score: m.score, line: describeLine(m.el, 0) })).filter((m) => m.line);
    const lines = matches.slice(0, 20).map((m) => describeLine(m.el, 0)).filter(Boolean);
    return lines.join('\n') || `No elements matched "${query}". Try read_page or a screenshot.`;
  }

  function getPageText() {
    const root = document.querySelector('main, article, [role="main"]') || document.body;
    let text = (root.innerText || '').trim();
    if (text.length < 200 && root !== document.body) text = (document.body.innerText || '').trim();
    if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n[Output truncated at ${MAX_CHARS} characters.]`;
    return text || 'The page has no visible text.';
  }

  function locate(ref) {
    const el = getEl(ref);
    const before = el.getBoundingClientRect();
    if (before.top < 0 || before.left < 0 || before.bottom > innerHeight || before.right > innerWidth) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) throw new Error(`${ref} is not visible on the page. Re-read the page or use a screenshot.`);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function labelFor(el) {
    if (!el) return { label: 'unknown element', secret: false };
    const target = el.closest('a, button, input, select, textarea, summary, [role], [onclick]') || el;
    const role = roleOf(target);
    const form = target.form || target.closest('form');
    const label = `${role || target.tagName.toLowerCase()} "${nameOf(target, role) || clean(target.innerText, 80)}"`;
    return { label, secret: isSecretField(target), inForm: Boolean(form) };
  }

  function describeRef(ref) { return labelFor(getEl(ref)); }
  function describePoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (isFrame(el)) {
      const index = frameList().indexOf(el);
      const box = frameBox(index);
      return { frame: index, x: x - box.x, y: y - box.y, ...labelFor(el) };
    }
    return labelFor(el);
  }

  function describeFocus() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    if (isFrame(el)) return { frame: frameList().indexOf(el), ...labelFor(el) };
    const info = labelFor(el);
    const form = el?.form || el?.closest?.('form');
    const submit = form?.querySelector('[type="submit"], button:not([type])');
    if (submit) info.submitLabel = clean(submit.value || submit.innerText, 80);
    return info;
  }

  function formInput(ref, value) {
    const el = getEl(ref);
    const fire = () => {
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    };
    if (el.tagName === 'SELECT') {
      const wanted = String(value);
      const option = [...el.options].find((o) => o.value === wanted || clean(o.text) === clean(wanted));
      if (!option) throw new Error(`No option matching ${quote(wanted)} in ${ref}.`);
      el.value = option.value;
      fire();
    } else if (el.type === 'checkbox' || el.type === 'radio') {
      const wanted = typeof value === 'string' ? !/^(false|0|off|no|unchecked)?$/i.test(value.trim()) : Boolean(value);
      if (wanted !== el.checked) el.click();
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.focus();
      el.value = String(value);
      fire();
    } else if (el.isContentEditable) {
      el.focus();
      el.textContent = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    } else {
      throw new Error(`${ref} is not a form element.`);
    }
    return `Set value of ${ref}.`;
  }

  function setFiles(ref, files) {
    const el = getEl(ref);
    if (el.tagName !== 'INPUT' || el.type !== 'file') throw new Error(`${ref} is not a file input.`);
    if (el.disabled) throw new Error(`${ref} is disabled.`);
    if (files.length > 1 && !el.multiple) throw new Error(`${ref} accepts only one file.`);
    const transfer = new DataTransfer();
    for (const file of files) {
      const binary = atob(file.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      transfer.items.add(new File([bytes], file.name, { type: file.type || 'application/octet-stream', lastModified: file.lastModified }));
    }
    el.files = transfer.files;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return `Set ${files.length} file(s) on ${ref}: ${files.map((f) => f.name).join(', ')}.`;
  }

  function scrollTo(ref) {
    getEl(ref).scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return `Scrolled ${ref} into view.`;
  }

  globalThis.__browserAgent = {
    readPage, find, getPageText, locate, describeRef, describePoint, describeFocus, formInput, scrollTo,
    setFiles, probeFrames, whoAmI, frameBox, framePoint,
  };
})();
