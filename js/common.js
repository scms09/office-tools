/*
 * Shared bits for every page: the tool registry (drives the nav bar and the
 * home page), safe localStorage, and a few small helpers.
 *
 * To add a new tool: create <name>.html + js/<name>.js, then add it to TOOLS.
 */
const TOOLS = [
  { href: 'route.html', name: 'Route Planner', icon: '🗺️', desc: 'Route between two places using multiple modes of transport, laid out on a slide with a map.' },
  { href: 'schedule.html', name: 'Trip Schedule', icon: '🕒', desc: 'Day-by-day visit planner (06:00–24:00) with meetings, flights, trains and car trips drawn as boxes.' },
];

const App = {
  store: {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    },
  },

  debounce(fn, ms = 150) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  },

  el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    });
    children.flat().forEach((c) => e.append(c instanceof Node ? c : document.createTextNode(c)));
    return e;
  },

  toast(msg, kind = 'info') {
    const t = App.el('div', { class: `toast ${kind}` }, msg);
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3500);
  },

  renderHeader() {
    const header = document.getElementById('app-header');
    if (!header) return;
    const here = location.pathname.split('/').pop() || 'index.html';
    header.append(
      App.el('a', { class: 'brand', href: 'index.html' }, 'Office Automation'),
      App.el('nav', {}, TOOLS.map((t) => App.el('a', { href: t.href, class: t.href === here ? 'active' : '' }, t.name))),
    );
  },
};

document.addEventListener('DOMContentLoaded', App.renderHeader);
