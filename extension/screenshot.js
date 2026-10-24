import { targetOptions } from './locator.js';
import { deadline } from './actionability.js';
import { framePoint } from './pointer.js';

export function createScreenshots(cdp, value, viewport, sessions, clickVisuals, resolveNode) {
  async function capture(tabId, args) {
    const view = await viewport(tabId);
    const hasTarget = args.ref != null || args.selector != null;
    if (!hasTarget && (args.frame || args.frame_id || args.nth != null || args.selector_type || args.name != null)) throw new Error('Element screenshot frame/nth/type/name requires an element selector');
    if (hasTarget && args.full_page) throw new Error('Element target and full_page are mutually exclusive');
    const clip = hasTarget ? await elementClip(tabId, args, view) : args.full_page ? await fullPageClip(tabId) : null;
    const includeIndicators = args.include_indicators === true;
    const hiddenError = includeIndicators ? null : await clickVisuals.visible(tabId, false);
    if (hiddenError) throw new Error(`Could not hide click feedback for a clean screenshot: ${hiddenError}`);
    try {
      // Render an explicit target surface without activating its tab or window.
      const captureClip = clip || { x: view.scroll_x, y: view.scroll_y, width: view.width, height: view.height, scale: 1 };
      let timer;
      let result;
      try {
        result = await Promise.race([
          cdp(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true,
            captureBeyondViewport: true, optimizeForSpeed: true, clip: captureClip }),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(
            'Screenshot did not finish within 5 seconds. An inactive or occluded Chromium page may not render. Use browser_tab_control action=activate before requesting another screenshot, or use DOM/AX.'
          )), 5000); }),
        ]);
      } finally { clearTimeout(timer); }
      return { ...result, capture: { scope: hasTarget ? 'element' : clip ? 'full_page' : 'viewport', viewport: view,
        css_width: clip?.width ?? view.width, css_height: clip?.height ?? view.height,
        image_origin_css: { x: clip?.x ?? view.scroll_x, y: clip?.y ?? view.scroll_y },
        click_coordinate_space: 'viewport_css_pixels', agent_indicators_included: includeIndicators } };
    } finally { await clickVisuals.visible(tabId, true); }
  }

  async function elementClip(tabId, args, view) {
    targetOptions(args);
    const budget = deadline(5000);
    const node = await resolveNode(tabId, args, budget);
    const { model } = await budget.run(() => cdp(node.target, 'DOM.getBoxModel', { backendNodeId: node.backendNodeId }));
    if (!model?.border) throw new Error('Element has no rendered box');
    let points = Array.from({ length: 4 }, (_, i) => ({ x: model.border[i * 2], y: model.border[i * 2 + 1] })), target = node.target;
    while (target.sessionId) {
      const parent = sessions.parent(tabId, target.sessionId);
      const owner = await budget.run(() => cdp(parent.target, 'DOM.getFrameOwner', { frameId: parent.frameId }));
      const box = await budget.run(() => cdp(parent.target, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId }));
      const childView = await budget.run(() => viewport(target));
      points = points.map(p => framePoint(p, box.model.content, childView));
      target = parent.target;
    }
    const x = Math.min(...points.map(p => p.x)) + view.scroll_x, y = Math.min(...points.map(p => p.y)) + view.scroll_y;
    const width = Math.max(...points.map(p => p.x)) + view.scroll_x - x, height = Math.max(...points.map(p => p.y)) + view.scroll_y - y;
    if (width <= 0 || height <= 0 || width * height > 40000000 || x < 0 || y < 0) throw new Error('Element capture requires a positive box within the document and at most 40 million pixels');
    return { x, y, width, height, scale: 1 };
  }

  async function fullPageClip(tabId) {
    const { cssContentSize } = await cdp(tabId, 'Page.getLayoutMetrics');
    if (cssContentSize.width * cssContentSize.height > 40000000) throw new Error('Full-page capture exceeds 40 million pixels; use viewport capture');
    return { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
  }

  return { capture };
}
