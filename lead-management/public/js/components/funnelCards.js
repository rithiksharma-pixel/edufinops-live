// =========================================================
// PRESENTATION LAYER — Funnel summary cards
// (stages, counts, onSelect) -> DOM. No fetching here. onSelect(stageId)
// fires on click — "All leads" passes null to clear the stage filter.
// =========================================================

// Best-effort icon match by stage name — falls back to a generic marker
// for any custom stage name that isn't in this list.
const STAGE_ICONS = {
  'lead created': 'fa-user-plus',
  'contacted': 'fa-phone',
  'connected': 'fa-handshake',
  'interested': 'fa-star',
  'documents requested': 'fa-file-circle-question',
  'documents received': 'fa-file-circle-check',
  'shared with lender': 'fa-building-columns',
  'sanctioned': 'fa-stamp',
  'pf paid': 'fa-sack-dollar',
  'disbursed': 'fa-money-bill-transfer',
  'dropped': 'fa-circle-xmark',
  'lost': 'fa-circle-xmark',
};
function iconForStage(name) {
  return STAGE_ICONS[(name || '').trim().toLowerCase()] || 'fa-circle-dot';
}

export function renderFunnelCards(container, stages, counts, activeStageId, onSelect) {
  container.innerHTML = '';

  const totalLeads = Object.values(counts).reduce((sum, n) => sum + n, 0);

  const totalCard = document.createElement('button');
  totalCard.type = 'button';
  totalCard.className = 'funnel-card' + (activeStageId ? '' : ' active');
  totalCard.style.setProperty('--stat-accent', 'var(--accent)');
  totalCard.innerHTML = `<div class="stat-icon"><i class="fa-solid fa-layer-group"></i></div><span class="count">${totalLeads}</span><span class="label">All leads</span>`;
  if (onSelect) totalCard.addEventListener('click', () => onSelect(null));
  container.appendChild(totalCard);

  for (const stage of stages) {
    const count = counts[stage.id] || 0;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'funnel-card' + (activeStageId === stage.id ? ' active' : '');
    if (stage.color) card.style.setProperty('--stat-accent', stage.color);
    card.innerHTML = `<div class="stat-icon"><i class="fa-solid ${iconForStage(stage.name)}"></i></div><span class="count">${count}</span><span class="label">${escapeHtml(stage.name)}</span>`;
    if (onSelect) card.addEventListener('click', () => onSelect(stage.id));
    container.appendChild(card);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
