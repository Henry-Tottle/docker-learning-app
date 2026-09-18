(function () {
  var cfg = window.SCAFFOLD;
  var bar = document.getElementById('fill-bar');
  var count = document.getElementById('fill-count');
  var done = document.getElementById('fill-done');
  var tokenEls = [document.getElementById('hint-token-count'), document.getElementById('tokens-here')];
  var total = document.querySelectorAll('.code-line.blank').length;

  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { j._status = r.status; return j; }); });
  }
  function setTokens(n) { tokenEls.forEach(function (el) { if (el) el.textContent = n; }); }

  document.querySelectorAll('.code-line.blank').forEach(function (row) {
    var id = row.dataset.blankId;
    var input = row.querySelector('input.blank-input');
    var check = row.querySelector('button.check');
    var hint = row.querySelector('button.hint');
    var feedback = row.querySelector('.feedback');
    var hintText = row.querySelector('.hint-text');
    if (!input || !check) return;

    function run() {
      post('/projects/' + cfg.projectId + '/scaffold/check', { blankId: id, value: input.value }).then(function (res) {
        feedback.hidden = false;
        if (res.error === 'locked') { feedback.className = 'feedback wrong'; feedback.textContent = res.why; return; }
        feedback.className = 'feedback ' + (res.correct ? 'ok' : 'wrong');
        feedback.textContent = (res.correct ? 'Correct. ' : '') + res.why;
        if (res.correct) {
          row.classList.add('correct');
          input.value = res.answer; input.disabled = true; check.remove(); if (hint) hint.remove();
          count.textContent = res.correctCount;
          bar.style.width = Math.round(res.correctCount / total * 100) + '%';
          if (res.complete) done.hidden = false;
        }
      });
    }
    check.addEventListener('click', run);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); run(); } });

    if (hint) hint.addEventListener('click', function () {
      post('/projects/' + cfg.projectId + '/scaffold/hint', { blankId: id }).then(function (res) {
        if (res.error) { feedback.hidden = false; feedback.className = 'feedback wrong'; feedback.textContent = res.why; return; }
        hintText.hidden = false; hintText.textContent = '💡 ' + res.hint; hint.textContent = 'Hint';
        setTokens(res.tokens);
      });
    });
  });
})();
