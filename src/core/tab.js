/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import { getClient, evaluate, setActiveTarget } from '../connection.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const tabs = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Open a new chart tab. Uses CDP Target.createTarget (reliable on Electron/TV Desktop),
 * falling back to the keyboard shortcut if needed.
 */
export async function newTab() {
  const c = await getClient();

  // Prefer CDP Target.createTarget — the keyboard shortcut is often swallowed by
  // Electron's global shortcut handler and never reaches the page.
  try {
    await c.Target.createTarget({ url: 'https://www.tradingview.com/chart/' });
    await new Promise(r => setTimeout(r, 2000));
    const state = await list();
    return { success: true, action: 'new_tab_opened_cdp', ...state };
  } catch (e) {
    // Fallback to keyboard shortcut
    const isMac = process.platform === 'darwin';
    const mod = isMac ? 4 : 2;
    await c.Input.dispatchKeyEvent({
      type: 'keyDown',
      modifiers: mod,
      key: 't',
      code: 'KeyT',
      windowsVirtualKeyCode: 84,
    });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 't', code: 'KeyT' });
    await new Promise(r => setTimeout(r, 2000));
    const state = await list();
    return { success: true, action: 'new_tab_opened_kbd', ...state };
  }
}

/**
 * Close the current tab via keyboard shortcut (Ctrl+W / Cmd+W).
 */
export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const c = await getClient();
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2;

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'w', code: 'KeyW' });

  await new Promise(r => setTimeout(r, 1000));

  const after = await list();
  return { success: true, action: 'tab_closed', tabs_before: before.tab_count, tabs_after: after.tab_count };
}

/**
 * Switch to a tab by index. Reconnects CDP to the new target.
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  // Use CDP Target.activateTarget to bring the tab to front
  try {
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${target.id}`);
    const text = await resp.text();
  } catch (e) {
    throw new Error(`Failed to activate tab ${idx}: ${e.message}`);
  }

  // Reconnect the CDP client to this tab's target so that chart_* / study_*
  // operations run in the correct tab context (fixes the sticky
  // _activeChartWidgetWV bug).
  try {
    await setActiveTarget(target.id);
  } catch (e) {
    throw new Error(`Failed to bind CDP client to tab ${idx}: ${e.message}`);
  }

  return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id };
}

/**
 * Switch to a tab by its stable CDP target id (not by index, which can shift).
 */
export async function switchTabById({ id }) {
  // Reconnect the CDP client to this tab's target
  try {
    await setActiveTarget(id);
  } catch (e) {
    throw new Error(`Failed to bind CDP client to tab ${id}: ${e.message}`);
  }
  // Also activate it in the UI
  try {
    await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${id}`);
  } catch (e) { /* non-fatal */ }
  return { success: true, action: 'switched_by_id', tab_id: id };
}
