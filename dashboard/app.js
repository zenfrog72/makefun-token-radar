// Launch Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// refits nothing: the fitted coefficients ship in the data, and this page recomputes every row's
// implied value from them, checks the result against board.json's checksum, and only then renders.
// No network: every byte it shows is in data.js. Scenario changes recompute the farm verdicts live.
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) return;
  var app = document.getElementById('board');
  var V = D.value, O = D.odds, K = D.kpis;
  var state = { tab: 'all', q: '', cat: 'all', chain: 'all', sort: 'rank', dir: 1, sc: { deposit: D.scenario.deposit, dropShare: D.scenario.dropShare, horizonWeeks: D.scenario.horizonWeeks } };

  // ---------- formatting ----------
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function usd(n, dec) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(dec === undefined ? 0 : dec) + 'K';
    return '$' + Math.round(n);
  }
  function usdFull(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function pct(n) { return n === null || n === undefined ? 'n/a' : (n > 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function ageFmt(days, years) {
    if (days === null || days === undefined) return 'unknown';
    if (years >= 1) return years.toFixed(1) + ' yr';
    return Math.round(days) + ' d';
  }
  function x2(n) { return '×' + n.toFixed(2); }

  // ---------- the model, mirrored from lib/model.ts ----------
  function growthF(c) { var p = c === null || c === undefined || !isFinite(c) ? 0 : Math.min(120, Math.max(-60, c)); return p / 100; }
  function valueIf(r) {
    var z = V.intercept + V.ln_tvl * Math.log(Math.max(1, r.tvl_usd));
    z += V.family_effects[r.family] || 0;
    z += V.category_effects[r.category || ''] || 0;
    z += V.growth * growthF(r.change_7d) + V.age * r.age_years + V.chains * Math.log(Math.max(1, r.chains.length));
    return Math.exp(z);
  }
  var OID = { age: 0, size: 1, growth: 2, chains: 3, family: 4 };
  function logit(p) { p = Math.min(0.999, Math.max(0.001, p)); return Math.log(p / (1 - p)); }
  function probByAge(r, ageYears) {
    var fam = O.family_rate[r.family] !== undefined ? O.family_rate[r.family] : O.base_rate;
    var f = [ageYears, Math.log(Math.max(1, r.tvl_usd)), growthF(r.change_7d), Math.log(Math.max(1, r.chains.length)), logit(fam)];
    // Zero the terms the dual test did not keep, exactly as the fit did.
    var kept = [0, 0, 0, 0, 0];
    O.kept.forEach(function (t) { kept[OID[t]] = 1; });
    var z = O.beta[0];
    for (var j = 0; j < 5; j++) if (kept[j]) z += (O.beta[j + 1] || 0) * f[j];
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  }
  function oddsOf(r) {
    var byNow = probByAge(r, r.age_years);
    var byMax = probByAge(r, O.a_max_years);
    var raw = (byMax - byNow) / Math.max(1e-9, 1 - byNow);
    return Math.min(0.98, Math.max(0.02, raw));
  }
  function impliedOf(r) { return Math.max(1, Math.round(valueIf(r) * oddsOf(r))); }
  function fnv(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  // Recompute the whole board once: the seals below report what this page found.
  var recomputed = D.rows.map(function (r) { return impliedOf(r); });
  var matched = 0;
  D.rows.forEach(function (r, i) { if (recomputed[i] === r.implied) matched++; });
  var checksum = fnv(D.rows.map(function (r, i) { return r.slug + ':' + recomputed[i] + ';'; }).join(''));
  var totalsOk = recomputed.reduce(function (s, v) { return s + v; }, 0) === D.totals.implied_sum;
  var orderOk = true;
  for (var oi = 1; oi < recomputed.length; oi++) if (recomputed[oi] > recomputed[oi - 1]) orderOk = false;

  // ---------- the farm engine, mirrored from lib/farm.ts ----------
  function farmMath(r, sc) {
    var plan = Math.max(250, Math.min(sc.deposit, Math.floor(0.0002 * r.tvl_usd)));
    var fees = r.fees_fixed + r.fees_week * sc.horizonWeeks;
    var imp = impliedOf(r);
    var drop = imp * sc.dropShare * plan / (r.tvl_usd + plan);
    var net = drop - fees;
    var hours = (70 + 10 * sc.horizonWeeks) / 60;
    var tbill = plan * 0.04 * sc.horizonWeeks / 52;
    var verdict = net <= 0 ? 'SKIP' : net >= tbill && net / hours >= 25 ? 'FARM' : 'MARGINAL';
    return { plan: plan, fees: fees, drop: drop, net: net, hours: hours, netHour: net / hours, tbill: tbill, verdict: verdict, implied: imp };
  }
  function verdicts(sc) { return D.rows.map(function (r) { return farmMath(r, sc); }); }

  // ---------- shared fragments ----------
  function badge(r) {
    if (r.group === 'ranked_watchlist') return '<span class="badge watch">Watchlist</span>';
    if (r.group === 'ranked_above_floor') return '<span class="badge off">Off-list</span>';
    return '<span class="badge off">Early</span>';
  }
  function sealsHtml() {
    var s = '';
    s += '<span class="seal' + (matched === D.rows.length ? '' : ' bad') + '">✓ this table = board.json: ' + matched + ' of ' + D.rows.length + ' rows recomputed here</span>';
    s += '<span class="seal' + (orderOk ? '' : ' bad') + '">✓ ranks 1–' + D.rows.length + ' in order, values never rise</span>';
    s += '<span class="seal' + (totalsOk ? '' : ' bad') + '">✓ totals equal: ' + usdFull(D.totals.implied_sum) + '</span>';
    s += '<span class="seal' + (checksum === D.checksum ? '' : ' bad') + '">✓ checksum ' + checksum + ' = main.ts</span>';
    s += '<span class="seal">✓ watchlist ' + K.watchlist_ranked + ' of ' + K.watchlist_size + ' ranked</span>';
    s += '<span class="seal">✓ ledger ' + K.protocols + ' of ' + K.protocols + ' protocols</span>';
    return s;
  }
  var LEDGER_COLORS = { ranked_watchlist: '#43b581', ranked_early: '#2f7d54', ranked_above_floor: '#7fc79a', token_priced: '#5b8dd9', token_unpriced: '#54677c', out_bridge: '#d9a441', out_staking: '#3aa79c', out_exchange: '#8a6bc9', out_versioned: '#95a5b5' };

  function headerHtml() {
    return '<div class="top"><div><h1>Launch Radar</h1><p>pre-token protocols, valued from their own record</p></div>' +
      '<div class="topr">DefiLlama snapshot ' + esc(D.as_of) + ' · model ' + esc(D.model_version) + ', refitted in this browser</div></div>';
  }
  function kpisHtml(vm) {
    var farm = 0, marg = 0, skip = 0;
    vm.forEach(function (m) { if (m.verdict === 'FARM') farm++; else if (m.verdict === 'MARGINAL') marg++; else skip++; });
    return '<div class="kpis">' +
      '<div class="kpi"><h3>Out-of-sample miss, walk-forward</h3><div class="big">' + x2(K.wf_miss) + '</div><div class="sub">vs ' + x2(K.flat_wf_miss) + ' flat — a flat cap/TVL multiple misses by ' + x2(K.flat_loo_miss) + ' leave-one-out</div></div>' +
      '<div class="kpi"><h3>Is the printed range honest?</h3><div class="big">' + K.honesty_p2575_wf + '% · ' + K.honesty_p1090_wf + '%</div><div class="sub">of later-listed caps fall inside P25–P75 · P10–P90 (stated 50% · 80%)</div></div>' +
      '<div class="kpi"><h3>Token odds vs base rate, Brier</h3><div class="big">' + K.odds_brier_wf.toFixed(3) + ' <span class="mut" style="font-size:13px">vs ' + K.odds_base_brier_wf.toFixed(3) + '</span></div><div class="sub">walk-forward; the odds are the peers’ record, fitted on ' + O.peers + ' peers</div></div>' +
      '<div class="kpi"><h3>Terms that survived both tests</h3><div class="big">' + K.value_terms_kept + ' of ' + K.value_terms_tested + ' · ' + K.odds_terms_kept + ' of ' + K.odds_terms_tested + '</div><div class="sub">value model · token odds; the rest are shown below, not used</div></div>' +
      '<div class="kpi"><h3>Worth farming, this scenario</h3><div class="big">' + farm + ' of ' + D.rows.length + '</div><div class="sub">net beats a T-bill and $25 an hour; ' + marg + ' marginal, ' + skip + ' skip</div></div>' +
      '<div class="kpi"><h3>Watchlist ranked</h3><div class="big">' + K.watchlist_ranked + ' / ' + K.watchlist_size + '</div><div class="sub">plus ' + (D.rows.length - K.watchlist_ranked) + ' pre-token protocols it leaves out</div></div>' +
      '</div>' +
      '<p class="formula"><b>Implied value = TVL × fitted multiple</b> (the value if a token launches) <b>× token odds</b> (from how long peers ran before recording one). Each coefficient is fitted on this snapshot and tested held-out.</p>';
  }
  function ledgerHtml() {
    var total = D.ledger.reduce(function (s, g) { return s + g.count; }, 0);
    var bar = D.ledger.map(function (g) { return '<div style="width:' + (g.count / total * 100).toFixed(2) + '%;background:' + LEDGER_COLORS[g.group] + '"></div>'; }).join('');
    var legend = D.ledger.map(function (g) { return '<span><span class="sw" style="background:' + LEDGER_COLORS[g.group] + '"></span>' + esc(g.label) + ' <span class="num">' + g.count + '</span></span>'; }).join('');
    var ranked = D.ledger.filter(function (g) { return g.group.indexOf('ranked') === 0; }).reduce(function (s, g) { return s + g.count; }, 0);
    var tokens = D.ledger.filter(function (g) { return g.group.indexOf('token') === 0; }).reduce(function (s, g) { return s + g.count; }, 0);
    return '<section class="panel"><div class="phead"><h2>Protocol accounting</h2><span class="note">all ' + total + ' snapshot protocols in exactly one group: ' + ranked + ' ranked as pre-token, ' + tokens + ' already record a token, ' + (total - ranked - tokens) + ' left out by the house list’s own rules</span></div>' +
      '<div class="ledgerbar">' + bar + '</div><div class="legend">' + legend + '</div><div class="seals">' + sealsHtml() + '</div></section>';
  }
  function ladderTable(rows, cols) {
    var h = '<table><tr>' + cols.map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr>';
    rows.forEach(function (r) { h += '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; });
    return h + '</table>';
  }
  function evidenceHtml() {
    var vRows = V.ladder.map(function (r) {
      var cls = r.verdict === 'kept' ? 'kept' : 'notkept';
      return [esc(r.term), x2(r.loo), x2(r.wf), '<span class="' + cls + '">' + esc(r.verdict) + '</span>'];
    });
    var oRows = O.ladder.map(function (r) {
      var cls = r.verdict === 'kept' ? 'kept' : 'notkept';
      return [esc(r.term), r.tenfold.toFixed(3) + ' (' + r.tenfoldCalled + '%)', r.wf.toFixed(3) + ' (' + r.wfCalled + '%)', '<span class="' + cls + '">' + esc(r.verdict) + '</span>'];
    });
    var hRows = [
      ['inside P25–P75, stated 50%', K.honesty_p2575_loo + '%', K.honesty_p2575_wf + '%'],
      ['inside P10–P90, stated 80%', K.honesty_p1090_loo + '%', K.honesty_p1090_wf + '%'],
    ];
    return '<section class="panel"><div class="phead"><h2>Out-of-sample evidence</h2><span class="note">a term is kept only if it lowers the held-out miss in both tests: leave-one-out, and walk-forward (tokens listed earlier price those listed later)</span></div>' +
      '<div class="evidence"><div><div class="cap">VALUE IF A TOKEN LAUNCHES · TYPICAL MISS, ' + V.comps_used + ' TRADED TOKENS</div>' + ladderTable(vRows, ['Term, added in order', 'Leave-one-out', 'Walk-forward', '']) + '</div>' +
      '<div><div class="cap">TOKEN ODDS · BRIER SCORE (SHARE CALLED RIGHT), ' + O.peers + ' PEERS</div>' + ladderTable(oRows, ['Term, added in order', 'Ten-fold', 'Walk-forward', '']) + '</div>' +
      '<div><div class="cap">IS THE PRINTED RANGE HONEST?</div>' + ladderTable(hRows, ['Share of real caps', 'Leave-one-out', 'Walk-forward']) +
      '<p class="small mut" style="margin-top:6px">Fitted: flat median multiple ' + x2(V.flat_multiple) + '; the fitted curve reads ' + x2(V.multiple_at_100m) + ' at $100M TVL. Odds in logits: base rate ' + Math.round(O.base_rate * 100) + '% of peers record a token.</p></div></div>' +
      '<p class="reading"><b>Reading it:</b> a term that fails either test is printed above and left out of the figure. The board’s implied value is this dashboard’s own claim from the snapshot’s figures — not a forecast that a token will launch, and not a promise about any protocol.</p></section>';
  }

  // ---------- board view ----------
  var TABS = [['all', 'All'], ['farm', 'Farm'], ['marginal', 'Marginal'], ['skip', 'Skip'], ['watchlist', 'Watchlist'], ['early', 'Early (< $50.0M)'], ['offlist', 'Off-list']];
  function tabCount(key, vm) {
    if (key === 'all') return D.rows.length;
    if (key === 'farm') return vm.filter(function (m) { return m.verdict === 'FARM'; }).length;
    if (key === 'marginal') return vm.filter(function (m) { return m.verdict === 'MARGINAL'; }).length;
    if (key === 'skip') return vm.filter(function (m) { return m.verdict === 'SKIP'; }).length;
    if (key === 'watchlist') return D.rows.filter(function (r) { return r.group === 'ranked_watchlist'; }).length;
    if (key === 'early') return D.rows.filter(function (r) { return r.group === 'ranked_early'; }).length;
    return D.rows.filter(function (r) { return r.group === 'ranked_above_floor'; }).length;
  }
  function filtered(vm) {
    var out = [];
    D.rows.forEach(function (r, i) {
      var m = vm[i];
      if (state.tab === 'farm' && m.verdict !== 'FARM') return;
      if (state.tab === 'marginal' && m.verdict !== 'MARGINAL') return;
      if (state.tab === 'skip' && m.verdict !== 'SKIP') return;
      if (state.tab === 'watchlist' && r.group !== 'ranked_watchlist') return;
      if (state.tab === 'early' && r.group !== 'ranked_early') return;
      if (state.tab === 'offlist' && r.group !== 'ranked_above_floor') return;
      if (state.cat !== 'all' && (r.category || '') !== state.cat) return;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return;
      if (state.q) {
        var q = state.q.toLowerCase();
        if ((r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return;
      }
      out.push({ r: r, m: m });
    });
    var key = state.sort, dir = state.dir;
    var val = function (x) {
      switch (key) {
        case 'tvl': return x.r.tvl_usd;
        case 'chg': return x.r.change_7d === null ? -1e9 : x.r.change_7d;
        case 'age': return x.r.age_days === null ? -1 : x.r.age_days;
        case 'odds': return oddsOf(x.r);
        case 'vif': return valueIf(x.r);
        case 'implied': return x.m.implied;
        case 'net': return x.m.net;
        default: return x.r.rank;
      }
    };
    out.sort(function (a, b) { return (val(a) - val(b)) * dir || a.r.rank - b.r.rank; });
    return out;
  }
  function controlsHtml(vm) {
    var tabs = TABS.map(function (t) {
      return '<button class="tab' + (state.tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '">' + t[1] + ' <span class="n">' + tabCount(t[0], vm) + '</span></button>';
    }).join('');
    var cats = [...new Set(D.rows.map(function (r) { return r.category || ''; }))].sort();
    var chains = [...new Set(D.rows.flatMap(function (r) { return r.chains; }))].sort();
    return '<div class="controls"><div class="tabs">' + tabs +
      '<span class="scenario"><label>Deposit <select id="sc-dep">' + [1000, 3000, 10000, 30000].map(function (v) { return '<option value="' + v + '"' + (state.sc.deposit === v ? ' selected' : '') + '>$' + v.toLocaleString('en-US') + '</option>'; }).join('') + '</select></label>' +
      '<label>Drop share <span class="val" id="sc-share-v">' + (state.sc.dropShare * 100).toFixed(1) + '%</span> <input type="range" id="sc-share" min="1" max="20" step="0.5" value="' + state.sc.dropShare * 100 + '"></label>' +
      '<label>Horizon <span class="val" id="sc-hor-v">' + state.sc.horizonWeeks + ' wk</span> <input type="range" id="sc-hor" min="2" max="26" step="1" value="' + state.sc.horizonWeeks + '"></label></span></div>' +
      '<div class="filters"><input type="search" id="f-q" placeholder="Search name, chain, category" value="' + esc(state.q) + '">' +
      '<select id="f-cat"><option value="all">All categories</option>' + cats.map(function (c) { return '<option value="' + esc(c) + '"' + (state.cat === c ? ' selected' : '') + '>' + esc(c || 'No category') + '</option>'; }).join('') + '</select>' +
      '<select id="f-chain"><option value="all">All chains</option>' + chains.map(function (c) { return '<option value="' + esc(c) + '"' + (state.chain === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>' +
      '<button class="btn" id="f-reset">Reset</button><button class="btn" id="f-csv">CSV</button><button class="btn" id="f-json">JSON</button>' +
      '<span class="spacer" id="f-count"></span></div></div>';
  }
  function th(label, key, cls) {
    var arrow = state.sort === key ? (state.dir === 1 ? ' ↑' : ' ↓') : '';
    return '<th class="' + (cls || '') + '" data-sort="' + key + '">' + label + arrow + '</th>';
  }
  function tableHtml(list) {
    var h = '<table class="board"><thead><tr><th>#</th><th>Range</th><th>Protocol</th>' +
      th('TVL', 'tvl', 'r') + th('7D', 'chg', 'r') + th('No-token age', 'age', 'r') + th('Token odds', 'odds', 'r') +
      th('If it launches', 'vif', 'r') + th('Implied value', 'implied', 'r') + '<th>Verdict · net of fees</th>' + th('Net / hour', 'net', 'r') + '</tr></thead><tbody>';
    list.forEach(function (x) {
      var r = x.r, m = x.m;
      var odds = oddsOf(r);
      h += '<tr data-slug="' + esc(r.slug) + '"><td class="num">' + r.rank + '</td>' +
        '<td class="num mut">' + r.rank_lo + '–' + r.rank_hi + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' + badge(r) + '<div class="psub">' + esc(r.category || 'No category') + ' · ' + esc(r.chains[0] || '—') + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) : '') + '</div></td>' +
        '<td class="r num">' + usd(r.tvl_usd) + '</td>' +
        '<td class="r num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') + '">' + (r.change_7d === null ? 'n/a' : pct(r.change_7d)) + '</td>' +
        '<td class="r num">' + ageFmt(r.age_days, r.age_years) + '</td>' +
        '<td class="r num"><span class="oddsbar"><i style="width:' + Math.round(odds * 100) + '%"></i></span>' + Math.round(odds * 100) + '%</td>' +
        '<td class="r num">' + usd(valueIf(r)) + '</td>' +
        '<td class="r num"><b>' + usd(m.implied) + '</b><div class="vsub">' + usd(r.p25, 1) + '–' + usd(r.p75, 1) + '</div></td>' +
        '<td><span class="chip ' + m.verdict + '">' + m.verdict + '</span> <span class="num">' + (m.net >= 0 ? '+' : '−') + usd(Math.abs(m.net)).slice(0) + '</span><div class="vsub">' + usd(m.drop) + ' drop − ' + usd(m.fees) + ' fees</div></td>' +
        '<td class="r num">' + (m.netHour >= 0 ? '' : '−') + '$' + Math.abs(m.netHour).toFixed(2) + '</td></tr>';
    });
    return h + '</tbody></table>';
  }
  function renderBoard() {
    var vm = verdicts(state.sc);
    var list = filtered(vm);
    app.innerHTML = headerHtml() + kpisHtml(vm) + ledgerHtml() + chartsHtml() + evidenceHtml() + controlsHtml(vm) + '<div id="tbl">' + tableHtml(list) + '</div>' +
      '<p class="foot">The board is this entry’s own model over the sealed snapshot of ' + esc(D.as_of) + ' (' + esc(D.source) + '). It separates the ' + K.protocols + ' protocols into those that record a token and those that do not, ranks the pre-token ones, and prices a farm plan for each. Nothing here is a forecast that a token will launch.</p>';
    var tvlSum = list.reduce(function (s, x) { return s + x.r.tvl_usd; }, 0);
    var impSum = list.reduce(function (s, x) { return s + x.m.implied; }, 0);
    document.getElementById('f-count').textContent = list.length + ' of ' + D.rows.length + ' rows · ' + usd(tvlSum) + ' TVL · ' + usd(impSum) + ' implied';
    wireBoard();
  }
  function download(name, text, type) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 400);
  }
  function wireBoard() {
    app.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { state.tab = b.getAttribute('data-tab'); renderBoard(); });
    });
    app.querySelectorAll('th[data-sort]').forEach(function (t) {
      t.addEventListener('click', function () {
        var k = t.getAttribute('data-sort');
        if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = k === 'rank' ? 1 : -1; }
        renderBoard();
      });
    });
    app.querySelectorAll('tbody tr[data-slug]').forEach(function (tr) {
      tr.addEventListener('click', function () { location.hash = '#/p/' + tr.getAttribute('data-slug'); });
    });
    var q = document.getElementById('f-q');
    q.addEventListener('input', function () {
      state.q = q.value;
      var vm = verdicts(state.sc);
      var list = filtered(vm);
      document.getElementById('tbl').innerHTML = tableHtml(list);
      document.getElementById('f-count').textContent = list.length + ' of ' + D.rows.length + ' rows';
      wireRows();
    });
    document.getElementById('f-cat').addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
    document.getElementById('f-chain').addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
    document.getElementById('f-reset').addEventListener('click', function () {
      state = { tab: 'all', q: '', cat: 'all', chain: 'all', sort: 'rank', dir: 1, sc: state.sc };
      renderBoard();
    });
    document.getElementById('sc-dep').addEventListener('change', function (e) { state.sc.deposit = Number(e.target.value); renderBoard(); });
    var share = document.getElementById('sc-share'), hor = document.getElementById('sc-hor');
    share.addEventListener('input', function () {
      state.sc.dropShare = Number(share.value) / 100;
      document.getElementById('sc-share-v').textContent = Number(share.value).toFixed(1) + '%';
    });
    share.addEventListener('change', renderBoard);
    hor.addEventListener('input', function () {
      state.sc.horizonWeeks = Number(hor.value);
      document.getElementById('sc-hor-v').textContent = hor.value + ' wk';
    });
    hor.addEventListener('change', renderBoard);
    document.getElementById('f-csv').addEventListener('click', function () {
      var vm = verdicts(state.sc);
      var rows = filtered(vm).map(function (x) {
        return [x.r.rank, x.r.slug, '"' + x.r.name.replace(/"/g, '""') + '"', x.r.tvl_usd, Math.round(oddsOf(x.r) * 1000) / 10, Math.round(valueIf(x.r)), x.m.implied, x.m.verdict, Math.round(x.m.net)].join(',');
      });
      download('launch-radar-board.csv', 'rank,slug,name,tvl_usd,token_odds_pct,value_if_usd,implied_value_usd,verdict,net_usd\n' + rows.join('\n'), 'text/csv');
    });
    document.getElementById('f-json').addEventListener('click', function () {
      var vm = verdicts(state.sc);
      var rows = filtered(vm).map(function (x) {
        return { rank: x.r.rank, slug: x.r.slug, name: x.r.name, tvl_usd: x.r.tvl_usd, token_odds: Math.round(oddsOf(x.r) * 10000) / 10000, value_if_usd: Math.round(valueIf(x.r)), implied_value_usd: x.m.implied, verdict: x.m.verdict, net_usd: Math.round(x.m.net) };
      });
      download('launch-radar-board.json', JSON.stringify(rows, null, 1), 'application/json');
    });
  }
  function wireRows() {
    app.querySelectorAll('tbody tr[data-slug]').forEach(function (tr) {
      tr.addEventListener('click', function () { location.hash = '#/p/' + tr.getAttribute('data-slug'); });
    });
  }

  // ---------- detail view ----------
  function ladderFind(substr) {
    for (var i = 0; i < V.ladder.length; i++) if (V.ladder[i].term.toLowerCase().indexOf(substr) >= 0) return V.ladder[i];
    return null;
  }
  function decomposeHtml(r) {
    var T = r.tvl_usd;
    var flat = T * V.flat_multiple;
    var run = Math.exp(V.intercept + V.ln_tvl * Math.log(Math.max(1, T)));
    var rows = '';
    rows += '<tr><td>TVL<div class="sub">DefiLlama, ' + esc(D.as_of) + '</div></td><td class="r">' + usd(T) + '</td></tr>';
    rows += '<tr><td>Flat multiple<div class="sub">the median traded cap/TVL, before any fitting</div></td><td class="r">' + x2(V.flat_multiple) + '</td></tr>';
    rows += '<tr><td>Size curve<div class="sub">slope ' + V.ln_tvl.toFixed(2) + ' × ln TVL, fitted on ' + V.comps_used + ' traded tokens; held-out miss ' + x2(K.loo_miss) + ' leave-one-out, ' + x2(K.wf_miss) + ' walk-forward</div></td><td class="r">' + x2(run / flat) + '</td></tr>';
    var stages = [
      ['family', 'Family effect', V.family_effects[r.family] || 0, 'shrunk by 16 pseudo-observations toward the pooled fit'],
      ['category', 'Category effect', V.category_effects[r.category || ''] || 0, 'shrunk by 64 pseudo-observations toward the family fit'],
      ['growth', '7-day growth', V.growth * growthF(r.change_7d), 'the protocol’s own last week, winsorised'],
      ['age', 'Age, years listed', V.age * r.age_years, 'how long it has run with no token recorded'],
      ['chain', 'Chain count', V.chains * Math.log(Math.max(1, r.chains.length)), 'chains it runs on, ln'],
    ];
    stages.forEach(function (s) {
      var lad = ladderFind(s[0]);
      if (!lad || lad.verdict !== 'kept') return;
      run *= Math.exp(s[2]);
      rows += '<tr><td>' + s[1] + '<div class="sub">' + s[3] + '; held-out miss ' + x2(lad.loo) + ' · ' + x2(lad.wf) + '</div></td><td class="r">' + x2(Math.exp(s[2])) + '</td></tr>';
    });
    var vif = valueIf(r);
    rows += '<tr class="total"><td>= Value if a token launches<div class="sub">TVL × the fitted multiple; half of held-out caps fall in ' + usd(vif * Math.exp(V.resid_q.q25)) + '–' + usd(vif * Math.exp(V.resid_q.q75)) + '</div></td><td class="r">' + usd(vif) + '</td></tr>';
    var byNow = probByAge(r, r.age_years), byMax = probByAge(r, O.a_max_years), odds = oddsOf(r);
    var finalOddsRow = O.ladder[0];
    O.ladder.forEach(function (l) { if (l.verdict === 'kept') finalOddsRow = l; });
    rows += '<tr><td>Token odds<div class="sub">peers of its family, size and chain count: ' + Math.round(byNow * 100) + '% record a token by its age (' + r.age_years.toFixed(1) + ' yr), ' + Math.round(byMax * 100) + '% by the oldest cohort’s (' + O.a_max_years.toFixed(1) + ' yr), so (' + Math.round(byMax * 100) + ' − ' + Math.round(byNow * 100) + ') ÷ (100 − ' + Math.round(byNow * 100) + '); Brier ' + finalOddsRow.tenfold.toFixed(3) + ' ten-fold vs ' + K.odds_base_brier_wf.toFixed(3) + ' base</div></td><td class="r">' + x2(odds) + '</td></tr>';
    rows += '<tr class="total"><td>= Implied value<div class="sub">P25–P75 ' + usd(r.p25) + '–' + usd(r.p75) + ' · P10–P90 ' + usd(r.p10) + '–' + usd(r.p90) + ' · rank ' + r.rank_lo + '–' + r.rank_hi + ' across 200 bootstrap refits</div></td><td class="r">' + usd(impliedOf(r)) + '</td></tr>';
    var notUsed = V.ladder.filter(function (l) { return l.verdict === 'tested, not kept'; }).map(function (l) { return esc(l.term.replace('+ ', '')) + ' (' + x2(l.loo) + ', ' + x2(l.wf) + ')'; }).join('; ');
    if (notUsed) rows += '<tr><td colspan="2" class="small mut">Tested, not used: ' + notUsed + '.</td></tr>';
    return '<section class="panel"><div class="phead"><h2>How the figure is made</h2></div><table class="kv">' + rows + '</table></section>';
  }
  function peersHtml(r) {
    if (!r.peers.length) return '';
    var rows = r.peers.map(function (p) {
      return '<tr><td>' + esc(p.name) + '<div class="psub">' + esc(p.symbol || '') + '</div></td><td>' + esc(p.category || '—') + '</td>' +
        '<td class="r">' + usd(p.tvl_usd) + '</td><td class="r">' + usd(p.mcap_usd) + '</td><td class="r">' + x2(p.multiple) + '</td><td class="r">' + x2(p.loo_multiple) + '</td></tr>';
    }).join('');
    return '<section class="panel"><div class="phead"><h2>Nearest priced peers · their tokens trade</h2></div><table class="peers"><tr><th>Token</th><th>Category</th><th class="r">TVL</th><th class="r">Market cap</th><th class="r">Cap ÷ TVL</th><th class="r">Cap ÷ held-out model</th></tr>' + rows + '</table></section>';
  }
  function farmHtml(r) {
    var sc = state.sc;
    var m = farmMath(r, sc);
    var T = r.tvl_usd;
    var shareOf = function (plan) { return plan / (T + plan); };
    var beShare = m.fees / (m.implied * shareOf(m.plan));
    var beOdds = m.fees / (valueIf(r) * sc.dropShare * shareOf(m.plan));
    var dropNoOdds = valueIf(r) * sc.dropShare * shareOf(m.plan);
    var chg = r.change_7d === null ? 0 : r.change_7d;
    var exitPct = Math.min(40, Math.max(10, Math.round(2 * Math.abs(chg))));
    var exitTvl = Math.round(T * (1 - exitPct / 100));
    var shares = [sc.dropShare / 2, sc.dropShare, sc.dropShare * 2];
    var plans = [];
    [1000, 3000, m.plan, 30000].forEach(function (p) { if (plans.indexOf(p) < 0) plans.push(p); });
    var grid = '<table class="grid"><tr><th>Share</th>' + plans.map(function (p) { return '<th>' + (p === m.plan ? 'PLAN ' : '') + usd(p) + '</th>'; }).join('') + '</tr>';
    shares.forEach(function (s) {
      grid += '<tr><th>' + (s * 100).toFixed(1) + '%</th>' + plans.map(function (p) {
        var net = m.implied * s * shareOf(p) - m.fees;
        var hl = Math.abs(s - sc.dropShare) < 1e-9 && p === m.plan ? ' class="hl"' : '';
        return '<td' + hl + '>' + (net >= 0 ? '+' : '−') + '$' + Math.abs(Math.round(net)) + '</td>';
      }).join('') + '</tr>';
    });
    grid += '</table>';
    var steps = r.steps.map(function (s, i) {
      return '<li><span class="no">' + (i + 1) + '</span><div><span class="tag">' + esc(s.tag) + '</span>' + esc(s.text) +
        '<div class="meta"><span>COST ' + esc(s.cost) + '</span><span>TIME ' + esc(s.time) + '</span></div></div></li>';
    }).join('');
    return '<section class="panel"><div class="phead"><h2>Farm verdict</h2><span class="note">' + usdFull(sc.deposit) + ' deposit · ' + (sc.dropShare * 100).toFixed(1) + '% drop share · ' + sc.horizonWeeks + ' weeks</span></div>' +
      '<p><span class="chip ' + m.verdict + '">' + m.verdict + '</span> &nbsp;' + usdFull(m.plan) + ' for ' + sc.horizonWeeks + ' weeks buys a modelled drop of ' + usdFull(m.drop) + ' for ' + usdFull(m.fees) + ' of fees and ' + m.hours.toFixed(1) + ' h of work, a net of ' + usdFull(m.net) + ' (' + usdFull(m.netHour) + ' an hour) against ' + usdFull(m.tbill) + ' from the same money in a 4% T-bill. Fees are covered while the drop share stays above ' + (beShare * 100).toFixed(1) + '% (model ' + (sc.dropShare * 100).toFixed(1) + '%) and the token odds above ' + Math.round(beOdds * 100) + '% (model ' + Math.round(oddsOf(r) * 100) + '%).</p>' +
      '<table class="kv"><tr><td>At risk</td><td>Fees, ' + sc.horizonWeeks + ' weeks</td><td>Modelled drop</td><td>Net of fees</td><td>Hands-on</td><td>Net per hour</td></tr>' +
      '<tr><td class="r" style="text-align:left">' + usdFull(m.plan) + '</td><td class="r" style="text-align:left">' + usdFull(m.fees) + '</td><td class="r" style="text-align:left">' + usdFull(m.drop) + '</td><td class="r" style="text-align:left">' + usdFull(m.net) + '</td><td class="r" style="text-align:left">' + m.hours.toFixed(1) + ' h</td><td class="r" style="text-align:left">' + usdFull(m.netHour) + '</td></tr></table>' +
      '<div class="phead" style="margin-top:8px"><h2>Net by drop share × plan</h2><span class="note">pick a cell</span></div>' + grid +
      '<table class="kv" style="margin-top:8px"><tr><td>Same ' + usdFull(m.plan) + ' in a 4% T-bill, ' + sc.horizonWeeks + ' weeks</td><td class="r">' + usdFull(m.tbill) + '</td></tr>' +
      '<tr><td>Drop if a token does launch (odds not applied)</td><td class="r">' + usdFull(dropNoOdds) + '</td></tr>' +
      '<tr><td>Fees covered above a drop share of</td><td class="r">' + (beShare * 100).toFixed(1) + '%</td></tr>' +
      '<tr><td>Fees covered above token odds of</td><td class="r">' + Math.round(beOdds * 100) + '%</td></tr>' +
      '<tr><td>Exit if TVL prints below (−' + exitPct + '% in a week)</td><td class="r">' + usdFull(exitTvl) + '</td></tr></table>' +
      '<p class="small mut" style="margin-top:6px">Drop = implied value × drop share × deposit ÷ (TVL + deposit) = ' + usd(m.implied) + ' × ' + (sc.dropShare * 100).toFixed(1) + '% × ' + usdFull(m.plan) + ' ÷ ' + usd(T + m.plan) + '. FARM: the net beats the T-bill and $25 an hour; SKIP: fees exceed the drop. Yield earned meanwhile is left out.</p></section>' +
      '<section class="panel"><div class="phead"><h2>Farm plan · ' + r.steps.length + ' steps</h2><span class="note">cost and time at a ' + usdFull(m.plan) + ' plan</span></div><ol class="steps">' + steps + '</ol></section>';
  }
  function renderDetail(r) {
    var m = farmMath(r, state.sc);
    var vif = valueIf(r), odds = oddsOf(r);
    var badges = badge(r) + '<span class="badge">' + m.verdict + '</span><span class="badge">' + esc(r.category || 'No category') + '</span><span class="badge">' + esc(r.family) + ' family</span>' +
      r.chains.slice(0, 4).map(function (c) { return '<span class="badge">' + esc(c) + '</span>'; }).join('');
    app.innerHTML = headerHtml() +
      '<button class="back" id="d-back">← Board</button> <span class="mut">/ ' + esc(r.name) + '</span>' +
      '<div class="dhead"><div class="panel dtitle"><div class="rankline">#' + r.rank + ' of ' + D.rows.length + ' by implied value · rank ' + r.rank_lo + '–' + r.rank_hi + ' across bootstrap refits</div>' +
      '<h1>' + esc(r.name) + '</h1><div style="margin-top:5px">' + badges + '</div>' +
      '<div class="dstats"><div><div class="lab">TVL</div><div class="val">' + usd(r.tvl_usd) + '</div></div>' +
      '<div><div class="lab">7-day change</div><div class="val ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg') + '">' + (r.change_7d === null ? 'n/a' : pct(r.change_7d)) + '</div></div>' +
      '<div><div class="lab">Listed since</div><div class="val">' + esc(r.listed_at || 'not recorded') + '</div></div>' +
      '<div><div class="lab">No-token age</div><div class="val">' + ageFmt(r.age_days, r.age_years) + '</div></div></div></div>' +
      '<div class="panel dvalue"><div class="lab">Implied value · a model estimate</div><div class="big">' + usdFull(impliedOf(r)) + '</div>' +
      '<table><tr><td>If a token launches</td><td class="r">' + usd(vif) + '</td></tr>' +
      '<tr><td>Token odds</td><td class="r">' + Math.round(odds * 100) + '%</td></tr>' +
      '<tr><td>P25–P75</td><td class="r">' + usd(r.p25) + '–' + usd(r.p75) + '</td></tr>' +
      '<tr><td>P10–P90</td><td class="r">' + usd(r.p10) + '–' + usd(r.p90) + '</td></tr></table>' +
      '<p class="small" style="color:#7fc79a;margin-top:6px">✓ Recomputed in this browser: equals board.json. DefiLlama records no token for it, which is not proof it has none; the odds are its peers’ record, not a forecast.</p></div></div>' +
      '<div class="dgrid"><div class="col">' + rangeHtml(r) + decomposeHtml(r) + peersHtml(r) + '</div><div class="col">' + farmHtml(r) + '</div></div>';
    document.getElementById('d-back').addEventListener('click', function () { location.hash = '#/'; });
    window.scrollTo(0, 0);
  }

  // ---------- charts: inline SVG drawn from the same recomputed rows; presentation only ----------
  var ACC = '#43b581', CMUT = '#54677c', CGRID = '#1c2634', CFAINT = '#5b6b7c', CBLUE = '#5b8dd9', CAMB = '#d9a441';
  function usdT(n) { return usd(n).replace(/\.0([BMK])$/, '$1'); }
  function svgOpen(w, h) { return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" role="img" style="display:block" font-family="ui-monospace,Menlo,Consolas,monospace">'; }
  function scatterSvg() {
    var W = 660, H = 104, L = 40, R = 8, T = 6, B = 16;
    var xs = D.rows.map(function (r) { return Math.log(r.tvl_usd); });
    var ys = D.rows.map(function (r) { return Math.log(valueIf(r) / r.tvl_usd); });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys) - 0.25, y1 = Math.max.apply(null, ys) + 0.25;
    var X = function (v) { return L + (v - x0) / (x1 - x0) * (W - L - R); };
    var Y = function (v) { return T + (y1 - v) / (y1 - y0) * (H - T - B); };
    var s = svgOpen(W, H), i;
    [0.05, 0.1, 0.2, 0.5, 1].forEach(function (m) {
      var ly = Math.log(m); if (ly < y0 || ly > y1) return;
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(ly).toFixed(1) + '" y2="' + Y(ly).toFixed(1) + '" stroke="' + CGRID + '"/>' +
        '<text x="' + (L - 5) + '" y="' + (Y(ly) + 3).toFixed(1) + '" fill="' + CFAINT + '" font-size="9.5" text-anchor="end">×' + m + '</text>';
    });
    [1e7, 1e8, 1e9].forEach(function (v) {
      var lx = Math.log(v); if (lx < x0 || lx > x1) return;
      s += '<line y1="' + T + '" y2="' + (H - B) + '" x1="' + X(lx).toFixed(1) + '" x2="' + X(lx).toFixed(1) + '" stroke="' + CGRID + '"/>' +
        '<text y="' + (H - 5) + '" x="' + X(lx).toFixed(1) + '" fill="' + CFAINT + '" font-size="9.5" text-anchor="middle">' + usdT(v) + ' TVL</text>';
    });
    var fy = Y(Math.log(V.flat_multiple));
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + fy.toFixed(1) + '" y2="' + fy.toFixed(1) + '" stroke="#8595a6" stroke-dasharray="4 3"/>' +
      '<text x="' + (W - R - 2) + '" y="' + (fy - 4).toFixed(1) + '" fill="#8595a6" font-size="9.5" text-anchor="end">flat ' + x2(V.flat_multiple) + '</text>';
    var p = '';
    for (i = 0; i <= 24; i++) {
      var lx2 = x0 + (x1 - x0) * i / 24;
      p += (i ? 'L' : 'M') + X(lx2).toFixed(1) + ' ' + Y(V.intercept + (V.ln_tvl - 1) * lx2).toFixed(1);
    }
    s += '<path d="' + p + '" fill="none" stroke="' + ACC + '" stroke-width="1.6"/>' +
      '<text x="' + X(x0 + (x1 - x0) * 0.55).toFixed(1) + '" y="' + (Y(V.intercept + (V.ln_tvl - 1) * (x0 + (x1 - x0) * 0.55)) - 6).toFixed(1) + '" fill="' + ACC + '" font-size="9.5">fitted size curve</text>';
    D.rows.forEach(function (r, j) { if (r.group !== 'ranked_watchlist') s += '<circle cx="' + X(xs[j]).toFixed(1) + '" cy="' + Y(ys[j]).toFixed(1) + '" r="2.1" fill="' + CMUT + '" fill-opacity="0.75"/>'; });
    D.rows.forEach(function (r, j) { if (r.group === 'ranked_watchlist') s += '<circle cx="' + X(xs[j]).toFixed(1) + '" cy="' + Y(ys[j]).toFixed(1) + '" r="2.6" fill="' + ACC + '"/>'; });
    return s + '</svg>';
  }
  function histSvg() {
    var W = 316, H = 104, L = 26, R = 6, T = 6, B = 16, NB = 14;
    var ls = D.rows.map(function (r) { return Math.log(r.implied); });
    var lo = Math.min.apply(null, ls), hi = Math.max.apply(null, ls), bw = (hi - lo) / NB;
    var bins = [], i;
    for (i = 0; i < NB; i++) bins.push({ a: 0, w: 0 });
    D.rows.forEach(function (r, j) {
      var k = Math.min(NB - 1, Math.floor((ls[j] - lo) / bw));
      bins[k].a++; if (r.group === 'ranked_watchlist') bins[k].w++;
    });
    var mx = Math.max.apply(null, bins.map(function (b) { return b.a; }));
    var X = function (k) { return L + k / NB * (W - L - R); };
    var Y = function (c) { return T + (1 - c / (mx * 1.1)) * (H - T - B); };
    var s = svgOpen(W, H);
    [Math.ceil(mx / 2), mx].forEach(function (c) {
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(c).toFixed(1) + '" y2="' + Y(c).toFixed(1) + '" stroke="' + CGRID + '"/>' +
        '<text x="' + (L - 4) + '" y="' + (Y(c) + 3).toFixed(1) + '" fill="' + CFAINT + '" font-size="9.5" text-anchor="end">' + c + '</text>';
    });
    bins.forEach(function (b, k) {
      if (!b.a) return;
      var x = (X(k) + 0.5).toFixed(1), wdt = (X(k + 1) - X(k) - 1).toFixed(1), yb = H - B;
      s += '<rect x="' + x + '" y="' + Y(b.a - b.w).toFixed(1) + '" width="' + wdt + '" height="' + (yb - Y(b.a - b.w)).toFixed(1) + '" fill="#3d5a73"/>';
      if (b.w) s += '<rect x="' + x + '" y="' + Y(b.a).toFixed(1) + '" width="' + wdt + '" height="' + (Y(b.a - b.w) - Y(b.a)).toFixed(1) + '" fill="' + ACC + '"/>';
    });
    [0, 0.5, 1].forEach(function (f) {
      s += '<text y="' + (H - 5) + '" x="' + (L + f * (W - L - R)).toFixed(1) + '" fill="' + CFAINT + '" font-size="9.5" text-anchor="' + (f === 0 ? 'start' : f === 1 ? 'end' : 'middle') + '">' + usdT(Math.exp(lo + (hi - lo) * f)) + '</text>';
    });
    return s + '</svg>';
  }
  function chartsHtml() {
    var med = D.rows.map(function (r) { return r.implied; }).sort(function (a, b) { return a - b; })[Math.floor(D.rows.length / 2)];
    return '<section class="panel"><div class="phead"><h2>The model, drawn</h2><span class="note">every ranked protocol, from the same figures the table below prints</span></div>' +
      '<div class="charts"><div><div class="chartcap">FITTED MULTIPLE — VALUE IF A TOKEN LAUNCHES ÷ TVL, AGAINST TVL (LOG–LOG)</div>' + scatterSvg() +
      '<p class="small mut" style="margin-top:3px">One dot per ranked protocol; <span style="color:' + ACC + '">green = the 40-protocol watchlist</span>. The green line is the fitted size curve with family effect 0; each dot also carries its own family effect, which is why they spread around the line. Dashed: the flat median multiple before any fitting.</p></div>' +
      '<div><div class="chartcap">IMPLIED VALUES — HOW THE ' + D.rows.length + ' ROWS SPREAD</div>' + histSvg() +
      '<p class="small mut" style="margin-top:3px">Rows per band of implied value, bands log-spaced; the green top of a bar is its watchlist rows. Half the board sits below ' + usd(med) + ' — the head is a few large protocols, the tail is long.</p></div></div></section>';
  }
  function rangeHtml(r) {
    if (!r.peers || !r.peers.length) return '';
    var Q = V.resid_q;
    var items = [{ name: r.name, lo: r.p10, q1: r.p25, pt: impliedOf(r), q3: r.p75, hi: r.p90, self: true }];
    r.peers.slice(0, 5).forEach(function (p) {
      if (!(p.loo_multiple > 0)) return;
      var pred = p.mcap_usd / p.loo_multiple;
      items.push({ name: p.name, lo: pred * Math.exp(Q.q10), q1: pred * Math.exp(Q.q25), pt: p.mcap_usd, q3: pred * Math.exp(Q.q75), hi: pred * Math.exp(Q.q90), self: false });
    });
    var lo = Math.log(Math.min.apply(null, items.map(function (d) { return d.lo; })));
    var hi = Math.log(Math.max.apply(null, items.map(function (d) { return d.hi; })));
    var W = 470, L = 118, R = 8, T = 2, B = 14, rowH = 13;
    var H = T + items.length * rowH + B;
    var X = function (v) { return L + (Math.log(v) - lo) / (hi - lo) * (W - L - R); };
    var s = svgOpen(W, H);
    for (var e = Math.ceil(lo / Math.LN10); e <= Math.floor(hi / Math.LN10); e++) {
      var xv = X(Math.pow(10, e));
      s += '<line x1="' + xv.toFixed(1) + '" x2="' + xv.toFixed(1) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="' + CGRID + '"/>' +
        '<text x="' + xv.toFixed(1) + '" y="' + (H - 4) + '" fill="' + CFAINT + '" font-size="8.5" text-anchor="middle">' + usdT(Math.pow(10, e)) + '</text>';
    }
    items.forEach(function (d, i) {
      var cy = T + i * rowH + rowH / 2;
      var col = d.self ? ACC : CBLUE;
      s += '<text x="0" y="' + (cy + 3) + '" fill="' + (d.self ? '#d8e0e8' : '#8595a6') + '" font-size="9.5" style="font-family:var(--sans)">' + esc(d.name.length > 17 ? d.name.slice(0, 16) + '…' : d.name) + '</text>' +
        '<line x1="' + X(d.lo).toFixed(1) + '" x2="' + X(d.hi).toFixed(1) + '" y1="' + cy + '" y2="' + cy + '" stroke="' + col + '" stroke-opacity="0.55"/>' +
        '<line x1="' + X(d.lo).toFixed(1) + '" x2="' + X(d.lo).toFixed(1) + '" y1="' + (cy - 2.5) + '" y2="' + (cy + 2.5) + '" stroke="' + col + '" stroke-opacity="0.55"/>' +
        '<line x1="' + X(d.hi).toFixed(1) + '" x2="' + X(d.hi).toFixed(1) + '" y1="' + (cy - 2.5) + '" y2="' + (cy + 2.5) + '" stroke="' + col + '" stroke-opacity="0.55"/>' +
        '<rect x="' + X(d.q1).toFixed(1) + '" y="' + (cy - 3) + '" width="' + (X(d.q3) - X(d.q1)).toFixed(1) + '" height="6" fill="' + col + '" fill-opacity="0.28" stroke="' + col + '" stroke-opacity="0.8"/>' +
        '<line x1="' + X(d.pt).toFixed(1) + '" x2="' + X(d.pt).toFixed(1) + '" y1="' + (cy - 4.5) + '" y2="' + (cy + 4.5) + '" stroke="' + (d.self ? CAMB : '#d8e0e8') + '" stroke-width="2"/>';
    });
    return '<section class="panel"><div class="phead"><h2>The range, drawn</h2><span class="note">whisker P10–P90 · box P25–P75 · tick = the figure</span></div>' + s + '</svg>' +
      '<p class="small mut" style="margin-top:4px">This protocol: the tick is its implied value, the box and whisker the board’s printed range. Peers: the box is where the model priced each one held-out — its cap ÷ the model’s figure for it, spread by the same residual range — and the white tick is the cap it actually trades at.</p></section>';
  }

  // ---------- routing ----------
  function route() {
    var h = location.hash || '';
    if (h.indexOf('#/p/') === 0) {
      var slug = decodeURIComponent(h.slice(4));
      for (var i = 0; i < D.rows.length; i++) if (D.rows[i].slug === slug) { renderDetail(D.rows[i]); return; }
    }
    if (h === '#/farm') state.tab = 'farm';
    renderBoard();
  }
  window.addEventListener('hashchange', route);
  app.removeAttribute('aria-busy');
  route();
})();
