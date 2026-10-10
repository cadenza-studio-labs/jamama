export async function readRecallCollection(fetchPage, { maxItems = 10000, maxPages = 200 } = {}) {
  const items = [], offsets = new Set();
  let offset = 0;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offsets.has(offset)) throw new Error('Apple Music repeated or returned an unreadable library page. Refresh and try again.');
    offsets.add(offset);
    const page = await fetchPage(offset);
    if (!Array.isArray(page?.items)) throw new Error('Apple Music returned unreadable library entries.');
    items.push(...page.items);
    if (items.length > maxItems) throw new Error(`This game supports up to ${maxItems.toLocaleString()} entries per selection. Choose a smaller playlist.`);
    offset = page.nextOffset;
    if (offset == null) return items;
  }
  throw new Error('Apple Music returned too many library pages. Choose a smaller playlist.');
}
