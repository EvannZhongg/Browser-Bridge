import { targetOptions } from './locator.js';
import { clickOptions } from './click.js';
import { inputMode, keyParameters } from './input.js';

// Validate the entire plan before the first action can change the page.
export function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) throw new Error('steps must contain 1..20 input actions');
  for (const step of steps) {
    if (!step || !['click', 'fill', 'press_key'].includes(step.action)) throw new Error('Each step action must be click, fill or press_key');
    if (step.action === 'press_key') keyParameters(step.key);
    else {
      if (!step.selector || step.ref != null) throw new Error('Batch click/fill requires selector; refs expire after input');
      targetOptions(step);
      inputMode(step);
      if (step.action === 'click') clickOptions(step);
      if (step.action === 'fill' && typeof step.text !== 'string') throw new Error('Batch fill requires text');
    }
  }
}
