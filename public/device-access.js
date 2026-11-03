// Keep Melody Tab on computers; phones use Chord Shift, including old links.
(() => {
  const mobile = navigator.userAgentData?.mobile === true
    || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    || (navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 768);
  if (mobile) document.documentElement.classList.add('phone-device');
  const isMelodyEntry = /(?:\/|\/index\.html)$/.test(location.pathname);
  if (isMelodyEntry && (mobile || new URLSearchParams(location.search).get('page') !== 'melody')) {
    location.replace('./chords.html');
  }
})();
