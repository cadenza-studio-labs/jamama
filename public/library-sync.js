export async function refreshLoadedPages(fetchPage, loadedCount = 0) {
  const items = new Map();
  const seen = new Set();
  const target = Math.max(1, loadedCount);
  let offset = 0, page, stalled = 0;
  do {
    if (seen.has(offset)) throw new Error('The music service returned a repeated library page. Try refreshing again.');
    seen.add(offset);
    page = await fetchPage(offset);
    if (!Array.isArray(page?.items)) throw new Error('The music service returned unreadable library data.');
    const before = items.size;
    for (const item of page.items) {
      if (!item || typeof item.id !== 'string' || !item.id) throw new Error('The music service returned unreadable library entries.');
      items.set(item.id, item);
    }
    stalled = items.size === before ? stalled + 1 : 0;
    if (stalled >= 3 || (!page.items.length && page.nextOffset != null)) throw new Error('The music service could not advance through the library. Try refreshing again.');
    offset = page.nextOffset;
    if (offset != null && (!Number.isSafeInteger(offset) || offset < 0)) throw new Error('The music service returned an invalid library page.');
  } while (offset != null && items.size < target);
  return { ...page, items: [...items.values()] };
}
