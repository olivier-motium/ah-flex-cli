import { BasketError } from "./basket.js";
import { searchProducts as searchProductsViaBrowser } from "./browser.js";
import { searchProductsHttp } from "./search-rsc.js";

export const TRANSPORTS = Object.freeze(["http", "browser"]);

export async function searchProducts(query, options = {}) {
  const transport = options.transport ?? "http";
  if (transport === "http") return searchProductsHttp(query, options);
  if (transport === "browser") return searchProductsViaBrowser(query, options);
  throw new BasketError(`Unknown search transport '${transport}'; use one of: ${TRANSPORTS.join(", ")}`);
}
