/*
 * SlideKit — one slide description drives both the on-page preview and the
 * editable .pptx export, so what you see is what you download.
 *
 * A slide is { background?, elements: [...] }. All positions are in inches on a
 * 13.333 x 7.5 in (16:9) slide; font sizes are in points. Element types:
 *   rect  { x, y, w, h, fill, line?, lineWidth? (pt), radius? (in) }
 *   text  { x, y, w, h, text | paras, fontSize, bold, italic, color, fill, align, valign, margin (pt) }
 *         paras: [{ text, bold, fontSize, color, bullet, align }] — one paragraph each
 *   table { x, y, w, colW[], rowH (number or array), rows[][], fontSize, header, zebra, align[], borderColor }
 *         a cell is a string or { text, bold, fill, color, align, valign, fontSize, colspan, rowspan }
 *         (cells covered by a span are left out of the row, as in PptxGenJS)
 *   image { x, y, w, h, data (data URL), imgW, imgH }  — fitted inside the box
 *   arrow { x, y1, y2, color, width (pt) }  — vertical, dot at y1, arrowhead at y2
 */
(function () {
  const W = 13.333, H = 7.5;
  const FONT = 'Calibri';
  const THEME = {
    primary: '1F3A5F', accent: '2E86DE', text: '222222', muted: '6B7280',
    light: 'F3F6FA', border: 'D0D7E2', white: 'FFFFFF', highlight: 'FFF4CC',
  };

  // Standard title bar + optional subtitle + accent footer.
  function frame(title, subtitle) {
    const els = [
      { type: 'rect', x: 0, y: 0, w: W, h: 0.9, fill: THEME.primary },
      { type: 'text', x: 0.4, y: 0, w: W - 0.8, h: 0.9, text: title, fontSize: 26, bold: true, color: THEME.white, valign: 'middle' },
      { type: 'rect', x: 0, y: H - 0.08, w: W, h: 0.08, fill: THEME.accent },
    ];
    if (subtitle) {
      els.push({ type: 'text', x: 0.4, y: 0.95, w: W - 0.8, h: 0.4, text: subtitle, fontSize: 13, color: THEME.muted, valign: 'middle' });
    }
    return els;
  }

  function tableCells(e) {
    return e.rows.map((row, ri) => row.map((c, ci) => {
      const cell = c && typeof c === 'object' ? c : { text: c };
      const isHead = e.header && ri === 0;
      const zebra = e.zebra && !isHead && ri % 2 === 0 ? THEME.light : null;
      return {
        text: cell.text == null ? '' : String(cell.text),
        bold: cell.bold ?? isHead,
        color: cell.color || (isHead ? THEME.white : THEME.text),
        fill: cell.fill || (isHead ? THEME.primary : zebra),
        align: cell.align || (e.align && e.align[ci]) || 'left',
        valign: cell.valign || 'middle',
        fontSize: cell.fontSize || e.fontSize || 11,
        colspan: cell.colspan, rowspan: cell.rowspan,
      };
    }));
  }

  const rowHeight = (e, i) => (Array.isArray(e.rowH) ? e.rowH[i] : e.rowH || 0.35);

  // Shrink an image to fit its box, keeping aspect ratio, centred.
  function fitImage(e) {
    if (!e.imgW || !e.imgH) return { x: e.x, y: e.y, w: e.w, h: e.h };
    const r = Math.min(e.w / e.imgW, e.h / e.imgH);
    const w = e.imgW * r, h = e.imgH * r;
    return { x: e.x + (e.w - w) / 2, y: e.y + (e.h - h) / 2, w, h };
  }

  // ---------- Preview (HTML) ----------
  const inch = (v) => `calc(var(--u) * ${v})`;
  const pt = (v) => `calc(var(--u) * ${v / 72})`;
  const VALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };

  function box(e) {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute;left:${inch(e.x)};top:${inch(e.y)};width:${inch(e.w)};height:${inch(e.h)};`;
    return d;
  }

  function drawParas(d, e) {
    e.paras.forEach((p) => {
      const pd = document.createElement('div');
      Object.assign(pd.style, {
        fontSize: pt(p.fontSize || e.fontSize || 14), fontWeight: p.bold ? '700' : '400',
        color: '#' + (p.color || e.color || THEME.text), textAlign: p.align || e.align || 'left',
      });
      if (p.bullet) {
        pd.style.paddingLeft = '1em';
        pd.style.textIndent = '-0.8em';
        pd.textContent = '• ' + p.text;
      } else {
        pd.textContent = p.text;
      }
      d.appendChild(pd);
    });
  }

  function drawElement(e) {
    if (e.type === 'rect') {
      const d = box(e);
      if (e.fill) d.style.background = '#' + e.fill;
      if (e.line) d.style.border = `max(1px, ${pt(e.lineWidth || 0.75)}) solid #${e.line}`;
      if (e.radius) d.style.borderRadius = inch(e.radius);
      return d;
    }
    if (e.type === 'text') {
      const d = box(e);
      Object.assign(d.style, {
        display: 'flex', flexDirection: 'column', justifyContent: VALIGN[e.valign || 'top'],
        textAlign: e.align || 'left', padding: pt(e.margin ?? 4), overflow: 'hidden',
        whiteSpace: 'pre-wrap', lineHeight: '1.15', fontSize: pt(e.fontSize || 14),
        fontWeight: e.bold ? '700' : '400', fontStyle: e.italic ? 'italic' : 'normal',
        color: '#' + (e.color || THEME.text), background: e.fill ? '#' + e.fill : 'transparent',
      });
      if (e.paras) drawParas(d, e);
      else d.textContent = e.text || '';
      return d;
    }
    if (e.type === 'image') {
      const d = box(fitImage(e));
      const img = document.createElement('img');
      img.src = e.data;
      img.style.cssText = 'width:100%;height:100%;display:block;';
      d.appendChild(img);
      return d;
    }
    if (e.type === 'arrow') {
      const wIn = 0.2, len = e.y2 - e.y1;
      const d = box({ x: e.x - wIn / 2, y: e.y1 - 0.06, w: wIn, h: len + 0.06 });
      const sw = (e.width || 3) / 72, col = '#' + e.color;
      // viewBox in inches so the drawing scales with the slide
      d.innerHTML = `<svg viewBox="0 0 ${wIn} ${len + 0.06}" width="100%" height="100%" preserveAspectRatio="none" style="overflow:visible">
        <line x1="${wIn / 2}" y1="0.06" x2="${wIn / 2}" y2="${Math.max(0.06, len - 0.08)}" stroke="${col}" stroke-width="${sw}"/>
        <circle cx="${wIn / 2}" cy="0.06" r="0.06" fill="${col}"/>
        <polygon points="${wIn / 2 - 0.06},${len - 0.1} ${wIn / 2 + 0.06},${len - 0.1} ${wIn / 2},${len + 0.04}" fill="${col}"/></svg>`;
      return d;
    }
    if (e.type === 'table') {
      const d = document.createElement('div');
      d.style.cssText = `position:absolute;left:${inch(e.x)};top:${inch(e.y)};width:${inch(e.w)};`;
      const t = document.createElement('table');
      t.className = 'sk-table';
      const cg = document.createElement('colgroup');
      (e.colW || []).forEach((w) => { const c = document.createElement('col'); c.style.width = inch(w); cg.appendChild(c); });
      t.appendChild(cg);
      tableCells(e).forEach((row, ri) => {
        const tr = document.createElement('tr');
        tr.style.height = inch(rowHeight(e, ri));
        row.forEach((c) => {
          const td = document.createElement('td');
          td.textContent = c.text;
          if (c.colspan) td.colSpan = c.colspan;
          if (c.rowspan) td.rowSpan = c.rowspan;
          Object.assign(td.style, {
            fontSize: pt(c.fontSize), fontWeight: c.bold ? '700' : '400', color: '#' + c.color,
            background: c.fill ? '#' + c.fill : 'transparent', textAlign: c.align, verticalAlign: c.valign,
            padding: `0 ${pt(3)}`, border: `1px solid #${e.borderColor || THEME.border}`,
          });
          tr.appendChild(td);
        });
        t.appendChild(tr);
      });
      d.appendChild(t);
      return d;
    }
    return document.createElement('div');
  }

  const observer = new ResizeObserver((entries) => {
    entries.forEach((en) => en.target.style.setProperty('--u', en.contentRect.width / W + 'px'));
  });

  // opts.onClick(slideIndex, xInches, yInches) makes the preview clickable.
  function renderPreview(container, slides, opts = {}) {
    container.innerHTML = '';
    slides.forEach((s, i) => {
      const el = document.createElement('div');
      el.className = 'sk-slide';
      el.style.background = '#' + (s.background || THEME.white);
      el.style.fontFamily = `${FONT}, Carlito, Arial, sans-serif`;
      s.elements.forEach((e) => el.appendChild(drawElement(e)));
      if (opts.onClick) {
        el.classList.add('clickable');
        el.addEventListener('click', (ev) => {
          const r = el.getBoundingClientRect();
          const k = W / r.width;
          opts.onClick(i, (ev.clientX - r.left) * k, (ev.clientY - r.top) * k);
        });
      }
      if (slides.length > 1) {
        const label = document.createElement('div');
        label.className = 'sk-label';
        label.textContent = `Slide ${i + 1}`;
        container.appendChild(label);
      }
      container.appendChild(el);
      observer.observe(el);
    });
  }

  // ---------- Export (.pptx via PptxGenJS) ----------
  function addElement(pptx, sl, e) {
    if (e.type === 'rect') {
      sl.addShape(e.radius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, {
        x: e.x, y: e.y, w: e.w, h: e.h, rectRadius: e.radius,
        fill: e.fill ? { color: e.fill } : undefined,
        line: e.line ? { color: e.line, width: e.lineWidth || 0.75 } : { type: 'none' },
      });
    } else if (e.type === 'text') {
      const content = e.paras
        ? e.paras.map((p, i) => ({
          text: p.text,
          options: {
            bold: !!p.bold, fontSize: p.fontSize || e.fontSize || 14, color: p.color || e.color || THEME.text,
            align: p.align || e.align || 'left', bullet: p.bullet ? { indent: 10 } : false,
            breakLine: i < e.paras.length - 1,
          },
        }))
        : e.text || '';
      sl.addText(content, {
        x: e.x, y: e.y, w: e.w, h: e.h, fontFace: FONT, fontSize: e.fontSize || 14,
        bold: !!e.bold, italic: !!e.italic, color: e.color || THEME.text,
        align: e.align || 'left', valign: e.valign || 'top', margin: e.margin ?? 4,
        fill: e.fill ? { color: e.fill } : undefined,
      });
    } else if (e.type === 'image') {
      sl.addImage({ data: e.data, ...fitImage(e) });
    } else if (e.type === 'arrow') {
      sl.addShape(pptx.ShapeType.line, {
        x: e.x, y: e.y1, w: 0, h: e.y2 - e.y1,
        line: { color: e.color, width: e.width || 3, beginArrowType: 'oval', endArrowType: 'triangle' },
      });
    } else if (e.type === 'table') {
      const rows = tableCells(e).map((row) => row.map((c) => ({
        text: c.text,
        options: {
          bold: c.bold, color: c.color, align: c.align, valign: c.valign, fontSize: c.fontSize,
          fill: c.fill ? { color: c.fill } : undefined, colspan: c.colspan, rowspan: c.rowspan,
        },
      })));
      sl.addTable(rows, {
        x: e.x, y: e.y, w: e.w, colW: e.colW, rowH: e.rowH || 0.35, margin: 0.02,
        fontFace: FONT, valign: 'middle', border: { type: 'solid', pt: 0.5, color: e.borderColor || THEME.border },
      });
    }
  }

  function buildPptx(slides) {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5 in
    slides.forEach((s) => {
      const sl = pptx.addSlide();
      if (s.background) sl.background = { color: s.background };
      s.elements.forEach((e) => addElement(pptx, sl, e));
      if (s.notes) sl.addNotes(s.notes);
    });
    return pptx;
  }

  function exportPptx(slides, fileName) {
    const safe = (fileName || 'slides').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'slides';
    return buildPptx(slides).writeFile({ fileName: safe.endsWith('.pptx') ? safe : safe + '.pptx' });
  }

  window.SlideKit = { W, H, THEME, FONT, frame, renderPreview, buildPptx, exportPptx };
})();
