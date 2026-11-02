// Translates Claude's key strings ("Enter", "ctrl+a", "Backspace Backspace") to CDP key data.
const NAMED = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  insert: { key: 'Insert', code: 'Insert', vk: 45 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = { key: `F${i}`, code: `F${i}`, vk: 111 + i };

export const MODIFIERS = {
  alt: { bit: 1, key: 'Alt', code: 'AltLeft', vk: 18 },
  option: { bit: 1, key: 'Alt', code: 'AltLeft', vk: 18 },
  ctrl: { bit: 2, key: 'Control', code: 'ControlLeft', vk: 17 },
  control: { bit: 2, key: 'Control', code: 'ControlLeft', vk: 17 },
  meta: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  cmd: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  command: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  super: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  win: { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 },
  shift: { bit: 8, key: 'Shift', code: 'ShiftLeft', vk: 16 },
};

const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };

function keyDef(raw, shift) {
  const named = NAMED[raw.toLowerCase()];
  if (named) return { ...named };
  if ([...raw].length !== 1) throw new Error(`Unknown key: ${raw}`);
  const lower = raw.toLowerCase();
  if (/[a-z]/.test(lower)) {
    const char = shift ? lower.toUpperCase() : raw;
    return { key: char, code: `Key${lower.toUpperCase()}`, vk: lower.toUpperCase().charCodeAt(0), text: char };
  }
  if (/\d/.test(raw)) return { key: raw, code: `Digit${raw}`, vk: raw.charCodeAt(0), text: raw };
  return { key: raw, code: '', vk: 0, text: raw };
}

export function parseChord(chord) {
  const parts = chord.endsWith('++') ? [...chord.slice(0, -2).split('+').filter(Boolean), '+'] : chord.split('+');
  const last = parts.pop();
  const modifiers = parts.map((part) => {
    const mod = MODIFIERS[part.toLowerCase()];
    if (!mod) throw new Error(`Unknown modifier: ${part}`);
    return mod;
  });
  const mask = modifiers.reduce((sum, mod) => sum | mod.bit, 0);
  const def = keyDef(last, Boolean(mask & 8));
  if (mask & 7) delete def.text;
  const command = mask & 6 ? EDIT_COMMANDS[last.toLowerCase()] : undefined;
  return { modifiers, mask, def, command };
}

export function parseKeySequence(text) {
  const trimmed = String(text).trim();
  if (!trimmed) throw new Error('Key text is empty.');
  return trimmed.split(/\s+/).map(parseChord);
}

export function modifierMask(text) {
  if (!text) return 0;
  return String(text).split('+').reduce((mask, part) => {
    const mod = MODIFIERS[part.trim().toLowerCase()];
    if (!mod) throw new Error(`Unknown modifier: ${part}`);
    return mask | mod.bit;
  }, 0);
}
