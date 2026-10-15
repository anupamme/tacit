// Slim views of an asset's listings, built from the list's JSON body.
//
// `book`: each preauth sale's price, amount, seller and times, for a page that draws the order book (the trade page). The whole list carries what
// a buyer completing a sale reads (the seller's signatures, the asset's outpoint and opening, the payout script): about 1 KB a sale, 156 KB for
// TAC's 146 (40 KB compressed). This keeps what the book is drawn from, about a fifth of it. The amount is the opening's amount alone. A buyer
// still reads the sale whole, from the whole list or /preauth-sales/:sale_id.
const KEEP = ['sale_id', 'seller_pubkey', 'min_price_sats', 'expiry', 'expired', 'created_at'];
export function preauthSalesBookBody(body) {
  const j = JSON.parse(body);
  if (!Array.isArray(j.sales)) throw new Error('no sales list');
  const sales = j.sales.map((s) => {
    const o = {};
    for (const k of KEEP) if (s[k] !== undefined) o[k] = s[k];
    o.asset_opening = { amount: s.asset_opening?.amount ?? null };
    return o;
  });
  return JSON.stringify({ ...j, view: 'book', sales });
}
