export function timingOption(value, name, max = 1000) {
  const values = Array.isArray(value) ? value : [value];
  if ((Array.isArray(value) && value.length !== 2) || values.some(n => !Number.isInteger(n) || n < 0 || n > max) || values.length === 2 && values[0] > values[1]) {
    throw new Error(`${name} must be 0..${max} or an ordered [min, max] integer pair`);
  }
}

export function sampleTiming(value = 0) {
  return Array.isArray(value) ? value[0] + Math.floor(Math.random() * (value[1] - value[0] + 1)) : value;
}

export async function pause(budget, value) {
  const ms = sampleTiming(value);
  if (ms) await budget.run(() => new Promise(resolve => setTimeout(resolve, ms)));
}

export function offsetOption(args) {
  if (args.offset == null) return;
  if ((!args.ref && !args.selector) || args.mode === 'dom') throw new Error('offset requires a native element target');
  const offset = args.offset;
  if (typeof offset !== 'object' || Array.isArray(offset) || Object.keys(offset).some(key => !['x_ratio', 'y_ratio'].includes(key)) ||
      ![offset.x_ratio, offset.y_ratio].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error('offset requires x_ratio and y_ratio in 0..1');
}

export function trajectoryOption(trajectory) {
  if (trajectory == null) return;
  if (typeof trajectory !== 'object' || Array.isArray(trajectory) || Object.keys(trajectory).some(key => !['curve_px', 'duration_ms'].includes(key)) ||
      !Number.isFinite(trajectory.curve_px) || Math.abs(trajectory.curve_px) > 100) throw new Error('trajectory requires curve_px in -100..100 and duration_ms in 100..5000');
  if (!Number.isInteger(trajectory.duration_ms) || trajectory.duration_ms < 100 || trajectory.duration_ms > 5000) throw new Error('trajectory duration_ms must be 100..5000');
}

// Keep both endpoints exact; vary progress and per-step timing only when opted in.
export function dragPath(from, to, steps, trajectory) {
  const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy);
  if (!trajectory) return Array.from({ length: steps }, (_, index) => ({
    point: { x: from.x + dx * (index + 1) / steps, y: from.y + dy * (index + 1) / steps }, dt: 16,
  }));
  const weights = Array.from({ length: steps }, () => 0.5 + Math.random());
  const total = weights.reduce((sum, n) => sum + n, 0);
  let elapsed = 0;
  return Array.from({ length: steps }, (_, index) => {
    const dt = weights[index] / total * trajectory.duration_ms;
    elapsed += dt;
    const t = index === steps - 1 ? 1 : elapsed / trajectory.duration_ms;
    const progress = t * t * (3 - 2 * t);
    const bend = length ? 2 * progress * (1 - progress) * trajectory.curve_px : 0;
    return { point: index === steps - 1 ? { ...to } : { x: from.x + dx * progress - (length ? dy / length * bend : 0),
      y: from.y + dy * progress + (length ? dx / length * bend : 0) }, dt };
  });
}
