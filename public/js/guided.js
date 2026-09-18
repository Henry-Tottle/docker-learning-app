(function () {
  var cfg = window.GUIDED;
  var gate = document.getElementById('gate');
  var bar = document.getElementById('gate-bar');
  var count = document.getElementById('viewed-count');
  var actions = document.getElementById('gate-actions');
  var lockedMsg = document.getElementById('gate-locked');
  var labels = { locked: 'quiz locked', unlocked: 'quiz available', mastered: 'mastered' };

  function paintConcept(key, status) {
    document.querySelectorAll('[data-concept-status="' + key + '"]').forEach(function (el) {
      el.textContent = '(' + (labels[status] || status) + ')';
    });
  }
  Object.keys(cfg.conceptStatus).forEach(function (k) { paintConcept(k, cfg.conceptStatus[k]); });

  document.querySelectorAll('details.code-line').forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (!d.open || d.classList.contains('viewed')) return;
      fetch('/projects/' + cfg.projectId + '/guided/viewed', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ lineId: d.dataset.lineId })
      }).then(function (r) { return r.json(); }).then(function (res) {
        d.classList.add('viewed');
        count.textContent = res.status.viewed;
        bar.style.width = Math.round(res.status.viewed / res.status.total * 100) + '%';
        if (res.concept) paintConcept(res.concept, res.conceptStatus);
        if (res.status.complete) { actions.hidden = false; lockedMsg.hidden = true; gate.dataset.complete = 'true'; }
      });
    });
  });

  var copy = document.getElementById('copy-all');
  if (copy) copy.addEventListener('click', function () {
    var text = cfg.files.map(function (f) { return '# ---- ' + f.name + ' ----\n' + f.text; }).join('\n');
    navigator.clipboard.writeText(text).then(function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy all to clipboard'; }, 1500); });
  });
})();
