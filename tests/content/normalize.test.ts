import { describe, expect, it } from "vitest";
import { normalizeFieldText } from "../../src/content/normalize.js";
import { hasCloze, resolveCloze } from "../../src/content/cloze.js";

describe("normalizeFieldText", () => {
  it("strips HTML tags but keeps their text content", () => {
    expect(normalizeFieldText("<div>Hello <b>world</b></div>")).toBe("Hello world");
  });

  it("removes [sound:...] references", () => {
    expect(normalizeFieldText("Hello[sound:001 hello.mp3] world")).toBe("Hello world");
  });

  it("removes <img> tags", () => {
    expect(normalizeFieldText('Look: <img src="cat.png"> here')).toBe("Look: here");
  });

  it("decodes common HTML entities", () => {
    expect(normalizeFieldText("Tom &amp; Jerry &lt;3&gt;")).toBe("Tom & Jerry <3>");
  });

  it("collapses whitespace and trims", () => {
    expect(normalizeFieldText("  a   \n\n b \t c  ")).toBe("a b c");
  });

  it("resolves cloze deletions to their revealed answer", () => {
    expect(normalizeFieldText("The capital of France is {{c1::Paris}}.")).toBe(
      "The capital of France is Paris.",
    );
  });

  it("resolves cloze deletions with a hint, dropping the hint", () => {
    expect(normalizeFieldText("The capital of France is {{c1::Paris::city}}.")).toBe(
      "The capital of France is Paris.",
    );
  });

  it("resolves every cloze in the text regardless of card ord", () => {
    const text = "{{c1::My}} car is {{c2::blue}}.";
    expect(resolveCloze(text)).toBe("My car is blue.");
  });

  it("combines cloze, HTML and media stripping together", () => {
    const raw = "<div>{{c1::My}} car[sound:car.mp3] is <b>{{c2::blue}}</b></div>";
    expect(normalizeFieldText(raw)).toBe("My car is blue");
  });
});

describe("hasCloze", () => {
  it("detects cloze markers", () => {
    expect(hasCloze("{{c1::answer}}")).toBe(true);
    expect(hasCloze("no cloze here")).toBe(false);
  });
});
