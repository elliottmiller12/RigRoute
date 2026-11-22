// Sets day/night before first paint so the page never flashes the wrong colors.
(function () {
  var m = null;
  try { m = localStorage.getItem('rigroute.mode'); } catch (e) {}
  if (m !== 'day' && m !== 'night') m = (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches) ? 'day' : 'night';
  document.documentElement.dataset.mode = m;
})();
