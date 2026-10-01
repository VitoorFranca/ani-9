import type { CycleReport, Reason, Relation, StudyCard } from "./types.js";

const PREVIEW_LENGTH = 60;

class MinHeap<T> {
  private readonly items: T[] = [];
  constructor(private readonly compare: (a: T, b: T) => number) {}
  get size(): number {
    return this.items.length;
  }
  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(items[i]!, items[parent]!) >= 0) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }
  pop(): T {
    const items = this.items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.compare(items[l]!, items[m]!) < 0) m = l;
        if (r < items.length && this.compare(items[r]!, items[m]!) < 0) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m]!, items[i]!];
        i = m;
      }
    }
    return top;
  }
}

function preview(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > PREVIEW_LENGTH ? `${clean.slice(0, PREVIEW_LENGTH - 1)}…` : clean;
}

function activePrerequisites<Id>(cards: readonly StudyCard<Id>[], relations: readonly Relation<Id>[]): Relation<Id>[] {
  const present = new Set(cards.map((c) => c.id));
  return relations.filter(
    (r) => r.kind === "prerequisite" && r.status === "active" && r.from !== r.to && present.has(r.from) && present.has(r.to),
  );
}

/** Strongly connected components with more than one card (Tarjan), each sorted by created order. */
function findCycles<Id>(cards: readonly StudyCard<Id>[], edges: readonly Relation<Id>[]): Id[][] {
  const next = new Map<Id, Id[]>();
  for (const e of edges) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const orderOf = new Map(cards.map((c) => [c.id, c.createdOrder]));
  const index = new Map<Id, number>();
  const low = new Map<Id, number>();
  const onStack = new Set<Id>();
  const stack: Id[] = [];
  const cycles: Id[][] = [];
  let counter = 0;

  // Iterative Tarjan: decks can have thousands of cards, recursion could overflow.
  for (const root of cards.map((c) => c.id)) {
    if (index.has(root)) continue;
    const work: Array<{ node: Id; child: number }> = [{ node: root, child: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const children = next.get(frame.node) ?? [];
      if (frame.child < children.length) {
        const child = children[frame.child++]!;
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter++);
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, child: 0 });
        } else if (onStack.has(child)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(child)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: Id[] = [];
        let member: Id;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        if (component.length > 1) cycles.push(component.sort((a, b) => orderOf.get(a)! - orderOf.get(b)!));
      }
    }
  }
  return cycles.sort((a, b) => orderOf.get(a[0]!)! - orderOf.get(b[0]!)!);
}

/**
 * Prerequisites come before their dependents. Cards in a cycle are treated
 * as having no ordering relation and are reported, never resolved. Each card
 * is keyed by the smallest created order among itself and everything that
 * depends on it, so a prerequisite is pulled forward to just before its
 * earliest dependent instead of pushing the dependent back; cards without
 * relations keep their created order relative to each other.
 */
export function orderCards<Id>(
  cards: readonly StudyCard<Id>[],
  relations: readonly Relation<Id>[],
): { order: Id[]; cycles: CycleReport<Id>[] } {
  const sorted = [...cards].sort((a, b) => a.createdOrder - b.createdOrder);
  const allEdges = activePrerequisites(sorted, relations);
  const cycles = findCycles(sorted, allEdges);
  const inCycle = new Set(cycles.flat());
  const edges = allEdges.filter((e) => !inCycle.has(e.from) && !inCycle.has(e.to));

  const dependents = new Map<Id, Id[]>();
  const indegree = new Map<Id, number>(sorted.map((c) => [c.id, 0]));
  for (const e of edges) {
    dependents.set(e.from, [...(dependents.get(e.from) ?? []), e.to]);
    indegree.set(e.to, indegree.get(e.to)! + 1);
  }

  const orderOf = new Map(sorted.map((c) => [c.id, c.createdOrder]));
  const key = new Map<Id, number>();
  // Reverse topological sweep (edges are acyclic now): key = min over self and dependents.
  const visiting = new Set<Id>();
  const keyOf = (id: Id): number => {
    const known = key.get(id);
    if (known !== undefined) return known;
    visiting.add(id);
    let best = orderOf.get(id)!;
    for (const d of dependents.get(id) ?? []) if (!visiting.has(d)) best = Math.min(best, keyOf(d));
    visiting.delete(id);
    key.set(id, best);
    return best;
  };
  for (const c of [...sorted].reverse()) keyOf(c.id);

  const compare = (a: Id, b: Id) => key.get(a)! - key.get(b)! || orderOf.get(a)! - orderOf.get(b)!;
  const ready = new MinHeap<Id>(compare);
  for (const c of sorted) if (indegree.get(c.id) === 0) ready.push(c.id);
  const order: Id[] = [];
  while (ready.size > 0) {
    const id = ready.pop();
    order.push(id);
    for (const d of dependents.get(id) ?? []) {
      indegree.set(d, indegree.get(d)! - 1);
      if (indegree.get(d) === 0) ready.push(d);
    }
  }
  return { order, cycles: cycles.map((cardIds) => ({ cardIds })) };
}

