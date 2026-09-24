export function matrixPosition(impact, urgency) {
  return { left: 95 - (urgency - 1) * 10, bottom: 5 + (impact - 1) * 10 };
}

export function scoresFromPoint(rect, clientX, clientY) {
  return {
    urgency: Math.max(1, Math.min(10, Math.round(((rect.right - clientX) / rect.width) * 9 + 1))),
    impact: Math.max(1, Math.min(10, Math.round(((rect.bottom - clientY) / rect.height) * 9 + 1))),
  };
}

export function layoutProjectDots(items, width, height) {
  if (!width || !height) return [];
  const placed = [];
  return items.map((item) => {
    const halfWidth = item.width / 2;
    const halfHeight = item.height / 2;
    const base = matrixPosition(item.impact, item.urgency);
    const baseX = width * base.left / 100;
    const baseY = height * base.bottom / 100;
    const fits = (x, y) => placed.every((position) =>
      Math.abs(position.x - x) >= position.halfWidth + halfWidth + 5
      || Math.abs(position.y - y) >= position.halfHeight + halfHeight + 5);
    let position = null;

    for (let step = 0; step < 240 && !position; step += 1) {
      const ring = step === 0 ? 0 : Math.ceil(step / 16);
      const angle = (step % 16) * Math.PI / 8;
      const radius = ring * 15;
      const x = Math.max(halfWidth + 3, Math.min(width - halfWidth - 3, baseX + Math.cos(angle) * radius));
      const y = Math.max(halfHeight + 3, Math.min(height - halfHeight - 3, baseY + Math.sin(angle) * radius));
      if (fits(x, y)) position = { x, y };
    }

    if (!position) {
      for (let y = halfHeight + 3; y <= height - halfHeight - 3 && !position; y += 15) {
        for (let x = halfWidth + 3; x <= width - halfWidth - 3; x += 15) {
          if (fits(x, y)) {
            position = { x, y };
            break;
          }
        }
      }
    }

    position ||= { x: baseX, y: baseY };
    placed.push({ ...position, halfWidth, halfHeight });
    return position;
  });
}
