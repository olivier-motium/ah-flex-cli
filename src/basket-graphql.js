import { assertExactProductUrl, BasketError } from "./basket.js";

export const BASKET_COLLECTIONS = Object.freeze(["itemsInList", "externalItems", "itemsInOrder"]);
export const BASKET_QUERY_OPERATION = "basket";
export const BASKET_ITEMS_ADD_OPERATION = "basketItemsAdd";
export const BASKET_ITEMS_UPDATE_OPERATION = "basketItemsUpdate";

export const BASKET_QUERY = `query basket {
  basket {
    itemsInList { id quantity }
    externalItems { id quantity }
    itemsInOrder { id quantity }
  }
}`;

const BASKET_MUTATION_RESULT_SELECTION = `
    result {
      itemsInList { id quantity }
      externalItems { id quantity }
      itemsInOrder { id quantity }
    }`;

export const BASKET_ITEMS_ADD_MUTATION = `mutation basketItemsAdd($items: [BasketMutation!]!) {
  basketItemsAdd(items: $items) { ${BASKET_MUTATION_RESULT_SELECTION} }
}`;

export const BASKET_ITEMS_UPDATE_MUTATION = `mutation basketItemsUpdate($items: [BasketMutation!]!) {
  basketItemsUpdate(items: $items) { ${BASKET_MUTATION_RESULT_SELECTION} }
}`;

const BASKET_HEADERS = Object.freeze({
  "content-type": "application/json",
  "X-Require-Member": "true",
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveSafeInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BasketError(`AH basket ${label} was malformed; refusing a cart action`);
  }
  return value;
}

export function parseProductIdFromUrl(value) {
  const exactUrl = assertExactProductUrl(value);
  const match = new URL(exactUrl).pathname.match(/\/producten\/product\/wi(\d+)(?:\/|$)/);
  if (!match) {
    throw new BasketError("Selected product URL has no numeric AH product ID; refusing a cart action");
  }
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BasketError("Selected product URL has a non-positive or unsafe AH product ID; refusing a cart action");
  }
  return id;
}

export function normalizeRequestedLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new BasketError("The reviewed basket contains no selected product lines");
  }
  const seen = new Set();
  return lines.map((line) => {
    if (!isObject(line)) throw new BasketError("A reviewed product line was malformed; refusing a cart action");
    const url = assertExactProductUrl(line.url);
    const id = parseProductIdFromUrl(url);
    if (seen.has(id)) {
      throw new BasketError(`Duplicate numeric AH product ID ${id}; refusing an ambiguous cart plan`);
    }
    seen.add(id);
    const quantity = positiveSafeInteger(line.quantity, "request quantity");
    return { ...line, url, id, quantity };
  });
}

function normalizeCollection(rows, collection, seen) {
  if (rows === null) return [];
  if (!Array.isArray(rows)) {
    throw new BasketError(`AH basket collection ${collection} was malformed; refusing a cart action`);
  }
  return rows.map((row) => {
    if (!isObject(row) || !Object.prototype.hasOwnProperty.call(row, "id") || !Object.prototype.hasOwnProperty.call(row, "quantity")) {
      throw new BasketError(`AH basket collection ${collection} contained a malformed item; refusing a cart action`);
    }
    const id = positiveSafeInteger(row.id, `${collection} product ID`);
    const quantity = positiveSafeInteger(row.quantity, `${collection} quantity`);
    if (seen.has(id)) {
      throw new BasketError(`Duplicate or ambiguous AH basket product ID ${id}; refusing a cart action`);
    }
    seen.add(id);
    return { id, quantity };
  });
}

export function normalizeBasketCollections(basket) {
  if (!isObject(basket)) {
    throw new BasketError("AH basket data was malformed; refusing a cart action");
  }
  const seen = new Set();
  for (const collection of BASKET_COLLECTIONS) {
    if (!Object.prototype.hasOwnProperty.call(basket, collection)) {
      throw new BasketError(`AH basket collection ${collection} was missing; refusing a cart action`);
    }
  }
  return {
    itemsInList: normalizeCollection(basket.itemsInList, "itemsInList", seen),
    externalItems: normalizeCollection(basket.externalItems, "externalItems", seen),
    itemsInOrder: normalizeCollection(basket.itemsInOrder, "itemsInOrder", seen),
  };
}

export function basketCollectionItems(snapshot) {
  const normalized = normalizeBasketCollections(snapshot);
  return [...normalized.itemsInList, ...normalized.externalItems, ...normalized.itemsInOrder];
}

function assertGraphqlEnvelope(payload) {
  if (!isObject(payload)) throw new BasketError("AH basket GraphQL response was malformed; refusing a cart action");
  if (Object.prototype.hasOwnProperty.call(payload, "errors")) {
    if (!Array.isArray(payload.errors) || payload.errors.length > 0) {
      throw new BasketError("AH basket GraphQL returned an error; refusing a cart action");
    }
  }
  if (!isObject(payload.data)) {
    throw new BasketError("AH basket GraphQL response had no usable data; refusing a cart action");
  }
  return payload.data;
}

