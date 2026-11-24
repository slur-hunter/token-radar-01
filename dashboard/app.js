// Token Launch Radar dashboard: renders window.RADAR (written by main.ts)
// with no network. Sorting, filtering and the detail view are all local.
//
// Farm economics have ONE source of truth: board.json. The table reads each
// row's verdict, net and net-per-hour from the board at the $1,000 reference
// deposit. The deposit control only scales that same formula (5% of launch
// value across 10,000 wallets, linear up to 10x, less fees, over 4 assumed
// farming hours a year); it never re-implements the verdict another way.
(function () {
  var R = window.RADAR;
  if (!R) { document.body.innerHTML = '<p>Data file missing.</p>'; return; }
  var rows = R.rows;
  var state = { group: 'all', verdict: 'all', q: '', cat: '', chain: '', sort: 'rank', dir: 1, deposit: R.deposit_usd, tradedQ: '' };

  function money(n) {
    if (Math.abs(n) < 0.5) return '$0';
    var neg = n < 0;
    var a = Math.abs(n);
    var s;
    if (a >= 1e9) s = '$' + (a / 1e9).toFixed(2) + 'B';
    else if (a >= 1e6) s = '$' + (a / 1e6).toFixed(1) + 'M';
    else if (a >= 1e3) s = '$' + (a / 1e3).toFixed(1) + 'K';
    else s = '$' + Math.round(a);
    return neg ? '-' + s : s;
  }
  function pct(n) { return (n * 100).toFixed(1) + '%'; }
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  // --- KPIs
  var kpis = [
    [rows.length, 'rows ranked'],
    [money(R.total_implied_usd), 'total implied value'],
    ['x' + R.model.loo_miss.toFixed(2), 'out-of-sample miss (leave-one-out)'],
    [pct(R.model.wf_range_coverage), 'of later-listed peers inside the walk-forward P25–P75 range (factors from the earlier-listed half only)'],
    [R.model.brier.toFixed(3) + ' Brier', 'token odds held out (base rate ' + R.model.brier_base.toFixed(3) + ')'],
    [R.farm_count, 'rows worth farming (FARM)'],
  ];
  el('kpis').innerHTML = kpis.map(function (k) {
    return '<div class="kpi"><b>' + k[0] + '</b><span>' + k[1] + '</span></div>';
  }).join('');

  // --- accounting
  var a = R.accounting;
  el('accounting').innerHTML = [
    [a.total, 'protocols in the snapshot'],
    [a.ranked, 'ranked pre-token rows'],
    [a.with_token, 'already record a token'],
    [a.with_mcap, 'of them carry a recorded market cap (listed below)'],
    [a.left_out, 'pre-token, left out'],
    [a.left_out_off_list, 'of them off-list (wrapped / staked / bridged / exchange)'],
    [a.left_out_above_floor, 'of them above the $50M floor'],
    [a.left_out_below_cutoff, 'of them below the early TVL cutoff'],
  ].map(function (k) { return '<div><b>' + k[0] + '</b><span>' + k[1] + '</span></div>'; }).join('');
  var earlyRows = rows.filter(function (r) { return r.early; });
  var earlyMax = Math.max.apply(null, earlyRows.map(function (r) { return r.tvl_usd; }));
  el('accounting-note').textContent = 'Every one of the ' + a.total + ' protocols sits in exactly one group: ' +
    a.ranked + ' ranked + ' + a.with_token + ' recording a token + ' + a.left_out + ' left out. ' +
    'The board holds 198 rows: the 40 watchlist protocols plus the 158 early rows, the pre-token protocols below the $50,000,000 floor with the most TVL. ' +
    'The early rows run from $' + earlyMax.toLocaleString('en-US') + ' of TVL down to the early cutoff of $' +
    a.early_cutoff_tvl.toLocaleString('en-US') + '.';

  // --- evidence tables
  el('term-table').innerHTML = '<thead><tr><th>Model</th><th>Leave-one-out</th><th>Walk-forward</th><th>Kept?</th></tr></thead><tbody>' +
    '<tr><td>Base: log TVL only</td><td>x' + R.model.base_loo_miss.toFixed(2) + '</td><td>x' + R.model.base_wf_miss.toFixed(2) + '</td><td>Base</td></tr>' +
    R.model.term_tests.map(function (t) {
      return '<tr><td>Base + ' + esc(t.term) + '</td><td>x' + t.loo_miss.toFixed(2) + '</td><td>x' + t.wf_miss.toFixed(2) + '</td><td>' + (t.kept ? 'Yes' : 'No') + '</td></tr>';
    }).join('') +
    '<tr><td><b>Final model</b></td><td><b>x' + R.model.loo_miss.toFixed(2) + '</b></td><td><b>x' + R.model.wf_miss.toFixed(2) + '</b></td><td><b>Yes</b></td></tr></tbody>';
  el('odds-table').innerHTML = '<thead><tr><th>No-token age</th><th>Peers</th><th>Share recording a token</th></tr></thead><tbody>' +
    R.model.odds_buckets.map(function (b) {
      return '<tr><td>' + esc(b.label) + '</td><td>' + b.n + '</td><td>' + pct(b.odds) + '</td></tr>';
    }).join('') + '</tbody>';
  var keptTerms = R.model.term_tests.filter(function (t) { return t.kept; }).map(function (t) { return t.term; });
  var droppedTerms = R.model.term_tests.filter(function (t) { return !t.kept; }).map(function (t) { return t.term; });
  el('evidence-note').textContent = 'Fitted on ' + R.model.fitted_on + ' traded tokens (positive market cap). Final coefficients: ' +
    R.model.coefficients.map(function (c) { return c.name + ' ' + c.value.toFixed(3); }).join(', ') +
    '. Kept: ' + (keptTerms.join(', ') || 'none') + '. Dropped: ' + (droppedTerms.join(', ') || 'none') +
    '. Leave-one-out range factors P25 x' + R.model.loo_p25_factor + ', P75 x' + R.model.loo_p75_factor +
    '; ' + pct(R.model.range_coverage) + ' of held-out traded tokens fall inside their printed range (leave-one-out), and ' +
    pct(R.model.wf_range_coverage) + ' of later-listed peers fall inside the walk-forward P25–P75 range, whose factors come from the earlier-listed half only. Median traded age ' + R.model.median_age_years + ' years.';

  // --- filter controls
  var cats = [...new Set(rows.map(function (r) { return r.category || '(none)'; }))].sort();
  var chains = [...new Set(rows.flatMap(function (r) { return r.chains; }))].sort();
  el('category').innerHTML += cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
  el('chain').innerHTML += chains.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  // One shared formula with lib/model.ts. At the $1,000 reference deposit
  // the stored board.json values are returned verbatim; any other deposit
  // scales them with the same constants (5% / 10,000 wallets, 10x cap).
  function economics(r, dep) {
    if (dep === R.deposit_usd) return { net: r.net_usd, perHour: r.net_per_hour_usd, v: r.verdict };
    var share = 0.05 / 10000 * Math.min(dep / 1000, 10);
    var net = r.implied_value_usd * share - r.fees_usd;
    var perHour = net / r.assumed_farm_hours_per_year;
    var v = perHour >= 5 ? 'FARM' : perHour >= 0 ? 'MARGINAL' : 'SKIP';
    if (r.off_list && v === 'FARM') v = 'MARGINAL';
    return { net: net, perHour: perHour, v: v };
  }

  function filtered() {
    var list = rows.filter(function (r) {
      if (state.group === 'watchlist' && !r.watchlist) return false;
      if (state.group === 'early' && !r.early) return false;
      if (state.group === 'off_list' && !r.off_list) return false;
      if (state.verdict !== 'all' && economics(r, state.deposit).v !== state.verdict) return false;
      if (state.cat && (r.category || '(none)') !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (state.q && (r.name + ' ' + r.slug).toLowerCase().indexOf(state.q) === -1) return false;
      return true;
    });
    var k = state.sort;
    list.sort(function (x, y) {
      var d = (k === 'age_years' ? (x.age_years ?? 99) - (y.age_years ?? 99) : x[k] - y[k]);
      return d * state.dir;
    });
    return list;
  }

  function render() {
    var list = filtered();
    el('count').textContent = list.length + ' of ' + rows.length + ' rows shown. Click a row for its detail, farm plan and model terms.';
    el('rows').innerHTML = list.map(function (r) {
      var vf = economics(r, state.deposit);
      var badge = r.watchlist ? '<span class="badge wl">WATCHLIST</span>' : r.off_list ? '<span class="badge off">OFF-LIST</span>' : '';
      var vclass = vf.v === 'FARM' ? 'farm' : vf.v === 'MARGINAL' ? 'marg' : 'skip';
      return '<tr data-slug="' + esc(r.slug) + '"><td>' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span>' + badge +
        '<div class="meta">' + esc(r.category || 'No category') + ' · ' + esc(r.chains.slice(0, 3).join(', ')) + ' · ' + r.risk + ' risk</div></td>' +
        '<td>' + money(r.tvl_usd) + '</td>' +
        '<td>' + (r.change_7d === null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</td>' +
        '<td>' + (r.age_years === null ? '—' : r.age_years.toFixed(1) + 'y') + '</td>' +
        '<td>' + pct(r.token_odds) + '</td>' +
        '<td>' + money(r.value_if_launches_usd) + '</td>' +
        '<td><b>' + money(r.implied_value_usd) + '</b><div class="meta">' + money(r.range_lo_usd) + ' – ' + money(r.range_hi_usd) + '</div></td>' +
        '<td><span class="badge ' + vclass + '">' + vf.v + '</span><div class="meta">net ' + money(vf.net) + '</div></td>' +
        '<td>' + money(vf.perHour) + '/h</td></tr>';
    }).join('');
    document.querySelectorAll('#rows tr').forEach(function (tr) {
      tr.addEventListener('click', function () { showDetail(tr.getAttribute('data-slug')); });
    });
  }

  function showDetail(slug, doScroll) {
    var r = rows.find(function (x) { return x.slug === slug; });
    if (!r) return;
    var vf = economics(r, state.deposit);
    el('detail').innerHTML =
      '<h3>#' + r.rank + ' ' + esc(r.name) + (r.watchlist ? ' <span class="badge wl">WATCHLIST</span>' : '') + (r.off_list ? ' <span class="badge off">OFF-LIST</span>' : '') + '</h3>' +
      '<p class="fine">' + esc(r.slug) + ' · ' + esc(r.category || 'No category') + ' · Chains: ' + esc(r.chains.join(', ')) + ' · ' + r.risk + ' risk</p>' +
      '<div class="detail-grid">' +
      '<div><b>' + money(r.tvl_usd) + '</b><span>TVL</span></div>' +
      '<div><b>' + (r.change_7d === null ? '—' : r.change_7d.toFixed(1) + '%') + '</b><span>7-day TVL change</span></div>' +
      '<div><b>' + (r.age_years === null ? '—' : r.age_years.toFixed(1) + ' years') + '</b><span>running with no token recorded</span></div>' +
      '<div><b>' + pct(r.token_odds) + '</b><span>token odds (peers of the same age)</span></div>' +
      '<div><b>' + money(r.value_if_launches_usd) + '</b><span>value if a token launches</span></div>' +
      '<div><b>' + money(r.implied_value_usd) + '</b><span>implied value (' + money(r.range_lo_usd) + ' – ' + money(r.range_hi_usd) + ')</span></div>' +
      '<div><b>' + vf.v + '</b><span>verdict at $' + state.deposit.toLocaleString('en-US') + ' deposit</span></div>' +
      '<div><b>' + money(vf.net) + ' net · ' + money(vf.perHour) + '/h</b><span>after $' + r.fees_usd + ' fees, ' + r.assumed_farm_hours_per_year + ' assumed hours a year</span></div>' +
      '</div>' +
      '<h4>Model terms behind its value</h4><p class="fine">' +
      r.model_terms.map(function (t) { return esc(t.name) + ' contributes ' + t.value.toFixed(2) + ' to log value'; }).join('; ') +
      '. Fitted on ' + R.model.fitted_on + ' traded tokens; leave-one-out miss x' + R.model.loo_miss.toFixed(2) + '.</p>' +
      '<h4>Farm plan — $1,000 deposit</h4><p class="fine">Steps are written for the $1,000 reference deposit.</p><ol>' +
      r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    if (doScroll !== false) el('detail-panel').scrollIntoView();
  }

  // --- already-traded list: every protocol with a recorded market cap
  function renderTraded() {
    var list = R.traded.filter(function (t) {
      return !state.tradedQ || (t.name + ' ' + t.slug).toLowerCase().indexOf(state.tradedQ) !== -1;
    });
    el('traded-note').textContent = list.length + ' of ' + R.traded.length +
      ' protocols carry a recorded market cap, with their realised values. The other ' +
      (R.accounting.with_token - R.accounting.with_mcap) +
      ' protocols that record a token carry no market cap in this snapshot, so no realised value is shown for them.';
    el('traded-rows').innerHTML = list.map(function (t) {
      var mult = t.tvl_usd > 0 ? (t.mcap_usd / t.tvl_usd) : 0;
      return '<tr><td><span class="name">' + esc(t.name) + '</span><div class="meta">' + esc(t.slug) + ' · ' + esc(t.category || 'No category') + ' · ' + esc(t.chains.slice(0, 3).join(', ')) + '</div></td>' +
        '<td>' + money(t.tvl_usd) + '</td>' +
        '<td>' + (t.change_7d === null ? '—' : (t.change_7d > 0 ? '+' : '') + t.change_7d.toFixed(1) + '%') + '</td>' +
        '<td><b>' + money(t.mcap_usd) + '</b></td>' +
        '<td>' + mult.toFixed(2) + 'x</td></tr>';
    }).join('');
  }

  // --- events
  document.querySelectorAll('#group-filters button').forEach(function (b) {
    b.addEventListener('click', function () {
      state.group = b.getAttribute('data-group');
      document.querySelectorAll('#group-filters button').forEach(function (x) { x.classList.toggle('on', x === b); });
      render();
    });
  });
  document.querySelectorAll('#verdict-filters button').forEach(function (b) {
    b.addEventListener('click', function () {
      state.verdict = b.getAttribute('data-verdict');
      document.querySelectorAll('#verdict-filters button').forEach(function (x) { x.classList.toggle('on', x === b); });
      render();
    });
  });
  el('search').addEventListener('input', function (e) { state.q = e.target.value.toLowerCase(); render(); });
  el('category').addEventListener('change', function (e) { state.cat = e.target.value; render(); });
  el('chain').addEventListener('change', function (e) { state.chain = e.target.value; render(); });
  el('deposit').addEventListener('change', function (e) {
    state.deposit = Math.max(100, Math.min(100000, Number(e.target.value) || 1000));
    e.target.value = state.deposit;
    render();
  });
  el('traded-search').addEventListener('input', function (e) { state.tradedQ = e.target.value.toLowerCase(); renderTraded(); });
  el('reset').addEventListener('click', function () {
    state = { group: 'all', verdict: 'all', q: '', cat: '', chain: '', sort: 'rank', dir: 1, deposit: R.deposit_usd, tradedQ: '' };
    el('search').value = ''; el('category').value = ''; el('chain').value = ''; el('deposit').value = R.deposit_usd; el('traded-search').value = '';
    document.querySelectorAll('.filters button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-group') === 'all' || x.getAttribute('data-verdict') === 'all'); });
    render();
  });
  document.querySelectorAll('#board th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-sort');
      if (state.sort === k) state.dir *= -1; else { state.sort = k; state.dir = k === 'rank' ? 1 : -1; }
      render();
    });
  });

  // --- deep links for the screenshots: #detail=<slug>, #filter=watchlist|farm, #shot=board|filter|detail
  var hash = window.location.hash.slice(1);
  var params = new URLSearchParams(hash);
  var shot = params.get('shot');
  var f = params.get('filter');
  if (shot === 'board' || shot === 'filter') {
    // A screenshot is taken from scroll 0, so the accounting and evidence
    // panels are hidden for the shot and the KPI strip sits above the board.
    el('accounting-panel').style.display = 'none';
    el('evidence-panel').style.display = 'none';
  }
  if (f === 'watchlist' || f === 'farm' || shot === 'filter') {
    if (shot !== 'filter') {
      // A filtered deep link is screenshotted from scroll 0: move the board
      // panel to the top so the filtered rows are what the shot shows.
      var boardPanel = el('board-panel');
      boardPanel.parentNode.insertBefore(boardPanel, el('kpis'));
    }
    if (f === 'watchlist' || shot === 'filter') {
      state.group = 'watchlist';
      document.querySelectorAll('#group-filters button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-group') === 'watchlist'); });
    } else if (f === 'farm') {
      state.verdict = 'FARM';
      document.querySelectorAll('#verdict-filters button').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-verdict') === 'FARM'); });
    }
  }
  render();
  renderTraded();
  var d = params.get('detail');
  if (d) {
    // The headless screenshot shell captures from scroll 0, so a deep-linked
    // detail is moved to the top of the page instead of scrolled to.
    var panel = el('detail-panel');
    panel.parentNode.insertBefore(panel, el('kpis'));
    showDetail(d, false);
  }
})();
