import { describe, expect, it } from "vitest";
import {
  buildFolderTree,
  groupTemplatesByPath,
  checkFolderMove,
  depthOf,
  descendantIds,
  flattenTree,
  folderPath,
  normalizeFolderName,
  type FolderDTO,
} from "./template-folders";

const f = (id: string, name: string, parentId: string | null = null, templateCount = 0): FolderDTO => ({
  id,
  channel: "email",
  name,
  parentId,
  templateCount,
});

const TREE: FolderDTO[] = [
  f("detox", "Detox", null, 2),
  f("pricing", "Pricing shared", "detox", 3),
  f("followup", "Follow-up", "pricing", 1),
  f("bridal", "Bridal", null, 1),
  f("others", "Others", null, 4),
];

describe("buildFolderTree", () => {
  it("nests folders and counts what is inside them", () => {
    const tree = buildFolderTree(TREE);
    expect(tree.map((n) => n.name)).toEqual(["Bridal", "Detox", "Others"]);

    const detox = tree.find((n) => n.name === "Detox")!;
    expect(detox.totalCount).toBe(6); // 2 of its own + 3 + 1 below it
    expect(detox.children[0].name).toBe("Pricing shared");
    expect(detox.children[0].children[0].path).toBe("Detox / Pricing shared / Follow-up");
    expect(detox.children[0].children[0].depth).toBe(2);
  });

  it("keeps Others at the bottom, where the unfiled things live", () => {
    // Alphabetically it would sit between Detox and Pricing, in the middle of
    // the folders people actually made.
    expect(buildFolderTree(TREE).at(-1)!.name).toBe("Others");
  });

  it("survives a cycle in the data instead of hanging the page", () => {
    const cyclic = [f("a", "A", "b"), f("b", "B", "a")];
    expect(() => buildFolderTree(cyclic)).not.toThrow();
  });

  it("flattens parents before their children", () => {
    expect(flattenTree(buildFolderTree(TREE)).map((n) => n.name)).toEqual([
      "Bridal",
      "Detox",
      "Pricing shared",
      "Follow-up",
      "Others",
    ]);
  });
});

describe("folderPath", () => {
  it("reads the whole path", () => {
    expect(folderPath(TREE, "followup")).toBe("Detox / Pricing shared / Follow-up");
    expect(folderPath(TREE, "detox")).toBe("Detox");
  });

  it("is nothing for a template in no folder", () => {
    expect(folderPath(TREE, null)).toBeNull();
  });
});

describe("descendantIds / depthOf", () => {
  it("finds everything beneath a folder", () => {
    expect(descendantIds(TREE, "detox").sort()).toEqual(["followup", "pricing"]);
    expect(descendantIds(TREE, "bridal")).toEqual([]);
  });

  it("measures how deep a folder sits", () => {
    expect(depthOf(TREE, "detox")).toBe(0);
    expect(depthOf(TREE, "followup")).toBe(2);
  });
});

describe("checkFolderMove", () => {
  it("allows an ordinary move", () => {
    expect(checkFolderMove(TREE, "bridal", "detox")).toBeNull();
    expect(checkFolderMove(TREE, "pricing", null)).toBeNull();
  });

  it("refuses the move that would detach a whole branch", () => {
    // Detox into its own grandchild: both would vanish from every listing,
    // and nothing on the page could bring them back.
    expect(checkFolderMove(TREE, "detox", "followup")).toBe("descendant");
    expect(checkFolderMove(TREE, "detox", "detox")).toBe("self");
  });

  it("refuses to mix the two channels", () => {
    const mixed = [...TREE, { ...f("wa", "WhatsApp folder"), channel: "whatsapp" as const }];
    expect(checkFolderMove(mixed, "detox", "wa")).toBe("channel");
  });

  it("allows a move that still fits inside the depth limit", () => {
    // Detox (two levels below it) under Bridal ends at the fourth level,
    // which is the deepest allowed.
    expect(checkFolderMove(TREE, "detox", "bridal")).toBeNull();
  });

  it("refuses a move that would bury a folder too deep to see", () => {
    // "Follow-up" already sits at the third level; anything under it would be
    // the fifth.
    const deeper = [...TREE, f("extra", "Extra", "followup")];
    expect(checkFolderMove(deeper, "bridal", "extra")).toBe("depth");
  });
});

describe("normalizeFolderName", () => {
  it("collapses whitespace and treats blank as no name", () => {
    expect(normalizeFolderName("  Detox   pricing ")).toBe("Detox pricing");
    expect(normalizeFolderName("   ")).toBeNull();
    expect(normalizeFolderName(null)).toBeNull();
  });
});

describe("groupTemplatesByPath", () => {
  it("orders folders A→Z, with Others and the unfiled after them", () => {
    const groups = groupTemplatesByPath([
      { name: "a", folderPath: "Others" },
      { name: "b", folderPath: "Detox / Pricing shared" },
      { name: "c", folderPath: null },
      { name: "d", folderPath: "Bridal" },
    ]);
    expect(groups.map((g) => g.path)).toEqual(["Bridal", "Detox / Pricing shared", "Others", null]);
  });

  it("keeps every template of one folder together", () => {
    const groups = groupTemplatesByPath([
      { name: "a", folderPath: "Detox" },
      { name: "b", folderPath: "Bridal" },
      { name: "c", folderPath: "Detox" },
    ]);
    expect(groups[1].templates.map((t) => t.name)).toEqual(["a", "c"]);
  });
});
