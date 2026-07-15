// =========================================================
// PRESENTATION LAYER — Funnel summary cards
// Pure render function: (stages, counts) -> DOM. No fetching here.
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

export function renderFunnelCards(container, stages, counts) {
  container.innerHTML = '';

  const totalLeads = Object.values(counts).reduce((sum, n) => sum + n, 0);

  const totalCard = document.createElement('div');
  totalCard.className = 'funnel-card';
  totalCard.style.setProperty('--stat-accent', 'var(--accent)');
  totalCard.innerHTML = `<div class="stat-icon"><i class="fa-solid fa-layer-group"></i></div><span class="count">${totalLeads}</span><span class="label">All leads</span>`;
  container.appendChild(totalCard);

  for (const stage of stages) {
    const count = counts[stage.id] || 0;
    const card = document.createElement('div');
    card.className = 'funnel-card';
    if (stage.color) card.style.setProperty('--stat-accent', stage.color);
    card.innerHTML = `<div class="stat-icon"><i class="fa-solid ${iconForStage(stage.name)}"></i></div><span class="count">${count}</span><span class="label">${escapeHtml(stage.name)}</span>`;
    container.appendChild(card);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
