/**
 * SugarGacha — main process
 *
 * - Frameless, transparent, always-on-top floating widget.
 * - The window is NON-ACTIVATING (focusable: false). Clicking the widget never steals
 *   keyboard focus from the app you were typing in, so the caret stays in whatever
 *   chat box you last clicked (Antigravity, Gemini, ChatGPT, Cursor, VS Code ...).
 * - After a spin, the English prompt is written to the clipboard and (optionally)
 *   a native Ctrl+V is sent to that focused input box.
 * - 100% offline. No network requests, no telemetry, no external APIs.
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  screen,
  Tray,
  Menu,
  nativeImage,
  shell
} = require('electron');
const path = require('path');
const fs = require('fs');
const pkg = require('./package.json');

// The only URL this app will ever open — in your default browser, and only when you click it.
const REPO_URL = pkg.homepage;
const STAR_NUDGE_AFTER_SPINS = 10;

const COLLAPSED_SIZE = { width: 88, height: 88 };
const EXPANDED_SIZE = { width: 376, height: 576 };
const IS_WIN = process.platform === 'win32';

let mainWindow = null;
let tray = null;
let isExpanded = false;
let savedCollapsedPos = null;
let movedWhileExpanded = false;

// ------------------------------------------------------------------
// Settings (persisted as JSON in the per-user app data folder)
// ------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  autoPaste: true, // send Ctrl+V into the focused input box after copying
  autoEnter: false, // also press Enter (send the message) after pasting
  sound: true,
  launchAtLogin: false,
  position: null,
  spinCount: 0,
  starNudgeShown: false
};
const INTERNAL_KEYS = ['position', 'spinCount', 'starNudgeShown'];

let settings = { ...DEFAULT_SETTINGS };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) {
    /* non-fatal */
  }
}

function updateSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS) || INTERNAL_KEYS.includes(key)) return settings;
  settings[key] = value;
  if (key === 'launchAtLogin') {
    app.setLoginItemSettings({ openAtLogin: !!value });
  }
  saveSettings();
  broadcastSettings();
  return settings;
}

function broadcastSettings() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings-changed', publicSettings());
  }
  rebuildTrayMenu();
}

function publicSettings() {
  const { position, spinCount, starNudgeShown, ...rest } = settings;
  return { ...rest, autoPasteAvailable: !!getUser32() };
}

function openRepo() {
  if (typeof REPO_URL === 'string' && REPO_URL.startsWith('https://github.com/')) {
    shell.openExternal(REPO_URL);
  }
}

// ------------------------------------------------------------------
// Native keyboard injection (Windows) via koffi FFI — no compiler needed
// ------------------------------------------------------------------
let user32 = undefined;
function getUser32() {
  if (user32 !== undefined) return user32;
  user32 = null;
  if (!IS_WIN) return user32;
  try {
    const koffi = require('koffi');
    const lib = koffi.load('user32.dll');
    const k32 = koffi.load('kernel32.dll');
    user32 = {
      keybd_event: lib.func(
        'void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)'
      ),
      GetForegroundWindow: lib.func('void * __stdcall GetForegroundWindow()'),
      GetWindowTextLengthW: lib.func('int __stdcall GetWindowTextLengthW(void *hWnd)'),
      GetWindowThreadProcessId: lib.func(
        'uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)'
      ),
      GetAsyncKeyState: lib.func('int16_t __stdcall GetAsyncKeyState(int vKey)'),
      OpenProcess: k32.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
      QueryFullProcessImageNameW: k32.func(
        'int __stdcall QueryFullProcessImageNameW(void *hProcess, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)'
      ),
      CloseHandle: k32.func('int __stdcall CloseHandle(void *h)'),
      koffi
    };
  } catch (err) {
    console.warn('[SugarGacha] Auto-paste unavailable (koffi failed to load):', err.message);
    user32 = null;
  }
  return user32;
}

const VK = { SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, LWIN: 0x5b, RETURN: 0x0d, V: 0x56 };
const KEYEVENTF_KEYUP = 0x0002;

