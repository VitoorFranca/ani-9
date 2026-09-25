import { describe, expect, it } from "vitest";
import { buildBm25Index, tokenize } from "../../src/model/bm25.js";

describe("tokenize", () => {
  it("lowercases and splits on non-alphanumeric characters", () => {
    expect(tokenize("There was once a Farmer's wife.")).toEqual([
      "there",
      "was",
      "once",
      "a",
      "farmer",
      "s",
      "wife",
    ]);
  });

  it("returns an empty array for text with no words", () => {
    expect(tokenize("...")).toEqual([]);
  });

  it("handles accented characters as letters", () => {
    expect(tokenize("café não")).toEqual(["café", "não"]);
  });
});

describe("buildBm25Index", () => {
  it("scores a document higher when it shares more query terms", () => {
    const docs = ["the farmer walked to the market", "the wife baked bread", "a completely unrelated sentence"];
    const index = buildBm25Index(docs);
    const query = tokenize("the farmer went to the market");

    const scoreFarmer = index.scoreAgainst(query, 0);
    const scoreUnrelated = index.scoreAgainst(query, 2);
    expect(scoreFarmer).toBeGreaterThan(scoreUnrelated);
  });

  it("gives terms that appear in fewer documents more weight (idf)", () => {
    // "the" appears in every doc (uninformative); "unicorn" appears in only one.
    const docs = ["the cat sat on the mat", "the dog ran in the park", "a rare unicorn appeared in the the forest"];
    const index = buildBm25Index(docs);

    const scoreCommonOnly = index.scoreAgainst(tokenize("the"), 0);
    const scoreRareOnly = index.scoreAgainst(tokenize("unicorn"), 2);
    // Per-occurrence, the rare term should score much higher than the ubiquitous one.
    expect(scoreRareOnly).toBeGreaterThan(scoreCommonOnly);
  });

  it("returns 0 for a query with no overlapping terms", () => {
    const docs = ["apples and oranges", "bananas and grapes"];
    const index = buildBm25Index(docs);
    expect(index.scoreAgainst(tokenize("xyz123"), 0)).toBe(0);
  });

  it("handles an empty corpus", () => {
    const index = buildBm25Index([]);
    expect(index.documentCount).toBe(0);
  });
});
