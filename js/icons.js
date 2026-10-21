/*
 * Transport icons drawn as SVG, rasterised to PNG once at start-up so the same
 * picture is used in the preview and embedded in the .pptx.
 */
const SlideIcons = (function () {
  const SVG = {
    plane: { w: 64, h: 28, body: `<g fill="#000">
      <path d="M6 14 Q6 11 12 11 L54 11 Q62 11 63 14 Q62 17 54 17 L12 17 Q6 17 6 14Z"/>
      <path d="M27 12 L36 12 L22 1 L17 1Z"/><path d="M27 16 L36 16 L22 27 L17 27Z"/>
      <path d="M7 12 L2 3 L7 3 L14 12Z"/></g>` },
    train: { w: 32, h: 40, body: `<rect x="5" y="2" width="22" height="28" rx="5" fill="#000"/>
      <rect x="9" y="7" width="14" height="9" rx="1.5" fill="#fff"/>
      <circle cx="11" cy="23" r="2" fill="#fff"/><circle cx="21" cy="23" r="2" fill="#fff"/>
      <path d="M10 30 L6 38 M22 30 L26 38 M8 35 H24" stroke="#000" stroke-width="2.5" fill="none"/>` },
    car: { w: 48, h: 26, body: `<path d="M3 19 L3 13 Q3 11 6 10.5 L12 9.5 L17 4 Q18 3 20 3 L32 3 Q34 3 35.5 4.5 L40 9.5 L44 10.5 Q46 11 46 13 L46 19 Z" fill="#000"/>
      <path d="M19 5 L26 5 L26 9.5 L15 9.5Z M28 5 L33 5 L37 9.5 L28 9.5Z" fill="#fff"/>
      <circle cx="13" cy="20" r="4.5" fill="#000" stroke="#fff" stroke-width="1.5"/>
      <circle cx="36" cy="20" r="4.5" fill="#000" stroke="#fff" stroke-width="1.5"/>` },
  };

  const icons = {};

  function rasterise(name) {
    const { w, h, body } = SVG[name];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * 4}" height="${h * 4}">${body}</svg>`;
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = w * 4; c.height = h * 4;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        icons[name] = { data: c.toDataURL('image/png'), w, h };
        resolve();
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  const ready = Promise.all(Object.keys(SVG).map(rasterise)).then(() => icons);
  return { ready, get: (name) => icons[name] };
})();