// Friendly display names for common apps (by executable name). Anything else is shown as-is.
const APP_NAMES = {
  antigravity: 'Antigravity',
  chrome: 'Chrome',
  msedge: 'Edge',
  firefox: 'Firefox',
  brave: 'Brave',
  opera: 'Opera',
  arc: 'Arc',
  code: 'VS Code',
  'code - insiders': 'VS Code Insiders',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  zed: 'Zed',
  idea64: 'IntelliJ IDEA',
  pycharm64: 'PyCharm',
  webstorm64: 'WebStorm',
  windowsterminal: 'Windows Terminal',
  wt: 'Windows Terminal',
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  notepad: 'Notepad',
  'notepad++': 'Notepad++',
  obsidian: 'Obsidian',
  discord: 'Discord',
  slack: 'Slack'
};

function processNameOf(hwnd) {
  const u = user32;
  const pid = [0];
  u.GetWindowThreadProcessId(hwnd, pid);
  if (!pid[0]) return null;
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const h = u.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid[0]);
  if (!h) return null;
  try {
    const buf = new Uint16Array(1024);
    const size = [1024];
    if (!u.QueryFullProcessImageNameW(h, 0, buf, size)) return null;
    const full = String.fromCharCode(...buf.slice(0, size[0]));
    return path.basename(full).replace(/\.exe$/i, '');
  } finally {
    u.CloseHandle(h);
  }
}

// Returns { app } for the window that currently has keyboard focus, or null if there is
// nothing sensible to paste into. Only the app's executable name is read — never window
// titles or contents — so screenshots/recordings of the widget don't leak what you're doing.
function getForegroundTarget() {
  const u = getUser32();
  if (!u) return null;
  try {
    const hwnd = u.GetForegroundWindow();
    if (!hwnd) return null;
    const addr = u.koffi.address(hwnd);
    // Ignore our own widget window (should never be foreground since it's non-activating)
    if (mainWindow && !mainWindow.isDestroyed()) {
      const own = mainWindow.getNativeWindowHandle();
      const ownAddr = own.length >= 8 ? own.readBigUInt64LE(0) : BigInt(own.readUInt32LE(0));
      if (BigInt(addr) === ownAddr) return null;
    }
    const exe = processNameOf(hwnd);
    if (!exe) return null;
    const key = exe.toLowerCase();
    // Desktop / taskbar / Start menu: nothing to paste into
    if (key === 'explorer' && u.GetWindowTextLengthW(hwnd) === 0) return null;
    if (['searchhost', 'startmenuexperiencehost', 'shellexperiencehost', 'lockapp'].includes(key)) return null;
    const app = APP_NAMES[key] || exe.charAt(0).toUpperCase() + exe.slice(1);
    return { app };
  } catch (e) {
    return null;
  }
}

function tap(vk, up) {
  user32.keybd_event(vk, 0, up ? KEYEVENTF_KEYUP : 0, 0);
}

