(function () {
  var form = document.querySelector('form.wizard');
  var preview = document.getElementById('preview');
  var note = document.getElementById('db-note');
  function update() {
    var data = new FormData(form);
    var q = new URLSearchParams({ appType: data.get('appType') || '', database: data.get('database') || '', target: data.get('target') || '', start: data.get('start') || '' });
    note.hidden = data.get('appType') !== 'static';
    fetch('/wizard/preview?' + q.toString()).then(function (r) { return r.json(); }).then(function (p) {
      var total = p.files.reduce(function (n, f) { return n + f.lines; }, 0);
      preview.textContent = 'This will generate ' + p.files.map(function (f) { return f.name; }).join(', ') + ' (' + total + ' lines) and involve ' + p.concepts.length + ' concepts.';
    }).catch(function () { preview.textContent = ''; });
  }
  form.addEventListener('change', update);
  update();
})();
