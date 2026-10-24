/**
 * SugarGacha — renderer
 * Two-stage gacha: 5-persona candy wheel → 01-40 slot machine → particles + copy/paste.
 * Works inside Electron (window.sugar bridge) and as a plain web page (preview mode).
 */
(function () {
  'use strict';

  const bridge = window.sugar || null; // null => running in a normal browser

  const PERSONAS = [
    { key: 'mint', icon: '🧊', name: 'Cool Mint', wheel: 'MINT', role: 'Tsundere Perfectionist', color: '#2dd4bf', colorDark: '#0f766e', glow: 'rgba(45, 212, 191, 0.48)' },
    { key: 'berry', icon: '🍓', name: 'Sweet Berry', wheel: 'BERRY', role: 'Wholesome Cheerleader', color: '#fb7185', colorDark: '#be123c', glow: 'rgba(251, 113, 133, 0.48)' },
    { key: 'volt', icon: '⚡', name: 'Volt Pop', wheel: 'VOLT', role: 'Mad Genius Partner', color: '#facc15', colorDark: '#6d28d9', glow: 'rgba(250, 204, 21, 0.5)' },
    { key: 'dark', icon: '☕', name: 'Dark Espresso', wheel: 'ESPRESSO', role: 'Hardcore Cyberpunk Mentor', color: '#f59e0b', colorDark: '#27272a', glow: 'rgba(245, 158, 11, 0.42)' },
    { key: 'royal', icon: '👑', name: 'Royal Sundae', wheel: 'SUNDAE', role: 'Dramatic Bard of Praise', color: '#fde047', colorDark: '#b91c1c', glow: 'rgba(253, 224, 71, 0.52)' }
  ];

  let settings = {
    autoPaste: true,
    autoEnter: false,
    sound: true,
    autoPasteAvailable: !!bridge
  };
  let isSpinning = false;
  let wheelAngle = 0;
  let currentEnglish = '';

  const $ = (id) => document.getElementById(id);
  const collapsedView = $('collapsed-view');
  const dragHandle = $('panel-drag-handle');
  const wheelCanvas = $('wheel-canvas');
  const wheelPointer = $('wheel-pointer');
  const btnSpinCenter = $('btn-spin-center');
  const btnSpinMain = $('btn-spin-main');
  const pills = document.querySelectorAll('.persona-pill');
  const settingsPop = $('settings-pop');
  const btnSettings = $('btn-settings');
  const toggleRows = document.querySelectorAll('.toggle-row');
  const slotStageText = $('slot-stage-text');
  const slotPersonaTitle = $('slot-persona-title');
  const reelTens = $('reel-tens');
  const reelOnes = $('reel-ones');
  const digitTens = $('digit-tens');
  const digitOnes = $('digit-ones');
  const resultBadge = $('result-badge');
  const enOutput = $('en-output');
  const toast = $('toast-popup');
  const targetHint = $('target-hint');
  const fxCanvas = $('fx-canvas');
  const starNudge = $('star-nudge');
  const REPO_URL = (window.SUGAR_CONFIG && window.SUGAR_CONFIG.repo) || '';

  // ------------------------------------------------------------------
  // "Star on GitHub" — a small button, plus ONE dismissible note after 10 spins (never again)
  // ------------------------------------------------------------------
  function openRepo() {
    if (bridge) bridge.openRepo();
    else if (REPO_URL) window.open(REPO_URL, '_blank', 'noopener');
  }
  function hideNudge() {
    starNudge.classList.remove('show');
  }
  $('btn-star').addEventListener('click', openRepo);
  $('btn-nudge-star').addEventListener('click', () => {
    openRepo();
    hideNudge();
  });
  $('btn-nudge-close').addEventListener('click', hideNudge);

  async function countSpinAndMaybeNudge() {
    let show = false;
    if (bridge) {
      show = await bridge.recordSpin();
    } else {
      try {
        const n = Number(localStorage.getItem('sg_spins') || 0) + 1;
        localStorage.setItem('sg_spins', String(n));
        if (n >= 10 && !localStorage.getItem('sg_nudged')) {
          localStorage.setItem('sg_nudged', '1');
          show = true;
        }
      } catch (e) {}
    }
    if (show) setTimeout(() => starNudge.classList.add('show'), 3000);
  }

  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------
  function applySettings(s) {
    settings = { ...settings, ...s };
    toggleRows.forEach((row) => {
      const key = row.dataset.setting;
      row.classList.toggle('on', !!settings[key]);
      let disabled = false;
      if (key === 'autoPaste') disabled = !settings.autoPasteAvailable;
      if (key === 'autoEnter') disabled = !settings.autoPasteAvailable || !settings.autoPaste;
      row.classList.toggle('disabled', disabled);
    });
    refreshTargetHint();
  }

  toggleRows.forEach((row) => {
    row.addEventListener('click', async () => {
      const key = row.dataset.setting;
      const value = !settings[key];
      if (bridge) applySettings(await bridge.setSetting(key, value));
      else applySettings({ [key]: value });
    });
  });

  btnSettings.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsPop.classList.toggle('open');
    btnSettings.classList.toggle('active', settingsPop.classList.contains('open'));
  });
  document.addEventListener('mousedown', (e) => {
    if (!settingsPop.contains(e.target) && e.target !== btnSettings) {
      settingsPop.classList.remove('open');
      btnSettings.classList.remove('active');
    }
  });

  // ------------------------------------------------------------------
  // Paste-target hint ("→ Pastes into: <window title>")
  // ------------------------------------------------------------------
  let hintTimer = null;
  function shorten(t, n) {
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  async function refreshTargetHint() {
    if (!document.body.classList.contains('mode-expanded')) return;
    targetHint.classList.remove('warn');
    if (!bridge) {
      targetHint.innerHTML = 'Web preview · <b>copy only</b> (download the app for auto-paste)';
      return;
    }
    if (!settings.autoPasteAvailable || !settings.autoPaste) {
      targetHint.innerHTML = 'Auto-paste off · <b>copy only</b>';
      return;
    }
    const target = await bridge.getTarget();
    if (target && target.app) {
      targetHint.innerHTML = `→ Pastes into: <b></b>${settings.autoEnter ? ' + Enter' : ''}`;
      targetHint.querySelector('b').textContent = shorten(target.app, 40);
    } else {
      targetHint.classList.add('warn');
      targetHint.innerHTML = '→ <b>Click into your AI chat box first</b> (otherwise copy only)';
    }
  }
  function startHintLoop() {
    stopHintLoop();
    refreshTargetHint();
    hintTimer = setInterval(refreshTargetHint, 1000);
  }
  function stopHintLoop() {
    if (hintTimer) clearInterval(hintTimer);
    hintTimer = null;
  }

  // ------------------------------------------------------------------
  // Local synthesized sound (Web Audio, no files, no network)
  // ------------------------------------------------------------------
  let audioCtx = null;
  function ctx() {
    if (!settings.sound) return null;
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  function tick(freq = 580, dur = 0.025) {
    const c = ctx();
    if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(freq, c.currentTime);
    g.gain.setValueAtTime(0.08, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start();
    o.stop(c.currentTime + dur);
  }
  const CHORDS = {
    mint: [523.25, 659.25, 783.99, 1046.5],
    berry: [587.33, 739.99, 880.0, 1174.66],
    volt: [440.0, 554.37, 659.25, 880.0, 1318.5],
    dark: [329.63, 440.0, 523.25, 659.25],
    royal: [523.25, 659.25, 783.99, 987.77, 1318.5]
  };
  function fanfare(key) {
    const c = ctx();
    if (!c) return;
    (CHORDS[key] || CHORDS.berry).forEach((f, i) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = key === 'volt' ? 'sawtooth' : 'sine';
      const t = c.currentTime + i * 0.065;
      o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.09, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      o.connect(g);
      g.connect(c.destination);
      o.start(t);
      o.stop(t + 0.36);
    });
  }

  // ------------------------------------------------------------------
  // Expand / collapse / drag
  // ------------------------------------------------------------------
  function setExpanded(expanded) {
    document.body.classList.toggle('mode-expanded', expanded);
    if (bridge) bridge.setExpanded(expanded);
    if (expanded) startHintLoop();
    else {
      stopHintLoop();
      settingsPop.classList.remove('open');
      btnSettings.classList.remove('active');
    }
  }

  function bindDraggable(el, onClick) {
    let down = false;
    let sx = 0;
    let sy = 0;
    let moved = false;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      down = true;
      moved = false;
      sx = e.screenX;
      sy = e.screenY;
      if (bridge) bridge.dragStart();
    });
    window.addEventListener('mousemove', (e) => {
      if (!down) return;
      if (Math.hypot(e.screenX - sx, e.screenY - sy) > 4) {
        moved = true;
        if (bridge) bridge.dragMove();
      }
    });
    window.addEventListener('mouseup', () => {
      if (!down) return;
      down = false;
      if (bridge) bridge.dragEnd();
      if (!moved && onClick) onClick();
    });
  }

  bindDraggable(collapsedView, () => setExpanded(true));
  bindDraggable(dragHandle, null);
  $('btn-collapse').addEventListener('click', () => setExpanded(false));
  $('btn-quit').addEventListener('click', () => (bridge ? bridge.quit() : setExpanded(false)));

  // ------------------------------------------------------------------
  // Wheel drawing
  // ------------------------------------------------------------------
  function drawWheel() {
    const c = wheelCanvas.getContext('2d');
    const w = wheelCanvas.width;
    const cx = w / 2;
    const cy = w / 2;
    const r = w / 2 - 4;
    const slice = 360 / PERSONAS.length;
    const base = -90 - slice / 2; // sector 0 centered under the pointer
    c.clearRect(0, 0, w, w);

    PERSONAS.forEach((p, i) => {
      const a0 = ((base + i * slice) * Math.PI) / 180;
      const a1 = ((base + (i + 1) * slice) * Math.PI) / 180;
      const grad = c.createRadialGradient(cx, cy, 18, cx, cy, r);
      grad.addColorStop(0, p.colorDark);
      grad.addColorStop(1, p.color);
      c.beginPath();
      c.moveTo(cx, cy);
      c.arc(cx, cy, r, a0, a1);
      c.closePath();
      c.fillStyle = grad;
      c.fill();
      c.lineWidth = 2.5;
      c.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      c.stroke();

      c.save();
      c.translate(cx, cy);
      c.rotate((a0 + a1) / 2 + Math.PI / 2);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = '26px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
      c.fillText(p.icon, 0, -r * 0.66);
      c.font = '900 14px "Segoe UI", -apple-system, sans-serif';
      c.fillStyle = '#ffffff';
      c.shadowColor = 'rgba(0, 0, 0, 0.7)';
      c.shadowBlur = 4;
      c.fillText(p.wheel, 0, -r * 0.43);
      c.restore();
    });

    c.beginPath();
    c.arc(cx, cy, r * 0.86, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    c.lineWidth = 1.5;
    c.stroke();
  }

  function verifyPool() {
    let total = 0;
    PERSONAS.forEach((p) => {
      const arr = window.SUGAR_DATA && window.SUGAR_DATA[p.key];
      if (Array.isArray(arr)) total += arr.length;
    });
    const badge = $('pool-count-badge');
    badge.textContent = total === 200 ? '200 ✓' : `${total}/200`;
    badge.title = `${total} prompts loaded`;
  }

  // ------------------------------------------------------------------
  // Copy + paste
  // ------------------------------------------------------------------
  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  async function browserCopy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err) {}
      document.body.removeChild(ta);
      return ok;
    }
  }

  async function deliver(text, allowPaste) {
    if (!text) return;
    if (bridge) {
      // Manual re-copy: clipboard only, never paste again
      if (!allowPaste) {
        await bridge.copyOnly(text);
        showToast('📋 Copied! Press Ctrl+V to feed your AI');
        return;
      }
      const r = await bridge.deliver(text);
      if (r && r.pasted) showToast(`🍬 Fed! Pasted into “${shorten(r.target || 'your app', 26)}”`);
      else showToast('📋 Copied! Press Ctrl+V to feed your AI');
    } else {
      await browserCopy(text);
      showToast('📋 Copied! Press Ctrl+V to feed your AI');
    }
  }

  $('btn-copy-again').addEventListener('click', () => deliver(currentEnglish, false));

  // ------------------------------------------------------------------
  // Two-stage gacha
  // ------------------------------------------------------------------
  function applyTheme(p) {
    document.documentElement.style.setProperty('--theme-color', p.color);
    document.documentElement.style.setProperty('--theme-glow', p.glow);
    pills.forEach((pill) => pill.classList.toggle('active', pill.dataset.key === p.key));
  }

  function spin(forcedIndex) {
    if (isSpinning) return;
    isSpinning = true;
    btnSpinCenter.disabled = true;
    btnSpinMain.disabled = true;

    const idx = typeof forcedIndex === 'number' ? forcedIndex : Math.floor(Math.random() * PERSONAS.length);
    const persona = PERSONAS[idx];

    slotStageText.textContent = 'Stage 1 · Spinning the wheel...';
    slotPersonaTitle.textContent = 'Choosing who feeds your AI...';
    digitTens.textContent = '-';
    digitOnes.textContent = '-';

    const slice = 360 / PERSONAS.length;
    const targetMod = (360 - idx * slice) % 360;
    const jitter = (Math.random() - 0.5) * 34;
    const curMod = ((wheelAngle % 360) + 360) % 360;
    let delta = targetMod - curMod + jitter;
    if (delta < 0) delta += 360;
    const start = wheelAngle;
    const end = start + (5 + Math.floor(Math.random() * 2)) * 360 + delta;
    const duration = 2300;
    const t0 = performance.now();
    let lastSector = -1;
    const ease = (t) => 1 - Math.pow(1 - t, 4);

    function frame(now) {
      const p = Math.min((now - t0) / duration, 1);
      wheelAngle = start + (end - start) * ease(p);
      wheelCanvas.style.transform = `rotate(${wheelAngle}deg)`;
      const sector = Math.floor(((wheelAngle + slice / 2) % 360) / slice);
      if (sector !== lastSector && p < 0.97) {
        lastSector = sector;
        wheelPointer.classList.add('tick');
        tick(520 + (sector % 5) * 45, 0.02);
        setTimeout(() => wheelPointer.classList.remove('tick'), 55);
      }
      if (p < 1) requestAnimationFrame(frame);
      else {
        applyTheme(persona);
        slotStageText.textContent = 'Stage 2 · Rolling 01-40...';
        slotPersonaTitle.textContent = `${persona.icon} ${persona.role}`;
        rollSlot(persona);
      }
    }
    requestAnimationFrame(frame);
  }

  function rollSlot(persona) {
    const pool = (window.SUGAR_DATA && window.SUGAR_DATA[persona.key]) || [];
    const max = pool.length || 40;
    const n = Math.floor(Math.random() * max) + 1;
    const s = String(n).padStart(2, '0');
    reelTens.classList.add('spinning');
    reelOnes.classList.add('spinning');
    const duration = 1350;
    const t0 = performance.now();
    let last = 0;

    function frame(now) {
      const el = now - t0;
      const p = Math.min(el / duration, 1);
      if (el - last > 55) {
        last = el;
        if (p < 0.72) {
          digitTens.textContent = Math.floor(Math.random() * 5);
          digitOnes.textContent = Math.floor(Math.random() * 10);
          tick(780, 0.018);
        } else if (p < 1) {
          reelTens.classList.remove('spinning');
          digitTens.textContent = s[0];
          digitOnes.textContent = Math.floor(Math.random() * 10);
          tick(920, 0.02);
        }
      }
      if (p < 1) requestAnimationFrame(frame);
      else {
        reelTens.classList.remove('spinning');
        reelOnes.classList.remove('spinning');
        digitTens.textContent = s[0];
        digitOnes.textContent = s[1];
        finish(persona, n, pool);
      }
    }
    requestAnimationFrame(frame);
  }

  function finish(persona, n, pool) {
    const entry = pool.find((e) => e.id === n) || pool[n - 1];
    const s = String(n).padStart(2, '0');
    slotStageText.textContent = `Locked · ${persona.name} #${s}`;
    resultBadge.textContent = `${persona.icon} ${persona.name} #${s}/40`;
    if (entry) {
      currentEnglish = entry.en;
      enOutput.textContent = entry.en;
    }
    fanfare(persona.key);
    burst(persona.key);
    deliver(currentEnglish, true).finally(() => {
      isSpinning = false;
      btnSpinCenter.disabled = false;
      btnSpinMain.disabled = false;
      countSpinAndMaybeNudge();
    });
  }

  btnSpinCenter.addEventListener('click', () => spin());
  btnSpinMain.addEventListener('click', () => spin());
  pills.forEach((pill, i) => pill.addEventListener('click', () => spin(i)));

  // ------------------------------------------------------------------
  // Per-persona particle effects
  // ------------------------------------------------------------------
  const fx = fxCanvas.getContext('2d');
  let particles = [];
  let fxRunning = false;
  fxCanvas.width = 360;
  fxCanvas.height = 560;

  function burst(key) {
    particles = [];
    const cx = 180;
    const cy = 220;
    const rand = Math.random;
    if (key === 'mint') {
      // ice shards
      for (let i = 0; i < 52; i++) {
        const a = rand() * Math.PI * 2;
        const v = 1.5 + rand() * 5.2;
        particles.push({ type: 'mint', x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.2, size: 4 + rand() * 7, rot: rand() * 6.28, vr: (rand() - 0.5) * 0.12, color: ['#2dd4bf', '#67e8f9', '#a7f3d0', '#ffffff'][i % 4], alpha: 1, decay: 0.012 + rand() * 0.01 });
      }
    } else if (key === 'berry') {
      // floating hearts
      for (let i = 0; i < 50; i++) {
        const a = rand() * Math.PI * 2;
        const v = 1.2 + rand() * 4.8;
        particles.push({ type: 'berry', x: cx + (rand() - 0.5) * 40, y: cy + (rand() - 0.5) * 30, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2.2, size: 6 + rand() * 8, color: ['#fb7185', '#f472b6', '#fda4af', '#fef08a'][i % 4], alpha: 1, decay: 0.011 + rand() * 0.01 });
      }
    } else if (key === 'volt') {
      // electric sparks
      for (let i = 0; i < 64; i++) {
        const a = rand() * Math.PI * 2;
        const v = 2.5 + rand() * 7.5;
        particles.push({ type: 'volt', x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, size: 3 + rand() * 5, color: ['#facc15', '#a855f7', '#38bdf8', '#ffffff'][i % 4], alpha: 1, decay: 0.016 + rand() * 0.012 });
      }
    } else if (key === 'dark') {
      // matrix code rain
      const glyphs = ['0', '1', '{ }', '//', '0x', 'AI', '>>', '99%'];
      for (let i = 0; i < 48; i++) {
        particles.push({ type: 'dark', x: 20 + rand() * 320, y: 40 + rand() * 260, vx: (rand() - 0.5) * 1.6, vy: 1.5 + rand() * 3.5, text: glyphs[i % glyphs.length], size: 10 + rand() * 5, color: ['#f59e0b', '#10b981', '#fbbf24', '#e2e8f0'][i % 4], alpha: 1, decay: 0.013 + rand() * 0.01 });
      }
    } else if (key === 'royal') {
      // golden confetti
      for (let i = 0; i < 60; i++) {
        const a = rand() * Math.PI * 2;
        const v = 1.8 + rand() * 6.0;
        particles.push({ type: 'royal', x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.8, w: 5 + rand() * 7, h: 3 + rand() * 4, rot: rand() * 6.28, vr: (rand() - 0.5) * 0.2, color: ['#fde047', '#f59e0b', '#ef4444', '#ffffff'][i % 4], alpha: 1, decay: 0.011 + rand() * 0.009 });
      }
    }
    if (!fxRunning) {
      fxRunning = true;
      requestAnimationFrame(render);
    }
  }

  function heart(x, y, s) {
    const t = s * 0.3;
    fx.beginPath();
    fx.moveTo(x, y + t);
    fx.bezierCurveTo(x, y, x - s / 2, y, x - s / 2, y + t);
    fx.bezierCurveTo(x - s / 2, y + (s + t) / 2, x, y + (s + t) / 1.4, x, y + s);
    fx.bezierCurveTo(x, y + (s + t) / 1.4, x + s / 2, y + (s + t) / 2, x + s / 2, y + t);
    fx.bezierCurveTo(x + s / 2, y, x, y, x, y + t);
    fx.closePath();
    fx.fill();
  }

  function render() {
    fx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.alpha -= p.decay;
      if (p.alpha <= 0) return;
      fx.save();
      fx.globalAlpha = p.alpha;
      fx.fillStyle = p.color;
      fx.strokeStyle = p.color;
      if (p.type === 'mint') {
        p.vy += 0.05;
        p.rot += p.vr;
        fx.translate(p.x, p.y);
        fx.rotate(p.rot);
        fx.beginPath();
        fx.moveTo(0, -p.size);
        fx.lineTo(p.size * 0.6, 0);
        fx.lineTo(0, p.size);
        fx.lineTo(-p.size * 0.6, 0);
        fx.closePath();
        fx.fill();
      } else if (p.type === 'berry') {
        p.vy -= 0.02;
        heart(p.x, p.y, p.size);
      } else if (p.type === 'volt') {
        fx.lineWidth = 2;
        fx.beginPath();
        fx.moveTo(p.x, p.y);
        fx.lineTo(p.x - p.vx * 1.6 + (Math.random() - 0.5) * 6, p.y - p.vy * 1.6 + (Math.random() - 0.5) * 6);
        fx.stroke();
        fx.beginPath();
        fx.arc(p.x, p.y, p.size * 0.45, 0, Math.PI * 2);
        fx.fill();
      } else if (p.type === 'dark') {
        fx.font = `bold ${Math.round(p.size)}px Consolas, monospace`;
        fx.fillText(p.text, p.x, p.y);
      } else if (p.type === 'royal') {
        p.vy += 0.09;
        p.rot += p.vr;
        fx.translate(p.x, p.y);
        fx.rotate(p.rot);
        fx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      fx.restore();
    });
    particles = particles.filter((p) => p.alpha > 0);
    if (particles.length) requestAnimationFrame(render);
    else {
      fxRunning = false;
      fx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
    }
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------
  drawWheel();
  verifyPool();

  if (bridge) {
    bridge.getSettings().then(applySettings);
    bridge.onSettings(applySettings);
    bridge.onForceCollapse(() => {
      document.body.classList.remove('mode-expanded');
      stopHintLoop();
    });
  } else {
    applySettings({ autoPasteAvailable: false });
    setExpanded(true); // web preview: open the panel right away
  }

  // Exposed for automated screenshots / tests only
  window.__sugarSpin = spin;
})();