export function normalizeBasketGraphqlResponse(payload) {
  const data = assertGraphqlEnvelope(payload);
  if (!isObject(data.basket)) {
    throw new BasketError("AH basket GraphQL response had no usable basket; refusing a cart action");
  }
  return normalizeBasketCollections(data.basket);
}

function mutationItems(items, label) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new BasketError(`AH ${label} mutation received no items; refusing a cart action`);
  }
  const seen = new Set();
  return items.map((item) => {
    if (!isObject(item)) throw new BasketError(`AH ${label} mutation item was malformed; refusing a cart action`);
    const id = positiveSafeInteger(item.id, `${label} product ID`);
    const quantity = positiveSafeInteger(item.quantity, `${label} quantity`);
    if (seen.has(id)) throw new BasketError(`AH ${label} mutation contained a duplicate product ID; refusing a cart action`);
    seen.add(id);
    return { id, quantity, description: null };
  });
}

function request(operationName, query, variables) {
  return {
    headers: { ...BASKET_HEADERS },
    body: { operationName, query, variables },
  };
}

export function createBasketQueryRequest() {
  return request(BASKET_QUERY_OPERATION, BASKET_QUERY, {});
}

export function createBasketItemsAddRequest(items) {
  return request(
    BASKET_ITEMS_ADD_OPERATION,
    BASKET_ITEMS_ADD_MUTATION,
    { items: mutationItems(items, "add") },
  );
}

export function createBasketItemsUpdateRequest(items) {
  return request(
    BASKET_ITEMS_UPDATE_OPERATION,
    BASKET_ITEMS_UPDATE_MUTATION,
    { items: mutationItems(items, "update") },
  );
}

function itemById(snapshot) {
  return new Map(basketCollectionItems(snapshot).map((item) => [item.id, item]));
}

function mutationItem(id, quantity) {
  return { id, quantity, description: null };
}

export function buildBasketMutationPlan(lines, snapshot) {
  const requested = normalizeRequestedLines(lines);
  const normalizedSnapshot = normalizeBasketCollections(snapshot);
  const observed = itemById(normalizedSnapshot);
  const actions = [];
  const addItems = [];
  const topUpCandidates = [];

  for (const line of requested) {
    const current = observed.get(line.id);
    if (!current) {
      actions.push({ ...line, action: "absent", observed_quantity: null });
      addItems.push(mutationItem(line.id, line.quantity));
      continue;
    }
    if (current.quantity === line.quantity) {
      actions.push({ ...line, action: "already-present", observed_quantity: current.quantity });
      continue;
    }
    if (current.quantity > line.quantity) {
      actions.push({ ...line, action: "kept-higher", observed_quantity: current.quantity });
      continue;
    }
    actions.push({
      ...line,
      action: "candidate-top-up",
      observed_quantity: current.quantity,
      from_quantity: current.quantity,
    });
    topUpCandidates.push({
      ...line,
      baseline_quantity: current.quantity,
      mutation: mutationItem(line.id, line.quantity),
    });
  }

  return {
    lines: actions,
    addItems,
    topUpCandidates,
    snapshot: normalizedSnapshot,
  };
}

export function reconcileTopUpCandidates(plan, snapshot) {
  const normalizedSnapshot = normalizeBasketCollections(snapshot);
  const observed = itemById(normalizedSnapshot);
  const actions = plan.lines.map((line) => ({ ...line }));
  const actionById = new Map(actions.map((line) => [line.id, line]));
  const updateItems = [];

  for (const candidate of plan.topUpCandidates) {
    const current = observed.get(candidate.id);
    const action = actionById.get(candidate.id);
    if (!current) {
      throw new BasketError("Basket changed concurrently before a safe top-up; refusing the update batch");
    }
    if (current.quantity >= candidate.quantity) {
      action.action = current.quantity === candidate.quantity ? "already-present" : "kept-higher";
      action.observed_quantity = current.quantity;
      delete action.from_quantity;
      continue;
    }
    if (current.quantity !== candidate.baseline_quantity) {
      throw new BasketError("Basket changed concurrently below the requested quantity; refusing the update batch");
    }
    action.action = "candidate-top-up";
    action.observed_quantity = current.quantity;
    action.from_quantity = current.quantity;
    updateItems.push(candidate.mutation);
  }

  return { ...plan, lines: actions, updateItems, snapshot: normalizedSnapshot };
}

export function validateBasketMutationResponse(payload, expectedField) {
  const data = assertGraphqlEnvelope(payload);
  if (expectedField !== BASKET_ITEMS_ADD_OPERATION && expectedField !== BASKET_ITEMS_UPDATE_OPERATION) {
    throw new BasketError("Unexpected AH basket mutation field; refusing a cart action");
  }
  const mutation = data[expectedField];
  if (!isObject(mutation)) {
    throw new BasketError("AH basket mutation response omitted the expected operation; cart state is unverified");
  }
  if (!isObject(mutation.result)) {
    throw new BasketError("AH basket mutation response had no usable result; cart state is unverified");
  }
  return {
    acknowledged: true,
    snapshot: normalizeBasketCollections(mutation.result),
  };
}

export function assertBasketHttpStatus(status) {
  if (status !== 200) {
    throw new BasketError("AH basket GraphQL did not return HTTP 200; cart state is unverified");
  }
}
