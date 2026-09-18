(function () {
  var cfg = JSON.parse(document.getElementById('page-config').textContent);
  if (!cfg.unlocked) return;
  var btn = document.getElementById('run-check');
  var status = document.getElementById('check-status');
  var report = document.getElementById('report');
  var summary = document.getElementById('report-summary');
  var list = document.getElementById('findings');
  var ed = { dockerfile: document.getElementById('ed-dockerfile'), compose: document.getElementById('ed-compose'), dockerignore: document.getElementById('ed-dockerignore') };

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  btn.addEventListener('click', function () {
    status.textContent = 'Checking…';
    fetch('/projects/' + cfg.projectId + '/free/lint', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ dockerfile: ed.dockerfile.value, compose: ed.compose.value, dockerignore: ed.dockerignore.value })
    }).then(function (r) { return r.json(); }).then(function (res) {
      status.textContent = '';
      if (res.error) { status.textContent = 'Locked: master the remaining concepts first.'; return; }
      report.hidden = false;
      summary.textContent = res.summary.errors + ' errors, ' + res.summary.warnings + ' warnings, ' + res.summary.ok + ' things right.' + (res.passed ? ' No errors: this would build and run. Look at the warnings for what an experienced reviewer would still change.' : '');
      list.innerHTML = res.findings.map(function (f) {
        return '<li class="finding ' + f.level + '"><span class="lvl">' + f.level + '</span> <code>' + esc(f.file) + '</code> ' + esc(f.message) +
          (f.hint ? ' <em class="hint">Think about: ' + esc(f.hint) + '</em>' : '') +
          (f.conceptTitle ? ' <a class="concept-link" href="/concepts/' + f.concept + '?back=' + encodeURIComponent(location.pathname) + '">' + esc(f.conceptTitle) + '</a>' : '') + '</li>';
      }).join('');
      report.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) { status.textContent = 'Check failed: ' + e.message; });
  });
})();
