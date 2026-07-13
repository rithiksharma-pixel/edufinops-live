// =========================================================
// PRESENTATION LAYER — Funnel summary cards
// Pure render function: (stages, counts) -> DOM. No fetching here.
// =========================================================

export function renderFunnelCards(container, stages, counts) {
  container.innerHTML = '';

  const totalLeads = Object.values(counts).reduce((sum, n) => sum + n, 0);

  const totalCard = document.createElement('div');
  totalCard.className = 'funnel-card';
  totalCard.innerHTML = `<span class="count">${totalLeads}</span><span class="label">All leads</span>`;
  container.appendChild(totalCard);

  for (const stage of stages) {
    const count = counts[stage.id] || 0;
    const card = document.createElement('div');
    card.className = 'funnel-card';
    card.innerHTML = `<span class="count">${count}</span><span class="label">${escapeHtml(stage.name)}</span>`;
    container.appendChild(card);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
