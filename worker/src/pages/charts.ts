/**
 * The dashboard's charts: small inline SVG with no library (the pages have no
 * build step). A page that draws includes CHARTS in its script; every helper
 * takes the numbers /api/v1/stats already returns. Bars carry their value in
 * data-tip; the layout's tooltip shows it.
 */
export const CHARTS = String.raw`  // ---- tiny SVG charts (no library; the page has no build step) ----
  var C = { green: "#9ece6a", amber: "#e0af68", red: "#f7768e", blue: "#7aa2f7", lilac: "#bb9af7", dim: "#414868", grid: "#2a2e3f", text: "#8b93b8" };
  // The viewBox is the drawing; the SVG scales uniformly with its column
  // (no preserveAspectRatio="none": stretched text overflowed its space).
  function svg(w, h, body) { return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" style="display:block;height:auto" font-family="JetBrains Mono, ui-monospace, monospace" font-size="11" fill="' + C.text + '">' + body + '</svg>'; }
  // Labels get the room they have, not more: cut with an ellipsis, full text in the tooltip.
  function fit(t, n) { t = String(t || ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; }
  function day(iso) { return iso.slice(0, 10); }
  function lastDays(n) { var out = [], t = Date.now(); for (var i = n - 1; i >= 0; i--) out.push(new Date(t - i * 86400000).toISOString().slice(0, 10)); return out; }
  function bars(items, fmt) { // vertical bars, items: [{label, value, color, title}]
    if (!items.length || !items.some(function (i) { return i.value > 0; })) return '<div class="empty">nothing yet</div>';
    var W = 360, H = 150, top = 16, bottom = 22, left = 6, max = Math.max.apply(null, items.map(function (i) { return i.value; })) || 1;
    var bw = (W - left * 2) / items.length, body = '';
    body += '<line x1="0" y1="' + (H - bottom) + '" x2="' + W + '" y2="' + (H - bottom) + '" stroke="' + C.grid + '"/>';
    items.forEach(function (it, i) {
      var h = (H - top - bottom) * it.value / max, x = left + i * bw, y = H - bottom - h;
      body += '<rect x="' + (x + bw * 0.15) + '" y="' + y + '" width="' + (bw * 0.7) + '" height="' + h + '" fill="' + (it.color || C.green) + '"><title>' + esc(it.title || it.label + ": " + fmt(it.value)) + '</title></rect>';
      var step = items.length > 8 ? 2 : 1;
      if (i % step === 0) body += '<text x="' + (x + bw / 2) + '" y="' + (H - 7) + '" text-anchor="middle" font-size="10">' + esc(it.label) + '</text>';
    });
    body += '<text x="' + left + '" y="11" font-size="10">max ' + esc(fmt(max)) + '</text>';
    return svg(W, H, body);
  }
  function area(points, fmt, height, color) { // points: [{t: ms, v}]; height in the 360-wide viewBox, 150 unless the card has room; green unless told
    if (points.length < 2) return '<div class="empty">' + (points.length ? 'one snapshot so far — the line needs two' : 'collecting snapshots') + '</div>';
    var W = 360, H = height || 150, top = 16, bottom = 20, left = 6, right = 6, col = color || C.green;
    var vs = points.map(function (p) { return p.v; }), max = Math.max.apply(null, vs) || 1, min = Math.min.apply(null, vs);
    var t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
    var lo = min === max ? 0 : min;
    var X = function (t) { return left + (W - left - right) * (t - t0) / (t1 - t0 || 1); }, Y = function (v) { return H - bottom - (H - top - bottom) * (v - lo) / (max - lo || 1); };
    var pts = points.map(function (p) { return X(p.t).toFixed(1) + "," + Y(p.v).toFixed(1); }).join(" ");
    var body = '<polygon points="' + X(t0).toFixed(1) + ',' + (H - bottom) + ' ' + pts + ' ' + X(t1).toFixed(1) + ',' + (H - bottom) + '" fill="' + col + '" fill-opacity="0.15"/>';
    body += '<polyline points="' + pts + '" fill="none" stroke="' + col + '" stroke-width="1.5"/>';
    body += '<text x="' + left + '" y="11" font-size="10">' + esc(fmt(max)) + '</text><text x="' + left + '" y="' + (H - bottom - 3) + '" font-size="10">' + esc(fmt(lo)) + '</text>';
    body += '<text x="' + left + '" y="' + (H - 6) + '" font-size="10">' + esc(new Date(t0).toUTCString().slice(5, 16)) + '</text><text x="' + (W - right) + '" y="' + (H - 6) + '" text-anchor="end" font-size="10">' + esc(new Date(t1).toUTCString().slice(5, 16)) + '</text>';
    return svg(W, H, body);
  }
  function heat(rows, days, cell) { // rows: [{key,label}], cell(key, day) -> status|null
    if (!rows.length) return '<div class="empty">no health checks yet</div>';
    var W = 360, labelW = 110, rh = 18, H = rows.length * rh + 22, cw = (W - labelW) / days.length, body = '';
    rows.forEach(function (r, ri) {
      body += '<text x="0" y="' + (ri * rh + 13) + '" font-size="10.5"><title>' + esc(r.label) + '</title>' + esc(fit(r.label, 17)) + '</text>';
      days.forEach(function (dd, di) {
        var st = cell(r.key, dd), col = st === "error" ? C.red : st === "warn" ? C.amber : st === "ok" ? C.green : C.dim;
        body += '<rect x="' + (labelW + di * cw + 1) + '" y="' + (ri * rh + 2) + '" width="' + (cw - 2) + '" height="' + (rh - 4) + '" fill="' + col + '" fill-opacity="' + (st ? 1 : 0.35) + '"><title>' + esc(r.label + " " + dd + ": " + (st || "no check")) + '</title></rect>';
      });
    });
    body += '<text x="' + labelW + '" y="' + (H - 4) + '" font-size="10">' + esc(days[0].slice(5)) + '</text><text x="' + W + '" y="' + (H - 4) + '" text-anchor="end" font-size="10">' + esc(days[days.length - 1].slice(5)) + '</text>';
    return svg(W, H, body);
  }
  function hbars(items) { // items: [{label, parts: [{v, color}], note}]
    if (!items.length) return '<div class="empty">no snapshot yet</div>';
    var W = 360, labelW = 112, noteW = 66, rh = 20, H = items.length * rh + 4, body = '';
    var max = Math.max.apply(null, items.map(function (i) { return i.parts.reduce(function (a, p) { return a + p.v; }, 0); })) || 1;
    items.forEach(function (it, i) {
      var x = labelW, y = i * rh + 2;
      body += '<text x="0" y="' + (y + 12) + '" font-size="10.5"><title>' + esc(it.label) + '</title>' + esc(fit(it.label, 17)) + '</text>';
      it.parts.forEach(function (p) { var w = (W - labelW - noteW - 10) * p.v / max; if (w > 0) { body += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + (rh - 6) + '" fill="' + p.color + '"><title>' + esc(it.label + ": " + p.v + " " + p.name) + '</title></rect>'; x += w; } });
      body += '<text x="' + (W) + '" y="' + (y + 12) + '" text-anchor="end" font-size="10">' + esc(it.note) + '</text>';
    });
    return svg(W, H, body);
  }
  function worst(a, b) { var rank = { error: 3, warn: 2, ok: 1 }; return (rank[b] || 0) > (rank[a] || 0) ? b : a; }

  // ---- v2 charts: stacked bars, several lines on one axis, html bars, a 14-day heat grid ----
  function nice(max) { var p = Math.pow(10, Math.floor(Math.log10(max || 1))), n = max / p; var s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10; return s * p; }
  function shortDay(l) { return String(l).length === 10 ? l.slice(5) : String(l).replace(/^\w+ /, ""); }
  // series: [{name, color, values}] over labels; every bar carries a data-tip with all its parts.
  function stacked(labels, series, opts) {
    opts = opts || {}; var W = 520, H = 170, L = 36, R = 6, T = 8, B = 24, n = labels.length || 1, iw = (W - L - R) / n, bw = Math.max(2, iw - 3);
    var sums = labels.map(function (_, i) { return series.reduce(function (a, s) { return a + (Number(s.values[i]) || 0); }, 0); });
    if (!labels.length || !sums.some(function (v) { return v > 0; })) return '<div class="empty">' + (opts.empty || "nothing yet") + '</div>';
    var max = nice(Math.max.apply(null, sums)); var ys = function (v) { return T + (H - T - B) * (1 - v / max); };
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(opts.label || "") + '">';
    [0, .5, 1].forEach(function (f) { var y = ys(max * f); out += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '"/><text class="ax" x="' + (L - 6) + '" y="' + (y + 3.5) + '" text-anchor="end">' + num(Math.round(max * f)) + '</text>'; });
    labels.forEach(function (lab, i) {
      var y0 = ys(0), x = L + i * iw + 1.5, tip = lab + series.map(function (s) { return " · " + s.name + " " + num(s.values[i] || 0); }).join("");
      series.forEach(function (s) { var v = Number(s.values[i]) || 0; if (!v) return; var y1 = ys(v); var h = y0 - y1; out += '<rect class="mark" x="' + x + '" y="' + (y0 - h) + '" width="' + bw + '" height="' + Math.max(0, h - 2) + '" fill="' + s.color + '" data-tip="' + esc(tip) + '"/>'; y0 -= h; });
      if (n <= 8 || i % 2 === 1) out += '<text class="ax" x="' + (x + bw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(opts.full ? lab : shortDay(lab)) + '</text>';
    });
    out += '</svg>';
    if (series.length > 1) out += '<div class="legend">' + series.map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>'; }).join("") + '</div>';
    return out;
  }
  function lines(labels, series, unit, label) {
    var W = 520, H = 170, L = 36, R = 10, T = 12, B = 24, n = labels.length, all = [];
    series.forEach(function (s) { all = all.concat(s.values.map(Number)); });
    if (n < 2 || !all.some(function (v) { return v > 0; })) return '<div class="empty">nothing yet</div>';
    var max = nice(Math.max.apply(null, all)), xs = function (i) { return L + (W - L - R) * i / (n - 1); }, ys = function (v) { return T + (H - T - B) * (1 - v / max); };
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(label || "") + '">';
    [0, .5, 1].forEach(function (f) { var y = ys(max * f); out += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '"/><text class="ax" x="' + (L - 6) + '" y="' + (y + 3.5) + '" text-anchor="end">' + num(Math.round(max * f)) + '</text>'; });
    series.forEach(function (s) {
      out += '<polyline points="' + s.values.map(function (v, i) { return xs(i) + "," + ys(Number(v) || 0); }).join(" ") + '" fill="none" stroke="' + s.color + '" stroke-width="2"/>';
      s.values.forEach(function (v, i) { out += '<circle class="mark" cx="' + xs(i) + '" cy="' + ys(Number(v) || 0) + '" r="' + (i === n - 1 ? 4.5 : 3) + '" fill="' + s.color + '" stroke="#1f2230" stroke-width="2" data-tip="' + esc(labels[i] + " · " + s.name + " " + num(v) + (unit ? " " + unit : "")) + '"/>'; });
    });
    labels.forEach(function (lab, i) { if (n <= 8 || i % 2 === 1) out += '<text class="ax" x="' + xs(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(shortDay(lab)) + '</text>'; });
    return out + '</svg><div class="legend">' + series.map(function (s) { return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span>'; }).join("") + '</div>';
  }
  // rows: [[label, small, percent, color?, shown?, tip?]] — a labelled bar per row, percent of a full bar; the tooltip is the label and the value unless the row brings its own (what a worker did in the day).
  // opts is the label column's width in px, or { w, html }: html when the label and its small print are markup the page escaped itself (a worker's name with its tooltip) — such a row brings its tip.
  function hrows(rows, opts) {
    if (!rows.length) return '<div class="empty">nothing yet</div>';
    opts = typeof opts === "number" ? { w: opts } : opts || {};
    var mark = function (t) { return opts.html ? t : esc(t); };
    return '<div class="hrows">' + rows.map(function (r) { var full = r[2] >= 100; return '<div class="hrow"' + (opts.w ? ' style="grid-template-columns:' + opts.w + 'px 1fr 52px"' : "") + '><div class="l">' + mark(r[0]) + (r[1] ? ' <small>' + mark(r[1]) + '</small>' : "") + '</div><div class="bar" data-tip="' + esc(r[5] || r[0] + (r[1] ? " " + r[1] : "") + " · " + (r[4] || r[2] + "%")) + '"><i class="' + (full ? "" : "partial") + '" style="width:' + Math.min(100, r[2]) + '%' + (r[3] ? ";background:" + r[3] : "") + '"></i></div><div class="p num">' + (r[4] || r[2] + "%") + '</div></div>'; }).join("") + '</div>';
  }
  // The factory's builds per day from the stats series (builds_daily: {day, status, n}): the labels and series stacked() draws — staged blue, published (done) green, failed red, over the last days — and days, the three counts per label for a page that draws one bar a day.
  function buildsByDay(series, days) {
    var by = {}; ((series || {}).builds_daily || []).forEach(function (r) { var x = by[r.day] = by[r.day] || { staged: 0, published: 0, failed: 0 }; if (r.status === "staged") x.staged += Number(r.n); else if (r.status === "done") x.published += Number(r.n); else if (r.status === "failed") x.failed += Number(r.n); });
    var labels = lastDays(days || 14), counts = labels.map(function (d) { return by[d] || { staged: 0, published: 0, failed: 0 }; }), of = function (k) { return counts.map(function (c) { return c[k]; }); };
    return { labels: labels, days: counts, series: [{ name: "staged", color: C.blue, values: of("staged") }, { name: "published", color: C.green, values: of("published") }, { name: "failed", color: C.red, values: of("failed") }] };
  }
  // The pool's jobs over the last days, from the stats series (jobs_daily: {day, kind, status, n, ms}, grouped by the day the job finished, a waiting one by the day it was queued), reduced once: runs, done, failed, waiting and the milliseconds — in all, per kind (byKind) and per day (byDay, over labels). The Status tiles, its jobs table and both its job charts, and the Pipeline's chart read this; none reduces the rows itself, and none reads the metrics snapshot's jobs, which is up to half an hour older than the series beside it and counts a cancelled job as a success. Here a cancelled job is a failed one: it did not do its work. The snapshot stays for the history it alone has (the pool's growth).
  function jobsSummary(series, days) {
    var labels = lastDays(days || 7), keep = {}; labels.forEach(function (d) { keep[d] = 1; });
    var zero = function () { return { runs: 0, done: 0, failed: 0, waiting: 0, ms: 0 }; };
    var add = function (o, r) { var n = Number(r.n || 0); o.runs += n; if (r.status === "done") o.done += n; else if (r.status === "failed" || r.status === "cancelled") o.failed += n; else o.waiting += n; o.ms += Number(r.ms || 0); };
    var all = zero(), byKind = {}, byDay = {};
    ((series || {}).jobs_daily || []).forEach(function (r) { if (!keep[r.day]) return; add(all, r); add(byKind[r.kind] = byKind[r.kind] || zero(), r); add(byDay[r.day] = byDay[r.day] || zero(), r); });
    return { labels: labels, runs: all.runs, done: all.done, failed: all.failed, waiting: all.waiting, ms: all.ms, byKind: byKind, byDay: byDay };
  }
  // The minutes the project's workers spent on pool jobs, over the last days: labels and values for a chart, and total for the tile beside it — the tile and the chart's bars are one sum, not a snapshot beside a series. A view on jobsSummary's days, so the minutes and the jobs are one reduce.
  function workerMinutes(series, days) {
    var js = jobsSummary(series, days), values = js.labels.map(function (d) { return Math.round((js.byDay[d] || { ms: 0 }).ms / 60000); });
    return { labels: js.labels, values: values, total: values.reduce(function (n, v) { return n + v; }, 0) };
  }
  // Fourteen days of health per ring and architecture, worst result per day, as html cells.
  function heatGrid(health) {
    var days = lastDays(14), cells = {}, RINGS = ["stable", "rc", "edge"], ARCHES = ["x86_64", "aarch64"];
    (health || []).forEach(function (h) { var k = h.ring + "/" + h.arch + "/" + day(h.created_at); cells[k] = worst(cells[k], h.status); });
    if (!Object.keys(cells).length) return '<div class="empty">no health checks yet</div>';
    var rows = []; RINGS.forEach(function (r) { ARCHES.forEach(function (a) { rows.push([r + " " + a, r + "/" + a]); }); });
    var names = { ok: "healthy", warn: "warning", error: "failed" };
    return '<div class="heat">' + rows.map(function (r) { return '<div class="r"><span class="l">' + esc(r[0]) + '</span>' + days.map(function (dd) { var st = cells[r[1] + "/" + dd]; return '<span class="c ' + (st || "") + '" data-tip="' + esc(dd + " · " + r[0] + " · " + (names[st] || "no check")) + '"></span>'; }).join("") + '</div>'; }).join("") +
      '<div class="days"><span></span>' + days.map(function (d, i) { return '<span>' + (i % 2 ? esc(d.slice(5)) : "") + '</span>'; }).join("") + '</div></div>';
  }
`;

