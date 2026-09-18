(function () {
  'use strict';

  const state = { campaign: null, revisions: [], spends: [], step: 0, editing: false, previewTimer: null, previewVersion: 0 };
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const money = (cents) => cents == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  const number = (value) => value == null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  function businessDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Phnom_Penh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const part = (type) => parts.find((entry) => entry.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    });
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }

  function showError(error) {
    const target = $('#error');
    target.textContent = error instanceof Error ? error.message : String(error);
    target.hidden = false;
  }

  function clearError() { $('#error').hidden = true; $('#error').textContent = ''; }
  function notice(message) { $('#notice').textContent = message; }

  function currentMonth() { return businessDate().slice(0, 7); }
  function selectedMonth() { return $('#month').value || currentMonth(); }
  function summaryAsOf(month) {
    const today = businessDate();
    if (month === today.slice(0, 7)) return today;
    const [year, value] = month.split('-').map(Number);
    return `${month}-${String(new Date(Date.UTC(year, value, 0)).getUTCDate()).padStart(2, '0')}`;
  }

  async function loadCampaigns(event) {
    if (event) event.preventDefault();
    clearError();
    const page = $('#page-filter').value.trim();
    if (!page) return showError(new Error('Enter a page name.'));
    try {
      const { campaigns } = await api(`/lead-control/campaigns?pageId=${encodeURIComponent(page)}`);
      $('#campaign-list').innerHTML = campaigns.length ? campaigns.map((campaign) => `
        <button class="lc-campaign-row" data-open="${escapeHtml(campaign.id)}">
          <span><strong>${escapeHtml(campaign.name)}</strong><small>${escapeHtml(campaign.pageId)} · ${escapeHtml(campaign.startsOn)}${campaign.endsOn ? ` → ${escapeHtml(campaign.endsOn)}` : ''}</small></span>
          <span class="lc-status-${campaign.status === 'active' ? 'Good' : 'Pending'}">${escapeHtml(campaign.status)}</span>
        </button>`).join('') : '<p class="lc-empty">No campaigns found for this page.</p>';
    } catch (error) { showError(error); }
  }

  async function openCampaign(id) {
    clearError();
    const month = selectedMonth();
    const asOf = summaryAsOf(month);
    try {
      const [{ campaign }, revisionsResult, spendsResult] = await Promise.all([
        api(`/lead-control/campaigns/${encodeURIComponent(id)}`),
        api(`/lead-control/campaigns/${encodeURIComponent(id)}/revisions?month=${encodeURIComponent(month)}`),
        api(`/lead-control/spend?campaignId=${encodeURIComponent(id)}&month=${encodeURIComponent(month)}`),
      ]);
      state.campaign = campaign;
      state.revisions = revisionsResult.revisions || [];
      state.spends = spendsResult.spends || [];
      $('#spend-mode').value = campaign.spendMode || 'daily';
      $('#spend-date-label').hidden = $('#spend-mode').value === 'monthly';
      $('#switch-confirm-label').hidden = true;
      $('#switch-confirm').checked = false;
      $('#detail').hidden = false;
      $('#campaign-title').textContent = campaign.name;
      $('#campaign-state').textContent = `${campaign.pageId} · ${campaign.status} · ${campaign.startsOn}${campaign.endsOn ? ` to ${campaign.endsOn}` : ' onward'}`;
      $('#activate-campaign').hidden = campaign.status !== 'draft';
      renderHistory();
      renderSpend();
      await Promise.all([loadSummary(), loadCancellations(), loadUnmatched(), loadHealth()]);
      $('#detail').scrollIntoView({ block: 'start' });
    } catch (error) { showError(error); }
  }

  async function loadSummary() {
    if (!state.campaign) return;
    const month = selectedMonth();
    try {
      const { summary } = await api(`/lead-control/campaigns/${encodeURIComponent(state.campaign.id)}/summary?month=${encodeURIComponent(month)}&asOf=${encodeURIComponent(summaryAsOf(month))}`);
      renderSummary(summary);
    } catch (error) {
      $('#summary').innerHTML = `<p class="lc-empty">${escapeHtml(error.message)}. Approve a forecast for this month to see the campaign ledger.</p>`;
    }
  }

  function renderSummary(summary) {
    const rail = [
      ['Budget', money(summary.pacing.actualSpendCents)],
      ['Messages', number(summary.actualFunnel.messages)],
      ['Phones', number(summary.actualFunnel.phoneLeads)],
      ['Visits', number(summary.actualFunnel.visits)],
      ['Bookings', number(summary.actualFunnel.grossBookings)],
      ['Net', number(summary.actualFunnel.netBookings)],
    ];
    const rows = [
      ['messages', 'Messages'], ['phoneLeads', 'Valid phone leads'], ['visits', 'Property visits'],
      ['grossBookings', 'Gross bookings'], ['cancellations', 'Cancellations'], ['netBookings', 'Net bookings'],
    ];
    $('#summary').innerHTML = `
      <div class="lc-ledger-head">
        <dl><div><dt>Monthly plan</dt><dd>${money(summary.revisions.latest?.monthlyBudgetCents)}</dd></div><div><dt>Planned to date</dt><dd>${money(summary.pacing.plannedSpendCents)}</dd></div><div><dt>Actual spend</dt><dd>${money(summary.pacing.actualSpendCents)}</dd></div><div><dt>Remaining</dt><dd>${money(summary.pacing.remainingBudgetCents)}</dd></div><div><dt>Pacing variance</dt><dd>${money(summary.pacing.varianceCents)} · ${escapeHtml(summary.pacing.state)}</dd></div></dl>
        ${summary.provisional ? '<p class="lc-provisional">Open-month net bookings are provisional until later cancellations are known.</p>' : ''}
      </div>
      <ol class="lc-rail">${rail.map(([label, value]) => `<li><small>${label}</small><strong>${value}</strong></li>`).join('')}</ol>
      <div class="lc-scroll" tabindex="0" aria-label="Campaign funnel ledger"><table><caption>Forecast, spend-adjusted expectation, and actual</caption><thead><tr><th>Stage</th><th>Full forecast</th><th>Expected to date</th><th>Actual</th><th>Variance</th><th>Actual cost</th><th>Status</th></tr></thead><tbody id="stage-ledger">${rows.map(([key, label]) => {
        const item = summary.stages[key];
        return `<tr><td>${label}</td><td>${number(item.forecast)}</td><td>${number(item.expected)}</td><td>${number(item.actual)}</td><td>${number(item.variance)}</td><td>${money(item.costPerResultCents)}</td><td class="lc-status-${item.status}">${item.status}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    $('#revision-context').textContent = summary.revisions.baseline && summary.revisions.latest
      ? `Baseline v${summary.revisions.baseline.revisionNumber}; latest approved v${summary.revisions.latest.revisionNumber}.`
      : 'Forecast approval is pending.';
  }

  function renderHistory() {
    const ordered = [...state.revisions].sort((a, b) => b.revisionNumber - a.revisionNumber);
    $('#history').innerHTML = ordered.length ? ordered.map((revision) => `<tr><td>${revision.kind === 'baseline' ? 'Baseline' : 'Revision'} v${revision.revisionNumber}</td><td>${revision.status}</td><td>${money(revision.monthlyBudgetCents)}</td><td>${money(revision.costPerMessageCents)}</td><td>${escapeHtml(revision.approvedBy || '—')}</td><td>${revision.approvedAt ? escapeHtml(new Date(revision.approvedAt).toLocaleString()) : '—'}</td></tr>`).join('') : '<tr><td colspan="6">No forecast yet.</td></tr>';
  }

  function renderSpend() {
    $('#spend-list').innerHTML = state.spends.length ? `<div class="lc-scroll"><table><thead><tr><th>Date / mode</th><th>Amount</th><th>Status</th></tr></thead><tbody>${state.spends.map((spend) => `<tr><td>${escapeHtml(spend.businessDate || spend.mode)}</td><td>${money(spend.amountCents)}</td><td>${escapeHtml(spend.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p>No actual spend recorded for this month.</p>';
  }

  async function loadCancellations() {
    if (!state.campaign) return;
    const view = $('#cancellation-view').value;
    $('#cancellation-help').textContent = view === 'cohort' ? 'Sales booked in this month that have since cancelled.' : 'Cancellation events recorded in this month.';
    try {
      const { cancellations } = await api(`/lead-control/campaigns/${encodeURIComponent(state.campaign.id)}/cancellations?month=${encodeURIComponent(selectedMonth())}&view=${encodeURIComponent(view)}`);
      $('#cancellations').innerHTML = cancellations.length ? cancellations.map((sale) => `<p><strong>${escapeHtml(sale.saleId)}</strong> · ${escapeHtml(sale.normalizedPhone)} · cancelled ${escapeHtml(sale.cancelledDate ? new Date(sale.cancelledDate).toLocaleDateString() : 'date pending')}</p>`).join('') : '<p>No cancellations in this view.</p>';
    } catch (error) { $('#cancellations').textContent = error.message; }
  }

  async function loadUnmatched() {
    try {
      const { sales } = await api('/lead-control/reconciliation/unmatched');
      $('#unmatched').innerHTML = sales.length ? sales.map((sale) => `<div class="lc-reconcile"><span><strong>${escapeHtml(sale.saleId)}</strong><small>${escapeHtml(sale.normalizedPhone)} · ${escapeHtml(new Date(sale.bookingDate).toLocaleDateString())}</small></span><button data-attribute="${escapeHtml(sale.saleId)}" ${state.campaign ? '' : 'disabled'}>Assign to this campaign</button></div>`).join('') : '<p>No unmatched bookings.</p>';
    } catch (error) { $('#unmatched').textContent = error.message; }
  }

  async function loadHealth() {
    try {
      const { health } = await api(`/lead-control/sync/health?asOf=${encodeURIComponent(summaryAsOf(selectedMonth()))}`);
      $('#sync-health').textContent = `${health.status} · ${health.unmatchedSales} unmatched · ${health.malformedSales} malformed${health.ageHours == null ? '' : ` · updated ${number(health.ageHours)}h ago`}`;
    } catch (error) { $('#sync-health').textContent = error.message; }
  }

  function setWizardStep(step) {
    state.step = Math.max(0, Math.min(3, step));
    $$('[data-step]').forEach((fieldset, index) => { fieldset.hidden = index !== state.step; });
    $$('.lc-steps li').forEach((item, index) => index === state.step ? item.setAttribute('aria-current', 'step') : item.removeAttribute('aria-current'));
    $('#wizard-back').disabled = state.step === 0;
    $('#wizard-next').hidden = state.step === 3;
    if (state.step === 3) renderReview();
  }

  function openWizard(editing) {
    state.editing = editing;
    $('#workspace').hidden = true;
    $('#wizard').hidden = false;
    $('#wizard-title').textContent = editing ? 'Edit campaign and revise forecast' : 'Set up campaign';
    const latest = editing ? [...state.revisions].sort((a, b) => b.revisionNumber - a.revisionNumber)[0] : null;
    const campaign = editing ? state.campaign : null;
    $('#campaign-name').value = campaign?.name || '';
    $('#campaign-page').value = campaign?.pageId || '';
    $('#property-project').value = campaign?.propertyProject || '';
    $('#campaign-objective').value = campaign?.objective || '';
    $('#campaign-audience').value = campaign?.audience || '';
    $('#starts-on').value = campaign?.startsOn || businessDate();
    $('#ends-on').value = campaign?.endsOn || '';
    $('#forecast-month').value = latest?.month || selectedMonth();
    $('#monthly-budget').value = latest ? String(latest.monthlyBudgetCents / 100) : '1200';
    $('#setup-spend-mode').value = campaign?.spendMode || 'daily';
    $('#cost-per-message').value = latest ? String(latest.costPerMessageCents / 100) : '1';
    $('#message-rate').value = latest ? String(latest.messageToPhoneRate * 100) : '30';
    $('#visit-rate').value = latest ? String(latest.phoneToVisitRate * 100) : '50';
    $('#booking-rate').value = latest ? String(latest.visitToBookingRate * 100) : '20';
    $('#cancel-rate').value = latest ? String(latest.cancellationRate * 100) : '10';
    $('#target-net').value = '';
    $('#revision-message').textContent = latest?.status === 'approved' ? 'The approved forecast stays immutable; saving creates a new revision.' : 'Save a draft or approve the forecast after review.';
    setWizardStep(0);
    updatePreview();
    $('#campaign-name').focus();
  }

  function closeWizard() { $('#wizard').hidden = true; $('#workspace').hidden = false; clearError(); }

  function forecastInput() {
    return {
      month: $('#forecast-month').value,
      monthlyBudgetCents: Math.round(Number($('#monthly-budget').value || 0) * 100),
      costPerMessageCents: Math.round(Number($('#cost-per-message').value || 0) * 100),
      messageToPhoneRate: Number($('#message-rate').value || 0) / 100,
      phoneToVisitRate: Number($('#visit-rate').value || 0) / 100,
      visitToBookingRate: Number($('#booking-rate').value || 0) / 100,
      cancellationRate: Number($('#cancel-rate').value || 0) / 100,
    };
  }

  async function updatePreview() {
    window.clearTimeout(state.previewTimer);
    const version = ++state.previewVersion;
    state.previewTimer = window.setTimeout(async () => {
      try {
        const input = forecastInput();
        if (!input.month || input.monthlyBudgetCents < 0 || input.costPerMessageCents <= 0) return;
        const { forecast } = await api('/lead-control/calculator/budget-to-results', { method: 'POST', body: JSON.stringify({ ...input, budgetCents: input.monthlyBudgetCents }) });
        if (version !== state.previewVersion) return;
        $('#preview').innerHTML = `<h3>Live forecast</h3><p>Monthly budget <strong>${money(input.monthlyBudgetCents)}</strong></p><dl><dt>Messages</dt><dd>${number(forecast.messages)}</dd><dt>Phone leads</dt><dd>${number(forecast.phoneLeads)}</dd><dt>Visits</dt><dd>${number(forecast.visits)}</dd><dt>Gross bookings</dt><dd>${number(forecast.grossBookings)}</dd><dt>Cancellations</dt><dd>${number(forecast.cancellations)}</dd><dt>Net bookings</dt><dd>${number(forecast.netBookings)}</dd></dl>`;
        const target = Number($('#target-net').value || 0);
        if (target > 0) {
          const result = await api('/lead-control/calculator/target-to-budget', { method: 'POST', body: JSON.stringify({ ...input, targetNetBookings: target }) });
          if (version !== state.previewVersion) return;
          $('#target-budget').textContent = `Required budget: ${money(result.budgetCents)}`;
          $('#use-target').disabled = false;
          $('#use-target').dataset.cents = String(result.budgetCents);
        } else { $('#target-budget').textContent = ''; $('#use-target').disabled = true; }
      } catch (error) { if (version === state.previewVersion) $('#preview').innerHTML = `<h3>Live forecast</h3><p>${escapeHtml(error.message)}</p>`; }
    }, 80);
  }

  function renderReview() {
    const input = forecastInput();
    $('#review').innerHTML = `<h3>${escapeHtml($('#campaign-name').value)}</h3><p>${escapeHtml($('#property-project').value)} · ${escapeHtml($('#campaign-objective').value)} · ${escapeHtml($('#campaign-audience').value)}</p><dl><dt>Page</dt><dd>${escapeHtml($('#campaign-page').value)}</dd><dt>Dates</dt><dd>${escapeHtml($('#starts-on').value)}${$('#ends-on').value ? ` → ${escapeHtml($('#ends-on').value)}` : ''}</dd><dt>Month</dt><dd>${escapeHtml(input.month)}</dd><dt>Budget</dt><dd>${money(input.monthlyBudgetCents)}</dd><dt>Actual spend mode</dt><dd>${escapeHtml($('#setup-spend-mode').value)}</dd><dt>Cost per message</dt><dd>${money(input.costPerMessageCents)}</dd></dl>`;
  }

  function validateStep() {
    const fieldset = $(`[data-step="${state.step}"]`);
    const invalid = fieldset?.querySelector(':invalid');
    if (invalid) { invalid.reportValidity(); return false; }
    return true;
  }

  async function saveWizard(approve) {
    clearError();
    try {
      const campaignBody = {
        name: $('#campaign-name').value.trim(), pageId: $('#campaign-page').value.trim(),
        propertyProject: $('#property-project').value.trim(), objective: $('#campaign-objective').value.trim(), audience: $('#campaign-audience').value.trim(),
        startsOn: $('#starts-on').value, endsOn: $('#ends-on').value || null, spendMode: $('#setup-spend-mode').value,
      };
      const campaignResult = state.editing
        ? await api(`/lead-control/campaigns/${encodeURIComponent(state.campaign.id)}`, { method: 'PUT', body: JSON.stringify(campaignBody) })
        : await api('/lead-control/campaigns', { method: 'POST', body: JSON.stringify(campaignBody) });
      const campaign = campaignResult.campaign;
      const input = forecastInput();
      const latest = state.editing ? [...state.revisions].sort((a, b) => b.revisionNumber - a.revisionNumber)[0] : null;
      let forecastResult;
      if (latest?.status === 'approved') forecastResult = await api(`/lead-control/forecasts/${encodeURIComponent(latest.id)}/revisions`, { method: 'POST', body: JSON.stringify(input) });
      else if (latest) forecastResult = await api(`/lead-control/forecasts/${encodeURIComponent(latest.id)}`, { method: 'PUT', body: JSON.stringify(input) });
      else forecastResult = await api(`/lead-control/campaigns/${encodeURIComponent(campaign.id)}/forecasts`, { method: 'POST', body: JSON.stringify(input) });
      let savedForecast = forecastResult.forecast;
      if (approve && savedForecast.status !== 'approved') {
        const approved = await api(`/lead-control/forecasts/${encodeURIComponent(savedForecast.id)}/approve`, { method: 'POST' });
        savedForecast = approved.forecast;
      }
      if (approve && campaign.status === 'draft') await api(`/lead-control/campaigns/${encodeURIComponent(campaign.id)}/activate`, { method: 'POST' });
      notice(approve ? 'Forecast approved. Baseline history is preserved.' : 'Forecast draft saved.');
      closeWizard();
      $('#page-filter').value = campaign.pageId;
      await loadCampaigns();
      await openCampaign(campaign.id);
    } catch (error) { showError(error); }
  }

  async function recordSpend(event) {
    event.preventDefault();
    if (!state.campaign) return;
    const mode = $('#spend-mode').value;
    const input = { campaignId: state.campaign.id, month: selectedMonth(), businessDate: mode === 'daily' ? $('#spend-date').value : null, amountCents: Math.round(Number($('#spend-amount').value) * 100) };
    try {
      await api('/lead-control/spend', { method: 'POST', body: JSON.stringify(input) });
    } catch (error) {
      if (!/mutually exclusive/.test(error.message)) throw error;
      $('#switch-confirm-label').hidden = false;
      if (!$('#switch-confirm').checked) return notice('Confirm the mode switch before replacing this month’s entries.');
      await api('/lead-control/spend/mode-switch', { method: 'POST', body: JSON.stringify({ campaignId: state.campaign.id, month: selectedMonth(), targetMode: mode, confirmed: true }) });
      await api('/lead-control/spend', { method: 'POST', body: JSON.stringify(input) });
    }
    const result = await api(`/lead-control/spend?campaignId=${encodeURIComponent(state.campaign.id)}&month=${encodeURIComponent(selectedMonth())}`);
    state.spends = result.spends;
    renderSpend();
    notice('Actual spend recorded.');
    await loadSummary();
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('#month').value = currentMonth();
    $('#spend-date').value = businessDate();
    $('#campaign-filter').addEventListener('submit', loadCampaigns);
    $('#campaign-list').addEventListener('click', (event) => { const button = event.target.closest('[data-open]'); if (button) openCampaign(button.dataset.open); });
    $('#new-campaign').addEventListener('click', () => openWizard(false));
    $('#edit-campaign').addEventListener('click', () => openWizard(true));
    $('#wizard-cancel').addEventListener('click', closeWizard);
    $('#wizard-back').addEventListener('click', () => setWizardStep(state.step - 1));
    $('#wizard-next').addEventListener('click', () => { if (validateStep()) setWizardStep(state.step + 1); });
    $('#wizard-form').addEventListener('input', updatePreview);
    $('#use-target').addEventListener('click', () => { $('#monthly-budget').value = String(Number($('#use-target').dataset.cents || 0) / 100); updatePreview(); });
    $('#save-draft').addEventListener('click', () => saveWizard(false));
    $('#save-approve').addEventListener('click', () => saveWizard(true));
    $('#refresh-summary').addEventListener('click', loadSummary);
    $('#month').addEventListener('change', () => state.campaign && openCampaign(state.campaign.id));
    $('#cancellation-view').addEventListener('change', loadCancellations);
    $('#activate-campaign').addEventListener('click', async () => { if (!state.campaign) return; await api(`/lead-control/campaigns/${state.campaign.id}/activate`, { method: 'POST' }); await openCampaign(state.campaign.id); });
    $('#spend-mode').addEventListener('change', () => { $('#spend-date-label').hidden = $('#spend-mode').value === 'monthly'; });
    $('#spend-form').addEventListener('submit', (event) => recordSpend(event).catch(showError));
    $('#unmatched').addEventListener('click', async (event) => {
      const button = event.target.closest('[data-attribute]');
      if (!button || !state.campaign) return;
      try { await api(`/lead-control/sales/${encodeURIComponent(button.dataset.attribute)}/attribution`, { method: 'POST', body: JSON.stringify({ campaignId: state.campaign.id }) }); notice('Sale attributed and frozen to this campaign.'); await loadUnmatched(); await loadSummary(); } catch (error) { showError(error); }
    });
  });
})();