function releaseStuckModifiers() {
  [VK.SHIFT, VK.MENU, VK.LWIN].forEach((vk) => {
    if (user32.GetAsyncKeyState(vk) & 0x8000) tap(vk, true);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendPaste(pressEnter) {
  releaseStuckModifiers();
  tap(VK.CONTROL, false);
  tap(VK.V, false);
  tap(VK.V, true);
  tap(VK.CONTROL, true);
  if (pressEnter) {
    await sleep(140);
    tap(VK.RETURN, false);
    tap(VK.RETURN, true);
  }
}

// ------------------------------------------------------------------
// Window
// ------------------------------------------------------------------
function clampToWorkArea(x, y, w, h) {
  const display = screen.getDisplayMatching({ x, y, width: w, height: h });
  const wa = display.workArea;
  const nx = Math.min(Math.max(x, wa.x), wa.x + wa.width - w);
  const ny = Math.min(Math.max(y, wa.y), wa.y + wa.height - h);
  return { x: Math.round(nx), y: Math.round(ny) };
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  let start = settings.position || {
    x: wa.x + wa.width - COLLAPSED_SIZE.width - 36,
    y: wa.y + wa.height - COLLAPSED_SIZE.height - 80
  };
  start = clampToWorkArea(start.x, start.y, COLLAPSED_SIZE.width, COLLAPSED_SIZE.height);
  savedCollapsedPos = start;

  mainWindow = new BrowserWindow({
    width: COLLAPSED_SIZE.width,
    height: COLLAPSED_SIZE.height,
    x: start.x,
    y: start.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false, // <- the key trick: never steal focus from your chat box
    show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.showInactive());

  // Hard offline guarantee: block any navigation / new windows / remote requests
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.session.webRequest.onBeforeRequest((details, cb) => {
    const ok = details.url.startsWith('file://') || details.url.startsWith('devtools://') || details.url.startsWith('data:');
    cb({ cancel: !ok });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setExpanded(target) {
  if (!mainWindow) return;
  const b = mainWindow.getBounds();

  if (target && !isExpanded) {
    isExpanded = true;
    movedWhileExpanded = false;
    savedCollapsedPos = { x: b.x, y: b.y };
    const want = clampToWorkArea(
      b.x + COLLAPSED_SIZE.width - EXPANDED_SIZE.width,
      b.y + COLLAPSED_SIZE.height - EXPANDED_SIZE.height,
      EXPANDED_SIZE.width,
      EXPANDED_SIZE.height
    );
    mainWindow.setResizable(true);
    mainWindow.setBounds({ ...want, ...EXPANDED_SIZE });
    mainWindow.setResizable(false);
  } else if (!target && isExpanded) {
    isExpanded = false;
    const base =
      !movedWhileExpanded && savedCollapsedPos
        ? savedCollapsedPos
        : {
            x: b.x + EXPANDED_SIZE.width - COLLAPSED_SIZE.width,
            y: b.y + EXPANDED_SIZE.height - COLLAPSED_SIZE.height
          };
    const pos = clampToWorkArea(base.x, base.y, COLLAPSED_SIZE.width, COLLAPSED_SIZE.height);
    mainWindow.setResizable(true);
    mainWindow.setBounds({ ...pos, ...COLLAPSED_SIZE });
    mainWindow.setResizable(false);
    settings.position = pos;
    saveSettings();
  }
}

// ------------------------------------------------------------------
// Tray
// ------------------------------------------------------------------
function rebuildTrayMenu() {
  if (!tray) return;
  const pasteOK = !!getUser32();
  const menu = Menu.buildFromTemplate([
    { label: 'SugarGacha 🍬', enabled: false },
    { type: 'separator' },
    {
      label: mainWindow && mainWindow.isVisible() ? 'Hide widget' : 'Show widget',
      click: toggleVisibility
    },
    { type: 'separator' },
    {
      label: pasteOK ? 'Auto-paste into focused input' : 'Auto-paste (unavailable on this OS)',
      type: 'checkbox',
      enabled: pasteOK,
      checked: pasteOK && settings.autoPaste,
      click: (i) => updateSetting('autoPaste', i.checked)
    },
    {
      label: 'Press Enter after paste (auto-send)',
      type: 'checkbox',
      enabled: pasteOK && settings.autoPaste,
      checked: settings.autoEnter,
      click: (i) => updateSetting('autoEnter', i.checked)
    },
    {
      label: 'Sound effects',
      type: 'checkbox',
      checked: settings.sound,
      click: (i) => updateSetting('sound', i.checked)
    },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: settings.launchAtLogin,
      click: (i) => updateSetting('launchAtLogin', i.checked)
    },
    { type: 'separator' },
    { label: '⭐ Star SugarGacha on GitHub', click: openRepo },
    { label: 'Reset widget position', click: resetPosition },
    { label: 'Quit SugarGacha', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
}

function toggleVisibility() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) mainWindow.hide();
  else mainWindow.showInactive();
  rebuildTrayMenu();
}

function resetPosition() {
  if (!mainWindow) return;
  if (isExpanded) setExpanded(false);
  const wa = screen.getPrimaryDisplay().workArea;
  const pos = {
    x: wa.x + wa.width - COLLAPSED_SIZE.width - 36,
    y: wa.y + wa.height - COLLAPSED_SIZE.height - 80
  };
  mainWindow.setPosition(pos.x, pos.y);
  mainWindow.webContents.send('force-collapse');
  settings.position = pos;
  saveSettings();
  mainWindow.showInactive();
}

function createTray() {
  const img = nativeImage
    .createFromPath(path.join(__dirname, 'build', 'icon.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('SugarGacha — feed your AI some candy');
  tray.on('click', toggleVisibility);
  rebuildTrayMenu();
}

// ------------------------------------------------------------------
// IPC
// ------------------------------------------------------------------
ipcMain.on('set-widget-state', (e, expanded) => setExpanded(!!expanded));

let dragCursor = null;
let dragWin = null;
ipcMain.on('window-drag-start', () => {
  if (!mainWindow) return;
  dragCursor = screen.getCursorScreenPoint();
  const b = mainWindow.getBounds();
  dragWin = { x: b.x, y: b.y };
});
ipcMain.on('window-drag-move', () => {
  if (!mainWindow || !dragCursor) return;
  const c = screen.getCursorScreenPoint();
  const dx = c.x - dragCursor.x;
  const dy = c.y - dragCursor.y;
  if (isExpanded && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) movedWhileExpanded = true;
  mainWindow.setPosition(Math.round(dragWin.x + dx), Math.round(dragWin.y + dy));
});
ipcMain.on('window-drag-end', () => {
  if (mainWindow && !isExpanded && dragCursor) {
    const b = mainWindow.getBounds();
    settings.position = { x: b.x, y: b.y };
    saveSettings();
  }
  dragCursor = null;
  dragWin = null;
});

ipcMain.handle('get-settings', () => publicSettings());
ipcMain.handle('set-setting', (e, key, value) => {
  updateSetting(key, value);
  return publicSettings();
});
ipcMain.handle('get-target', () => getForegroundTarget());

// Copy the prompt and (optionally) paste it into the focused input box
ipcMain.handle('deliver-prompt', async (e, text) => {
  if (typeof text !== 'string' || !text.trim()) return { copied: false, pasted: false };
  clipboard.writeText(text);
  const result = { copied: true, pasted: false, target: null };

  if (settings.autoPaste && getUser32()) {
    const target = getForegroundTarget();
    if (target) {
      await sleep(60);
      await sendPaste(settings.autoEnter);
      result.pasted = true;
      result.target = target.app;
    }
  }
  return result;
});

ipcMain.handle('copy-only', (e, text) => {
  if (typeof text !== 'string' || !text.trim()) return false;
  clipboard.writeText(text);
  return true;
});

ipcMain.on('open-repo', openRepo);

// Counts spins locally. Returns true exactly once (after N spins) so the renderer can show
// a single, dismissible "leave a star?" note. Never shown again after that.
ipcMain.handle('record-spin', () => {
  settings.spinCount = (settings.spinCount || 0) + 1;
  let nudge = false;
  if (!settings.starNudgeShown && settings.spinCount >= STAR_NUDGE_AFTER_SPINS) {
    settings.starNudgeShown = true;
    nudge = true;
  }
  saveSettings();
  return nudge;
});

ipcMain.on('hide-widget', () => {
  if (mainWindow) mainWindow.hide();
  rebuildTrayMenu();
});
ipcMain.on('quit-app', () => app.quit());

// ------------------------------------------------------------------
// App lifecycle
// ------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) mainWindow.showInactive();
  });

  app.whenReady().then(() => {
    if (IS_WIN) app.setAppUserModelId('io.github.sugargacha');
    loadSettings();
    createWindow();
    createTray();
  });

  app.on('window-all-closed', () => app.quit());
}
