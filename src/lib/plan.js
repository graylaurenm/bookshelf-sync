// What a sync would write for one Goodreads item. Shared by the worker and the popup.

export const SHELF_TO_STATUS = { read: 'read', 'currently-reading': 'currently-reading', 'to-read': 'to-read' };

export function planSteps(item) {
  const steps = [{ op: 'setStatus', status: SHELF_TO_STATUS[item.shelf] }];
  if (item.shelf === 'read') {
    if (item.readAt) steps.push({ op: 'setFinishDate', date: item.readAt });
    if (item.rating > 0) steps.push({ op: 'createRating', stars: item.rating });
  }
  return steps;
}

export function describePlan(item) {
  return planSteps(item).map(s => {
    if (s.op === 'setStatus') return `mark ${s.status.replace(/-/g, ' ')}`;
    if (s.op === 'setFinishDate') return `finished ${s.date}`;
    return `${s.stars}★`;
  }).join(', ');
}
