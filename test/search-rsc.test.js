import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeNextFPayloads,
  extractProductArrays,
  mapSearchProduct,
  normalizeSalesUnitSize,
  parseSearchResponse,
  searchProductsHttp,
} from "../src/search-rsc.js";
import { searchProducts } from "../src/search.js";
import { BasketError } from "../src/basket.js";

function nextFHtml(...chunks) {
  return `<html><body>${chunks
    .map((chunk) => `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`)
    .join("")}</body></html>`;
}

function rscChunk(products) {
  return `f8:["$","$Lfb",null,{"locale":"nl-BE","products":${JSON.stringify(products)}}]`;
}

function rawProduct(overrides = {}) {
  return {
    id: 543332,
    title: "AH Scharrel kipfilet naturel",
    webPath: "/producten/product/wi543332/ah-scharrel-kipfilet-naturel",
    salesUnitSize: "150 g",
    priceV2: { now: { amount: 3.49 }, was: { amount: 3.49 }, promotionLabels: [] },
    availability: { isOrderable: true, availabilityLabel: null },
    ...overrides,
  };
}

test("next_f script strings decode back into one rsc stream", () => {
  const html = nextFHtml('a:["x",{"k":1}]', 'b:{"products":[]}', "trailing");
  assert.equal(decodeNextFPayloads(html), 'a:["x",{"k":1}]b:{"products":[]}trailing');
});

test("product arrays are found across chunks and survive malformed slices", () => {
  const decoded = `{"products":[${JSON.stringify(rawProduct())}]}noise{"products":[{"broken":]}tail{"products":[]}`;
  const arrays = extractProductArrays(decoded);
  assert.equal(arrays.length, 2);
  assert.equal(arrays[0][0].id, 543332);
  assert.deepEqual(arrays[1], []);
});

test("salesUnitSize variants normalize to parseable packs or stay unreadable", () => {
  assert.equal(normalizeSalesUnitSize("150 g"), "150 g");
  assert.equal(normalizeSalesUnitSize("1 kg"), "1 kg");
  assert.equal(normalizeSalesUnitSize("Pakje 500 gram"), "500 g");
  assert.equal(normalizeSalesUnitSize("ca. 320 g"), "320 g");
  assert.equal(normalizeSalesUnitSize("390 gram"), "390 g");
  assert.equal(normalizeSalesUnitSize("75 cl"), "750 ml");
  assert.equal(normalizeSalesUnitSize("6 stuks"), "6 stuks");
  assert.equal(normalizeSalesUnitSize("2 flessen van 355 ml"), null);
  assert.equal(normalizeSalesUnitSize("6 x 33 cl"), null);
  assert.equal(normalizeSalesUnitSize("Per zak"), null);
  assert.equal(normalizeSalesUnitSize("2 schalen"), null);
  assert.equal(normalizeSalesUnitSize(""), null);
  assert.equal(normalizeSalesUnitSize(null), null);
});

test("rsc products map into the candidate shape with unit prices and promotions", () => {
  const product = mapSearchProduct(
    rawProduct({
      salesUnitSize: "Pakje 500 gram",
      priceV2: {
        now: { amount: 4 },
        was: { amount: 6.65 },
        promotionLabels: [{ topText: "40%", centerText: null, bottomText: "korting" }],
      },
    }),
    "2026-07-31T00:00:00.000Z",
  );
  assert.equal(product.name, "AH Scharrel kipfilet naturel");
  assert.equal(product.url, "https://www.ah.be/producten/product/wi543332/ah-scharrel-kipfilet-naturel");
  assert.equal(product.product_id, "wi543332");
  assert.equal(product.price_eur, 4);
  assert.equal(product.pack, "500 g");
  assert.equal(product.unit_price_eur, 8);
  assert.equal(product.unit_price_basis, "kg");
  assert.equal(product.promotion, "40% korting");
  assert.equal(product.availability, "available");
  assert.equal(product.checked_at, "2026-07-31T00:00:00.000Z");
});

test("unorderable and labelled products read as unavailable", () => {
  assert.equal(mapSearchProduct(rawProduct({ availability: { isOrderable: false } })).availability, "unavailable");
  assert.equal(
    mapSearchProduct(rawProduct({ availability: { isOrderable: true, availabilityLabel: "Niet leverbaar" } }))
      .availability,
    "unavailable",
  );
});

test("search responses dedupe by url and keep unreadable multipacks visible", () => {
  const html = nextFHtml(
    rscChunk([
      rawProduct(),
      rawProduct({ id: 3, title: "Spa water", webPath: "/producten/product/wi3/spa", salesUnitSize: "2 flessen van 355 ml" }),
    ]),
    rscChunk([rawProduct(), { title: "no webPath" }]),
  );
  const products = parseSearchResponse(html, "2026-07-31T00:00:00.000Z");
  assert.equal(products.length, 2);
  assert.equal(products[0].product_id, "wi543332");
  assert.equal(products[1].pack, null);
  assert.equal(products[1].availability, "available");
});

test("http search returns products through an injected fetch", async () => {
  const html = nextFHtml(rscChunk([rawProduct()]));
  const products = await searchProductsHttp("kipfilet", {
    limit: 5,
    headers: {},
    fetchImpl: async (url) => {
      assert.match(url, /^https:\/\/www\.ah\.be\/zoeken\?query=kipfilet$/);
      return { status: 200, ok: true, url, text: async () => html };
    },
  });
  assert.equal(products.length, 1);
  assert.equal(products[0].price_eur, 3.49);
});

test("http search fails closed when nothing or nothing readable comes back", async () => {
  const empty = nextFHtml(rscChunk([]));
  await assert.rejects(
    searchProductsHttp("kip", { headers: {}, fetchImpl: async () => ({ status: 200, ok: true, url: "https://www.ah.be/zoeken?query=kip", text: async () => empty }) }),
    (error) => error instanceof BasketError && /No products/.test(error.message),
  );
  const unreadable = nextFHtml(rscChunk([rawProduct({ salesUnitSize: "Per zak" })]));
  await assert.rejects(
    searchProductsHttp("kip", { headers: {}, fetchImpl: async () => ({ status: 200, ok: true, url: "https://www.ah.be/zoeken?query=kip", text: async () => unreadable }) }),
    /false-success/,
  );
});

test("transport selection defaults to http and rejects unknown transports", async () => {
  const html = nextFHtml(rscChunk([rawProduct()]));
  const fetchImpl = async (url) => ({ status: 200, ok: true, url, text: async () => html });
  const viaDefault = await searchProducts("kipfilet", { headers: {}, fetchImpl });
  const viaExplicit = await searchProducts("kipfilet", { transport: "http", headers: {}, fetchImpl });
  assert.equal(viaDefault[0].product_id, "wi543332");
  assert.equal(viaExplicit[0].product_id, "wi543332");
  await assert.rejects(searchProducts("kipfilet", { transport: "carrier-pigeon" }), /Unknown search transport/);
});