const MAX_AFTER_REASONS = 2;
const MAX_BEFORE_REASONS = 1;

function activeBetween<Id>(byId: ReadonlyMap<Id, StudyCard<Id>>, relations: readonly Relation<Id>[]): Relation<Id>[] {
  return relations
    .filter((r) => r.status === "active" && r.from !== r.to && byId.has(r.from) && byId.has(r.to))
    .sort(
      (a, b) =>
        byId.get(a.from)!.createdOrder - byId.get(b.from)!.createdOrder || byId.get(a.to)!.createdOrder - byId.get(b.to)!.createdOrder,
    );
}

/**
 * Plain-language reasons for a card's position, for the card list (never the
 * study screen): only what explains the position — prerequisites (at most two
 * "comes after" and one "comes before"), a cycle, or no relation.
 */
export function explainPosition<Id>(
  cardId: Id,
  cards: readonly StudyCard<Id>[],
  relations: readonly Relation<Id>[],
): Reason<Id>[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  if (!byId.has(cardId)) return [];
  const { cycles } = orderCards(cards, relations);
  const inCycle = new Set(cycles.flatMap((c) => c.cardIds));
  const name = (id: Id) => `"${preview(byId.get(id)!.front)}"`;
  if (inCycle.has(cardId)) {
    return [
      {
        code: "cycle",
        text: "Faz parte de um grupo de cartões que dependem uns dos outros em círculo; nesse grupo vale a ordem normal do baralho.",
      },
    ];
  }
  const prerequisites = activeBetween(byId, relations).filter((r) => r.kind === "prerequisite" && !inCycle.has(r.from) && !inCycle.has(r.to));
  const after = prerequisites.filter((r) => r.to === cardId).slice(0, MAX_AFTER_REASONS);
  const before = prerequisites.filter((r) => r.from === cardId).slice(0, MAX_BEFORE_REASONS);
  const reasons: Reason<Id>[] = [
    ...after.map((r) => ({
      code: "after-prerequisite" as const,
      otherId: r.from,
      text: `Vem depois de ${name(r.from)}${r.reason ? `: ${r.reason}` : ", que ajuda a entendê-lo."}`,
    })),
    ...before.map((r) => ({
      code: "before-dependent" as const,
      otherId: r.to,
      text: `Vem antes de ${name(r.to)}${r.reason ? `: ${r.reason}` : ", que fica mais fácil depois deste."}`,
    })),
  ];
  if (reasons.length === 0) reasons.push({ code: "none", text: "Sem relações: segue a ordem normal do baralho." });
  return reasons;
}

/** Cue relations of a card, in plain language, for the card list. They do not explain the position. */
export function describeCues<Id>(cardId: Id, cards: readonly StudyCard<Id>[], relations: readonly Relation<Id>[]): Reason<Id>[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  if (!byId.has(cardId)) return [];
  const name = (id: Id) => `"${preview(byId.get(id)!.front)}"`;
  const out: Reason<Id>[] = [];
  for (const r of activeBetween(byId, relations)) {
    if (r.kind !== "cue") continue;
    if (r.to === cardId) out.push({ code: "cue-from", otherId: r.from, text: `${name(r.from)} mostra a resposta deste cartão.` });
    else if (r.from === cardId) out.push({ code: "cue-to", otherId: r.to, text: `Este cartão mostra a resposta de ${name(r.to)}.` });
  }
  return out;
}
