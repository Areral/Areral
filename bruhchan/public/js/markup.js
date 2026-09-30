import { esc } from './util.js';

// Classic imageboard markup on already-escaped text: >greentext, >>quotelinks, [spoiler], bare URLs.
export function renderComment(text) {
  return esc(text)
    .split('\n')
    .map((line) => {
      let html = line
        .replace(/\[spoiler\]([\s\S]*?)\[\/spoiler\]/g, '<s class="spoiler">$1</s>')
        .replace(/https?:\/\/[^\s<]+[^\s<.,:;!?)\]]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`)
        .replace(/&gt;&gt;(\d{1,10})/g, '<a class="quotelink" href="#p$1" data-no="$1">&gt;&gt;$1</a>');
      if (/^&gt;(?!&gt;\d)/.test(line)) html = `<span class="quote">${html}</span>`;
      return html;
    })
    .join('<br>');
}
