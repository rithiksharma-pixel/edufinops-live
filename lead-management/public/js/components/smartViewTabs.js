// =========================================================
// PRESENTATION LAYER — Smart View tabs (top of the All Leads list)
// "All Leads" (no filters) + one tab per saved view, each with a live
// count badge. Clicking a tab applies its stored filters to the list
// (via ctx.applyFilters, which also syncs the filter-bar controls).
// The "+" saves the CURRENTLY active filter-bar state as a new view.
// =========================================================
import { getSavedViews, createSavedView, deleteSavedView } from '../services/savedViewsService.js';
import { countLeads } from '../services/leadService.js';

export async function initSmartViewTabs(containerEl, ctx) {
  const { currentUser, showToast, getCurrentFilters, applyFilters } = ctx;
  let views = [];
  let activeViewId = null; // null = "All Leads"

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  function tabHtml(id, name, count, isActive, deletable) {
    return `
      <button class="smart-view-tab ${isActive ? 'active' : ''}" data-view-tab="${id ?? ''}">
        <span>${escapeHtml(name)}</span>
        <span class="smart-view-tab-count">${count}</span>
        ${deletable ? `<span class="smart-view-tab-delete" data-delete-view="${id}" title="Delete view">&times;</span>` : ''}
      </button>
    `;
  }

  async function render() {
    const [allCount, viewCounts] = await Promise.all([
      countLeads({}),
      Promise.all(views.map((v) => countLeads(v.filters))),
    ]);

    containerEl.innerHTML = [
      tabHtml(null, 'All Leads', allCount, activeViewId === null, false),
      ...views.map((v, i) => tabHtml(v.id, v.name, viewCounts[i], activeViewId === v.id, true)),
      `<button class="smart-view-tab smart-view-tab-add" data-action="add-view" title="Save the current filters as a view"><i class="fa-solid fa-plus"></i></button>`,
    ].join('');

    containerEl.querySelectorAll('[data-view-tab]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        if (e.target.closest('[data-delete-view]')) return;
        const id = btn.dataset.viewTab || null;
        activeViewId = id;
        const view = id ? views.find((v) => v.id === id) : null;
        applyFilters(view ? view.filters : {});
        render();
      });
    });

    containerEl.querySelectorAll('[data-delete-view]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = el.dataset.deleteView;
        if (!confirm('Delete this saved view?')) return;
        try {
          await deleteSavedView(id);
          if (activeViewId === id) {
            activeViewId = null;
            applyFilters({});
          }
          showToast('View deleted.');
          await refresh();
        } catch (err) {
          showToast('Could not delete this view.', true);
        }
      });
    });

    containerEl.querySelector('[data-action="add-view"]').addEventListener('click', async () => {
      const name = prompt('Name this view:')?.trim();
      if (!name) return;
      try {
        const view = await createSavedView(name, getCurrentFilters(), currentUser.id);
        activeViewId = view.id;
        showToast('View saved.');
        await refresh();
      } catch (err) {
        showToast(err.message?.includes('duplicate') ? 'You already have a view with that name.' : 'Could not save this view.', true);
      }
    });
  }

  async function refresh() {
    views = await getSavedViews();
    await render();
  }

  /** Called when the filter bar is edited directly — the active tab no longer exactly matches. */
  function clearActive() {
    if (activeViewId === null) return;
    activeViewId = null;
    render();
  }

  await refresh();
  return { refresh, clearActive };
}
