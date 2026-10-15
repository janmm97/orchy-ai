// The saved theme, set before the page paints (a file, not inline: the page's CSP allows only Orchy's own scripts)
try { var t = localStorage.getItem('jos-theme'); if (t) document.documentElement.dataset.theme = t === 'day' ? 'day' : t; } catch (e) {}
